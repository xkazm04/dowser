---
name: temper
description: "Use when the operator types /temper, or asks to start, resume or end the daily loop (the daily perfection loop) in the Dowser repo. /temper runs one long session a day: a morning report and at most three questions, then Scan -> Triage -> Build -> Simulated UAT -> Update cycles until the charter's end time, the usage window or the 8 h wall. It stabilizes each Dowser module to a measured bar before it proposes new directions, triages as delegate:temper (locally when an inbox has no delegation), builds on day branches, and lands each repo only under that repo's own landing law when green. Never production, tags or releases."
version: 0.1.0
argument-hint: "[resume | end]"
---

# /temper - the daily loop

You are the **director** of one temper day. You orchestrate only. Subagents do all the work (scans, triage reading,
QA specs, builds, UAT), and they write their results to files. You read state from disk at the start of every cycle,
never from memory. `T` below is `node .claude/skills/temper/scripts/temper.mjs`. It prints JSON and exits 0 (done),
1 (refused or red) or 2 (bad arguments). Act on the exit code and the JSON, not on what a subagent says.

These are operator and loop surfaces, not Dowser runner surfaces, so they have no guided-mode form. The Dowser
scans that the loop starts keep theirs.

## 0. Start

1. `T day resume`. When it answers, this is a killed day: go to section 1 at its `next` (references/long-run.md).
2. When there is no charter (`T charter show` exits 1), run the day-1 charter dialog (references/charter.md).
   Otherwise run the daily start dialog: `T report --date <yesterday>`, show the report, and ask its `questions`
   (at most 3). Record the answers about directions with the exact start-dialog form:
   `TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs day start --approve a --veto b`.
   The guard asks the operator to confirm it. Without direction answers, run plain `T day start`.
3. Commit the records that rode onto the new branch: `chore(temper): the <yesterday> records`.
4. For each other repo with `build: true`, run `T repo start --repo <name> [--paths a,b]`. A repo with a ledger
   (personas) needs `--paths`, and its `check` must pass. Sibling sessions are active there.

## 1. Cycle (repeat)

1. `T clock`. When `drain` is true, go to section 2. When `rate_limited_until` is set, follow the wait in
   references/long-run.md.
2. `T modules bar`. Pick the target: an approved `direction:<id>`, else the bar's `next` module. A build in another
   repo is `--repo <name> --target area:<path>` (or `goal:<text>`; no space after the colon).
3. `T cycle begin --target <t> [--repo <r>]`, then run the cycle as references/cycle.md says. Its steps are scan,
   triage, build, simulated UAT and update.
   Each repo has its own open cycle (`.temper/cycle-<repo>.json`), so a bp cycle can run beside a Dowser one. Cycle
   numbers stay unique across repos for the day.
4. Merge the runner's branch into the day branch first: `cycle end` then runs the gates and e2e itself on the merged
   tree (the runner's own results are self-reported). Write the cycle file (with its `repo` when it is not Dowser),
   run `T cycle end --file <cycle.json> [--repo <r>]`,
   and commit `docs/evals/temper/`
   (`chore(temper): cycle <n> record`). When the red was environmental (a stale `node_modules`, a dead server) and
   the cause is fixed, `T cycle reverify --n <n>` re-runs the same gates and e2e on that cycle's unchanged tree
   (references/cycle.md). Otherwise, on exit 1 (red), revert this cycle's build commits (`git revert`) so the
   branch is back at the last green tree, and park the item with its reason.

## 2. Day end

1. Finish or abandon every open cycle (`T cycle end --repo <r>` for each). Never leave one open: `day end` and `land`
   refuse while any repo has one.
2. `T modules bar`, then `T report`, then commit the records.
3. `T land --dry-run --repo <name>` for each repo, then `T land --repo <name>` (Dowser last). See
   references/landing.md. Then `T repo end --repo <name>` for each started repo.
4. `T day end`. The landing results appear in the next morning's report.

## Rules that do not bend

- Land only through `T land`. The guard denies production deploys, `forge deploy` without `-e`, tags, releases,
  force pushes and any push that a repo's landing does not permit (dowser master and `loop/*`, bp master, personas
  nothing).
- The charter and direction answers are the operator's. Write them only through the start dialog's exact command.
- No gate grades itself: a QA subagent writes the failing specs first, and the builder never edits them. UAT verdicts
  come from runner exit codes and result files, in three states. Unverifiable is never a pass.
- Triage is honest: real reason codes, a reject or snooze share of at least 20% (`T triage check`), the day's caps,
  and accepts only for cards you checked against the code and that are in direction.
- Scans are read-only. Only the charter's `build: true` repos get builds, and each lands under its own law.

References: charter.md (the dialogs), cycle.md (one cycle), bar.md (the stability bar), landing.md (land and
rollback), expansion.md (directions and new lenses), long-run.md (context, rate limits, the clock, resume).
