#!/usr/bin/env node
// report-lint.mjs — mechanical gate for the five-section report contract in REPORT-CONTRACT.md.
//
//   Usage: node tools/gates/report-lint.mjs <report.md> [--strict] [--json]
//          node tools/gates/report-lint.mjs -h|--help
//
// Exit codes: 0 = pass, 1 = gate violation, 2 = cannot judge.
// Pure static parsing: no network, no LLM, no npm dependencies (Node 18+ ESM only).

import fs from "node:fs";

const TOOL = "report-lint";

// ---------------------------------------------------------------------------
// Section model
// ---------------------------------------------------------------------------

const SECTIONS = ["conclusion", "findings", "verified", "notcovered", "skipped"];

// Heading aliases are tested against the raw heading text. English forms use
// word boundaries so "Unverified" never reads as "Verified"; Chinese aliases
// match as substrings. "Not covered" / "not-covered" / "notcovered" collapse
// into one equivalence class via /not[\s_-]*covered/.
const HEADING_ALIASES = {
  conclusion: [/\bconclusion\b/i, /结论/],
  findings: [/\bfindings\b/i, /发现/],
  verified: [/\bverified\b/i, /已验证/],
  notcovered: [/\bnot[\s_-]*covered\b/i, /未覆盖/],
  skipped: [/\bskipped?\b/i, /跳过/],
};

const DISPLAY = {
  conclusion: "Conclusion",
  findings: "Findings",
  verified: "Verified",
  notcovered: "Not covered",
  skipped: "Skipped",
};

const ALIAS_TEXT = {
  conclusion: "conclusion, 结论",
  findings: "findings, 发现",
  verified: "verified, 已验证",
  notcovered: "not covered, 未覆盖",
  skipped: "skipped, 已跳过",
};

// E2 (a) — abandonment markers: the writer says they deliberately did not run it.
// The negative lookahead kills the "run into/out/over" idioms ("did not run into
// issues", "did not run out of budget"), which are blocks, not skips.
const ABANDON = new RegExp(
  "\\b(skip(ped)?|deprioritized|not run|did(n't| not|nt) run)(?!\\s+(into|across|out|over)\\b)\\b|" +
    "未运行|没跑|未跑|未测|没有?执行|未执行|跳过",
  "i"
);

// E2 (b) — reason markers: cost / time / pressure that motivated the choice.
// English words are fully word-bounded so "timeout" or "costly" never count.
const REASON = new RegExp(
  "\\b(slow(er)?|time|cost|budget|deadline)\\b|太慢|嫌慢|耗时|时间不够|时间紧|成本|预算|排期|来不及",
  "i"
);

// E3 — evidence markers; any one of the four suffices.
const URL_RE = /https?:\/\/\S+/i;
const FILELINE_RE = /\b[\w./-]+:\d{1,6}\b/;
const COMMAND_RE = /`[^`\n]{4,}`/;
// a rendered artifact path (visual acceptance cites the page image it inspected)
const IMAGE_RE = /\b[\w./\\-]+\.(png|jpe?g|webp|gif)\b/i;

const NONE_RE = /^\s*(none|无|n-?a|n\/a)\s*$/i;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const BULLET_RE = /^\s*([-*+]|\d+[.)])\s+|^\s*\|/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]*\|\s*$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseReport(text) {
  // Strip BOM; split on any of \r\n / \n / lone \r (CRLF tolerance).
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const sections = {};
  for (const key of SECTIONS) sections[key] = { body: [], startLine: null };
  const present = [];
  let current = null;

  lines.forEach((line, i) => {
    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      current = null;
      if (level >= 2 && level <= 4) {
        for (const key of SECTIONS) {
          if (HEADING_ALIASES[key].some((re) => re.test(title))) {
            current = key;
            break;
          }
        }
      }
      if (current) {
        if (!present.includes(current)) present.push(current);
        if (sections[current].startLine === null) sections[current].startLine = i + 1;
      }
      return;
    }
    if (current) sections[current].body.push({ text: line, line: i + 1 });
  });

  return { sections, present };
}

function hasContent(section) {
  return section.body.some((l) => l.text.trim() !== "");
}

function isExplicitNone(section) {
  const lines = section.body.map((l) => l.text.trim()).filter(Boolean);
  return lines.length === 1 && NONE_RE.test(lines[0]);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function lint(text, strict) {
  const { sections, present } = parseReport(text);
  const findings = [];
  let ok = 0;

  const err = (location, message, fix) =>
    findings.push({ severity: "error", location, message, fix });
  const warn = (location, message, fix) =>
    findings.push({ severity: "warning", location, message, fix });
  const info = (location, message, fix) =>
    findings.push({ severity: "info", location, message, fix });

  if (present.length === 0) {
    // Nothing that looks like a report at all (wrong file handed in).
    err(
      "document",
      "no report sections found (expected at least '## Conclusion'; see REPORT-CONTRACT.md)",
      "add the five required sections per REPORT-CONTRACT.md"
    );
    return finish(findings, ok, strict);
  }

  // E1 + W1: required sections present and non-empty.
  for (const key of SECTIONS) {
    if (!present.includes(key)) {
      err(
        "document",
        `missing required section '${DISPLAY[key]}'`,
        `add '## ${DISPLAY[key]}' (aliases: ${ALIAS_TEXT[key]})`
      );
      continue;
    }
    ok++;
    if (hasContent(sections[key])) {
      ok++;
    } else {
      warn(
        `section '${DISPLAY[key]}'`,
        `section '${DISPLAY[key]}' is empty — state 'none' explicitly (silence is ambiguous)`,
        "write 'none' or fill the section with real content"
      );
    }
  }

  // W2 + E3: Verified.
  if (present.includes("verified")) {
    const v = sections.verified;
    if (hasContent(v)) {
      ok++; // W2 satisfied — the section is not empty
      if (isExplicitNone(v)) {
        info("section 'Verified'", "Verified is explicitly 'none' — nothing to verify", "no action needed");
      } else {
        for (const l of v.body) {
          const t = l.text.trim();
          if (!t) continue;
          if (!BULLET_RE.test(t)) continue;
          if (TABLE_SEP_RE.test(t)) continue;
          if (URL_RE.test(t) || FILELINE_RE.test(t) || COMMAND_RE.test(t) || IMAGE_RE.test(t)) {
            ok++;
          } else {
            err(
              `line ${l.line}`,
              "verified item lacks an evidence marker",
              "add a URL, file:line, or command + exit code"
            );
          }
        }
      }
    } else {
      warn(
        "section 'Verified'",
        "section 'Verified' is empty — state 'none' explicitly (silence is ambiguous)",
        "write 'none' or fill the section with real content"
      );
    }
  }

  // E2: Not covered must not contain decisions dressed as blockers.
  if (present.includes("notcovered")) {
    for (const l of sections.notcovered.body) {
      const t = l.text.trim();
      if (!t) continue;
      if (ABANDON.test(t) && REASON.test(t)) {
        err(
          `line ${l.line}`,
          "this reads like a skipped check, not a blocked one",
          "move it to '## Skipped' and state the cost of running it"
        );
      } else {
        ok++;
      }
    }
  }

  return finish(findings, ok, strict);
}

function finish(findings, ok, strict) {
  // Drop exact duplicates (W2 repeats W1's wording for an empty Verified).
  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.location}|${f.message}|${f.fix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(f);
  }

  const errors = [];
  const warnings = [];
  const infos = [];
  for (const f of dedup) {
    if (f.severity === "error") errors.push(f);
    else if (f.severity === "warning") warnings.push(f);
    else infos.push(f);
  }

  if (strict) {
    for (const w of warnings) w.severity = "error";
    errors.push(...warnings);
    warnings.length = 0;
  }

  return { ok, errors, warnings, infos };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function severityLabel(severity) {
  return severity === "error" ? "ERROR" : severity === "warning" ? "WARN" : "INFO";
}

function formatFinding(f) {
  return `${severityLabel(f.severity)} ${f.location}: ${f.message}. Fix: ${f.fix}`;
}

function fail2(message) {
  process.stderr.write(`[RUNTIME_ERROR] ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `report-lint — validate a report against REPORT-CONTRACT.md

Usage:
  node tools/gates/report-lint.mjs <report.md> [--strict] [--json]
  node tools/gates/report-lint.mjs -h|--help

The contract requires five sections (## / ### / #### headings; English and
Chinese aliases are both recognized):

  ## Conclusion    | 结论
  ## Findings      | 发现
  ## Verified      | 已验证
  ## Not covered   | 未覆盖   (aliases: not-covered, notcovered)
  ## Skipped       | 已跳过

Checks:
  E1  every required section is present
  E2  'Not covered' must not contain entries that are actually skips
  E3  every 'Verified' bullet carries an evidence marker: a URL, a file:line
      (e.g. src/router.ts:88), or a backticked command of >= 4 chars
      (e.g. \`npm test\` → exit 0)
  W1  an empty section must say 'none' explicitly — silence is ambiguous
  W2  an empty 'Verified' without an explicit 'none' is called out too
  --strict promotes every warning to an error

E2 防误杀设计 (anti-false-positive design):
  A 'Not covered' line only triggers E2 when it matches BOTH
  (a) an abandonment marker: skip, skipped, not run, didn't run, did not run,
      deprioritized, 未运行, 没跑, 未跑, 未测, 未执行, 跳过 — AND
  (b) a reason marker: slow, slower, time, cost, budget, deadline,
      太慢, 嫌慢, 耗时, 时间不够, 时间紧, 成本, 预算, 排期, 来不及.
  Merely reporting that a third party was slow — a line with no first-person
  abandonment marker — never triggers. "blocked: the vendor's site is slow"
  passes; "did not run because it was slow" fails. Idioms such as "did not
  run into a rate limit" also pass.

Exit codes:
  0  pass — contract satisfied
  1  gate violation — evidence does not satisfy the contract
  2  cannot judge — missing argument, unreadable file, internal error

Examples:
  node tools/gates/report-lint.mjs reports/lane1.md
  node tools/gates/report-lint.mjs reports/lane1.md --strict
  node tools/gates/report-lint.mjs reports/lane1.md --json
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const flagSet = new Set(["--json", "--strict"]);
  const positional = args.filter((a) => !flagSet.has(a));

  const unknown = positional.filter((a) => a.startsWith("-"));
  if (unknown.length > 0) {
    return fail2(`unknown argument '${unknown[0]}'. Usage: node tools/gates/report-lint.mjs <report.md> [--strict] [--json]`);
  }
  if (positional.length === 0) {
    return fail2("missing report path. Usage: node tools/gates/report-lint.mjs <report.md> [--strict] [--json]");
  }
  if (positional.length > 1) {
    return fail2(`too many arguments: ${positional.slice(1).join(", ")}. Usage: node tools/gates/report-lint.mjs <report.md> [--strict] [--json]`);
  }

  const file = positional[0];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return fail2(`cannot read '${file}': ${e.message}`);
  }

  const { ok, errors, warnings, infos } = lint(text, strict);

  if (json) {
    const out = {
      tool: TOOL,
      input: file,
      ok: errors.length === 0,
      errors: errors.map((f) => ({ severity: f.severity, location: f.location, message: f.message, fix: f.fix })),
      warnings: warnings.map((f) => ({ severity: f.severity, location: f.location, message: f.message, fix: f.fix })),
      summary: { errors: errors.length, warnings: warnings.length },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    if (errors.length > 0) {
      process.stderr.write(`[GATE_VIOLATION] FAIL: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  for (const f of errors) process.stdout.write(formatFinding(f) + "\n");
  for (const f of warnings) process.stdout.write(formatFinding(f) + "\n");
  for (const f of infos) process.stdout.write(formatFinding(f) + "\n");

  if (errors.length > 0) {
    process.stdout.write(`FAIL: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    process.stderr.write(`[GATE_VIOLATION] FAIL: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS: ${ok} check(s) ok\n`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[RUNTIME_ERROR] internal error: ${e.stack || e.message}\n`);
  process.exit(2);
}
