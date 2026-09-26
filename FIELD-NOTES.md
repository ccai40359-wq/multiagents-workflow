# Field notes

Observations from running this pack on real work (sanitized — no client data, no credentials). Numbers come from a single-host setup and will vary with host, models and gateways.

## Cost & latency

- 4-lane research run (low end of the standard tier): ≈84K–262K tokens per lane (depends on pages read); ≈560K tokens total; ≈5 min wall clock parallel + ≈1 min arbitration.
- Heavy tier (10–20 lanes): estimate 1.5M–4M tokens per round — check your quota before opening it.
- "Premium" research (adversarial lane + cross-family arbitration + two-round protocol): ≈1.5–2.5× standard cost, 15–25 min wall clock.

## What worked

- **Lane productivity ordering**: official docs / primary pages > GitHub repos & issues > community threads. Community lanes (EN/ZH) cost the most and produce the least.
- **Index-layer access**: `site:` queries through a search API read Reddit/Zhihu content from the index snapshot when direct fetch is IP-blocked. The index layer, not more firepower, is the fix for blocked sites.
- **Claims-table contract** (assertion | URL | date | primary/secondary | counter-evidence): turns merging from prose-reading into bookkeeping, and makes single-source assertions and conflicts mechanically visible.
- **Cross-family arbitration**: heterogeneous models catch correlated blind spots that same-family review misses; it is about uncorrelated blind spots, not about buying a smarter model.
- **Role separation**: a zero-write reviewer with a clean context surfaces issues that the writer cannot see about its own work.

## What failed / surprises

- **Skill loaded ≠ protocol executed.** A skill being present does not guarantee the orchestrator follows it. Load-bearing steps should be made mechanical (hooks, scripts), not left as prose. This pack's hook exists for that reason.
- **Hard sites: retrying harder never works.** When the exit IP is blocked, all effort-based escalation fails; escalate the *channel* (index layer → exit IP → real browser).
- **Sub-agent inactivity kills**: hosts may terminate a sub-agent idle for ~10 minutes. Give fetches their own timeouts (the bundled fetcher ships with 25s/45s timeouts) so no step hangs silently.
- **Session snapshots**: on some hosts, sub-agent tool/config changes are snapshotted at session start — restart the session after changing a role's tools.
- **Search fallbacks are fragile**: DuckDuckGo result pages are CAPTCHA-walled from some hosts; Bing's Chinese query segmentation returns garbage results; Brave result pages work but are brittle. Treat search-page scraping as a last resort, not a channel.
- **Free-tier numbers hide behind 403'd pricing pages** — if you cannot fetch a primary source, mark "unverified: no primary source" instead of guessing.

## Visual gate notes

- An LLM judge over rendered page PNGs (one verdict line per page, with evidence) plus a mechanical screenshot hook covers the "does it actually look right" gap that command-line acceptance misses.
- Re-judging after fixes is cheap and catches regressions: fixing a header on one page can break another.
- Keep the judge zero-write; render → judge → fix → re-render is the loop.

## v0.2 notes: what the gates are for (2026-09-26)

Studying a deterministic workflow runner's design (compile-time-checked
orchestration, journaled state, exit-code gates) produced five transfers, each
mapping a weakness we had already observed in ourselves onto a mechanical fix:

- **"I ran it" is the most expensive sentence in the pack.** A subagent reporting
  success is a claim; the acceptance step now re-runs one declared command and
  reads its exit code. The interesting part is not the check — it is that the
  rule stopped being something the host must remember.
- **Knobs in prompt text are identity leaks.** Our dispatch template embedded
  "budget: ≤8 searches" directly in the brief — meaning any tuning silently
  invalidated every conclusion drawn under the old budget, with nothing marking
  which ones. Brief = invariant; parameters = recorded, hashed, per dispatch.
- **Editing a brief is a silent invalidation.** Gap rounds used to re-send
  amended briefs, re-opening conclusions round 1 had already settled. Gaps are
  now additive lanes with fresh task-ids.
- **"Retry once" was three rules wearing a trenchcoat.** Transport failure
  (wait), protocol failure (re-dispatch once, narrower), definition failure
  (never re-dispatch — void downstream) have opposite correct actions; the
  ledger makes the attribution explicit instead of leaving it to vibes.
- **The one place dishonesty hides is the gap between "blocked" and "skipped".**
  Not covered = tried, wall hit. Skipped = chose not to, with the cost. A
  "skipped" filed as "blocked" reads like humility but is a decision wearing an
  excuse — that is the one thing report-lint fails hardest.

Counter-lesson, kept deliberately: the deterministic runner routes everything
through one model and has no notion of independent evidence families. Our
cross-family arbitration and anti-majority-vote rules are the part a compiled
orchestrator cannot express — do not trade them for executability.
