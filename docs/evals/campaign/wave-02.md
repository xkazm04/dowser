# Wave 2 - 2026-10-29

Scan at 6ef46d0: incremental, 9 new cards (DW-15 to DW-23), 0 dropped, $3.89. Lens states: opportunity 4,
ux-friction 2, doc-drift 3, security-cra 0 (partial: forge lockfiles not audited, osv-scanner absent).

## Learning loop

All 14 wave-1 verdicts were pulled and applied (10 accepted, 2 merged, 2 snoozed). **No merged or snoozed item
came back as a new card.** No outcomes existed yet; wave-1 outcomes were rated after this scan (DW-7 `partly`,
DW-1, 2, 3, 12, 13 and 14 `right`).

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-15 | Data-model doc names store version 3; it is 4 | accepted, built | Real, unplanted. |
| DW-16 | README does not mention the triage overview or full cards | accepted, built | Real: **my wave-1 build skipped doc sync**, and Dowser caught it. |
| DW-17 | Docs say Node 22; the store needs 22.13 | accepted, built | Real, and a code defect (the installer accepted 22.0 to 22.12). Reproduced from the pre-campaign scan. |
| DW-18 | Snooze until a date | accepted, carried | Real; weak demand (4 tickets). |
| DW-19 | Audit every lockfile in a monorepo | accepted, built | Real; 9 tickets including the dogfood one. The strongest demand. |
| DW-20 | A path from the README to connecting the Jira inbox | accepted, built | Real (G-2: a judge must find it). |
| DW-21 | Share kept proposals as markdown | accepted, carried | Real; 3 tickets. |
| DW-22 | Reject reasons in plain words for guided users | accepted, built | Real. |
| DW-23 | No lens ids or paths in the new overview and full cards (guided) | accepted, built | Real: **my wave-1 overview had no guided form**. Dowser found a gap in the previous wave's change. |

Every card was real again (9 of 9). I accepted all of them: none was wrong, out of direction or too big. Next
wave I weigh value harder; a team that accepts everything teaches Dowser nothing about what it does not want.

## Built

- 9e3ff66 - SECURITY.md (DW-8, carried from wave 1): private reporting, supported versions, what Dowser stores and sends.
- f38e5b4 - harness: the clone hides the seed with a sparse checkout, so HEAD is the real commit (see below).
- 85dbe8b - Node 22.13 checked by the installer, and stated in the README, preflight, guided text and AGENTS.md (DW-17).
- 8cf5c37 - `deps` audits manifest directories up to 3 levels below the root (DW-19), with a new test. The first real
  run found 1 advisory in `forge/static/app` that no scan had seen. security-cra 0.2.2.
- 1a32716 - XS docs and guided triage (DW-15, 16, 20, 22, 23).
- Carried: DW-5 (time to triage), DW-9 (keep quotes local), DW-18 (dated snooze), DW-21 (markdown share).
- World: PAGE-11 now says 22.13. New tickets: DOW-75 (**the 22.13 check refuses a user on 22.11**, a reaction to
  this wave's change), DOW-76 (praise for the UI audit, plus a fixed-in ask), DOW-77 (scan only what changed,
  which incremental runs already do: a decoy for opportunity), and DOW-78 (praise for the plain reasons).

Policy clarification: the 3-build cap counts S-and-larger builds. XS doc and wording fixes are not capped,
because carrying them only delays a one-line change. This wave built 2 capped items (DW-17 S, DW-19 M).

## Harness finding

Wave 2 started incremental, but its stored base (the wave-1 clone's hide commit) did not exist in the new clone.
The old harness removed the seed in an extra commit, so every clone had a different HEAD. The agent noticed and
picked a stand-in base by date. Fixed in f38e5b4: a sparse checkout keeps HEAD real. Residual: `git ls-files`
still lists the hidden paths, so an agent that looks can see the seed's name. Wave 2's scan saw a slightly
wrong diff; read its "incremental" scope with that in mind.

## Quality (wave-01 -> wave-02)

Gates green, 102 tests (+1, the monorepo test). Long functions 14, duplicated windows 48 and import cycles 0:
all unchanged. skill-lib +81 lines (`deps.mjs`: directory walk, per-directory auditors, a missing tool reported
once). Agent words +205 (+1.0%): the guided Triage section, and the security-cra deps text.

## Reflection

- **Dowser reviewed my last wave.** Two of nine cards (DW-16, DW-23) were gaps in what I built in wave 1, and
  wave 1's DW-7 outcome is `partly` for exactly those. This is the loop working: a change that skips doc sync
  or one mode's rendering is caught one wave later.
- **Variance repeats.** The monorepo audit, dated snooze and Node 22.13 findings left wave 1 and came back in
  wave 2. Over two waves the important findings surface; any single scan misses some.
- **Code quality:** the one real code change (`deps.mjs`) added helpers (`manifestDirs`, `auditDir`,
  `onceNotInstalled`) instead of lengthening `runDeps`, kept root output byte-identical (the old tests pass
  unchanged) and added one test that covers the new branches. No regression in the structural numbers.
- **Risk to watch:** the agent-read prose grows every wave (+2.3%, then +1.0%) while the code barely does.
  Each build so far was cheapest as prose. Wave 3's stewardship pass should look at prose, not only code.
