---
name: dev-delivery
description: Dev delivery orchestration — QA-first acceptance checklist → single writer implements (self-verified) → independent read-only review (diff-only input) → fail-closed acceptance → fixes go back to the writer → (visual gate for UI/PPT deliverables); multi-module tasks can run as parallel workstreams on disjoint files. MUST USE for multi-file coding tasks, code delivered for others to run, or changes needing independent acceptance; single-file scripts may use the lite path.
---

# Dev Delivery

Core principles: **one writer; independent, read-only review; fail-closed acceptance; fixes go back to the writer.**
Multi-agent raises the floor (that's what gates are for) — the ceiling is still the main model. So the gates must be real, short, and evidence-backed.

## 0. Pick the path

- **Full flow**: multi-file / delivered for the user to run / touches data or security.
- **Lite**: single-file tools, exploratory scripts → the main session lists acceptance points → implement with self-test coverage → (optional) one static review pass.

## 1. HITL plan gate (big changes only)

Before spending budget, produce a 3-5 line plan: files touched, module boundaries/contracts, failure modes, how it will be accepted. Get the user's nod first — reworking a plan is far cheaper than reworking a heap of code.

## 2. QA-first: freeze the acceptance checklist

Dispatch **reviewer** (read-only) to produce the acceptance checklist: numbered items + the pass bar for each + severity P0-P3.
The checklist must be **frozen before** implementation; changing requirements mid-flight = change the checklist and say so.

## 3. Single-writer implementation

Dispatch **worker-coder**, one module per dispatch. "One writer" is a **per-workstream** rule, not one writer for the whole project — independent workstreams may run in parallel (below).

- **verification-before-completion**: run verification yourself (tests/command output) before reporting back; no fresh run output → you may not say "done".
- **Every workstream declares one exit-code verification command** — a single command whose exit code decides the workstream's pass/fail (test suite, build, lint, script). The writer runs it and cites the command + exit code; the main session re-runs it at acceptance. A subagent *reporting* "tests pass" is a claim, not evidence — the exit code is the evidence. (This is the `world.run` lesson: judgment belongs to a command's exit code, not to a model's self-report.)
- **Every dispatch declares its file boundary** — the list of paths/globs the writer may touch. At acceptance the main session runs the boundary gate: `node <pack-root>/tools/gates/boundary-check.mjs --boundary <patterns> --git-base <base-ref>` (exit 0 required). An out-of-bounds edit is a P0 finding even if the code is perfect — it means two writers now collide.
- Report format: the pack-wide five-section shape (`REPORT-CONTRACT.md`) — files changed + run evidence under **Verified** (command + exit code each) + leftover risks under **Not covered**/**Skipped**.

### Parallel workstreams (multi-module tasks)

Two modules are independent workstreams when their file sets are disjoint. Then dispatch N worker-coders **in a single message** (so they run in parallel), each carrying its own slice of the frozen checklist.

| Safe to parallelize | Keep as one workstream |
|---|---|
| separate directories / modules / projects | the same file (entry point, router, registry, `package.json`, lockfile) |
| separate service boundaries behind a frozen interface | DB schema / migrations |
| docs vs code, in separate files | shared i18n / config files |

Rules:

1. **Freeze the interface before dispatch** — function signatures, data shapes, file paths go into every dispatch note. A moving interface turns parallel work into rework.
2. **Freeze each workstream's file boundary** — the path/glob list the writer may touch, recorded with the dispatch. After merge, prove the boundaries held: `node <pack-root>/tools/gates/boundary-check.mjs --boundary <patterns> --git-base <merge-base>` must exit 0.
3. A shared file that must change is **its own workstream**: main session (or one writer) lands it first, the others build on the result.
4. Each workstream runs the **same pipeline** end to end: QA-first checklist slice → writer self-verifies → diff-only review → fail-closed acceptance. Parallelism changes *how many writers run*, not *how each one is gated*.
5. **Integration belongs to the main session**: merge, run the cross-module check, then re-run every workstream's acceptance items (including the exit-code verification command and the boundary gate) on the integrated tree — per-workstream review cannot see cross-module breakage.

## 4. Independent read-only review

Dispatch **reviewer**. Dispatch notes:

- **Feed only the diff + requirements (+ optional commit SHA), never the conversation history** — clean perspective, no contamination.
- Output: each finding = location (file:line) + phenomenon + severity (P0-P3); no unsubstantiated generic advice.
- **finder ≠ fixer**: the reviewer only finds; fixes go back to the single writer; **one repair round, no recursion**.

## 5. Fail-closed acceptance

- **unknown = fail**: anything unconfirmed counts as not-passed unless explicitly waived with a written reason.
- An empty diff needs an explicit waiver to count as "no change needed".
- Numeric assertions must trace to first-hand output (test logs / command output) — "I did run it" is not accepted.
- **Mechanical gates run at acceptance** (all must exit 0):
  - `node <pack-root>/tools/gates/boundary-check.mjs --boundary <patterns> --git-base <base>` — no file outside the declared boundary was touched.
  - `node <pack-root>/tools/gates/report-lint.mjs <writer-report.md>` — the writer's report satisfies the five-section contract (and no "skipped" check is disguised as blocked).
  - the workstream's declared **exit-code verification command**.

## 6. Visual gate (when the deliverable is UI / web / PPT)

- Render → screenshot → verdict (pass/fail + evidence, one line per page/screen) → fix → re-render and re-judge.
- Judge with **visual-judge** (zero write permission; sees only rendered images, never source files).
- Mechanical gate (optional): edited UI files but produced no screenshot evidence this turn → bounce at wrap-up to collect evidence. Example hook: `hooks/ui-screenshot-gate.mjs` in this repo.

## 7. Failure handling — attribute first, then act

"Retry once" is not one rule. The three failure classes have opposite correct actions:

- **`failed-transport`** (timeout, killed for inactivity, turn execution failed, provider 4xx/5xx): retries belong to the host/provider layer. Do not burn a protocol retry — wait, then re-check via the ledger. Record `mark --status failed-transport`.
- **`failed-protocol`** (agent returned malformed output, ignored the contract, edited out-of-bounds files, claimed done without evidence): re-dispatch **once** with a narrower scope; a second protocol failure means the brief is the problem → treat as `failed-definition`.
- **`failed-definition`** (the task itself was misspecified — wrong scope, duplicate of another workstream, unreachable as written): **never re-dispatch as-is.** Void the task, void any work that rested on it, and re-specify as a new dispatch.
- **Circuit breaker**: the same channel/model failing **twice in a row** → switch channel/model; do not hit it a third time.
- **Silent model substitution**: for third-party OpenAI-compatible endpoints, verify the response's `model` field matches the request (`scripts/verify-model.mjs`) — some endpoints answer with their own default model for unknown ids without saying so.
- Every outcome is recorded with `tools/ledger/dispatch-ledger.mjs` — an unlogged failure is a silent one.

## 8. Dispatch ledger (recommended for anything multi-dispatch)

- Mechanical record: `node <pack-root>/tools/ledger/dispatch-ledger.mjs append|mark|status` — append-only JSONL at `<project>/.dispatch/ledger.jsonl` (created on first use, with its own `.gitignore`). Each event carries the task id, lane, model, sha256 of the invariant brief and of the parameter block, output path, timestamp, and status (`dispatched` / `succeeded` / `failed-transport` / `failed-protocol` / `failed-definition` / `verified` / `completed` / `voided`).
- `status` answers "which conclusions are not yet verified" — the gap list reads itself from the ledger instead of from memory.
- Prose layer (optional, unchanged): save full task + raw output to `<project>/.dispatch/<time>-<role>.md`; multi-round progress in `.dispatch/STATE.md`.

## Pre-delivery self-check (all must pass)

- Checklist items all verified? Un-passed ones explicitly waived with reasons?
- Review findings all carry location + evidence? P0/P1 fixed or explicitly declined with reasons?
- Fresh run output exists before any "done" claim?
- Visual deliverables: screenshot evidence + verdicts present?
- Dispatch ledger complete (if enabled)?
