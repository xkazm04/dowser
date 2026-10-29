# Wave 3 - 2026-10-29

Scan at d9a55e5: incremental (the first with a real base, after the sparse-checkout fix), 7 new cards (DW-24 to
DW-30), 0 dropped, $4.41. Lens states: opportunity 1, ux-friction 3, doc-drift 3, security-cra 0 (partial:
osv-scanner absent; npm audit now ran on the root, `forge` and `forge/static/app`).

## Learning loop

All 9 wave-2 verdicts (all accepted) and 7 outcomes (6 right, DW-7 partly) were pulled and applied. Opportunity
named its losers correctly: dated snooze, markdown share and time to triage were "already accepted" and not
re-proposed. **The decoy worked as intended:** DOW-77 ("scan only what changed") asks for something incremental
runs already do. Opportunity did not propose building it, and doc drift proposed documenting it instead (DW-25).

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-24 | Security docs omit that audits send package lists to advisory services | accepted, built | Real and precise; SECURITY.md and PAGE-13 now say it. |
| DW-25 | README never says later scans read only what changed | accepted, built | Real (and the honest answer to DOW-77). |
| DW-26 | SKILL.md says dependency audits read only the root | accepted, built | Real: **my DW-19 build skipped doc sync a second time**. |
| DW-27 | Audit every service, not only the first ten | accepted, built differently | A 14-service repo (DOW-15) loses 4 at a cap of 10. The cap stays, because each auditor has 60 s per directory, but it is raised to 25. |
| DW-28 | Fall back to a full scan when the last scanned version is gone | accepted, built | Real defect, which my harness bug in wave 2 exposed: force-pushes and rebases do the same. |
| DW-29 | Guided partial wording for a missing local tool | accepted, built | Real: my wave-1 wording assumed every partial lens meant "not connected". |
| DW-30 | Say why the installer needs Node 22.13 | accepted, built | Real (DOW-75, a reaction to wave 2's change). |

7 of 7 real again. Outcomes rated: DW-17 right, DW-19 partly (doc sync and the cap), DW-8, 15, 16, 20, 22, 23
right. Correction: the DW-19 outcome note cites DW-28 and DW-27, which should read DW-26 and DW-27. Outcomes are
append-only, so it stays as written.

## Built

- 632907b - **stewardship:** the mock Forge's 191-line `callTool` switch is twelve handlers behind a table, and
  quality-snapshot counts the synced `forge/src/shared` copies once.
- 7ef8450 - `run start` falls back to `full` when the base commit left the history, and says so in `fallback`
  (DW-28), with a test. XS: DW-24, 25, 26, 27, 29 and 30. **security-cra 0.2.3:** off-focus candidates fill slots
  the focused ones leave empty. This wave's scan left a high advisory (prosemirror-view, transitive in
  `forge/static/app`) in the summary with all 4 slots free, because off-focus candidates could only take rank 1-2.
- 877b9aa - `share --run` prints a run's kept proposals as markdown, with evidence by ref and no quotes (DW-21, carried).
- 7423dc9 - time to triage per push in the Learning tab, by a builder subagent under a written brief. The
  Director reviewed the diff and re-ran the forge gates (DW-5, carried, serves G-1).
- Carried: DW-9 (keep quotes local, M) and DW-18 (dated snooze, M).
- World: PAGE-13 states the advisory lookups. New tickets: DOW-79 (share with quotes), DOW-80 (a reaction to
  DW-28: warn before a fallback full scan), DOW-81 (pick the Jira project on accept, more DOW-65 demand) and
  DOW-82 (the fixture's fake key).

## Quality (wave-02 -> wave-03)

Gates green: 104 tests (+2), forge 58 tests, typecheck clean, forge build clean. Long functions 14 -> 11: one
removed by the stewardship refactor, two because the snapshot now counts synced copies once (13 by the old
definition). Duplicated windows 48 and import cycles 0: unchanged. skill/lib import edges 35 -> 38 (`share.mjs`
on store and model; `git.mjs` `hasCommit`). Agent words +172 (+0.8%). CLI commands 19 -> 20 (`share`).

## Reflection

- **The doc-sync miss is mine, and it repeats.** Twice now (waves 1 and 2) Dowser's next scan caught a doc I did
  not update after a code change. From this wave I grep the docs for the changed behaviour before committing.
  It caught nothing new this wave; the next scan will tell.
- **A lens rule hid a real finding.** Direction focus in security-cra filtered instead of ordering. Under a
  team focus, the lens kept a high advisory out of an empty budget. The fix is one sentence; the lesson is that
  a direction rule needs a test case where the budget is not full.
- **Dowser hardened against my harness.** The base-missing fallback came from a defect in my tooling, which a
  scan turned into a product defect real teams hit (rebases, force-pushes).
- **Precision stays at 100%** (30 of 30 cards real so far). The cards are getting smaller, mostly XS doc and
  wording gaps left by the previous wave. That is what a converging loop should look like, but it also means
  each scan finds less new ground. Wave 4 will show whether the lenses find structural issues once the
  surface is clean.
- **Prose stewardship is still owed.** Agent words grew in every wave (+2.3%, +1.0%, +0.8%), and nothing was
  removed. The wave-3 stewardship went to code, so prose gets wave 4's attention.
