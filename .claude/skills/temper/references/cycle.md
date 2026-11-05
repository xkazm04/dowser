# One cycle

`T cycle begin` prints the target, the focus, the scan commands, the triage caps and the branch. Every step below runs
in a subagent that writes its result to a file under the OS temp folder. You keep only file paths and exit codes.

## 1. Pick

The target is the least-stable module (`modules bar` -> `next`) or an approved direction slice
(`direction:<id>`). In another build repo (bp, personas), the target is a focus (`area: <path>` or
`goal: <text>`). For that, run `cycle begin --repo <name>`.

## 2. Scan

- Dowser: the `scan.dowser` command, `node tools/temper-scan.mjs --repo <dowser> --project-key <inbox> --focus "<focus>"`.
  It is one scan per cycle, and its ledger row (`~/.temper/scans.jsonl`) is the scan-yield instrument of the bar.
- Other repos: `scan.others_due` lists those with no scan today or yesterday, so each is scanned every second day,
  read-only, into its own inbox.
- A full four-lens scan costs about $8 (n=1, bp, 2026-11-05). Never call ScheduleWakeup inside a scan.

## 3. Triage (delegate:temper)

- A subagent reads every new card against the code it quotes. Accept only a card that is real (the evidence holds
  at HEAD), in direction, and inside the charter's bounds. Reject with the honest reason code. Snooze what is real but
  not now. Merge duplicates into the accepted item.
- At least 20% of decided cards are rejected or snoozed. Within the day's caps, check the verdicts file first with
  `T triage check --verdicts <file> --inbox <key>`. Exit 1 means look again for the weak cards.
- Record them live with `node tools/temper-verdicts.mjs --project-key <k> --verdicts <file>`. When it refuses with
  `forbidden` (no valid delegation in Jira Settings), the verdicts are **local only**. Put them in the cycle file with
  `recorded: "local"`. The live inbox keeps its cards undecided, and the report counts them apart.

## 4. Build

- A **QA subagent** writes the item's specs or tests first, from the card's Flow and acceptance criteria. A defect
  spec must fail on the base (the red control). It commits them alone.
- **Builder subagents** work in worktrees off the day branch (`loop/<date>`, or the repo's `temper/<date>`
  worktree from `repo start`). They never edit their item's specs. They run the repo's item gates (personas:
  `npm run verify:affected -- --files <files>`).
- Any size. An XL item is staged in slices, each slice gated and committed on its own. Merge each green slice into
  the day branch.

## 5. Simulated UAT

- Every cycle: `npm run e2e:fixture` and `npm run e2e:local`. After a deploy, also `npm run e2e:live`. Until the
  operator signs in, live reports unverifiable. That never blocks a cycle and never counts as a pass.
- The verdict is the runner's exit code and `e2e/results/<project>.json`. `cycle end` reads those files itself and
  counts only files newer than the cycle's start.
- An exploratory persona pass (a subagent playing a product person on the fixture and local UI) writes findings as
  `{title, surface, steps, expected, actual, screenshot?, spec?}`. They are filed with
  `node tools/temper-tickets.mjs file --findings <json>` (deduped by fingerprint, labelled `temper-uat`).

## 6. Update

- `node tools/quality-snapshot.mjs --label c<n> --append docs/evals/temper/quality.jsonl`
- lens-scan cover on the changed features: `node C:/Users/kazda/kiro/bp/.claude/skills/lens-scan/scripts/drive.mjs cover --lens all --root . --features <a,b>`
- Outcome ratings for items built two or more cycles ago go in the cycle file as `{ref, rating, basis}`. The basis is
  the evidence (their specs green on local and live, no finding filed). They are self-reported. The Learning tab's
  rating stays the operator's, so nothing is written to Forge.
- `T modules bar`, then the cycle file and `T cycle end`.

## The cycle file

```json
{"target": "inbox-ui", "scan": {"project_key": "dowser-temper", "created": 3, "cost_usd": 7.9},
 "verdicts": [{"ref": "DW-50", "verdict": "reject", "reason": "duplicate", "inbox": "dowser-temper", "recorded": "local"}],
 "built": [{"ref": "DW-48", "size": "M", "slice": "1/2", "commits": ["abc1234"], "specs": ["e2e/fixture/x.spec.mjs"]}],
 "uat": {"pass": 40, "fail": 0}, "findings": ["DOW-12"], "outcomes": [{"ref": "DW-40", "rating": "right", "basis": "specs green on local; no finding"}],
 "directions": [], "parked": [{"item": "DW-49", "why": "needs the operator's call on scope"}], "notes": "..."}
```

Everything in it is self-reported. `cycle end` adds what it verifies: the gates (it runs typecheck and test in
Dowser, or the repo's land gates elsewhere) and the e2e results. The row is green only when both are green.
