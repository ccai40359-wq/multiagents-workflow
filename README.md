# seanswarm

![seanswarm — multi-agent workflow pack for coding agents](assets/banner.png)

**A lightweight multi-agent workflow pack for mainstream coding agents — Claude Code, Codex, Cursor, ZCode, and other compatible hosts.**
Turn your coding agent into a supervised small team: research fan-out with evidence governance, dual-channel document reading, and dev delivery with independent review and visual acceptance.

[中文说明](README.zh.md)

---

## What this is

A pack of **agent skills + role templates** that install into mainstream coding agents (Claude Code, Codex, Cursor, ZCode). No runtime, no server, no framework — the host agent executes the protocols; the skills describe *how to organize the work*.

It covers four recurring scenarios:

| Scenario | Piece | Pattern |
|---|---|---|
| Web research | `skills/web-research-fanout` | fan-out lanes → claims table → adversarial lane → cross-family arbitration → anti-scrape ladder (L0–L4) |
| Document reading | `skills/dual-read` | two independent channels read the same document, then cross-compare (match / addition / conflict) |
| Dev delivery | `skills/dev-delivery` | QA-first acceptance list → single writer → independent read-only review (diff-only) → fail-closed acceptance → fixes go back to the single writer; disjoint modules run as parallel workstreams |
| Visual acceptance | `agents/visual-judge.md` + `hooks/ui-screenshot-gate.mjs` | render → screenshot → per-page verdict → fix → re-render; a mechanical hook bounces "done" without screenshot evidence |
| Evidence enforcement | `tools/gates/` + `tools/ledger/` + `REPORT-CONTRACT.md` | mechanical, zero-dependency checks: claims-table lint, file-boundary check, report-contract lint; append-only dispatch ledger with three-way fault attribution |

Role templates live in `agents/`: `researcher`, `reviewer`, `worker-coder`, `visual-judge`.

## Architecture

![seanswarm architecture at a glance](assets/architecture.png)

## Design principles

- **Evidence over consensus.** Claims need sources; conflicts are resolved by arbitration, never by majority vote. Independent-source count > vote count; primary > secondary; newer > older.
- **Role separation, not one super-agent.** A zero-write reviewer, a single writer, and a dedicated adversarial lane that hunts for counter-evidence.
- **Clean-context review.** The reviewer receives the diff + requirements — never the conversation history.
- **Fail-closed acceptance.** "Unknown" counts as failed; an empty diff needs an explicit waiver.
- **finder ≠ fixer.** The reviewer only finds; fixes go back to the single writer; one repair round, no recursion.
- **One writer *per workstream*.** Modules whose files are disjoint run as parallel workstreams — each still goes through the full gated pipeline, and the main session owns integration.
- **Verification before completion.** No "done" without fresh run output.
- **Judgment belongs to exit codes, not self-reports.** Every workstream declares one command whose exit code decides pass/fail; a subagent *reporting* "tests pass" is a claim, the exit code is the evidence. Ported from watching deterministic gate runners: the model answers questions, the command renders verdicts.
- **Frozen briefs, recorded knobs.** A dispatch's invariant brief never changes after dispatch — gaps are handled by adding lanes, not editing briefs — and tunable parameters (budget, model, tier) are recorded in the ledger, not embedded in the prompt. Every conclusion stays traceable to the parameter set that produced it.
- **Faults are attributed, not just retried.** `failed-transport` (host/provider layer — wait), `failed-protocol` (contract broken — re-dispatch once, narrower), `failed-definition` (the task itself was wrong — never re-dispatch; void downstream and re-specify). One flat "retry once" rule conflates three opposite situations.
- **Cheap gates beat clever prompts.** The mechanical hook exists because prose alone is not enforcement — v0.2 extends the idea from one hook to a gate suite (see below).

## Install

### Manual (any host with skills support)

```bash
# skills → your skills directory
cp -r skills/* <skills-dir>/
# roles → your agents directory
cp agents/*.md <agents-dir>/
```

Common locations: ZCode `~/.agents/skills` + `~/.zcode/agents`; Claude Code `~/.claude/skills` + `~/.claude/agents`; Codex `~/.codex/skills`. See `adapters/` for per-platform notes.

### Plugin (ZCode)

The repo ships a plugin manifest at `.zcode-plugin/plugin.json`. Add the repo as a plugin source and enable it.

### Hook (optional)

`hooks/ui-screenshot-gate.mjs` is a Stop-event hook: when UI files were edited in a turn that produced no screenshot evidence, it sends the turn back to collect evidence. Wiring instructions in `hooks/README.md`.

### Mechanical gates & ledger (new in v0.2)

`tools/` ships the mechanical layer of the protocols — deliberately dumb (no LLM, no judgment, just bookkeeping), zero npm dependencies, Node 18+:

| Command | Gate | Fails when |
|---|---|---|
| `node tools/gates/claims-lint.mjs <lane-output.md>` | research claims table | a row lacks a public URL / date / primary-secondary marker / counter-evidence; a conflict never reached an arbitration section |
| `node tools/gates/boundary-check.mjs --boundary <patterns> --git-base <ref>` | dev-delivery file boundaries | a changed file falls outside the workstream's declared boundary |
| `node tools/gates/report-lint.mjs <report.md>` | the five-section report contract (`REPORT-CONTRACT.md`) | a required section is missing; a "skipped" check is disguised as blocked; a *Verified* item carries no evidence marker |
| `node tools/ledger/dispatch-ledger.mjs append\|mark\|status` | dispatch bookkeeping | (not a gate) — append-only JSONL answering "which conclusions are not yet verified", with `failed-transport` / `failed-protocol` / `failed-definition` attribution |

All gates: exit `0` pass · `1` violation · `2` cannot-judge; `--json` for machines; `--strict` promotes warnings. 175 tests cover the suite (`node tests/*.test.mjs`).

## Quick start

- Research: *"Research X across official docs, GitHub, and community — fan out, then verify."*
- Document: *"Read this contract with a second independent pass and cross-compare."*
- Dev delivery: *"Implement feature Y: QA-first, single writer, independent review. Unknown counts as failed."*
- Visual acceptance: *"Render the deck to PNGs and run the visual judge page by page; fix fails and re-judge."*

Skills trigger on these kinds of requests; you can also name them explicitly.

## Design notes

**Orchestration vs channels.** The pack separates *how work is organized* (lanes, tiers, contracts, arbitration) from *how data is actually fetched* (APIs, search-index layer, direct fetch, browsers). Many failures people blame on "the model" are channel failures.

**Why fan-out isn't cloning.** N agents with the same question pick the same pages and reinforce the same error. Lanes must differ in at least one dimension: source type, language, stance, or model family.

**Output shape.** Every workstream reports in the same five sections — Conclusion / Findings / Verified / Not covered / Skipped — so merging becomes bookkeeping instead of prose-reading. See `REPORT-CONTRACT.md`; the claims-table contract every lane must return is shown in `examples/claims-table-sample.md`.

**Cost, measured (4-lane run — the low end of the standard tier — single host):** ≈0.56M tokens total, ≈5 min wall clock (parallel) + ≈1 min arbitration. Heavy tier (10–20 lanes): 1.5–4M tokens per round. Details in `FIELD-NOTES.md`.

## Related work & differences

The surrounding ecosystem is active. None of this pack claims to be first — the value is in the combination and the field-tested playbooks.

| Project | What it is | How this pack differs |
|---|---|---|
| [Socialpranker/deepdive](https://github.com/Socialpranker/deepdive) | Research pipeline: parallel sub-agents, claims ledger, 5-role red team, fetch ladder | Closest neighbour on the research side; this pack adds cross-family arbitration + dual-channel document reading, and stays a lightweight skill pack rather than a scripted pipeline |
| [obra/superpowers](https://github.com/obra/superpowers) | Agentic skills framework & software-development methodology | Same direction on the dev side; this pack adds the visual gate + mechanical screenshot hook and ships a much smaller surface |
| [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills) | Structured deep-research skill, human-in-the-loop, multi-platform | This pack's research skill adds adversarial lanes, arbitration and an anti-scrape ladder |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | Social-platform research skill (single-agent checkpoint architecture) | Different architecture; see its channel engineering for social platforms |
| [zhjai/agent-arena](https://github.com/zhjai/agent-arena) | Cross-model debate / review protocol | Same "heterogeneous models" idea applied to code review; this pack applies it to research conflicts and bans majority voting explicitly |
| [eforge-build/eforge](https://github.com/eforge-build/eforge) | Spec-to-verified-code build system, blind adversarial review | This pack borrows the fail-closed acceptance rule and keeps it as a portable skill |
| [lucasfcosta/backpressured](https://github.com/lucasfcosta/backpressured) | Skills for long unattended coding sessions (incl. Playwright visual review) | Similar visual-gate idea; this pack adds a mechanical (non-LLM) screenshot hook |

Ideas borrowed with gratitude: diff-only review input (superpowers); fail-closed acceptance (eforge); circuit breaker + dispatch ledger + model-substitution check (ai-cross); human plan gate + minority-counsel roles (deepdive); adversarial-behaviour testing (last30days).

## Status & roadmap

v0.2.0. Skills ship in English (`SKILL.md`) with Chinese translations alongside (`SKILL.zh.md`); agent role templates carry bilingual descriptions. Codex/Cursor adapters are drafts pending verification.

- v0.3: machine-checkable evals (including an adversarial-lane behaviour test); cross-round claim reconciliation on top of the dispatch ledger.

## License

MIT — see `LICENSE`.
