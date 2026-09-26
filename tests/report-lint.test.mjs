// Self-test for report-lint.mjs: node tests/report-lint.test.mjs (run from the repo root)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../tools/gates/report-lint.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-lint-test-"));

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS  " + name);
  } else {
    fail++;
    console.log("FAIL  " + name + (extra ? "  [" + extra + "]" : ""));
  }
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function write(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---- report builders -------------------------------------------------------

function report(overrides = {}) {
  const c = overrides.conclusion ?? "## Conclusion\nThe claim holds.\n";
  const f = overrides.findings ?? "## Findings\n- claim table: src/a.ts:1\n";
  const v = overrides.verified ?? "## Verified\n- claim A — https://example.org/pricing\n";
  const n = overrides.notcovered ?? "## Not covered\n- question Q — blocked: upstream API returned 503\n";
  const s = overrides.skipped ?? "## Skipped\n- check S — skipped: cost: about $20 per run\n";
  return ["# Report: sample lane\n", c, f, v, n, s].join("\n");
}

// A fully compliant report.
const goodFile = write(
  "good.md",
  report({
    verified: [
      "## Verified",
      "- claim A — https://example.org/pricing",
      "- claim B — src/router.ts:88",
      "- claim C — `npm test` → exit 0",
      "",
    ].join("\n"),
  })
);

// ---- 1. fully compliant report ----------------------------------------------

let r = run([goodFile]);
check("1 compliant report exits 0", r.code === 0, `code=${r.code}`);
check("1a PASS summary line present", /PASS: \d+ check\(s\) ok$/.test(r.out.trim()), r.out.trim());
check("1b stderr empty on pass", r.err === "", r.err);

// ---- 2. each missing section ------------------------------------------------

const display = {
  conclusion: "Conclusion",
  findings: "Findings",
  verified: "Verified",
  notcovered: "Not covered",
  skipped: "Skipped",
};
const sectionName = {
  conclusion: "conclusion",
  findings: "findings",
  verified: "verified",
  notcovered: "notcovered",
  skipped: "skipped",
};
for (const key of ["conclusion", "findings", "verified", "notcovered", "skipped"]) {
  const file = write(`missing-${key}.md`, report({ [sectionName[key]]: "" }));
  r = run([file]);
  check(
    `2 missing '${display[key]}' fails with exit 1`,
    r.code === 1 && r.out.includes(`missing required section '${display[key]}'`),
    `code=${r.code} out=${r.out.slice(0, 120)}`
  );
  check(`2a missing '${key}' stderr has [GATE_VIOLATION]`, r.err.includes("[GATE_VIOLATION]"), r.err.slice(0, 80));
}

// ---- 3. skip disguised as not covered (Chinese) ------------------------------

const disguised = write(
  "disguised.md",
  report({ notcovered: "## Not covered\n- 嫌慢没跑 — 这条其实是跳过\n" })
);
r = run([disguised]);
check(
  "3 '嫌慢没跑' in Not covered is blocked (exit 1)",
  r.code === 1 && r.out.includes("this reads like a skipped check, not a blocked one"),
  `code=${r.code} out=${r.out.slice(0, 160)}`
);

const moved = write(
  "moved.md",
  report({ notcovered: "## Not covered\nnone\n", skipped: "## Skipped\n- 嫌慢没跑 — skipped: cost: 5 min\n" })
);
r = run([moved]);
check("3a same entry moved to Skipped passes", r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);

// English variant: decision dressed as block.
const engSkip = write(
  "eng-skip.md",
  report({ notcovered: "## Not covered\n- full crawl did not run because the budget ran out\n" })
);
r = run([engSkip]);
check(
  "3b English 'did not run … budget' in Not covered is blocked",
  r.code === 1 && r.out.includes("this reads like a skipped check, not a blocked one"),
  `code=${r.code} out=${r.out.slice(0, 160)}`
);

// ---- 4. anti-false-positive: relaying a third party's slowness ---------------

const thirdParty = write(
  "third-party-slow.md",
  report({ notcovered: "## Not covered\n- question Q — blocked: the vendor's staging site is slow and never answered\n" })
);
r = run([thirdParty]);
check("4 relaying third-party slowness (no abandon marker) passes", r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);

// Genuine block that merely mentions a timeout — must not be flagged.
const timeoutBlock = write(
  "timeout-block.md",
  report({ notcovered: "## Not covered\n- question Q — blocked: the API timed out, no data returned\n" })
);
r = run([timeoutBlock]);
check("4a genuine block mentioning 'timed out' passes", r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);

// Idiom guard: "did not run into …" is a block, not a skip.
const idiom = write(
  "idiom.md",
  report({ notcovered: "## Not covered\n- question Q — did not run into the vendor's rate limit; the site is slow anyway\n" })
);
r = run([idiom]);
check("4b 'did not run into …' idiom passes", r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);

// ---- 5. verified evidence markers -------------------------------------------

for (const [label, verifiedBody] of [
  ["URL", "- claim A — https://example.org/pricing"],
  ["file:line", "- claim B — src/router.ts:88"],
  ["command", "- claim C — `npm test`"],
  ["image path", "- page 1 — out/stills/page-1.png (visually inspected)"],
]) {
  const file = write(`ev-${label}.md`, report({ verified: `## Verified\n${verifiedBody}\n` }));
  r = run([file]);
  check(`5 ${label} marker accepted`, r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);
}

const noMarker = write(
  "ev-none.md",
  report({ verified: "## Verified\n- claim A — I ran it, trust me\n" })
);
r = run([noMarker]);
check(
  "5a verified bullet without marker is blocked",
  r.code === 1 && r.out.includes("verified item lacks an evidence marker"),
  `code=${r.code} out=${r.out.slice(0, 160)}`
);

// Explicit 'none' Verified is allowed with an INFO note.
const verifiedNone = write(
  "ev-none-explicit.md",
  report({ verified: "## Verified\nnone\n" })
);
r = run([verifiedNone]);
check("5b Verified 'none' passes with INFO", r.code === 0 && r.out.includes("INFO section 'Verified'"), r.out.slice(0, 160));

// ---- 6. Chinese heading aliases ----------------------------------------------

const chinese = write(
  "chinese.md",
  [
    "# Report: lane",
    "## 结论",
    "成立。",
    "## 发现",
    "- claim table",
    "## 已验证",
    "- claim — src/router.ts:88",
    "## 未覆盖",
    "none",
    "## 已跳过",
    "none",
    "",
  ].join("\n")
);
r = run([chinese]);
check("6 all-Chinese headings parse and pass", r.code === 0, `code=${r.code} out=${r.out.slice(0, 200)}`);

// English spelling variants of the same section.
for (const [label, heading] of [["not-covered", "not-covered"], ["notcovered", "notcovered"]]) {
  const file = write(`alias-${label}.md`, report({ notcovered: `## ${heading}\nnone\n` }));
  r = run([file]);
  check(`6a heading '${heading}' parses`, r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);
}

// ---- 7. empty sections --------------------------------------------------------

const emptySection = write(
  "empty.md",
  report({ notcovered: "## Not covered\n" })
);
r = run([emptySection]);
check(
  "7 empty section warns but exits 0",
  r.code === 0 && r.out.includes("WARN section 'Not covered'") && r.out.includes("is empty"),
  `code=${r.code} out=${r.out.slice(0, 200)}`
);
check("7a empty-section pass leaves stderr clean", r.err === "", r.err);

r = run([emptySection, "--strict"]);
check(
  "7b --strict turns the warning into an error (exit 1)",
  r.code === 1 && r.out.includes("ERROR section 'Not covered'"),
  `code=${r.code} out=${r.out.slice(0, 200)}`
);

const emptyVerified = write(
  "empty-verified.md",
  report({ verified: "## Verified\n" })
);
r = run([emptyVerified]);
check("7c empty Verified warns too", r.code === 0 && r.out.includes("WARN section 'Verified'"), r.out.slice(0, 200));

// ---- 8. file with no report sections at all ----------------------------------

const noSections = write("nosections.md", "# Report: nothing\n\njust prose, wrong file\n");
r = run([noSections]);
check(
  "8 no sections found fails with exit 1",
  r.code === 1 && r.out.includes("no report sections found"),
  `code=${r.code} out=${r.out.slice(0, 160)}`
);

// ---- 9. --json mode -----------------------------------------------------------

r = run([goodFile, "--json"]);
let j = null;
try {
  j = JSON.parse(r.out.trim());
} catch {}
check(
  "9 --json good report parses, ok=true",
  !!j && j.tool === "report-lint" && j.input === goodFile && j.ok === true && j.errors.length === 0 && j.warnings.length === 0 && j.summary.errors === 0 && j.summary.warnings === 0,
  r.out.slice(0, 200)
);

const missingFindings = write("missing-findings.md", report({ findings: "" }));
r = run([missingFindings, "--json"]);
j = null;
try {
  j = JSON.parse(r.out.trim());
} catch {}
check(
  "9a --json failing report: ok=false, errors populated with required fields",
  !!j &&
    j.ok === false &&
    j.errors.some((e) => e.message.includes("missing required section 'Findings'")) &&
    j.errors.every((e) => e.severity === "error" && typeof e.location === "string" && typeof e.message === "string" && typeof e.fix === "string") &&
    j.summary.errors >= 1 &&
    Array.isArray(j.warnings),
  r.out.slice(0, 240)
);
check("9b --json failing report stderr has [GATE_VIOLATION]", r.err.includes("[GATE_VIOLATION]"), r.err.slice(0, 80));

r = run([emptySection, "--json"]);
j = null;
try {
  j = JSON.parse(r.out.trim());
} catch {}
check(
  "9c --json warnings-only report: ok=true, 1 warning",
  !!j && j.ok === true && j.warnings.length === 1 && j.summary.warnings === 1 && j.summary.errors === 0,
  r.out.slice(0, 200)
);

// ---- 10. --help ---------------------------------------------------------------

for (const flag of ["--help", "-h"]) {
  r = run([flag]);
  check(
    `10 ${flag} shows usage, exit-code legend, anti-false-positive note`,
    r.code === 0 &&
      r.out.includes("Usage:") &&
      r.out.includes("Exit codes:") &&
      r.out.includes("0  pass") &&
      r.out.includes("1  gate violation") &&
      r.out.includes("2  cannot judge") &&
      r.out.includes("防误杀") &&
      /Examples:/.test(r.out) &&
      /node tools\/gates\/report-lint\.mjs reports\/lane1\.md/.test(r.out),
    `code=${r.code}`
  );
}

// ---- 11. CRLF tolerance --------------------------------------------------------

const crlfFile = write(
  "crlf.md",
  report({
    verified: [
      "## Verified",
      "- claim A — https://example.org/pricing",
      "- claim B — src/router.ts:88",
      "- claim C — `npm test` → exit 0",
      "",
    ].join("\r\n"),
  }).replace(/\r?\n/g, "\r\n")
);
r = run([crlfFile]);
check("11 CRLF report passes", r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);

// ---- 12. runtime errors (exit 2) ----------------------------------------------

r = run([]);
check("12 no argument exits 2 with [RUNTIME_ERROR]", r.code === 2 && r.err.includes("[RUNTIME_ERROR]") && r.err.includes("missing report path"), `code=${r.code} err=${r.err.slice(0, 120)}`);

r = run([path.join(tmp, "does-not-exist.md")]);
check("12a unreadable file exits 2 with [RUNTIME_ERROR]", r.code === 2 && r.err.includes("[RUNTIME_ERROR]") && r.err.includes("cannot read"), `code=${r.code} err=${r.err.slice(0, 120)}`);

r = run([goodFile, "--bogus"]);
check("12b unknown flag exits 2 with [RUNTIME_ERROR]", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), `code=${r.code}`);

// ---- cleanup --------------------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
