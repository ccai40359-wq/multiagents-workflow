// Self-test for claims-lint.mjs: node tests/claims-lint.test.mjs (run from the repo root)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../tools/gates/claims-lint.mjs", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../examples/claims-table-sample.md", import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claims-lint-test-"));

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

let seq = 0;
function tmp(content) {
  const p = path.join(DIR, `case-${seq++}.md`);
  fs.writeFileSync(p, content);
  return p;
}
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const TABLE = ["| Assertion | Source | Date | P/S | Counter-evidence |", "|---|---|---|---|---|"].join("\n");
const t = (...rows) => TABLE + (rows.length ? "\n" + rows.map((s) => "| " + s + " |").join("\n") : "") + "\n";

// --- sample file (hard self-check: default mode must pass) -----------------
let r = run([SAMPLE]);
check("1 sample passes by default", r.code === 0 && /PASS: \d+ check\(s\) ok/.test(r.out), `code=${r.code} out=${r.out.slice(0, 120)}`);
check("2 sample lists warnings", /WARN line \d/.test(r.out) && r.out.includes("secondary-only claim"), r.out.slice(0, 200));

r = run([SAMPLE, "--strict"]);
check("3 --strict turns sample warnings into failure", r.code === 1 && r.out.includes("FAIL:"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([SAMPLE, "--json"]);
let j = null;
try { j = JSON.parse(r.out); } catch {}
check("4 sample --json parses as one JSON object", !!j, r.out.slice(0, 120));
check(
  "5 sample --json structure conforms",
  !!j && j.tool === "claims-lint" && j.input === SAMPLE && j.ok === true &&
    Array.isArray(j.errors) && j.errors.length === 0 &&
    Array.isArray(j.warnings) && j.warnings.length >= 1 &&
    j.warnings[0].severity === "warn" && /^line \d+$/.test(j.warnings[0].location) &&
    typeof j.warnings[0].message === "string" && typeof j.warnings[0].fix === "string" &&
    j.summary.errors === 0 && j.summary.warnings === j.warnings.length,
  JSON.stringify(j).slice(0, 300)
);

// --- E1..E7 violations (one per file, exit 1) ------------------------------
r = run([tmp(t("Some claim | | 2026-09-01 | primary (official) | none found"))]);
check("6 E1 no source url fails", r.code === 1 && r.out.includes("assertion has no source URL"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([tmp(t("Some claim | http://127.0.0.1/a | 2026-09-01 | primary (official) | none found"))]);
check("7 E2 private url fails", r.code === 1 && r.out.includes("not a publicly fetchable URL"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([tmp(t("Some claim | https://example.org/a | Sep 2026 | primary (official) | none found"))]);
check("8 E3 malformed date fails", r.code === 1 && r.out.includes("missing or malformed date"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([tmp(t("Some claim | https://example.org/a | 2026-09-01 | tertiary (blog) | none found"))]);
check("9 E4 bad marker fails", r.code === 1 && r.out.includes("missing primary/secondary evidence marker"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([tmp(t("Some claim | https://example.org/a | 2026-09-01 | primary (official) | "))]);
check("10 E5 empty counter-evidence fails", r.code === 1 && r.out.includes("empty counter-evidence column"), `code=${r.code} out=${r.out.slice(0, 120)}`);

r = run([tmp(t("Some claim | https://example.org/a | 2026-09-01 | primary (official) | conflicting result from another lane"))]);
check("11 E6 conflict without arbitration section fails", r.code === 1 && r.out.includes("conflict marked in table but no not-found/arbitration section below"), `code=${r.code} out=${r.out.slice(0, 200)}`);

r = run([tmp(TABLE + "\n")]);
check("12 E7 empty table fails", r.code === 1 && r.out.includes("claims table is empty"), `code=${r.code} out=${r.out.slice(0, 200)}`);

r = run([tmp("| Name | Age |\n|---|---|\n| Alice | 30 |\n")]);
check("13 no claims table fails", r.code === 1 && r.out.includes("no claims table found"), `code=${r.code} out=${r.out.slice(0, 200)}`);

// --- URL safety via the gate -------------------------------------------------
const bad = tmp(t(
  "A | http://localhost/a | 2026-09-01 | primary | none found",
  "B | http://127.0.0.1/b | 2026-09-01 | primary | none found",
  "C | http://192.168.1.1/c | 2026-09-01 | primary | none found",
  "D | file:///etc/passwd | 2026-09-01 | primary | none found"
));
r = run([bad, "--as-of", "2026-09-26"]);
check("14 url-guard blocks loopback/private/file urls", r.code === 1 && ["localhost", "127.0.0.1", "192.168.1.1", "file:"].every((s) => r.out.includes(s)), r.out.slice(0, 300));

// --- --as-of drives the staleness WARN -------------------------------------
const old = tmp(t("Old claim | https://example.org/a | 2025-11-02 | primary (official) | none found"));
r = run([old, "--as-of", "2026-09-26"]);
check("15 stale WARN fires with far as-of", r.code === 0 && r.out.includes("evidence may be stale"), r.out.slice(0, 200));
r = run([old, "--as-of", "2025-11-10"]);
check("16 no stale WARN with near as-of", r.code === 0 && !r.out.includes("evidence may be stale"), r.out.slice(0, 200));

// --- --strict upgrades WARN to ERROR ---------------------------------------
const sec = tmp(t("Some claim | https://example.org/a | 2026-09-01 | secondary (blog) | none found"));
r = run([sec, "--as-of", "2026-09-26"]);
check("17 secondary-only warns by default", r.code === 0 && r.out.includes("WARN line 3: secondary-only claim"), r.out.slice(0, 200));
r = run([sec, "--strict", "--as-of", "2026-09-26"]);
check("18 --strict upgrades warn to error", r.code === 1 && r.out.includes("ERROR line 3: secondary-only claim"), r.out.slice(0, 200));

// --- --json on an error run -------------------------------------------------
const e1 = tmp(t("Some claim | | 2026-09-01 | primary (official) | none found"));
r = run([e1, "--json"]);
j = null;
try { j = JSON.parse(r.out); } catch {}
check("19 error --json parses", !!j && j.ok === false, r.out.slice(0, 120));
check(
  "20 error --json structure",
  !!j && j.errors.length === 1 && j.errors[0].severity === "error" && j.errors[0].location === "line 3" &&
    j.errors[0].message.includes("no source URL") && j.errors[0].fix.length > 0 &&
    Array.isArray(j.warnings) && j.warnings.length === 0 && j.summary.errors === 1 && j.summary.warnings === 0,
  JSON.stringify(j).slice(0, 300)
);
check("21 error --json stderr carries GATE_VIOLATION prefix", r.err.includes("[GATE_VIOLATION]"), r.err.slice(0, 120));

// --- runtime errors ----------------------------------------------------------
r = run([path.join(DIR, "nope.md")]);
check("22 missing file is runtime error (exit 2)", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), `code=${r.code} err=${r.err.slice(0, 120)}`);
r = run([]);
check("23 missing argument is runtime error (exit 2)", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), `code=${r.code} err=${r.err.slice(0, 120)}`);

// --- help ---------------------------------------------------------------------
r = run(["--help"]);
check("24 --help shows usage, exit-code legend and example", r.code === 0 && r.out.includes("exit codes:") && r.out.includes("0 = pass") && r.out.includes("1 = gate violation") && r.out.includes("2 = runtime error") && r.out.includes("claims-lint.mjs"), r.out.slice(0, 300));

// --- CRLF vs LF ----------------------------------------------------------------
const lfContent = t("Some claim | https://example.org/a | Sep 2026 | primary (official) | none found");
const lfp = tmp(lfContent);
const crlfp = tmp(lfContent.replace(/\n/g, "\r\n"));
const a = run([lfp, "--as-of", "2026-09-26"]);
const b = run([crlfp, "--as-of", "2026-09-26"]);
check("25 CRLF file gives identical result to LF file", a.code === 1 && b.code === 1 && a.out === b.out, `a=${a.out.slice(0, 120)} b=${b.out.slice(0, 120)}`);

// --- escaped pipe is not a column split ---------------------------------------
const esc = tmp(t("R\\&D funding rose \\| despite layoffs | https://example.org/a | 2026-09-01 | primary (official) | none found"));
r = run([esc, "--as-of", "2026-09-26"]);
check("26 escaped \\| cell is not misreported", r.code === 0, `code=${r.code} out=${r.out.slice(0, 150)}`);

// --- markdown link form URL is extracted ---------------------------------------
const linkform = tmp(t("Some claim | [official page](https://example.org/widgetdb/pricing) | 2026-09-01 | primary | none found"));
r = run([linkform, "--as-of", "2026-09-26"]);
check("27 markdown link target used as source URL", r.code === 0, `code=${r.code} out=${r.out.slice(0, 150)}`);

// --- empty table with explicit none-found statement is allowed ----------------
const emptyPass = tmp(TABLE + "\n\nSearched all lanes: no results found, none found.\n");
r = run([emptyPass]);
check("28 empty table with explicit none-found passes", r.code === 0 && r.out.includes("PASS"), `code=${r.code} out=${r.out.slice(0, 200)}`);

// --- v0.2.1 regression: bilingual headers and 一手/二手 markers ----------------
// SKILL.zh.md's dispatch template ships this exact header — the gate must accept it.
const ZH_TABLE = ["| 断言 | 来源URL | 日期 | 一手/二手 | 有无反证 |", "|---|---|---|---|---|"].join("\n");
const zhPass = tmp(
  ZH_TABLE +
    "\n| 某组件免费额度为 5GB | https://example.org/widgetdb/pricing | 2026-09-10 | 一手（官方定价页） | 未发现反证 |\n" +
    "| 某组件宣布缩减免费额度 | https://example.net/community/thread/12345 | 2026-09-20 | 二手（社区帖） | 待一手复核 |\n"
);
r = run([zhPass, "--as-of", "2026-09-26"]);
check("29 Chinese claims table (SKILL.zh.md header) passes", r.code === 0 && r.out.includes("PASS"), `code=${r.code} out=${r.out.slice(0, 200)}`);

const zhMissingPs = tmp(ZH_TABLE + "\n| 某断言 | https://example.org/a | 2026-09-10 | 可信（官方） | 未发现反证 |\n");
r = run([zhMissingPs, "--as-of", "2026-09-26"]);
check("30 Chinese row without 一手/二手 marker fails", r.code === 1 && r.out.includes("missing primary/secondary"), `code=${r.code} out=${r.out.slice(0, 200)}`);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);