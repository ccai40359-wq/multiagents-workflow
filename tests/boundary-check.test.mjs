// Self-test for boundary-check.mjs: node tests/boundary-check.test.mjs (run from the repo root)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../tools/gates/boundary-check.mjs", import.meta.url));

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

function run(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    timeout: 30000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function git(dir, ...args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bnd-check-"));
const diffOk = path.join(tmpRoot, "diff-ok.txt");
const diffBad = path.join(tmpRoot, "diff-bad.txt");
const boundaryFile = path.join(tmpRoot, "boundary.txt");
const nogit = path.join(tmpRoot, "nogit");
const gitRepo = path.join(tmpRoot, "git");
fs.mkdirSync(nogit, { recursive: true });
fs.mkdirSync(gitRepo, { recursive: true });
fs.writeFileSync(diffOk, "src/a.js\n");
fs.writeFileSync(diffBad, "src/a.js\nnotes.md\n");
fs.writeFileSync(boundaryFile, "# demo boundary\nsrc/**\n\n# docs side\ndocs/**  \n");

git(gitRepo, "init", "-q");
git(gitRepo, "config", "user.name", "boundary-test");
git(gitRepo, "config", "user.email", "boundary-test@example.invalid");
fs.mkdirSync(path.join(gitRepo, "src"), { recursive: true });
fs.writeFileSync(path.join(gitRepo, "src", "base.js"), "v1\n");
git(gitRepo, "add", ".");
git(gitRepo, "commit", "-q", "-m", "base");

let r = run(["--help"]);
check(
  "1 help shows usage, exit-code legend, and an example",
  r.code === 0 &&
    r.out.includes("usage:") &&
    r.out.includes("exit codes") &&
    r.out.includes("0  pass") &&
    r.out.includes("1  violation") &&
    r.out.includes("2  cannot determine") &&
    r.out.includes("--git-base"),
  r.out.slice(0, 80)
);

r = run(["--boundary", "src/**,tests/**", "--files", "src/a.js,tests/b.test.mjs"]);
check("2 all changed files matched exit 0", r.code === 0 && r.out.includes("PASS: 4 check(s) ok") && !r.out.includes("WARN"), r.out);

r = run(["--boundary", "src/**", "--files", "src/a.js,README.md"]);
check(
  "3 out-of-boundary file exit 1 and listed",
  r.code === 1 && r.out.includes("ERROR README.md") && r.out.includes("FAIL: 1 error(s), 0 warning(s)") && r.err.includes("[GATE_VIOLATION]"),
  r.out
);

r = run(["--boundary", "src/**", "--files", "src/a.js,src/a/b/c.js"]);
check("4 src/** matches nested paths", r.code === 0, r.out);

r = run(["--boundary", "src/core/app.js", "--files", "src/core/app.js"]);
check("5 literal pattern matches the exact path", r.code === 0 && r.out.includes("PASS: 2 check(s) ok"), r.out);

r = run(["--boundary", "src/core/app.js", "--files", "src/core/app.js,src/core/app.js/helper.js"]);
check("6 literal pattern does not match subpaths", r.code === 1 && r.out.includes("ERROR src/core/app.js/helper.js"), r.out);

r = run(["--boundary", "*.md", "--files", "README.md,docs/x.md"]);
check("7 *.md stays at the root (nested file flagged)", r.code === 1 && r.out.includes("ERROR docs/x.md"), r.out);

r = run(["--boundary", "*.md", "--files", "README.md"]);
check("8 *.md root file passes", r.code === 0, r.out);

r = run(["--boundary", "**", "--files", "x/y/z.js"]);
check("9 bare ** matches any depth", r.code === 0, r.out);

r = run(["--boundary", "src/**", "--files", "src/a.js\nsrc/b.js"]);
check("10 newline-separated --files list works", r.code === 0 && r.out.includes("PASS: 3 check(s) ok"), r.out);

r = run(["--boundary", "src/**", "--diff-file", diffOk]);
check("11 --diff-file source passes", r.code === 0 && r.out.includes("PASS: 2 check(s) ok"), r.out);

r = run(["--boundary", "src/**", "--diff-file", diffBad]);
check("12 --diff-file source flags the outsider", r.code === 1 && r.out.includes("ERROR notes.md"), r.out);

r = run(["--boundary", boundaryFile, "--files", "src/a.js,docs/b.md"]);
check("13 boundary from a text file with # comments", r.code === 0 && !r.out.includes("WARN"), r.out);

r = run(["--boundary", "src/**", "--files", "src\\core\\app.js"]);
check("14 windows backslash path matches src/**", r.code === 0, r.out);

r = run(["--boundary", "src/**", "--files", ""]);
check(
  "15 empty changed list exit 0 with INFO",
  r.code === 0 && r.out.includes("INFO -: no changed files") && r.out.includes("PASS: 1 check(s) ok"),
  r.out
);

r = run(["--boundary", "src/**"]);
check("16 missing changed-file source exit 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]") && r.out === "", r.err);

r = run(["--files", "src/a.js"]);
check("17 missing --boundary exit 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), r.err);

r = run(["--boundary", "src/**", "--files", "src/a.js", "--diff-file", diffOk]);
check("18 multiple changed-file sources exit 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), r.err);

r = run(["--boundary", "src/**", "--diff-file", path.join(tmpRoot, "nope.txt")]);
check("19 unreadable diff file exit 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), r.err);

r = run(["--boundary", "src/**", "--files", "src/a.js,README.md", "--json"]);
let j = null;
try { j = JSON.parse(r.out); } catch {}
check(
  "20 --json violation object parses",
  r.code === 1 &&
    j &&
    j.tool === "boundary-check" &&
    j.ok === false &&
    j.errors.length === 1 &&
    j.errors[0].severity === "error" &&
    j.errors[0].location === "README.md" &&
    j.summary.errors === 1 &&
    r.err.includes("[GATE_VIOLATION]"),
  r.out.slice(0, 80)
);

r = run(["--boundary", "src/**", "--files", "src/a.js", "--json"]);
j = null;
try { j = JSON.parse(r.out); } catch {}
check(
  "21 --json pass object parses",
  r.code === 0 &&
    j &&
    j.ok === true &&
    j.errors.length === 0 &&
    j.warnings.length === 0 &&
    j.summary.errors === 0 &&
    j.input.includes("1 boundary pattern(s), 1 changed file(s)"),
  r.out.slice(0, 80)
);

r = run(["--files", "src/a.js", "--json"]);
j = null;
try { j = JSON.parse(r.out); } catch {}
check(
  "22 --json runtime error object parses",
  r.code === 2 &&
    j &&
    j.ok === false &&
    j.errors.length === 1 &&
    j.errors[0].severity === "error" &&
    j.summary.errors === 1 &&
    r.err.includes("[RUNTIME_ERROR]"),
  r.out.slice(0, 80)
);

r = run(["--boundary", "src/**,docs/**", "--files", "src/a.js"]);
check(
  "23 unused declared pattern warns but passes",
  r.code === 0 && r.out.includes("WARN docs/**") && r.out.includes("matched no changed file") && r.out.includes("PASS: 3 check(s) ok"),
  r.out
);

fs.writeFileSync(path.join(gitRepo, "src", "base.js"), "v2\n");
r = run(["--boundary", "src/**", "--git-base", "HEAD"], gitRepo);
check("24 --git-base in-boundary change passes", r.code === 0, r.out);

fs.writeFileSync(path.join(gitRepo, "notes.md"), "oops\n");
git(gitRepo, "add", ".");
r = run(["--boundary", "src/**", "--git-base", "HEAD"], gitRepo);
check("25 --git-base flags the out-of-boundary file", r.code === 1 && r.out.includes("ERROR notes.md") && r.out.includes("FAIL: 1 error(s), 0 warning(s)"), r.out);

r = run(["--boundary", "src/**", "--git-base", "HEAD"], nogit);
check("26 git failure exit 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), r.err);

r = run(["--boundary", "src/**", "--files", "src/a.js"], nogit);
check("27 --files still works without a git repo", r.code === 0, r.out);

// v0.2.1 regression: --strict promotes the unused-pattern warning to a violation
r = run(["--boundary", "src/**,docs/**", "--files", "src/a.js", "--strict"]);
check(
  "28 --strict promotes unused-pattern warning to exit 1",
  r.code === 1 && r.out.includes("ERROR docs/**") && r.out.includes("FAIL: 1 error(s), 0 warning(s)"),
  r.out
);
r = run(["--boundary", "src/**,docs/**", "--files", "src/a.js", "--strict", "--json"]);
let jsonStrict = JSON.parse(r.out);
check(
  "29 --strict in json mode reports the promoted error",
  r.code === 1 && jsonStrict.summary.errors === 1 && jsonStrict.errors[0].location === "docs/**",
  r.out.slice(0, 120)
);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
