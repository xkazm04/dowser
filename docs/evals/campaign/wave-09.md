# Wave 9 - 2026-10-30

Scan at 212f8aa: incremental (5 commits, 23 files), **2 new cards** (DW-63, DW-64), 0 dropped, $4.27. Opportunity
proposed nothing; security found nothing. New cards per wave: 14, 9, 7, 6, 10, 3, 8, 5, 2.

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-63 | Data-handling docs promise interrupted-scan text is dropped after a day | accepted, built | Real and precise: it is dropped by the first scan that starts more than a day later, so with no later scan it stays. My wave-8 SECURITY.md sentence overstated the code. |
| DW-64 | Guided wording for the "abandoned" notice | accepted, built | Real: **the fifth guided-form miss**. DW-61 was built before I promoted the rule into the overlay. |

Outcomes: DW-62 partly (it crashed, see below); DW-61 partly (DW-63, DW-64); DW-58 and DW-60 right. The DW-59
rejection was applied, and no Rovo card came back.

## Built

- **fd853dd - a crash I shipped in wave 8, found by a builder.** My DW-62 hint in the accept dialog read `inbox`,
  a variable that exists only inside a `useEffect`, so opening Accept blanked the page. The build was green, and
  `forge:typecheck` does not cover `static/app`. The inbox-split builder found it while running its before/after
  fixture script. I re-ran that script after the fix (accept works, the hint renders) and viewed the dialog.
  **Dowser never saw it**: no lens runs the UI, so a runtime crash is invisible to a static scan. The spark overlay
  now requires a fixture render for every UI change.
- **212f8aa - stewardship: the 418-line `Inbox` component splits** into four hooks (data, verdicts, focus, keys) and
  five components (list, reading pane, dialogs, toolbar, states). `Inbox` is 103 lines. The builder ran a Playwright
  script on the fixture UI before and after: 8 screenshot pairs pixel-identical, console identical.
- 2f20487 - DW-63, DW-64.
- 20ca931 - the spark overlay's Gates and Repo law now carry the campaign's recurring lessons: render UI changes
  in the fixture; give every runner-facing output its guided form; doc-sync by grepping the old claim; a seam
  change updates every test double and the seam test.
- World: PAGE-13. New tickets DOW-99 (the inbox works as before after the refactor) and DOW-100 ("Dowser finds only
  a couple of follow-ups now: what should we scan next?").

## Quality (wave-08 -> wave-09)

Gates green: 123 tests, forge 69, build clean, and the fixture UI exercised. Duplicated windows 48, import cycles 0.
**Long functions 12 -> 15, while the longest function fell 418 -> 114.** Splitting one 418-line function left
several functions of 60 to 107 lines, each over the threshold. A count over a threshold penalises exactly the
refactor it should reward. The row's `longest` list tells the true story. forge-ui +145 lines: the imports, props
and file headers a split costs. Agent words +35.

## Reflection

- **Convergence.** Two cards, both edges of last wave's work. On a codebase this size, with this world, the
  lenses have little left that is new. DOW-100 asks the right question for a real team: point Dowser at the next
  repo, or scan less often.
- **The most serious defect of the campaign was invisible to Dowser and to every gate**, and a builder doing an
  unrelated refactor found it, because its brief required a behaviour check. Dowser reads code and docs. It does not
  run the product, so runtime defects belong to tests and fixture renders, not to the lenses. The campaign proves
  both halves are needed.
- **Metrics need a maximum, not only a count.** The long-function count rose because of the stewardship it was
  meant to encourage. The campaign's final report reads `longest` and the count together.
