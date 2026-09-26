# Changelog

## v0.2.0 — 2026-09-26

Theme: **turn the protocols' most expensive rules into mechanical gates.** Prose
rules are only followed when the host feels like it; this release moves the rules
whose violation is most costly (evidence gaps, boundary collisions, disguised
skips, unattributed failures) out of prose and into scripts that cannot be
talked past. Inspired by studying how deterministic workflow runners gate
subagent output (exit codes over self-reports; frozen briefs; journaled state).

- **REPORT-CONTRACT.md** — one five-section report shape for every workstream
  (Conclusion / Findings / Verified / Not covered / Skipped), bilingual headings.
  The load-bearing distinction: **Not covered** = tried and blocked (record the
  wall); **Skipped** = could have run and chose not to (record the reason and the
  cost). Filing a skip as "blocked" is the dishonest move the lint catches.
- **tools/gates/claims-lint.mjs** — mechanically validates a lane's claims table:
  every row needs a public URL (loopback/private/reserved rejected, aligned with
  `fetch-hard.mjs`), a YYYY-MM-DD date, a primary/secondary marker, and a
  counter-evidence cell; conflicts must reach an arbitration section; empty
  tables need an explicit "none found". `--strict`, `--as-of`, `--json`.
- **tools/gates/boundary-check.mjs** — dev-delivery's "one writer, one boundary"
  as a gate: fails when a changed file falls outside the workstream's declared
  boundary (patterns or pattern-file; changed files from `--files`, a diff file,
  or `git diff --name-only <base>`). Windows/POSIX path normalization.
- **tools/gates/report-lint.mjs** — enforces the report contract: required
  sections (bilingual headings), "skipped" masquerading as "not covered" fails,
  every Verified item needs an evidence marker (URL, file:line, or command +
  exit code). Anti-false-positive guards for third-party slowness narrations.
- **tools/ledger/dispatch-ledger.mjs** — append-only JSONL dispatch ledger
  (`.dispatch/ledger.jsonl`): task id, lane, model, sha256 of the invariant
  brief and the parameter block, output path, status. Status vocabulary forces
  three-way fault attribution: `failed-transport` / `failed-protocol` /
  `failed-definition` — each with its own correct next action. `status` answers
  "which conclusions are not yet verified".
- **skills/web-research-fanout** — dispatch briefs split into a **frozen
  invariant brief** and a **recorded parameter block** (budget/model/tier live in
  the ledger, not the prompt); gap rounds add lanes with fresh task-ids instead
  of editing round-1 briefs (edited briefs invalidate settled conclusions);
  claims-lint gates every lane report before merging; flat "retry once" replaced
  by the three-way fault taxonomy.
- **skills/dev-delivery** — every workstream must declare one **exit-code
  verification command** (a subagent's "tests pass" is a claim; the exit code is
  the evidence) and one **file boundary**; both plus report-lint run at
  fail-closed acceptance; dispatch ledger upgraded from prose convention to the
  mechanical tool.
- **skills/dual-read** — output wraps the five-section report contract.
- **agents/** — all four role templates' output sections aligned to the report
  contract; researcher gains an explicit 3-escalations-per-task quota.
- **Tests**: 163 new spawnSync tests across the four new tools (30 + 29 + 43 +
  61); existing 12 hook tests unchanged. `node tests/*.test.mjs` — 175 total.

## v0.1.0 — 2026-09-16

Initial release.

- **skills/web-research-fanout** — web research orchestration: lane splitting, firepower tiers, claims-table contract, adversarial lanes, cross-family arbitration, anti-scrape escalation ladder (L0–L4). Ships `scripts/fetch-hard.mjs`.
- **skills/dual-read** — dual-channel document reading: main agent reads + one subagent per file reads independently, then cross-compare (match / addition / conflict).
- **skills/dev-delivery** — dev delivery protocol: QA-first acceptance checklist → single writer → independent read-only review (diff-only input) → fail-closed acceptance → visual gate. Ships `scripts/verify-model.mjs`.
- **agents/** — four role templates: researcher, reviewer, worker-coder, visual-judge.
- **hooks/ui-screenshot-gate.mjs** — mechanical gate: blocks finishing a turn that edited UI files without screenshot evidence.
- **Languages**: skills ship in English (`SKILL.md`) with Chinese translations (`SKILL.zh.md`); READMEs in English and Chinese.
- **Security**: `fetch-hard.mjs` and `verify-model.mjs` include a URL safety guard (http/https only; loopback, private and reserved addresses rejected).
