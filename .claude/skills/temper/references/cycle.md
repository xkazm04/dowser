# One cycle

`T cycle begin` prints the target, the focus, the scan commands, the triage caps, the branch and the `runner` block.
The runner subagent runs the steps below from references/runner.md and that block, and it writes the cycle file to the
block's `cycle_file`. Every step runs in a subagent that writes its result to a file. You keep only file paths and
exit codes.

## 1. Pick

The target is the least-stable module (`modules bar` -> `next`) or an approved direction slice
(`direction:<id>`). In another build repo (bp, personas), the target is a focus, and `cycle begin --repo <name>`
needs one as `--target`. Two forms are accepted, written exactly as the lens-scan store takes them:

- `area:<path>`: a path that exists in the repo's day worktree, for example `area:scripts/lib`.
- `goal:<text>`: a goal in words, for example `goal:faster triage` (quote it in the shell).

There is no space after the colon: the store refuses `goal: text`, so `cycle begin` refuses it too and names the
form to write. Any other prefix, an empty goal or an area path the worktree lacks is a usage error (exit 2).

## 2. Scan

- Dowser: the `scan.dowser` command, `node tools/temper-scan.mjs --repo <dowser> --project-key <inbox> --ref loop/<date> --focus "<focus>"`.
  Run the printed command as is: its `--ref` is the day branch (`loop/<date>`, or a started repo's `temper/<date>`),
  so the scan reads the day's fixes and does not bring back cards they closed. The ledger row's `ref` and `head` say
  what was scanned. It is one scan per cycle, and its ledger row (`~/.temper/scans.jsonl`) is the scan-yield instrument of the bar.
  The row's `report` names `~/.temper/scans/<stamp>-<inbox>.json`: the row, the scan's summary and every card it
  created or moved (`{fp, ref, status, lens, title, evidence, created}`). The clone is deleted after the scan.
  While it runs, stderr gets a heartbeat every 60 s (`temper-scan <inbox>: <n> min elapsed, last step: <tool> ...`): no
  heartbeat for several minutes means a hung scan, not a slow one. Run it in the background and watch stderr.
- Other repos: `scan.others_due` lists those with no scan today or yesterday, so each is scanned every second day,
  read-only, into its own inbox. An inbox whose accepts are spent is not listed.
- **No accepts left, no scan.** A scan's cards can only be carried once the inbox's accepts are at the cap, so
  `cycle begin` drops that inbox's scan command and answers `accepts_spent` (`accepts`, `cap`, `carried`, `why`,
  `instead`) in both the answer and the runner block: triage what is undecided, then the spec-only cycle, or a repo with
  accepts left. `--scan-anyway` keeps the command. `T clock` answers `inboxes_spent` and `all_inboxes_spent`; when every
  build inbox is spent, the day ends early (SKILL.md section 1) and the report's Summary gives the reason.
- What a scan costs, measured from `~/.temper/scans.jsonl` (all 15 rows of 2026-11-05, every one `ok`; n is small, so
  these are the first night's evidence, not constants):

  | inbox | scan | n | cost min / median / max | minutes min / median / max |
  |---|---|---|---|---|
  | bp | full | 1 | $7.86 | 33 |
  | bp | focused | 4 | $3.92 / $4.23 / $4.64 | 10 / 11 / 15 |
  | dowser | focused | 6 | $2.91 / $4.07 / $5.26 | 9 / 11 / 12 |
  | personas | full | 1 | $4.02 | 9 |
  | personas | focused | 3 | $4.67 / $5.24 / $5.37 | 14 / 14 / 14 |

  Budget a focused cycle at $4 to $5.50 and up to 15 minutes, per repo as above. No full Dowser scan ran. The two full
  rows are one run each and disagree by a factor of two, so plan a full scan at the $8 budget it runs under. Never call
  ScheduleWakeup inside a scan.

## 3. Triage (delegate:temper)

- List the cards with `node tools/temper-cards.mjs --project-key <inbox> [--status s] [--quotes]` (or the scan's
  `report`). `--full` adds the rationale, impact, effort, confidence, the body's sections (Flow, Expected impact) and
  `acceptance` (the Evaluation section): hand that to the QA step, so it quotes the card instead of inventing criteria.
  A card the store keeps `pushed` may already be judged: each row carries `decided_local` or `decided_live`
  (`{verdict, cycle}`, from the day ledger), and `--undecided` lists only the cards with no verdict yet. Not `dowser.mjs list --repo <path>`: the scan keys the store by the inbox key (the clone's origin is set to
  it), so the real checkout maps to another project and lists nothing.
- **The falsifier first.** Each card's own `Falsified if` check (the Evaluation section, `acceptance` in `--full`) runs
  before anything else, and a true falsifier is a reject as `false-positive`. Scans push such cards (DW-176, 2026-11-05).
  The charter's other repo paths (the block's `other_repos`) may be read to check one, and a card that says "outside
  this repo" is checked there before it is carried (DW-151 and DW-156, closed by one grep of a sibling checkout).
- A subagent reads every new card against the code it quotes. Accept only a card that is real (the evidence holds
  at HEAD), in direction, and inside the charter's bounds. Reject with the honest reason code. Snooze what is real but
  not now. Merge duplicates into the accepted item.
- At least 20% of the cards decided today in each inbox are rejected or snoozed: the floor is per inbox per day,
  over the day's earlier verdicts plus this file (a card decided again counts once, at its newest verdict; a merge stays out of the share but counts against the
  reject cap), so a cycle
  that decides one or two good cards is not pushed into a dishonest reject. Within the day's caps, check the verdicts file first with
  `T triage check --verdicts <file> --inbox <key>`. Exit 1 means look again for the weak cards.
- **The rejects cap counts snoozes and merges.** Forge counts a day's rejects, snoozes and merges together against
  `rejects_per_day`, and so do `triage check`, `cycle end` and the runner block's `caps.used.rejects` and
  `caps.left.rejects`: a snooze or a merge spends the rejects cap as a reject does (`today.rejects_by` and
  `caps.used.rejects_by` tell them apart, so `rejects` reads as the cap's spend, not as cards rejected). A `deferred: "cap"` snooze does
  not: it is counted as `carried` (below), outside both the cap and the floor.
- One verdicts file serves both tools: `[{ref, verdict, reason?, note?, into?, until?, inbox?, recorded?, deferred?}]`.
  `reason` is a reject's code only (model.mjs REASONS); a snooze or an accept says why in `note`. `inbox` (when given)
  must be the inbox checked, and `recorded` is `live` or `local`; temper-verdicts checks both and never sends them.
- **Carried to tomorrow.** A real card that you would accept, but the day's accept cap is reached, is a snooze with
  `deferred: "cap"` (and a `note`). It is counted apart, as `carried`: it does not count toward the reject-or-snooze
  floor or the rejects cap, because the cap made the call, not the triage. It is valid only once the inbox's accepts
  today reach the cap (`triage check` and `cycle end` refuse it under the cap). The report lists these cards under
  "Carried to tomorrow", and the next day's start dialog asks about them first. Forge still records a live one as a
  snooze. `deferred` is a ledger key too: checked, never sent. When an inbox's accepts reach the cap, the report's
  Needs you says so with the numbers and asks the operator for real caps in the charter (`repos[].caps`; a charter
  that set none runs on the defaults, 10 accepts and 30 rejects a day). Several inboxes at their cap make one
  question that lists them all.
- Record them live with `node tools/temper-verdicts.mjs --project-key <k> --verdicts <file>`. When it answers
  `{forbidden: true, record_as: "local"}` and exit 1 (no valid delegation in Jira Settings), the verdicts are **local
  only**. It remembers the answer for the inbox for the day, so later cycles get it without a `claude -p` call; pass
  `--retry` once the operator has set up a delegation. Put them in the cycle file with
  `recorded: "local"`. The live inbox keeps its cards undecided, and the report counts them apart.

## 4. Build

- **Check every bound before QA starts**: the registered paths (`repo paths --add` first), a baseline the fix moves
  (personas: `scripts/census/rules.json`), a file the repo marks as needing a human. A spawned QA subagent cannot be
  stopped mid-run, only messaged at its next tool round, so a bound found later leaves a committed red spec.
- A **QA subagent** writes the item's specs or tests first, from the card's Flow and acceptance criteria. A defect
  spec must fail on the base (the red control). It commits them alone.
- **Old behaviour in existing tests.** A behaviour change makes the tests that encode the old behaviour fail, and the
  builder may not edit specs. So QA greps for them before it commits: the old message, value, flag or claim the
  card changes, across the repo's test folders (Dowser: `skill/scripts/tests/`, `forge/test/`, `e2e/`). It updates
  each one in the same spec commit, then runs the whole affected suite on the base and lists every red test as
  "new spec", "encodes the old behaviour, updated here" or "unrelated: stop and report". A red test in the third
  group stops the item.
- One QA subagent per cycle writes every item's specs, one commit per item: QA agents in one shared worktree fight
  over the index and one spec file. QA never patches source in the shared worktree (and never restores it with
  `git checkout` there). When it patches source to show a spec can pass, it does so in its own scratch worktree
  (`git worktree add <tmp> <branch>`, removed after) and never commits the patch: that the spec turns green on the
  build is the builder's to show.
- A pure docs card (doc drift inside the registered paths) has no natural test file. Its spec is a declared
  acceptance command (a quote or grep check that fails on the base and passes after), written by the QA subagent
  before the build and listed in `built[].specs` as the command, with `qa` saying who wrote it.
- **Builder subagents** work in worktrees off the day branch (`loop/<date>`, or the repo's `temper/<date>`
  worktree from `repo start`). They never edit their item's specs (a `test.fixme` mark they remove as the red control is the one exception). They run the repo's item gates (personas:
  `npm run verify:affected -- --files <files>`).
- At the accept cap, a cycle may be spec-only: findings become specs proven red once, then marked `test.fixme(...)`
  naming their ticket (runner.md, "The spec-only cycle"). `e2e:coverage` and the report count them.
- Any size. An XL item is staged in slices, each slice gated and committed on its own. Merge each green slice into
  the day branch.
- **Merge first, then verify.** The runner builds in its worktree, and its gate and e2e results there are
  self-reported. The director merges the runner's branch into the day branch in the main checkout first. Only then
  does `cycle end` run the gates and e2e itself on the merged tree. That run is the independent check, and it is the
  only one that can make the row green. Results left in the worktree's `e2e/results/` (gitignored) or its
  `docs/evals/temper/quality.jsonl` are never read.

## 5. Simulated UAT

- Every cycle: `npm run e2e:fixture` and `npm run e2e:local`. Dowser's `cycle end` runs both itself in the main
  checkout after the merge (once: not again when a charter land gate already runs them). After a deploy, also
  `npm run e2e:live`. Until the operator signs in, live reports unverifiable. That never blocks a cycle and never
  counts as a pass.
- The verdict is the runner's exit code and `e2e/results/<project>.json`. `cycle end` reads those files itself, in the
  main checkout, and counts only files newer than the cycle's start.
- An exploratory persona pass (a subagent playing a product person on the fixture and local UI) runs when the cycle
  touched a UI surface (`forge/static/app/`, or a route or resolver a spec covers). A cycle that changed none (a
  CLI-only module, `"uat": "tests"` in modules.json) skips it and says so in `uat.persona_pass`
  (`"skipped: no UI surface touched"`).
- `"not-reachable: <why>"` is the state for a change a person would see, but that no UI surface the pass can drive
  reaches: a server-only message or refusal the fixture bridge never produces, a Jira issue or comment body that the
  local Jira double neither refuses nor renders. Name the paths and say which specs cover them instead. It is
  neither a pass nor a skip: nobody walked the change. When a reachable UI path also changed, run the
  pass on that path.
- `uat.persona_pass` is one of `"run"` (or `"run: <what it found>"`), `"skipped: <why>"` or `"not-reachable: <why>"`;
  `cycle end` refuses any other form. The pass writes findings as
  `{title, surface, steps, expected, actual, screenshot?, spec?}`. They are filed with
  `node tools/temper-tickets.mjs file --findings <json>` (deduped by fingerprint, labelled `temper-uat`).

## 6. Update

- `node tools/quality-snapshot.mjs --label c<n> --append docs/evals/temper/quality.jsonl`
  When no row was written since the cycle began, `cycle end` runs this itself (Dowser cycles only), so the bar's
  quality part fills on a fresh day without relying on this step. The row's `verified.quality` says `present`,
  `appended`, `no row written` or `failed`; a failed snapshot never makes the cycle red.
- lens-scan cover on the changed features, run by the director **from the main checkout, after the merge**:
  `node C:/Users/kazda/kiro/bp/.claude/skills/lens-scan/scripts/drive.mjs cover --lens all --root . --features <a,b>`.
  It writes the lens-scan store in `.ai/lens-scan/`, which is gitignored and exists only in the main checkout (a
  worktree has none), so a runner in a worktree never runs it. It calls Claude, so its cost comes out of the day's
  budget.
- Outcome ratings for items built two or more cycles ago go in the cycle file as `{ref, rating, basis}`. The basis is
  the evidence (their specs green on local and live, no finding filed). They are self-reported. The Learning tab's
  rating stays the operator's, so nothing is written to Forge.
- `T modules bar`, then the cycle file and `T cycle end`.

## Reverify an environmental red

A red caused by the environment, not by the build (the main checkout's `node_modules` predated a merge, a dev server
held a port), is not fixed by reverting the build. Fix the cause, then run `T cycle reverify --n <n> [--repo <r>]`.

- It runs exactly what `cycle end` runs (dependency sync, gates, fixture and local e2e) on that cycle's tree, and
  reads only e2e results written after it started.
- HEAD must be the cycle's recorded head, or past it only by record-only commits (changes under
  `docs/evals/temper/`), and the tree must be clean outside the records. Anything else is refused: end a new cycle.
- It appends a `kind: "reverify"` row (`head`, `of_head`, `before`, `green`, `red_because`, `verified`). The cycle's
  row is never rewritten. The newest verdict per cycle is what the bar, `report` (as "reverified at ...") and `land`
  (the rollback target) read. A green reverify moves the day's last green to HEAD.
- A gate whose output names a missing module or an unknown command is recorded as `<gate> failed (environmental:
  module not found | command not recognized)` (`verified.env` keeps the cause). A red whose only reasons are such
  (or a failed `npm ci`, with e2e results missing beside them) and that a later green cycle of the same repo answers
  at its head or a descendant reads in the report as "red (environmental?) superseded by c<m> green", not an open
  red. Any other reason keeps it open.
- A repo without e2e suites (bp, personas) reports its verified UAT as the land gates `cycle end` ran itself:
  "verified gates n passed of m (c<k> p/q, ...)", never "none".

## A flaky gate is a defect

A gate that fails and then passes on a rerun with no change is a flaky gate (a fixed wait in a test, a port race). It
is a defect to file, never a pass to wave through: the rerun's green proves nothing about the first failure. Read the
failure to see whether the item caused it. If it did, or you cannot tell, the item stops. If not, the build goes on,
and the gate goes in the cycle file's `flaky_gates: [{gate, evidence}]` (`evidence`: the failing test, its counts on
each run, and the file:line that causes it when found) and is filed as a finding. `cycle end` checks the shape; the
report lists them under Needs you, or Also waiting past the three questions.

`cycle reverify` is for a cause you fixed. A red it turns green with no cause fixed is a flaky gate: name it in the
next cycle file's `flaky_gates`.

## The cycle file

```json
{"target": "inbox-ui", "scan": {"project_key": "dowser-temper", "created": 3, "cost_usd": 7.9},
 "verdicts": [{"ref": "DW-50", "verdict": "reject", "reason": "duplicate", "inbox": "dowser-temper", "recorded": "local"}],
 "built": [{"ref": "DW-48", "size": "M", "slice": "1/2", "commits": ["abc1234"], "specs": ["e2e/fixture/x.spec.mjs"]}],
 "uat": {"pass": 40, "fail": 0}, "findings": ["DOW-12"], "outcomes": [{"ref": "DW-40", "rating": "right", "basis": "specs green on local; no finding"}],
 "directions": [], "parked": [{"item": "DW-49", "why": "needs the operator's call on scope"}], "notes": "...",
 "skill_issues": [{"where": "temper.mjs cycleEnd", "what": "...", "evidence": "file:line or a run's output", "fix": "..."}],
 "flaky_gates": [{"gate": "npm run check:x", "evidence": "151/152 then 152/152, no change; a fixed 2.5 s wait at x.ts:177"}],
 "chores": [{"what": "the README's section on the ledger, asked for by the director", "commits": ["9fef33e"]}]}
```

The top-level keys are closed (an unknown one is a usage error). Inside them a runner may add informational keys,
stored as written. These are known and type-checked:

- `scan`: `cost_usd` and `minutes` (numbers), `turns` (a whole number), `run_id` (text), `ref` (the branch scanned, the ledger row's `ref`), `head` (the commit
  scanned), `pushed` (the refs pushed to the inbox) and `lens_states` (text, each lens's state).
- `built[]`: `slice` ("1/2"), `commits` and `specs` (lists), `qa` (who wrote the specs, e.g. `subagent`).
- `chores`: `[{what, commits}]`, work with no accepted card behind it (a docs task the director asked for). `built[]`
  is keyed by a card's ref, so such a commit has no place there. `what` is non-empty and `commits` a non-empty list of
  commits; `cycle end` checks both, and the report lists them under Chores.
- `uat` is free-form, and all of it is self-reported: the runner's own e2e counts, its gate results, where its
  result files are and `persona_pass` (its state, section 5). `cycle end` checks only the form of `persona_pass` and
  trusts none of it.

`skill_issues` is what the runner learned about the loop itself (this skill, its scripts, the brief). Each entry
has exactly `where`, `what`, `evidence` and `fix`, each a non-empty string. `cycle end` stores them in the row's
`self_reported`, and `report` lists them in its "Skill issues" section, grouped by `where`, newest first.

Everything in it is self-reported. `cycle end` adds what it verifies: the gates (it runs typecheck and test in
Dowser, or the repo's land gates elsewhere) and the e2e results. The row is green only when both are green.

Before the gates, Dowser's `cycle end` checks root, `forge` and `forge/static/app` for dependency drift: a
`package-lock.json` whose packages are not those in `node_modules/.package-lock.json` (a merge added or bumped a
dependency) gets `npm ci` there first. The row's `verified.deps` says `in sync`, `installed` or `failed` per folder.
A failed `npm ci` makes the cycle red with that reason.
