// Self-test for tools/ledger/dispatch-ledger.mjs: node tests/dispatch-ledger.test.mjs (run from the repo root)
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../tools/ledger/dispatch-ledger.mjs", import.meta.url));
const STATUSES = ["dispatched", "succeeded", "failed-transport", "failed-protocol", "failed-definition", "verified", "completed", "voided"];
const tmpDirs = [];

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
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  tmpDirs.push(dir);
  return dir;
}
const ledger = (dir) => path.join(dir, ".dispatch", "ledger.jsonl");
function nonEmptyLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
}
const lastLine = (file) => JSON.parse(nonEmptyLines(file).pop());
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const validISO = (s) => new Date(s).toISOString() === s;

// 1. append 字段齐全、sha256 与手工一致、seq 递增、ts 合法 ISO、整个文件是合法 JSONL
{
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "brief.md"), "brief content\nsecond line\n");
  fs.writeFileSync(path.join(dir, "params.json"), '{"lanes":["web"]}\n');
  const r = run(
    ["append", "--task-id", "t-01", "--lane", "web-research", "--model", "sonnet",
     "--brief-file", path.join(dir, "brief.md"), "--params-file", path.join(dir, "params.json"),
     "--output-file", path.join(dir, "out.log"), "--note", "kickoff"],
    dir
  );
  check("1.0 append exits 0", r.code === 0, `code=${r.code} err=${r.err}`);
  const rec = lastLine(ledger(dir));
  check("1.1 append fields present",
    rec.event === "append" && rec.task_id === "t-01" && rec.lane === "web-research" &&
    rec.model === "sonnet" && rec.status === "dispatched" && rec.note === "kickoff" &&
    rec.output_path === path.join(dir, "out.log"),
    JSON.stringify(rec));
  check("1.2 hashes match manual sha256",
    rec.brief_sha256 === sha(path.join(dir, "brief.md")) && rec.params_sha256 === sha(path.join(dir, "params.json")),
    `${rec.brief_sha256} vs ${sha(path.join(dir, "brief.md"))}`);
  check("1.3 seq starts at 1", rec.seq === 1, String(rec.seq));
  check("1.4 ts is valid ISO", validISO(rec.ts), rec.ts);
  const r2 = run(["append", "--task-id", "t-02", "--lane", "web", "--model", "sonnet"], dir);
  check("1.5 seq increments", r2.code === 0 && lastLine(ledger(dir)).seq === 2, `code=${r2.code}`);
  const lines = nonEmptyLines(ledger(dir));
  const parseOk = lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  check("1.6 whole file is valid JSONL, exactly two events", lines.length === 2 && parseOk, lines.length + " lines");
}

// 2. 重复 append：exit 0 + WARN，两条事件都完整
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "sonnet"], dir);
  const r = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "sonnet", "--note", "retry"], dir);
  check("2.0 dup append still exits 0", r.code === 0, `code=${r.code} err=${r.err}`);
  check("2.1 dup WARN present", /WARN .*already has an append event/.test(r.out), r.out);
  const recs = nonEmptyLines(ledger(dir)).map((l) => JSON.parse(l));
  check("2.2 both append events intact",
    recs.length === 2 && recs.every((x) => x.event === "append" && x.task_id === "t-01") && recs[0].seq === 1 && recs[1].seq === 2,
    recs.length + " lines");
}

// 3. 上一行末尾无换行符时，追加先补 \n，不拆坏上一条
{
  const dir = mkTmp();
  const p = ledger(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const first = JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00.000Z", event: "append", task_id: "prev", lane: "web", model: "m", brief_sha256: null, params_sha256: null, output_path: null, status: "dispatched", note: null });
  fs.writeFileSync(p, first); // 无尾部换行
  run(["append", "--task-id", "t-02", "--lane", "web", "--model", "m"], dir);
  const lines = nonEmptyLines(p);
  const parseOk = lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  const recs = lines.map((l) => JSON.parse(l));
  check("3.0 both lines parse after newline repair", lines.length === 2 && parseOk, lines.join(" | "));
  check("3.1 original line preserved, new event appended", recs[0].task_id === "prev" && recs[1].task_id === "t-02" && recs[1].seq === 2, lines.join(" | "));
}

// 4. mark 八个合法状态都接受
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  let allOk = true,
    bad = [];
  for (const s of STATUSES) {
    const r = run(["mark", "--task-id", "t-01", "--status", s], dir);
    if (r.code !== 0) { allOk = false; bad.push(s + ":" + r.code); }
  }
  check("4.0 all 8 mark statuses exit 0", allOk, bad.join(","));
  const recs = nonEmptyLines(ledger(dir)).map((l) => JSON.parse(l));
  check("4.1 mark events recorded in order",
    recs.length === 9 && recs.slice(1).every((x, i) => x.event === "mark" && x.status === STATUSES[i] && x.note === null),
    recs.length + " lines");
}

// 5. 非法状态 exit 2，且列出合法枚举
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  const r = run(["mark", "--task-id", "t-01", "--status", "bogus"], dir);
  check("5.0 invalid status exits 2", r.code === 2, `code=${r.code}`);
  check("5.1 error lists prefix + valid enum",
    r.err.includes("[RUNTIME_ERROR]") && r.err.includes("invalid status") &&
    r.err.includes("dispatched") && r.err.includes("failed-definition"),
    r.err);
}

// 6. 未知 task-id exit 2
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  const r = run(["mark", "--task-id", "nope", "--status", "verified"], dir);
  check("6.0 unknown task-id exits 2", r.code === 2 && r.err.includes("unknown task-id 'nope'"), `code=${r.code} err=${r.err}`);
}

// 7. status 识别 open 项（含三种 failed 提示文案），有 open 时仍是 exit 0
{
  const dir = mkTmp();
  for (const id of ["t-01", "t-02", "t-03", "t-04"]) {
    run(["append", "--task-id", id, "--lane", "research", "--model", "m"], dir);
  }
  run(["mark", "--task-id", "t-01", "--status", "verified"], dir);
  run(["mark", "--task-id", "t-02", "--status", "failed-protocol"], dir);
  run(["mark", "--task-id", "t-03", "--status", "failed-definition"], dir);
  run(["mark", "--task-id", "t-04", "--status", "failed-transport"], dir);
  const r = run(["status"], dir);
  check("7.0 status exits 0 with open tasks", r.code === 0, `code=${r.code}`);
  check("7.1 open items listed, closed task not in open list",
    r.out.includes("t-02") && r.out.includes("t-03") && r.out.includes("t-04") && !r.out.includes("status=verified"),
    r.out);
  check("7.2 protocol hint present", r.out.includes("re-dispatch once with narrowed scope"), r.out);
  check("7.3 definition hint present", r.out.includes("do NOT re-dispatch; void downstream and open a new lane"), r.out);
  check("7.4 transport hint present", r.out.includes("host/provider layer — wait and retry via host, do not burn a protocol retry"), r.out);
  check("7.5 not all verified yet", !r.out.includes("all tasks verified"), r.out);
  const j = JSON.parse(run(["status", "--json"], dir).out);
  check("7.6 json counts latest statuses",
    j.statuses.verified === 1 && j.statuses["failed-protocol"] === 1 && j.statuses["failed-definition"] === 1 && j.statuses["failed-transport"] === 1,
    JSON.stringify(j.statuses));
  check("7.7 json open has hint field",
    j.open.length === 3 && j.open.some((o) => o.hint && o.hint.includes("narrowed scope")),
    JSON.stringify(j.open));
}

// 8. 全部关闭后输出 all tasks verified
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  run(["mark", "--task-id", "t-01", "--status", "verified"], dir);
  run(["append", "--task-id", "t-02", "--lane", "web", "--model", "m"], dir);
  run(["mark", "--task-id", "t-02", "--status", "voided"], dir);
  const r = run(["status"], dir);
  check("8.0 all closed prints all tasks verified", r.code === 0 && r.out.includes("all tasks verified"), r.out);
  const j = JSON.parse(run(["status", "--json"], dir).out);
  check("8.1 json all_verified true, no open", j.all_verified === true && j.open.length === 0, JSON.stringify(j));
}

// 9. 损坏行：stderr WARN、不崩溃、summary 报 corrupt_lines；全损坏账本仍 exit 0
{
  const dir = mkTmp();
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  fs.appendFileSync(ledger(dir), "this is not json\n");
  const r = run(["status"], dir);
  check("9.0 status survives corrupt line", r.code === 0, `code=${r.code} err=${r.err}`);
  check("9.1 corrupt WARN on stderr", /WARN ledger:2:/.test(r.err) && r.err.includes("corrupt"), r.err);
  check("9.2 summary reports corrupt_lines", r.out.includes("corrupt_lines=1"), r.out);
  const j = JSON.parse(run(["status", "--json"], dir).out);
  check("9.3 json corrupt_lines=1, open kept", j.corrupt_lines === 1 && j.open.length === 1 && j.open[0].task_id === "t-01", JSON.stringify(j));
}
{
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, ".dispatch"), { recursive: true });
  fs.writeFileSync(ledger(dir), "garbage1\ngarbage2\n", "utf8");
  const r = run(["status"], dir);
  check("9.4 all-corrupt ledger exits 0 and counts corrupt_lines=2", r.code === 0 && r.out.includes("corrupt_lines=2"), r.out);
}

// 10. 首次使用自动建 .dispatch/ + .gitignore("*\n")，不动目录内其他文件；已有 .gitignore 不改写
{
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, ".dispatch"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".dispatch", "keep.txt"), "KEEP", "utf8");
  const r = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir);
  check("10.0 first append ok", r.code === 0, `code=${r.code}`);
  check("10.1 gitignore written as *", fs.readFileSync(path.join(dir, ".dispatch", ".gitignore"), "utf8") === "*\n");
  check("10.2 other files untouched", fs.readFileSync(path.join(dir, ".dispatch", "keep.txt"), "utf8") === "KEEP");

  const dir2 = mkTmp();
  fs.mkdirSync(path.join(dir2, ".dispatch"), { recursive: true });
  fs.writeFileSync(path.join(dir2, ".dispatch", ".gitignore"), "# custom\n", "utf8");
  run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m"], dir2);
  check("10.3 existing gitignore not overwritten", fs.readFileSync(path.join(dir2, ".dispatch", ".gitignore"), "utf8") === "# custom\n");
}

// 11. --json：stdout 恰好一个 JSON 对象，诊断走 stderr
{
  const dir = mkTmp();
  const ra = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m", "--json"], dir);
  const a = JSON.parse(ra.out);
  check("11.0 append --json parses, stdout only one object",
    a.event === "append" && a.task_id === "t-01" && ra.out.split(/\r?\n/).filter((l) => l.trim()).length === 1,
    ra.out);
  const rd = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m", "--note", "again", "--json"], dir);
  JSON.parse(rd.out);
  check("11.1 dup append --json: stdout clean JSON, WARN on stderr",
    rd.err.includes("already has an append event") && !rd.out.includes("WARN"),
    rd.out + " | " + rd.err);
  const rb = run(["mark", "--task-id", "t-01", "--status", "verified", "--json"], dir);
  const b = JSON.parse(rb.out);
  check("11.2 mark --json parses", b.event === "mark" && b.status === "verified", rb.out);
  const rs = run(["status", "--json"], dir);
  const s = JSON.parse(rs.out);
  check("11.3 status --json parses and counts latest status", s.statuses.verified === 1, rs.out);
}

// 12. --help 含用法、退出码图例、状态枚举、示例
{
  const r = run(["--help"], process.cwd());
  check("12.0 --help exits 0", r.code === 0, `code=${r.code}`);
  check("12.1 help has usage and subcommands", r.out.includes("Usage:") && r.out.includes("append") && r.out.includes("mark") && r.out.includes("status"));
  check("12.2 help has exit-code legend 0/1/2", r.out.includes("0  success") && r.out.includes("1  ledger content") && r.out.includes("2  cannot decide"), r.out);
  check("12.3 help has status enum", r.out.includes("failed-transport") && r.out.includes("failed-definition") && r.out.includes("dispatched"));
  check("12.4 help has example", r.out.includes("Examples:") && r.out.includes("--task-id t-01"));
  const rh = run(["-h"], process.cwd());
  check("12.5 -h also prints help", rh.code === 0 && rh.out.includes("Usage:"));
}

// 13. 缺参数 / 未知子命令 exit 2
{
  const dir = mkTmp();
  let r = run(["append"], dir);
  check("13.0 append no args exits 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), `code=${r.code}`);
  r = run(["append", "--task-id", "t01"], dir);
  check("13.1 append missing lane exits 2", r.code === 2 && r.err.includes("--lane"), `code=${r.code}`);
  r = run(["mark", "--task-id", "t01"], dir);
  check("13.2 mark missing status exits 2", r.code === 2 && r.err.includes("--status"), `code=${r.code}`);
  r = run([]);
  check("13.3 no subcommand exits 2", r.code === 2 && r.err.includes("missing subcommand"), `code=${r.code}`);
  r = run(["frob"]);
  check("13.4 unknown subcommand exits 2", r.code === 2 && r.err.includes("unknown subcommand"), `code=${r.code}`);
}

// 14. append 的 --status 约束与文件必须存在
{
  const dir = mkTmp();
  let r = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m", "--status", "dispatched"], dir);
  check("14.0 explicit --status dispatched accepted", r.code === 0, `code=${r.code}`);
  r = run(["append", "--task-id", "t-02", "--lane", "web", "--model", "m", "--status", "verified"], dir);
  check("14.1 append --status non-dispatched exits 2", r.code === 2 && r.err.includes("[RUNTIME_ERROR]"), `code=${r.code}`);
  r = run(["append", "--task-id", "t-03", "--lane", "web", "--model", "m", "--brief-file", path.join(dir, "missing.txt")], dir);
  check("14.2 missing brief-file exits 2", r.code === 2 && r.err.includes("file not found"), `code=${r.code}`);
}

// 15. --ledger 覆盖：自定义路径、gitignore 放账本所在目录、status/mark 走同一账本；默认账本不受影响
{
  const dir = mkTmp();
  const over = path.join(dir, "custom", "ledger.jsonl");
  const r = run(["append", "--task-id", "t-01", "--lane", "web", "--model", "m", "--ledger", over], dir);
  check("15.0 --ledger override writes custom file", r.code === 0 && fs.existsSync(over), `code=${r.code}`);
  check("15.1 gitignore next to custom ledger", fs.readFileSync(path.join(dir, "custom", ".gitignore"), "utf8") === "*\n");
  const j = JSON.parse(run(["status", "--ledger", over, "--json"], dir).out);
  check("15.2 status --ledger reads custom ledger", j.total === 1 && j.open.length === 1 && j.open[0].task_id === "t-01", JSON.stringify(j));
  const rm = run(["mark", "--task-id", "nope", "--status", "verified", "--ledger", over], dir);
  check("15.3 mark --ledger unknown id exits 2", rm.code === 2 && rm.err.includes("unknown task-id 'nope'"), `code=${rm.code}`);
  const rs = run(["status", "--json"], dir);
  check("15.4 default ledger untouched by override runs", rs.code === 2 && rs.err.includes("ledger not found"), `code=${rs.code} err=${rs.err}`);
}

// 16. 账本不存在：status exit 2，mark 视为 unknown task-id
{
  const dir = mkTmp();
  const r = run(["status"], dir);
  check("16.0 status on missing ledger exits 2", r.code === 2 && r.err.includes("ledger not found"), r.err);
  const m = run(["mark", "--task-id", "x", "--status", "verified"], dir);
  check("16.1 mark on missing ledger = unknown task-id exit 2", m.code === 2 && m.err.includes("unknown task-id 'x'"), m.err);
}

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
