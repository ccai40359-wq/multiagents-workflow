#!/usr/bin/env node
// 文件边界越界检查闸门：dev-delivery 并行开发时，验证派单声明的文件边界确实覆盖了实际改动文件
// （"一个写手一个边界"从散文变成闸门）。纯本地判断、零依赖、不访问网络；
// 唯一允许的子进程是 --git-base 触发的 git diff。
// pattern 语义：** 任意深度（含零段）、* 单段内任意字符、? 单字符、无通配符字面量只精确匹配该路径。
// 任何路径比较前先把 \ 归一化为 /（Windows 反斜杠与 git 输出的正斜杠行为一致）。

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 10000;

const USAGE = `usage: node tools/gates/boundary-check.mjs --boundary <patterns> [--files <list> | --diff-file <path> | --git-base <ref>] [--json]

Verify that every changed file is covered by at least one declared boundary
pattern (one writer, one boundary). Paths are matched as repo-relative
strings; Windows backslashes are normalized to forward slashes.

options:
  --boundary <patterns>  comma-separated glob/path list, or a path to a text
                         file with one pattern per line (# comment lines
                         allowed). Required.
  --files <list>         changed files as a comma- or newline-separated list.
  --diff-file <path>     file with one changed-file path per line.
  --git-base <ref>       run 'git diff --name-only <ref>' in the current
                         directory and use its output as the changed files.
  --json                 print exactly one JSON object on stdout; all
                         diagnostics go to stderr.
  --strict               promote warnings (e.g. a declared pattern that matched
                         no changed file) to violations.
  -h, --help             show this help and exit.

pattern syntax:
  **   any number of path segments (including zero)
  *    any characters within one path segment
  ?    exactly one character
  a pattern with no wildcards matches only that exact path
  examples: src/** matches src/a.js and src/a/b.js but not top.txt;
            *.md matches README.md but not docs/x.md

exit codes:
  0  pass: every changed file matched at least one boundary pattern
  1  violation: a changed file is outside the declared boundary
  2  cannot determine: missing arguments, unreadable file, git failure

examples:
  node tools/gates/boundary-check.mjs --boundary "src/**,tests/**" --files "src/a.js,tests/b.test.mjs"
  node tools/gates/boundary-check.mjs --boundary "src/**" --diff-file changed.txt
  node tools/gates/boundary-check.mjs --boundary boundaries.txt --git-base HEAD~1
`;

const VALUE_FLAGS = new Set(["boundary", "files", "diff-file", "git-base"]);
// flag 名（kebab-case）→ args 属性名（camelCase）
const FLAG_TO_KEY = { boundary: "boundary", files: "files", "diff-file": "diffFile", "git-base": "gitBase" };

function normalizePath(p) {
  return String(p).replace(/\\/g, "/");
}

// 手写 glob 编译（不引库）：先吃 **/（任意深度含零段）再吃剩余 **，保证 * 不跨段、字面量精确锚定。
function compilePattern(raw) {
  const p = normalizePath(raw);
  let out = "";
  let i = 0;
  while (i < p.length) {
    if (p.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (p[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (p[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += /[\\^$.*+?()[\]{}|]/.test(p[i]) ? "\\" + p[i] : p[i];
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}

function parseArgs(argv) {
  const args = { boundary: null, files: null, diffFile: null, gitBase: null, json: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--strict") {
      args.strict = true;
    } else {
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0 && VALUE_FLAGS.has(key)) {
        args[FLAG_TO_KEY[key]] = a.slice(eq + 1);
      } else if (VALUE_FLAGS.has(key)) {
        if (i + 1 >= argv.length) throw new Error(`missing value for --${key}`);
        args[FLAG_TO_KEY[key]] = argv[++i];
      } else {
        throw new Error(`unknown argument: ${a}`);
      }
    }
  }
  return args;
}

function readBoundary(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("missing --boundary <patterns>");
  let patterns;
  if (fs.existsSync(raw)) {
    // 已存在文件优先：按每行一个 pattern 读，允许 # 注释行
    let text;
    try {
      text = fs.readFileSync(raw, "utf8");
    } catch (e) {
      throw new Error(`cannot read boundary file ${raw}: ${e.message}`);
    }
    patterns = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  } else {
    patterns = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (patterns.length === 0) throw new Error("no boundary patterns given");
  return patterns;
}

function listChanged(args) {
  const n = [args.files, args.diffFile, args.gitBase].filter((v) => v != null).length;
  if (n === 0) throw new Error("missing changed-file source: need one of --files, --diff-file, --git-base");
  if (n > 1) throw new Error("ambiguous changed-file source: give only one of --files, --diff-file, --git-base");
  if (args.files != null) {
    return String(args.files).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  if (args.diffFile != null) {
    let raw;
    try {
      raw = fs.readFileSync(args.diffFile, "utf8");
    } catch (e) {
      throw new Error(`cannot read diff file ${args.diffFile}: ${e.message}`);
    }
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  let out;
  try {
    out = execFileSync("git", ["diff", "--name-only", args.gitBase], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (e) {
    throw new Error(`git diff --name-only ${args.gitBase} failed: ${e.message}`);
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function sourceLabel(args) {
  if (args.files != null) return "--files";
  if (args.diffFile != null) return "--diff-file";
  return "--git-base " + (args.gitBase ?? "");
}

function argSummary(args, boundary, changed) {
  const s = `${boundary.length} boundary pattern(s), ${changed.length} changed file(s) from ${sourceLabel(args)}`;
  return changed.length === 0 ? s + "; no changed files" : s;
}

function rawArgSummary(argv) {
  const hasBoundary = argv.some((a) => a === "--boundary" || a.startsWith("--boundary="));
  const src = ["--files", "--diff-file", "--git-base"].find((f) => argv.some((a) => a === f || a.startsWith(f + "="))) || "none";
  return `boundary=${hasBoundary ? "set" : "missing"}, source=${src}`;
}

function emitHuman(result) {
  for (const e of result.errors) process.stdout.write(`ERROR ${e.location}: ${e.message}. Fix: ${e.fix}\n`);
  for (const w of result.warnings) process.stdout.write(`WARN ${w.location}: ${w.message}. Fix: ${w.fix}\n`);
  for (const i of result.infos) process.stdout.write(`INFO ${i.location}: ${i.message}. Fix: ${i.fix}\n`);
  if (result.code === 1) {
    process.stdout.write(`FAIL: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`);
    process.stderr.write(`[GATE_VIOLATION] ${result.errors.length} changed file(s) outside declared boundary\n`);
  } else {
    const checks = result.changed.length === 0 ? 1 : result.changed.length + result.boundary.length;
    process.stdout.write(`PASS: ${checks} check(s) ok\n`);
  }
}

function emitJson(result) {
  const obj = {
    tool: "boundary-check",
    input: argSummary(result.args, result.boundary, result.changed),
    ok: result.code === 0,
    errors: result.errors.map((e) => ({ severity: "error", location: e.location, message: e.message, fix: e.fix })),
    warnings: result.warnings.map((w) => ({ severity: "warning", location: w.location, message: w.message, fix: w.fix })),
    summary: { errors: result.errors.length, warnings: result.warnings.length },
  };
  process.stdout.write(JSON.stringify(obj) + "\n");
  if (result.code === 1) process.stderr.write(`[GATE_VIOLATION] ${result.errors.length} changed file(s) outside declared boundary\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return { help: true };
  }
  const boundary = readBoundary(args.boundary);
  const changed = [...new Set(listChanged(args).map(normalizePath))];
  const patterns = boundary.map((p) => ({ raw: p, re: compilePattern(p), hits: 0 }));
  const errors = [];
  const warnings = [];
  const infos = [];
  if (changed.length === 0) {
    infos.push({ location: "-", message: "no changed files", fix: "nothing to check" });
  } else {
    for (const f of changed) {
      const matched = patterns.filter((c) => c.re.test(f));
      for (const c of matched) c.hits++;
      if (matched.length === 0) {
        errors.push({
          location: f,
          message: "changed file outside declared boundary",
          fix: "restrict changes to: " + patterns.map((c) => c.raw).join(", "),
        });
      }
    }
    for (const c of patterns) {
      if (c.hits === 0) {
        warnings.push({
          location: c.raw,
          message: `declared boundary pattern '${c.raw}' matched no changed file (typo, or already done?)`,
          fix: "remove the pattern or fix its spelling (or confirm the workstream already delivered)",
        });
      }
    }
  }
  if (args.strict) {
    for (const w of warnings) {
      errors.push({ location: w.location, message: w.message + " (--strict)", fix: w.fix });
    }
    warnings.length = 0;
  }
  return { args, code: errors.length ? 1 : 0, json: args.json, boundary, changed, errors, warnings, infos };
}

try {
  const result = main(process.argv.slice(2));
  if (result.help) process.exit(0);
  if (result.json) emitJson(result);
  else emitHuman(result);
  process.exit(result.code);
} catch (e) {
  const msg = e && e.message ? e.message : String(e);
  const json = process.argv.includes("--json");
  if (json) {
    const obj = {
      tool: "boundary-check",
      input: rawArgSummary(process.argv.slice(2)),
      ok: false,
      errors: [{ severity: "error", location: "-", message: msg, fix: "check arguments and retry" }],
      warnings: [],
      summary: { errors: 1, warnings: 0 },
    };
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
  process.stderr.write(`[RUNTIME_ERROR] ${msg}\n`);
  process.exit(2);
}