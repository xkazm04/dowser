# Wave 7 - 2026-10-30

Scan at b3ec06b: incremental (4 commits), 8 new cards (DW-50 to DW-57), 0 dropped, $5.22.

## What the scan found

**Every card was a follow-up to wave 6**, and every one was real. Wave 6 shipped two features (dated snooze in Jira,
quote masking in card text), and wave 7 found eight gaps in them:

| Ref | Card | Verdict |
|---|---|---|
| DW-50 | Triage guide page says a Jira snooze returns "on that day"; it returns at the next scan | accepted, built (world). **The inaccurate wording was mine, written into the world in wave 6.** |
| DW-51 | SECURITY.md says withheld lines still go out in card text; they are masked now | accepted, built. **My doc sync missed it again.** |
| DW-52 | Data model says only a terminal snooze sets a date | accepted, built (the builder's doc gap) |
| DW-53 | Bulk snooze in the inbox has no date | accepted, built |
| DW-54 | Mask the line in views and confidence notes too | accepted, built |
| DW-55 | A snoozed card never shows when it comes back | accepted, built |
| DW-56 | The mask leaves broken sentences (DOW-91) | accepted, built |
| DW-57 | The dialog promises "on that day"; the truth is "at the first scan on or after it" | accepted, built |

Outcomes: DW-42 partly (DW-53, 55, 57); DW-47 and DW-49 right.

## Built

- b23b40e - the mask covers `confidence_why` and every string inside views, and reads as "the line at <path:line>"
  (backticks included). SKILL.md asks the agent to describe a withheld line in words, so the mask is only a
  backstop. SECURITY.md and data-model synced; a test for the views.
- 7e8a63c - bulk snooze takes one Until date; snoozed cards and their history say when they come back; the copy
  says what happens. Built by a builder, **who viewed the UI headless** (the bulk step, the hint, the return line;
  no console errors). It corrected my brief: the inbox renders `Detail.jsx`, not `ProposalCard`.
- World: PAGE-12 and PAGE-13 corrected. New tickets: DOW-93 (the reworded mask reads fine), DOW-94 (**the
  monorepo audit adds four minutes per scan**, a cost of wave 2's DW-19) and DOW-95 ("opportunity found nothing
  new for two scans": the convergence a real team would notice).

## Quality (wave-06 -> wave-07)

Gates green: 121 tests, forge 69 (+2), build clean. Duplicated windows 48 and import cycles 0. Agent words +31.

**A measurement blind spot, now fixed:** the long-function detector never matched `export default function`, so
React page components were invisible to it. Fixed, it finds the inbox page `Inbox` at **418 lines**, the largest
function in the repo by far, and it has grown in waves 6 and 7 (each inbox feature added to it). Long functions
11 -> 12 is that definition change alone. This is wave 9's stewardship target, and the clearest antipattern the
campaign has surfaced: a page component that accretes every feature.

## Reflection

- **The previous wave sets the next wave's work.** Wave 6 shipped two features; wave 7 spent its whole scan on
  them. Each wave builds less than it finds, and what it finds is mostly the edges of what it just built. Two
  readings: the loop is good at catching half-finished work, and my builds keep shipping half-finished (no
  guided form, no doc sync, the second surface, the test double).
- **My doc-sync guardrail failed again** (DW-51). The rule says grep before commit, and for the masking change I
  grepped for the new function's name, not for the claim the old docs made ("covers evidence only"). Grepping
  for the behaviour means grepping for the old sentence about it.
- **Dowser can't see code quality; my instrument almost couldn't either.** No lens ever proposed splitting the
  inbox page, and the snapshot missed it for seven waves. Code health is outside Dowser's lenses by design. The
  campaign's own metrics are the only thing watching it, so their blind spots matter.
