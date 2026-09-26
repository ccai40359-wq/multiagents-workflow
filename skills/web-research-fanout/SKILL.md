---
name: web-research-fanout
description: Web research orchestration protocol — split lanes (sub-question × source type) → dispatch researchers in parallel → structured claims table (assertion + source URL + date + primary/secondary) → independent arbitration only for conflicts. MUST USE for web research, multi-source verification, vendor/market research, cross-checking — triggers include "research this", "verify across sources", "全网查", "多源核对". Not for single-fact lookups or reading local documents (use dual-read in this pack).
---

# Web Research Fanout

Core principle: **coverage comes from independent sources, not from the number of agents.** The lane count equals the number of genuinely independent lines (sub-question × source type), not a fixed number you feel like dispatching.
N researchers asked the same question will pick the same pages from the same search results → correlated errors reinforce each other and produce "confident mistakes".

## 0. First: decide whether to fan out

- Single fact (one number, one link) → dispatch nothing, or one agent; the main session searches directly.
- You need "a map" (breadth, multi-source corroboration, conflicting claims) → fan out.
- Reading local documents/PDFs → use `dual-read`, not this skill.

## 1. Firepower tiers (lane count by stake, not by mood)

| Tier | Size | When |
|---|---|---|
| Quick | 2-3 | One claim needs 2-3 independent sources |
| Standard (default) | 5-8 | One full research pass, cut into 5-8 lanes by source type |
| Heavy | 10-20 | Only if you can list ≥10 **genuinely independent** sources/sub-questions (multi-language, multi-platform, multi-category); if you can't, you don't get to open it |

Lane examples (cut by source type): official announcements/docs | code repos & issues | benchmarks/review sites | community reports (Reddit/HN/V2EX) | Chinese sources | pricing pages/terms | regulators/primary documents.
Every lane's researcher must get a **different seed** (wording / language / site restriction — at least one must differ), otherwise it's a clone.

> **Quality formula**: quality = independent sources × adversarial verification × arbitration; raw numbers are just an amplifier. Before adding a lane, ask: in which dimension is it independent from the existing ones — source type, language, stance, model family? If none, it's a clone and will only amplify correlated error.
> **Model assignment**: lanes are standardized work — mid-tier models are enough (in practice: contract compliance is fine; failures happen in the channels, not the thinking). Judgment-heavy steps are only three: the main session's planning/merging, the adversarial lane, and arbitration. **Different family ≠ more expensive**: the point of cross-family is uncorrelated blind spots; any mid-tier model from a different family will do.

## 2. Dispatch (one message, parallel; batch if heavy)

- Send multiple Agent calls (subagent_type: `researcher`) in **one message** — do not serialize.
- **≤6 per batch**; heavy tier dispatches in batches (avoid gateway rate limits).
- **Validate channels before writing them into tasks**: the main session verifies one working channel first, then writes the **complete command** into the task template — sub-agents have no Skill tool and cannot load other manuals, so commands must be self-contained. Common channels: search APIs (Exa etc., via mcporter/MCP or curl) | search-engine result pages (Bing/Brave) | r.jina.ai for page reading | `gh` | `yt-dlp`; verify social-platform channels before using them.
- Every task must be **self-contained** (sub-agents cannot see the main session). A dispatch has two parts — keep them apart:
  - **Invariant brief** — frozen the moment the lane is dispatched: question, scope, seeds, output contract below. Never edit it afterwards; a changed brief invalidates the lane's evidence. Gaps are handled by *adding* lanes (see the two-round rule), never by re-sending an edited brief.
  - **Parameter block** — the tunable knobs (budget, model, tier), recorded in the dispatch ledger, not embedded in the brief: `node <pack-root>/tools/ledger/dispatch-ledger.mjs append --params-file <params.md> ...`. Every conclusion is traceable to the parameter set it was produced under — change a knob and you know exactly which conclusions are invalidated.

  Template (invariant part):

```
Research task (lane: <name>).
Goal: <one-sentence question>. Scope: <source type / sites / language>. Seeds: <3-5 keywords or site restrictions>.
Tools: prefer Bash with your search command, e.g. mcporter call 'exa.web_search_exa(query: "...", numResults: 8)' (replace with your environment's);
fetch pages with node <pack-root>/skills/web-research-fanout/scripts/fetch-hard.mjs <url> (chained degradation: real-UA direct fetch → HTML-to-text → r.jina fallback) or WebFetch;
search-result-page fallback (use only if the two above fail): www.bing.com/search?q= / search.brave.com/search?q=; DuckDuckGo is CAPTCHA-walled, don't use it;
on 403/blocks: escalate one level (see §6); if still blocked, stop and mark "blocked: <site> <status code>" — never force it.
Output contract (strict — the pack-wide five-section shape, REPORT-CONTRACT.md):
## Conclusion — ≤3 lines
## Findings — 1) claims table, one row per claim: assertion | source URL | date | primary/secondary | counter-evidence   2) "not found / conflicting" list
## Verified — rows traced to primary sources (URL each)
## Not covered — walls hit: "blocked: <site> <status>"
## Skipped — sources you deprioritized (with the reason)
Nothing else.
```

  Parameter block (recorded via the dispatch ledger, not embedded in the brief):
  `budget: ≤8 searches + ≤10 page fetches; stop once a claim has 2 independent sources.` · `model: <as dispatched>` · `tier: <Quick|Standard|Heavy>`

### Big topics (heavy tier / decision-grade conclusions): two rounds, don't one-shot

1. **Recon round (main session, 5-10 min)**: search 3-6 times yourself to learn the key entities, where the primary sources live, and where accounts disagree → use that to cut lanes and seeds. (For high-cost tasks you may add a "plan gate": show the plan to the user before starting.)
2. **Collection round**: dispatch researchers per lane in parallel (≤6 per batch).
3. **Gap round**: dispatch 1-2 **additional** lanes with fresh task-ids, targeting exactly three things — the "not found" list, conflicts, and counter-evidence for load-bearing claims. **The round-1 briefs stay frozen**: never re-send an edited brief, because that re-opens (and re-pays for) every conclusion round 1 already settled. Gaps are new lanes, not patched ones.

The cost of one-shotting: lanes burn their budget guessing keywords (measured).

## 3. Mechanical merge in the main session (don't read every report)

- **Gate every lane report before merging**: `node <pack-root>/tools/gates/claims-lint.mjs <lane-output.md>` must exit 0. It mechanically fails any row missing a public URL, date, primary/secondary marker, or counter-evidence — and conflicts that never made it into an arbitration section. A lane that fails the gate goes back to that lane; do not hand-merge around it.
- Deduplicate by assertion: same assertion from multiple sources → one row, note the source count.
- Mechanically flag two things: ① load-bearing assertions with a single source ② assertions with conflicting conclusions → into the "conflict list".
- Keep only the merged table + conflict list; never stuff all raw reports into context.
- Log each lane's outcome in the dispatch ledger (`tools/ledger/dispatch-ledger.mjs`) — a lane that returned nothing usable is `failed-protocol` or `failed-definition`, not a silent shrug (see the failure taxonomy in the Appendix).

## 4. Verification & arbitration (default: primary sources + adversarial + cross-family)

For **every load-bearing assertion** (an assertion the conclusion rests on), do all three by default at standard tier and above; quick tier does at least ①:

1. **Primary-source trace**: the assertion must be traceable to a primary source (official page / official repo / original document). Secondary-only → mark "pending primary verification" and do not treat as settled.
2. **Adversarial lane**: dispatch one researcher whose job is to find counter-evidence — search "X is wrong / not recommended / complaints / scam", find primary documents that contradict. Finding none is itself a result (write one line: "no counter-evidence found").
3. **Cross-family arbitration**: the verifier/arbiter uses a model from a **different family** than the lanes — the point is uncorrelated blind spots, not a smarter model. Feed it only the conflict list + adversarial results, and require **verbatim quotes** from the originals as grounds.

- Arbitration output uses the match/addition/conflict tri-classification (same as dual-read) + for each conflict: each side's sources, dates, primacy, recommended resolution or "disputed".
- **Majority vote ≠ truth**: independent-source count > vote count; primary > secondary; newer > older.

## 5. Output format

Lane reports and the final merged deliverable both follow the pack-wide five-section shape (`REPORT-CONTRACT.md`): **Conclusion / Findings / Verified / Not covered / Skipped**. For this skill:

- **Findings** = the merged conclusions table (assertion | sources | date | confidence — a *merge view* over the lanes; the per-lane claims tables feeding it keep the full five-column contract that `claims-lint.mjs` checks) + the disputed list with both sides and their sources.
- **Verified** = load-bearing assertions traced to primary sources (each with its URL).
- **Not covered** = `blocked: <site> <status>` items — tried, wall hit.
- **Skipped** = sources deprioritized by the parameter block — chose not to, with the reason.
- Disputed items must be explicitly surfaced — never silently dropped. Enforce mechanically: `node <pack-root>/tools/gates/report-lint.mjs <report.md>`.

**Pre-delivery self-check (all must pass)**:

- What evidence would overturn this conclusion? Where is the adversarial lane's output row?
- Do all load-bearing assertions trace to primary sources? Are secondary-only ones marked "pending primary verification"?
- Freshness: key numbers ≤7 days, background ≤30 days; flag anything older as "stale" with a note.
- Is the "not found" list preserved verbatim? Was anything quietly deleted?

## 6. Anti-scrape escalation ladder (escalate in order; never retry the same rung)

On any 403/block: **go up one level; do not retry the same level.** Retrying is meaningless against a real block — measured: Reddit returned 403 to plain curl+UA, headless browsers, r.jina, and WebFetch alike = **exit-IP-level ban**; no stronger scraper gets in.

| Level | Channel | Works for | How |
|---|---|---|---|
| L0 | Official API / public JSON | Sites with an API (HN Algolia, GitHub, Reddit OAuth, any `.json` endpoint) | Use directly. Never blocked — always first choice |
| L1 | **Index layer** (bypasses live requests) | Blocked live but indexed by search engines (measured on Reddit) | The search API's `site:` syntax (e.g. `exa.web_search_exa(query: "site:reddit.com keywords")`) → titles/authors/dates/body highlights without touching the site |
| L2 | Direct fetch / chained degradation | Ordinary static pages, light anti-bot | The `fetch-hard` script (real UA direct fetch → HTML-to-text → r.jina fallback) or WebFetch |
| L3 | Change exit IP | IP-banned sites (datacenter IPs blacklisted) | **Main session only**: switch the proxy exit node and retry |
| L4 | Real browser | Heavy JS rendering, login-gated material | **Main session only**: host browser tooling or the user's real browser (cookies intact) → **save fetched content to disk** and hand the text to sub-agents |

- **Researchers may only use L0-L2**; escalate at most one level; if still blocked → stop and mark `blocked: <site> <status>` in the lane report, hand it to the main session. **Never burn budget forcing it.**
- **Channels differ per site (measured)**: `fetch-hard` succeeds on ordinary sites; on hard sites (Reddit, Zhihu) direct fetch and r.jina both return 403 — jina only works on ordinary sites. The cure for hard sites is the **L1 index layer**, not more effort at L2.
- L1 returns an **index snapshot** (may be stale): verify key assertions via L0/L2, or mark the date column as "index time".
- Sub-agents usually have no browser tools — hard sites always go "main session fetches → saves to disk → sub-agents read".

## Appendix: budget and known pitfalls (measured)

- **Real cost (4-lane low-end run; the standard tier is 5-8 lanes)**: per lane ≈84K-262K tokens (depends on pages fetched); 4 lanes ≈560K tokens total, ≈5 min wall clock (parallel) + ≈1 min arbitration. Heavy tier (10-20 lanes): ≈1.5M-4M tokens per round — check your quota before opening it.
- **Premium cost** (adversarial lane + cross-family arbitration + two rounds): ≈1.5-2.5× standard, 15-25 min wall clock; worth it when the conclusion is decision-grade.
- **Lane productivity ordering (measured)**: official docs/primary pages > GitHub READMEs/issues > community threads. EN/ZH community lanes cost the most and produce the least.
- **Reddit-class hard sites may be blocked at the exit-IP level** (curl+UA, headless browser, r.jina, WebFetch all blocked) → use the L1 index layer (readable highlights, measured); for HN use the Algolia API (hn.algolia.com/api/v1/search?query=..., never blocked); if neither works, mark "not obtained" — don't force it.
- **Bing's result page returns garbage for Chinese queries** (tokenization failure) → use Brave or English seeds for Chinese lanes.
- **"Free tier" numbers tend to hide behind 403'd pricing pages** → needs Bash+curl or a logged-in channel; if unavailable, mark "disputed: no primary source obtained".
- **Failure handling = attribute first, then act.** "Retry once" is not one rule; the three failure classes have opposite correct actions:
  - **`failed-transport`** (timeout, killed for inactivity, turn execution failed, provider 4xx/5xx): the host/provider layer owns retries. Do not burn a protocol retry — wait and re-check via the ledger. Record `mark --status failed-transport`.
  - **`failed-protocol`** (lane returned malformed output, no claims table, skipped the contract): re-dispatch **once** with a narrower scope; a second protocol failure means the brief, not the channel, is the problem → treat as `failed-definition`.
  - **`failed-definition`** (the lane's question was wrong, duplicate of another lane, or unreachable as specified): **never re-dispatch as-is.** Void the lane, void any conclusion that rested on it, and open a new lane with a corrected invariant brief.
  - Record every outcome with `tools/ledger/dispatch-ledger.mjs mark` — an unlogged failure is a silent one. Lane fetches go through fetch-hard (which carries its own timeouts) so nothing hangs.
- Channel ranking (measured): search API (mcporter/Exa) > fetch-hard (L2) > Brave/Bing result-page scraping (quality varies) > main-session browser (L4).
- Sub-agent configs are usually **session-start snapshots** in many hosts: changing a role's tools/system prompt requires a new session.
- This protocol borrowed ideas from contemporary open-source projects (red-team/claims-ledger, review isolation, etc.) — see the repo README's Related work.
