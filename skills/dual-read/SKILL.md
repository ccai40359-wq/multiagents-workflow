---
name: dual-read
description: Dual-channel document reading — the main agent reads, one subagent per file reads independently, then cross-compare (match/addition/conflict). MUST USE for close reading, analysis, or fact extraction from documents/PDFs/contracts/manuals/reports/long files — triggers include "read carefully", "don't miss anything", "cross-check", "用子agent读", "双读". Essential when extracting key facts (numbers, limits, clauses, rules). Not for browsing a table of contents, reading a code diff, or merely confirming a file exists.
---

# Dual-Channel Document Reading (Dual-Read)

Why: single-channel reading misses things. Dual-channel = the main agent reads + a subagent reads independently + cross-compare.
Measured (single environment, 5 long PDFs; numbers vary with document and environment): after the main agent's own read felt complete, the subagent still surfaced 4-5 key omissions (rule details, numeric limits, full clauses — the "you don't know what you missed until you see it" kind).

## Flow (strict order)

### 1. The main agent reads first
Run the extraction script or Read directly, and form a preliminary conclusion (document type + key-facts list). Cross-compare against your own answers — do not wait blank-minded for the subagent to feed you.

### 2. Extract to plain text (mandatory for PDF/Office)
- PDF: use fitz (PyMuPDF) to extract the full text page by page to a .txt, with page separators like `===== page N =====`; one txt per PDF.
- If your environment's path-safety policy blocks `open(variable_path)`: safe template = the script only `print()`s to stdout and you redirect with the shell (`python extract.py 1 > pdf_txt_a.txt`).
- Why: a subagent's Read cannot read binary PDFs; plain text is the robust route (convert first, then dispatch).

### 3. One subagent per file, dispatched in parallel
Send multiple Agent calls in one message (parallel, never serial).

Role choice:
- **researcher**: plain-text close reading, summaries, fact extraction (txt is the robust input; Bash availability depends on your role config)
- **general-purpose / worker-coder**: when the subagent must run scripts itself on PDF/Office/images

The subagent prompt must be self-contained (it starts from zero, cannot see the main session):
1. The txt's absolute path + how long it is and how it's segmented
2. Context: what we already know (existing knowledge base / product library / known conclusions) so the subagent doesn't treat existing content as news
3. The specific questions to answer (the more specific the better — e.g. "does the cooling-off period state a specific number of days? give the page and the sentence")
4. Output format (list-shaped, every item with a source)
5. Traceability rule: **every fact carries a page/line number; if it's not in the text, write "not found in text" — never fill in from imagination**

Long files (>50K chars): explicitly instruct "do not read linearly; Grep for keywords and read only around hits", and provide the keyword list (both languages).

### 4. Tri-classified comparison (the main agent arbitrates)
- **match**: both reads agree → high confidence, adopt directly
- **addition**: the subagent found what the main agent missed → spot-check 1-2 items against the original before adopting
- **conflict**: the two disagree → the main agent returns to the original text and arbitrates on the actual sentences — no fence-sitting, no splitting the difference

### 5. Output
- Verdict table: one row per file (match/addition/conflict + reason + page source)
- Explicitly list "additions found by the subagent" and "conflicts arbitrated" — that's the proof of the dual channel's value
- Wrap it in the pack-wide five-section shape (`REPORT-CONTRACT.md`): **Findings** = the verdict table; **Verified** = citations checked against the source text (page/line each); **Not covered** = sections unread; **Skipped** = files below the deep-read threshold. Enforce mechanically: `node <pack-root>/tools/gates/report-lint.mjs <report.md>`

## When you can skip dual-read
- Files <10K chars with no key-fact extraction (browsing, existence checks)
- Code diffs / config changes (that's the reviewer flow, not this)
- The user says "just take a quick look"

## When dual-read is mandatory
- Key-fact extraction: numbers, limits, rules, clauses, dates
- The user has questioned reading accuracy before, or said "don't miss anything / read carefully / double-check"
- The content will go into a knowledge base / product library / external material (one wrong entry = compliance risk)

---

Shares the same evidence tri-classification (match / addition / conflict) with `web-research-fanout` in this pack.
