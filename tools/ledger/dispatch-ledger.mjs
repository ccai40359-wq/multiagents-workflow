#!/usr/bin/env node
// tools/ledger/dispatch-ledger.mjs — append-only JSONL 派发留痕账本。
// 与 skills/dev-delivery/SKILL.md §8 的 .dispatch/ 约定共存：
//   首用自动建目录；.gitignore 不存在则写 "*"（`*\n`），已存在绝不改写；目录内其他文件一律不碰。
// 写入纪律：严格 'a' 追加，禁止整文件读改写；若末字节非 \n 先补一个再写，防拆坏上一条 JSON。
// 故障三分类（mark --status）：failed-transport=宿主/供应商层，failed-protocol=输出不成形/越界/无证据，
//   failed-definition=lane 本身派错。status 只汇报不做门禁——存在 open 任务时退出码仍为 0。
// 退出码 1 为保留位（账本内容揭示违规状态），当前没有任何子命令 emit；帮助里照实列出。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_LEDGER = path.join(process.cwd(), ".dispatch", "ledger.jsonl");
const MARK_STATUSES = [
  "dispatched",
  "succeeded",
  "failed-transport",
  "failed-protocol",
  "failed-definition",
  "verified",
  "completed",
  "voided",
];
const CLOSED = new Set(["verified", "completed", "voided"]);
const FAILED_HINTS = {
  "failed-transport": "host/provider layer — wait and retry via host, do not burn a protocol retry",
  "failed-protocol": "re-dispatch once with narrowed scope",
  "failed-definition": "do NOT re-dispatch; void downstream and open a new lane",
};

function usage() {
  return `dispatch-ledger — append-only JSONL ledger for agent dispatch tracking

Usage:
  node tools/ledger/dispatch-ledger.mjs <subcommand> [flags]

Subcommands:
  append --task-id <id> --lane <name> --model <model> [--brief-file <p>] [--params-file <p>]
         [--output-file <p>] [--note <text>] [--status dispatched] [--json]
  mark   --task-id <id> --status <s> [--note <text>] [--json]
  status [--json]
  -h, --help  show this help

Common flags:
  --ledger <path>  ledger file (default: <cwd>/.dispatch/ledger.jsonl)
  --json           stdout emits exactly one JSON object; diagnostics go to stderr

Status enum (mark --status, and status output):
  dispatched | succeeded | failed-transport | failed-protocol | failed-definition | verified | completed | voided
  open (not yet closed) = current status not in {verified, completed, voided}

Exit codes:
  0  success
  1  ledger content reveals a violation (reserved — no subcommand emits it today; status is report-only)
  2  cannot decide: missing args, missing file, internal error (stderr prefixed "[RUNTIME_ERROR]")

Examples:
  node tools/ledger/dispatch-ledger.mjs append --task-id t-01 --lane web-research --model sonnet --brief-file brief.md
  node tools/ledger/dispatch-ledger.mjs mark --task-id t-01 --status failed-definition --note "lane was wrong scope"
  node tools/ledger/dispatch-ledger.mjs status
  node tools/ledger/dispatch-ledger.mjs status --json
`;
}

function exit2(msg) {
  process.stderr.write("[RUNTIME_ERROR] " + msg + "\n");
  return 2;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--json") {
      flags.json = true;
      continue;
    }
    if (tok === "-h" || tok === "--help") {
      flags.help = true;
      continue;
    }
    if (!tok.startsWith("--")) {
      flags.__error = `unexpected argument '${tok}'`;
      return flags;
    }
    let name, val;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      name = tok.slice(2, eq);
      val = tok.slice(eq + 1);
    } else {
      name = tok.slice(2);
      val = argv[i + 1];
      if (val === undefined) {
        flags.__error = `missing value for '--${name}'`;
        return flags;
      }
      i++;
    }
    // CLI 参数名用连字符（--task-id），记录对象字段用下划线（task_id），在此归一化
    flags[name.replace(/-/g, "_")] = val;
  }
  return flags;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ensureGitignore(dir) {
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
}

// 只读解析：空行静默跳过；不可解析或字段不齐（非 append/mark 事件、缺 task_id/seq/status）计入损坏行并告警。
function loadLedger(ledgerPath, onWarn) {
  let content;
  try {
    content = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return { exists: false, records: [], corrupt: 0 };
  }
  const records = [];
  let corrupt = 0;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {}
    if (
      !rec ||
      typeof rec !== "object" ||
      typeof rec.event !== "string" ||
      (rec.event !== "append" && rec.event !== "mark") ||
      typeof rec.task_id !== "string" ||
      typeof rec.seq !== "number" ||
      typeof rec.status !== "string"
    ) {
      corrupt++;
      onWarn(`WARN ledger:${i + 1}: corrupt line skipped (not a valid dispatch event). Fix: repair the line by hand, or remove it.`);
      continue;
    }
    records.push(rec);
  }
  return { exists: true, records, corrupt };
}

// 纯追加写（'a' flag），禁止整文件读改写。Windows 上对 'a' fd read 会 EBADF，
// 故是否需补 \n 用独立只读 fd 判定；上一行末字节非 \n 时先补一个换行再写，避免拆坏上一条 JSON。
function appendRecord(ledgerPath, rec) {
  let needNewline = false;
  try {
    const st = fs.statSync(ledgerPath);
    if (st.size > 0) {
      const rf = fs.openSync(ledgerPath, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(rf, last, 0, 1, st.size - 1);
        needNewline = last[0] !== 0x0a;
      } finally {
        fs.closeSync(rf);
      }
    }
  } catch {}
  const fd = fs.openSync(ledgerPath, "a");
  try {
    fs.writeSync(fd, (needNewline ? "\n" : "") + JSON.stringify(rec) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

// 每 task 取全局最新一条事件作为当前状态；lane 只在 append 事件上更新。
function taskAggregate(records) {
  const latest = new Map();
  const lanes = new Map();
  for (const r of records) {
    const cur = latest.get(r.task_id);
    if (!cur || r.seq >= cur.seq) latest.set(r.task_id, r);
    if (r.event === "append") lanes.set(r.task_id, r.lane ?? null);
  }
  return { latest, lanes };
}

function flushWarns(warns, json) {
  for (const w of warns) (json ? process.stderr : process.stdout).write(w + "\n");
}

function cmdAppend(flags) {
  const ALLOWED = new Set(["task_id", "lane", "model", "brief_file", "params_file", "output_file", "note", "status", "ledger"]);
  for (const k of Object.keys(flags)) if (k !== "json" && !ALLOWED.has(k)) return exit2(`unknown flag '--${k.replace(/_/g, "-")}' for command 'append'`);
  if (!flags.task_id) return exit2("append requires --task-id");
  if (!flags.lane) return exit2("append requires --lane");
  if (!flags.model) return exit2("append requires --model");
  const status = flags.status ?? "dispatched";
  if (status !== "dispatched") return exit2(`append --status only accepts 'dispatched', got '${status}'`);
  if (flags.brief_file && !fs.existsSync(flags.brief_file)) return exit2(`file not found: ${flags.brief_file}`);
  if (flags.params_file && !fs.existsSync(flags.params_file)) return exit2(`file not found: ${flags.params_file}`);

  const ledgerPath = flags.ledger ? path.resolve(flags.ledger) : DEFAULT_LEDGER;
  const ledgerDir = path.dirname(ledgerPath);
  fs.mkdirSync(ledgerDir, { recursive: true });
  ensureGitignore(ledgerDir);

  const warns = [];
  const { records } = loadLedger(ledgerPath, (w) => warns.push(w));
  let maxSeq = 0;
  for (const r of records) if (r.seq > maxSeq) maxSeq = r.seq;
  if (records.some((r) => r.event === "append" && r.task_id === flags.task_id)) {
    warns.push(`WARN task ${flags.task_id}: task '${flags.task_id}' already has an append event. Fix: confirm the re-dispatch is intentional, or use 'mark' to update the existing task.`);
  }

  const rec = {
    seq: maxSeq + 1,
    ts: new Date().toISOString(),
    event: "append",
    task_id: flags.task_id,
    lane: flags.lane,
    model: flags.model,
    brief_sha256: flags.brief_file ? sha256File(flags.brief_file) : null,
    params_sha256: flags.params_file ? sha256File(flags.params_file) : null,
    output_path: flags.output_file ?? null,
    status,
    note: flags.note ?? null,
  };
  appendRecord(ledgerPath, rec);

  if (flags.json) {
    process.stdout.write(JSON.stringify(rec));
  } else {
    process.stdout.write(`appended: seq=${rec.seq} task=${rec.task_id} lane=${rec.lane} status=${rec.status} ts=${rec.ts}\n`);
  }
  flushWarns(warns, !!flags.json);
  return 0;
}

function cmdMark(flags) {
  const ALLOWED = new Set(["task_id", "status", "note", "ledger"]);
  for (const k of Object.keys(flags)) if (k !== "json" && !ALLOWED.has(k)) return exit2(`unknown flag '--${k.replace(/_/g, "-")}' for command 'mark'`);
  if (!flags.task_id) return exit2("mark requires --task-id");
  if (!flags.status) return exit2("mark requires --status");
  if (!MARK_STATUSES.includes(flags.status)) {
    return exit2(`invalid status '${flags.status}' — expected one of: ${MARK_STATUSES.join(", ")}`);
  }

  const ledgerPath = flags.ledger ? path.resolve(flags.ledger) : DEFAULT_LEDGER;
  const warns = [];
  const { records } = loadLedger(ledgerPath, (w) => warns.push(w));
  if (!records.some((r) => r.event === "append" && r.task_id === flags.task_id)) {
    return exit2(`unknown task-id '${flags.task_id}'`);
  }

  let maxSeq = 0;
  for (const r of records) if (r.seq > maxSeq) maxSeq = r.seq;
  const rec = {
    seq: maxSeq + 1,
    ts: new Date().toISOString(),
    event: "mark",
    task_id: flags.task_id,
    status: flags.status,
    note: flags.note ?? null,
  };
  appendRecord(ledgerPath, rec);

  if (flags.json) {
    process.stdout.write(JSON.stringify(rec));
  } else {
    process.stdout.write(`marked: seq=${rec.seq} task=${rec.task_id} status=${rec.status} ts=${rec.ts}\n`);
  }
  flushWarns(warns, !!flags.json);
  return 0;
}

function cmdStatus(flags) {
  const ALLOWED = new Set(["ledger"]);
  for (const k of Object.keys(flags)) if (k !== "json" && !ALLOWED.has(k)) return exit2(`unknown flag '--${k.replace(/_/g, "-")}' for command 'status'`);
  const ledgerPath = flags.ledger ? path.resolve(flags.ledger) : DEFAULT_LEDGER;
  const warns = [];
  const { exists, records, corrupt } = loadLedger(ledgerPath, (w) => warns.push(w));
  if (!exists) return exit2(`ledger not found: ${ledgerPath}`);

  const { latest, lanes } = taskAggregate(records);
  const counts = {};
  for (const r of latest.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const open = [];
  for (const r of latest.values()) {
    if (CLOSED.has(r.status)) continue;
    const item = { task_id: r.task_id, lane: lanes.get(r.task_id) ?? null, status: r.status, last_ts: r.ts ?? null };
    const hint = FAILED_HINTS[r.status];
    if (hint) item.hint = hint;
    open.push(item);
  }
  open.sort((a, b) => a.task_id.localeCompare(b.task_id));
  const allVerified = open.length === 0;

  if (flags.json) {
    process.stdout.write(JSON.stringify({ statuses: counts, total: latest.size, open, all_verified: allVerified, corrupt_lines: corrupt }));
  } else {
    process.stdout.write(`tasks: ${open.length} open, ${latest.size} total, corrupt_lines=${corrupt}\n`);
    process.stdout.write("statuses:\n");
    const keys = Object.keys(counts).sort();
    if (keys.length) {
      for (const k of keys) process.stdout.write(`  ${k}: ${counts[k]}\n`);
    } else {
      process.stdout.write("  (none)\n");
    }
    process.stdout.write("open tasks:\n");
    if (open.length) {
      open.forEach((o, i) => {
        let line = `  ${i + 1}. ${o.task_id}  lane=${o.lane}  status=${o.status}  last=${o.last_ts}`;
        if (o.hint) line += `  — ${o.hint}`;
        process.stdout.write(line + "\n");
      });
    } else {
      process.stdout.write("  (none)\n");
    }
    if (allVerified) process.stdout.write("all tasks verified\n");
  }
  flushWarns(warns, true);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    process.stderr.write(usage());
    return exit2("missing subcommand (append|mark|status)");
  }
  const sub = args[0];
  if (sub === "-h" || sub === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  const flags = parseFlags(args.slice(1));
  if (flags.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (flags.__error) return exit2(flags.__error);
  if (sub === "append") return cmdAppend(flags);
  if (sub === "mark") return cmdMark(flags);
  if (sub === "status") return cmdStatus(flags);
  process.stderr.write(usage());
  return exit2(`unknown subcommand '${sub}'`);
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write("[RUNTIME_ERROR] internal error: " + (e && e.message ? e.message : String(e)) + "\n");
  process.exitCode = 2;
}