# Wave 6 - 2026-10-30

Scan at 13a3be7: incremental (4 commits, 18 files), 6 cards verified: **3 folded by the scan into items the team
already accepted**, 3 new (DW-47 to DW-49). 0 dropped, $5.88.

## Learning loop

New cards per wave: 14, 9, 7, 6, 10, 3. The scan now finds what changed since the last one, and it merges its own
findings into accepted work instead of re-proposing them. That is the fingerprint and `similar` step doing its job
on a store with 46 decided items.

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-47 | CLI help lists two preferences; the README names a third | accepted, built | Real: my DW-9 doc sync missed the CLI help. |
| DW-48 | Signed releases: the G-3 outcome with no work behind it | snoozed | Real, but release work (DW-10, DW-11) waits on the release plan. Consistent with the wave-1 snoozes. |
| DW-49 | The Learning tab reports a one-decision push as "Decided in 0 min" | accepted, built | Real: a flaw in wave 5's DW-41 definition. |

Outcomes: DW-37 right; DW-41 partly (DW-49); DW-38, 39, 40, 43, 44, 45, 46 right. Refs were listed before any note
was written, and none is wrong this wave.

## Built

- 0d06b31 - **stewardship: `store.mjs` (788 lines) splits into `store-core.mjs`, `proposals.mjs` and `runs.mjs`
  behind a facade**, by a builder under a "pure move" brief: bodies moved verbatim, every import site unchanged,
  no test edited, no import cycle (core <- proposals <- runs). `sql` became exported, the one private helper two
  modules share.
- 802bdb3 - XS: DW-47, DW-49.
- ea48a8f - **DW-42 (carried): dated snooze in the Jira inbox**, carried to the skill, by a builder. It found what
  the brief and the card missed: a woken item is re-pushed with unchanged evidence, and Forge reopened snoozed
  items only on new evidence. So a dated Jira snooze would never have come back, while the skill showed it as
  pushed. Fixed in `push.mjs`, with a test. It also handled the time-zone edge: "after today" uses the earliest
  zone, "the day has come" the latest. **Director follow-up: the mock Forge did not mirror the reopen**, so the
  campaign's own inbox would have diverged from real Forge. The mock now matches.
- Same commit: `quotes=omit` also masks quoted lines repeated in card text (the DW-43 carry-over), with a test.
- World: PAGE-12 (dated snooze in Jira). New tickets: DOW-89 (praise), DOW-90 (bulk snooze has no date, a gap the
  builder flagged), DOW-91 (**the mask reads oddly mid-sentence**, a fair reaction to this wave's guard) and DOW-92
  (old runs, a second store-growth ticket).

## Quality (wave-05 -> wave-06)

Gates green: 120 tests (+5), forge 67 (+6), typecheck clean, build clean. Long functions 11, duplicated windows 48,
import cycles 0. `store.mjs` is off the largest-files list. skill/lib import edges 39 -> 47: the facade's
`export *` lines and the three modules importing core and model directly. That is more edges for less coupling,
because each module now imports only what it uses; the metric counts edges, not coupling. Agent words +80
(references: triage.md's Jira snooze).

Watch list: `validateCandidate` grew 81 -> 88 lines (wave 4's wire mode); `sync.mjs` 539 -> 550 (the verdict date
and the text mask); `forge/static/app/src/routes/inbox/index.jsx` 658 is now the largest file. Wave 9's stewardship
picks one.

## Reflection

- **Builders find seams I miss, and I still have to cross-check them.** The DW-42 builder found the reopen gap in
  real Forge. I found that its own test double (the mock) had not followed. A change that crosses a seam has three
  places to change: both sides and every test double of either side. Briefs now list the doubles.
- **Pure-move refactors delegate well under a strict brief.** "No renames, no reformatting, tests pass unchanged"
  gave a reviewable result in one pass. The builder even had to work around the snapshot (it reads `git ls-files`,
  so it cannot see uncommitted new files) to report true numbers.
- **Every build now invites a reaction ticket.** DOW-91 says the quote mask reads oddly. The beta world is doing
  what real users do, and Dowser will tell whether it proposes the follow-up.
