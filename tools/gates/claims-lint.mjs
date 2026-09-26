#!/usr/bin/env node
// claims-lint — mechanical gate for web-research-fanout claims tables (pure static parsing)
//   usage: node tools/gates/claims-lint.mjs <claims-table.md> [--strict] [--as-of YYYY-MM-DD] [--json]
//   exit codes: 0 = pass / 1 = gate violation / 2 = runtime error (missing arg, unreadable file, internal error)
//   A claims table is any markdown table whose header carries assertion + source/url +
//   date + p/s|evidence + counter; every data row is validated mechanically (no LLM).
import fs from "node:fs";
import { isSafePublicUrl } from "./lib/url-guard.mjs";

const USAGE = [
  "usage: node tools/gates/claims-lint.mjs <claims-table.md> [--strict] [--as-of YYYY-MM-DD] [--json]",
  "exit codes: 0 = pass / 1 = gate violation (evidence does not meet the contract) / 2 = runtime error (missing arg, unreadable file, internal error)",
  "example: node tools/gates/claims-lint.mjs examples/claims-table-sample.md",
  "         node tools/gates/claims-lint.mjs report.md --strict --json",
].join("\n");

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// W2 recheck marker: the SKILL contract says secondary-only claims must be marked
// "pending primary verification" — accept the canonical English/Chinese variants.
const RECHECK_MARK = /(pending (primary|verification)|first-?hand (recheck|verification)|待(一手|主源)?复核)/i;
const CONFLICT_MARK = /conflict|disputed|矛盾|冲突|arbitrat/i;
const ARB_SECTION = /not found|conflict|未找到|冲突|arbitrat/i;
const NONE_FOUND = /none found|no results|查不到|无结果/i;
const WORD_RE = /[A-Za-z0-9]{6,}/g;
const LINK_RE = /\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g;
const LINK_TARGET_RE = /\[[^\]]*\]\(((?:[^()]|\([^()]*\))*)\)/g;
const URL_TOKEN_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s)\]]+/g;

const HEADER_ROLES = [
  // bilingual headers: SKILL.zh.md's template ships 断言|来源URL|日期|一手/二手|有无反证
  ["assertion", /assertion|断言/i],
  ["counter", /counter|反证/i],
  ["source", /source|url|来源/i],
  ["ps", /p\/s|evidence|一手|二手/i],
  ["date", /date|日期/i],
];

function splitRow(line) {
  // split on pipes whose preceding backslashes are even (so \| stays inside the cell)
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "|") {
      let bs = 0;
      for (let j = i - 1; j >= 0 && body[j] === "\\"; j--) bs++;
      if (bs % 2 === 0) {
        cells.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.replace(/\\\|/g, "|").replace(/\\\\/g, "\\").trim());
}

function assignRoles(cells) {
  const idx = {};
  for (const [role] of HEADER_ROLES) idx[role] = -1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i].toLowerCase();
    for (const [role, re] of HEADER_ROLES) {
      if (idx[role] < 0 && re.test(c)) {
        idx[role] = i;
        break;
      }
    }
  }
  return idx.assertion >= 0 && idx.source >= 0 && idx.date >= 0 && idx.ps >= 0 && idx.counter >= 0 ? idx : null;
}

function parseTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim().startsWith("|")) {
      i++;
      continue;
    }
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) block.push(i++);
    const cells = splitRow(lines[block[0]]);
    const cols = assignRoles(cells);
    if (!cols) continue;
    const rows = [];
    for (const idx of block.slice(1)) {
      const r = splitRow(lines[idx]);
      if (r.length && r.every((c) => /^:?-{1,}:?$/.test(c))) continue; // delimiter row
      rows.push({ line: idx + 1, cells: r });
    }
    tables.push({ headerLine: block[0] + 1, cols, rows, endLine: block[block.length - 1] + 1 });
  }
  return tables;
}

function collectHeadings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i].trim());
    if (m) out.push({ line: i + 1, depth: m[1].length, text: m[2] });
  }
  return out;
}

function bulletsUnder(lines, heading) {
  const out = [];
  for (let i = heading.line; i < lines.length; i++) {
    const t = lines[i].trim();
    const h = /^(#{1,6})\s+/.exec(t);
    if (h) {
      if (h[1].length <= heading.depth) break;
      continue;
    }
    const m = /^[-*+]\s+(\S.*)$/.exec(t);
    if (m) out.push(m[1].trim());
  }
  return out.filter((b) => b.length > 0);
}

function shareWord(a, b) {
  const ta = new Set((a.match(WORD_RE) || []).map((w) => w.toLowerCase()));
  if (ta.size === 0) return true;
  const tb = new Set((b.match(WORD_RE) || []).map((w) => w.toLowerCase()));
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}

function extractUrls(cell) {
  const urls = [];
  let m;
  LINK_TARGET_RE.lastIndex = 0;
  while ((m = LINK_TARGET_RE.exec(cell))) {
    const t = m[1].trim();
    if (t) urls.push(t);
  }
  const rest = cell.replace(LINK_RE, " ");
  while ((m = URL_TOKEN_RE.exec(rest))) urls.push(m[0].replace(/[.,;:)\]"'`]+$/, ""));
  return urls;
}

function daysBefore(asOf, dateCell) {
  return Math.floor((Date.parse(asOf) - Date.parse(dateCell)) / 86400000);
}

function checkRow(row, cols, asOf) {
  const findings = [];
  const line = row.line;
  const cell = (i) => row.cells[i] ?? "";
  const assertion = cell(cols.assertion);
  const source = cell(cols.source);
  const dateCell = cell(cols.date);
  const ps = cell(cols.ps);
  const counter = cell(cols.counter).trim();

  const urls = extractUrls(source);
  if (urls.length === 0) {
    findings.push({ severity: "error", line, message: "assertion has no source URL", fix: "add a source URL (https://...) to the Source column" });
  } else {
    for (const u of urls) {
      const r = isSafePublicUrl(u);
      if (!r.ok) {
        findings.push({ severity: "error", line, message: `source URL is not a publicly fetchable URL (${r.reason})`, fix: "replace the URL with a publicly fetchable http(s) address" });
        break;
      }
    }
  }

  if (!DATE_RE.test(dateCell)) {
    findings.push({ severity: "error", line, message: "missing or malformed date (expected YYYY-MM-DD)", fix: "add a YYYY-MM-DD date to the Date column" });
  }

  if (!/^(primary|secondary|一手|二手)/i.test(ps)) {
    findings.push({ severity: "error", line, message: "missing primary/secondary evidence marker", fix: "write 'primary'/'secondary' (or 一手/二手) as the first word of the P/S column" });
  }

  if (!counter) {
    findings.push({ severity: "error", line, message: "empty counter-evidence column (write 'none found' if you found none)", fix: "write 'none found' if you found no counter-evidence" });
  }

  if (/stale/i.test(counter) || (DATE_RE.test(dateCell) && daysBefore(asOf, dateCell) > 30)) {
    findings.push({ severity: "warn", line, message: `evidence may be stale (>30 days as of ${asOf}); refresh if time-sensitive`, fix: "refresh the source or re-verify before relying on it" });
  }

  if (/^(secondary|二手)/i.test(ps) && !RECHECK_MARK.test(counter)) {
    findings.push({ severity: "warn", line, message: "secondary-only claim; consider the first-hand recheck marker", fix: "mark the claim 'pending primary verification' in the counter-evidence column" });
  }

  return { line, assertion, counter, conflict: CONFLICT_MARK.test(counter), findings };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgv(argv) {
  const flags = { help: false, strict: false, json: false, asOf: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "--strict") flags.strict = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--as-of") flags.asOf = argv[++i];
    else if (a.startsWith("--")) { /* unknown flag: ignore */ }
    else if (flags.input === null) flags.input = a;
  }
  return flags;
}

function humanLine(f) {
  return `${f.severity === "warn" ? "WARN" : "ERROR"} line ${f.line}: ${f.message}. Fix: ${f.fix}`;
}

function toJson(f) {
  return { severity: f.severity, location: `line ${f.line}`, message: f.message, fix: f.fix };
}

function run(argv) {
  const flags = parseArgv(argv);
  if (flags.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (flags.asOf !== null && !DATE_RE.test(String(flags.asOf))) {
    throw new Error(`invalid --as-of date '${flags.asOf}' (expected YYYY-MM-DD)`);
  }
  const asOf = flags.asOf || today();
  if (!flags.input) throw new Error("missing <claims-table.md> argument");

  const raw = fs.readFileSync(flags.input, "utf8");
  const lines = raw.split(/\n/).map((l) => l.replace(/\r$/, ""));
  const tables = parseTables(lines);
  const findings = [];
  const conflictRows = [];
  let totalChecks = 0;

  if (tables.length === 0) {
    findings.push({
      severity: "error",
      line: 1,
      message: "no claims table found (expected header: Assertion | Source | Date | P/S | Counter-evidence)",
      fix: "add a claims table with that header",
    });
  } else {
    for (const t of tables) {
      totalChecks += 1 + t.rows.length;
      if (t.rows.length === 0) {
        if (!NONE_FOUND.test(lines.join("\n"))) {
          findings.push({
            severity: "error",
            line: t.headerLine,
            message: "claims table is empty with no explicit 'none found' statement",
            fix: "write an explicit 'none found' statement (e.g. 'none found') somewhere in the document",
          });
        }
        continue;
      }
      for (const row of t.rows) {
        const res = checkRow(row, t.cols, asOf);
        findings.push(...res.findings);
        if (res.conflict) conflictRows.push(res);
      }
    }
    if (conflictRows.length > 0) {
      const lastEnd = Math.max(...tables.map((t2) => t2.endLine));
      const heading = collectHeadings(lines).find((h) => h.line > lastEnd && ARB_SECTION.test(h.text));
      const bullets = heading ? bulletsUnder(lines, heading) : [];
      if (!heading || bullets.length === 0) {
        findings.push({
          severity: "error",
          line: conflictRows[0].line,
          message: "conflict marked in table but no not-found/arbitration section below",
          fix: "add a 'Not found / conflicting' section with at least one non-empty bullet below the table",
        });
      } else {
        for (const row of conflictRows) {
          if (!bullets.some((b) => shareWord(row.assertion, b))) {
            findings.push({
              severity: "warn",
              line: row.line,
              message: "arbitration section may not cover the marked conflict",
              fix: "add a bullet in the arbitration section that names the conflict",
            });
          }
        }
      }
    }
  }

  if (flags.strict) for (const f of findings) if (f.severity === "warn") f.severity = "error";

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");

  if (flags.json) {
    const obj = {
      tool: "claims-lint",
      input: flags.input,
      ok: errors.length === 0,
      errors: errors.map(toJson),
      warnings: warnings.map(toJson),
      summary: { errors: errors.length, warnings: warnings.length },
    };
    process.stdout.write(JSON.stringify(obj) + "\n");
    for (const f of findings) process.stderr.write(humanLine(f) + "\n");
    if (errors.length > 0) process.stderr.write(`[GATE_VIOLATION] ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    return errors.length > 0 ? 1 : 0;
  }

  for (const f of findings) process.stdout.write(humanLine(f) + "\n");
  process.stdout.write(
    errors.length > 0
      ? `FAIL: ${errors.length} error(s), ${warnings.length} warning(s)\n`
      : `PASS: ${totalChecks} check(s) ok\n`
  );
  if (errors.length > 0) process.stderr.write(`[GATE_VIOLATION] ${errors.length} error(s), ${warnings.length} warning(s)\n`);
  return errors.length > 0 ? 1 : 0;
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
try {
  process.exit(run(argv));
} catch (e) {
  const msg = e && e.message ? e.message : String(e);
  process.stderr.write(`[RUNTIME_ERROR] ${msg}\n`);
  process.stderr.write("usage: node tools/gates/claims-lint.mjs <claims-table.md> [--strict] [--as-of YYYY-MM-DD] [--json]\n");
  if (json) {
    process.stdout.write(
      JSON.stringify({
        tool: "claims-lint",
        input: argv.find((a) => !a.startsWith("--")) ?? "",
        ok: false,
        errors: [{ severity: "error", location: "input", message: msg, fix: "" }],
        warnings: [],
        summary: { errors: 1, warnings: 0 },
      }) + "\n"
    );
  }
  process.exit(2);
}