# Report Contract

Every workstream in this pack reports in the same five-section shape. The point is
to turn "merge the reports" from prose-reading into bookkeeping: the main agent
should be able to reconcile claims across lanes, rounds, and workstreams without
re-reading anyone's narrative.

Enforced mechanically by `tools/gates/report-lint.mjs`.

## The five sections

```markdown
# Report: <task title>

## Conclusion
<One paragraph. The answer, not the journey. A reader who stops here must not be misled.>

## Findings
<The workstream's structured payload. Shape is workstream-specific — see mapping below.>

## Verified
<Every claim this run actually checked, one bullet each, ending with its evidence marker.>
- <claim> — <evidence marker>

## Not covered
<Questions this run TRIED to answer and could not. One bullet each, with the blocker.>
- <question> — blocked: <site / status code / missing source>

## Skipped
<Checks that EXIST and were deliberately not run (cost, time, budget). Never fold these into Not covered.>
- <check> — skipped: <reason> (cost: <rough price of running it>)
```

An empty section must say so explicitly (`none` / `无`) — silence is ambiguous.

## The distinction that matters

**Not covered ≠ Skipped.**

- **Not covered** = "I tried, the world wouldn't let me" — a wall was hit.
  The honest record is *what* blocked it, so a later run knows where to push.
- **Skipped** = "I could have run it and chose not to" — a decision, not a wall.
  The honest record is *why* and *what it would cost*, so the reader can price the risk.

Filing a skip under "Not covered" is the dishonest move this contract exists to
catch: it dresses a decision up as an obstacle. `report-lint.mjs` fails reports
that do it.

## Evidence markers

Every bullet in **Verified** must end with one of:

| Marker | Example |
|---|---|
| Source URL | `https://example.org/pricing` |
| File and line | `src/router.ts:88` |
| Command and exit code | `` `npm test` → exit 0 `` |
| Rendered artifact path | `out/stills/page-3.png` (visual acceptance: the page image actually inspected) |

No marker, no verified. "I ran it" is not evidence; the command and its exit code are.

## Per-workstream mapping

| Workstream | Findings | Verified | Not covered | Skipped |
|---|---|---|---|---|
| **research fan-out** | the claims table (see `examples/claims-table-sample.md`) | first-hand confirmed rows | `blocked: <site> <status>` items | sources deprioritized by the parameter block |
| **dual-read** | per-file verdict table + additions + arbitrated conflicts | page/line citations checked against the source text | sections unread | files below the deep-read threshold |
| **dev-delivery / review** | P0–P3 findings with `file:line` | gate commands run this round + exit codes | acceptance items that could not be evaluated | suites not run this round |
| **visual acceptance** | one JSON verdict line per page (unchanged) | pages actually rendered and inspected | pages with missing renders | none, normally |

## Escalation quota

A dispatched subagent may push a question back to the dispatcher at most **3 times**
per task. The question must carry the evidence it is stuck on. On the fourth miss it
must decide with what it has and record the decision under **Not covered**. This
keeps escalation an escape hatch instead of a chat channel.

---

## 中文对照

统一五段报告契约：`结论 (Conclusion)` / `发现 (Findings)` / `已验证 (Verified)` /
`未覆盖 (Not covered)` / `已跳过 (Skipped)`。标题用中英文均可，`report-lint.mjs` 两种都认。

关键区分：**未覆盖 = 试过但被世界挡住**（记录挡住你的东西：站点、状态码、缺来源）；
**已跳过 = 能跑但决定不跑**（记录原因和大概成本）。「因为嫌慢没跑」写进未覆盖 =
把决定伪装成障碍，lint 会直接拦。

已验证段每条必须带证据标记：来源 URL、`文件:行号`、或 `` 命令 → exit 0 ``。
「我跑过了」不是证据。

派发的子代理每个任务最多反向提问 **3 次**，问题必须附带卡住的证据；第四次必须
用手头信息做决定并记入「未覆盖」。
