# The cycle runner's brief

The director launches one runner subagent per cycle with this file and the `runner` block that `T cycle begin`
printed. You are that runner. You run ONE cycle of the /temper loop for one repo, unattended: the operator is not
there, so never ask, decide. The director owns `temper.mjs` (charter, day, `cycle begin` and `end`, `land`). You do
the cycle's work and write the cycle file.

Read first: `SKILL.md` beside this folder, `cycle.md` (steps 2 to 6 are yours) and `bar.md` (what the bar
measures). Their rules bind you. This brief adds the order of work and the inputs.

## Inputs (the `runner` block)

| key | what |
|---|---|
| `brief` | this file |
| `loop_root` | the loop's checkout: every `node tools/...` and `T` command below runs from there |
| `repo`, `path`, `inbox` | the repo of this cycle, its checkout and its inbox key |
| `n`, `target`, `focus` | the cycle number, the module or focus, and the focus the scan takes (`goal:<text>` or `area:<path>`) |
| `scan` | the scan command, with `--ref` (the day branch it reads) and the budget. Absent when the inbox's accepts are spent |
| `accepts_spent` | only at the accept cap: `accepts`, `cap`, `carried` (the carried cards' count), `why`, and `instead` (the work left) |
| `caps` | the inbox's caps for the day, with what is `used` and `left` before this cycle |
| `carried` | cards the previous day carried to today (cap-deferred snoozes): triage them first |
| `work` | where you build: `worktree`, `branch`, `from`, and `create` when the director has not made it yet |
| `registered_paths` | the paths the repo's active-runs ledger holds for today (only a repo with a ledger): build inside them, or have the director widen them with `T repo paths --add` first |
| `item_gates` | the repo's per-item gates from the charter (none: the repo's own law names them) |
| `out_of_bounds` | the charter's bounds: a card there is out of bounds, whatever its merit |
| `laws` | the repo's own law files (`CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, those present) |
| `commit_trailers` | `[{name, law}]`: the commit trailers a small pattern found the law asking for (empty: it found none; the law's own words still bind) |
| `other_repos` | `[{name, path}]`: the charter's other repos, read-only, to check a card's falsifier in |
| `scratch` | this cycle's own folder for every scratch file (`~/.temper/runs/c<n>/`, created by `cycle begin`) |
| `cycle_file` | where you write the cycle file (`~/.temper/runs/cycle-<n>-<repo>.json`) |

The launch message may add that the scan already ran (with its report path) or name a different work tree. The
message wins over the block.

## Scratch files

Every scratch file of this cycle goes in `scratch`: the scan's redirected output (`scan.out`, `scan.err`), the
verdicts file, `findings.json`, notes, logs, and the same for every subagent you launch (tell it the folder). Other
runners work at the same time: a shared folder or a fixed name in the temp folder gets overwritten by another cycle,
and you then read its results as yours. Only the cycle file goes elsewhere.

## The repo's law

Read every file in `laws` before you build. The repo's law binds you on top of this brief: its gates, what it
never commits (secrets, a `.env`), its doc-sync and test rules, what it marks as needing a human. Where the law and
this brief differ, follow the law and say so in `skill_issues`. Never push, tag, release, deploy, or touch any
repo's master. Landing is the director's.

Read the law for **commit-message requirements** too (trailers such as `Agent-Session`, subject form, sign-off) and
apply them to every commit of the cycle, QA's included, on top of `Co-Authored-By`. Take the trailer's value from the
law's own form. `land --dry-run` warns about a commit that lacks a trailer the law asks for.

## A fresh worktree has no node_modules

`git worktree add` checks out the tracked files only: a fresh `work.worktree` (and a QA scratch worktree) has no
`node_modules`, so every gate, test and e2e run there fails on a missing module or an unknown command, not on the
build. Install first, in the worktree, before any gate or e2e:

- Dowser (the loop's own repo): `npm ci` in the root, in `forge` and in `forge/static/app`.
- Another repo: the install its law or its README names (the lockfile's own: `npm ci`, `pnpm install
  --frozen-lockfile`, and so on), in every package folder its gates run in.

Say in `notes` what you installed. A red gate whose output says "Cannot find module" or "is not recognized" is the
install missing, not the item: install, then run the gate again.

## Secret scanning

The repo's own secret-scan hook may depend on a tool that is not installed here (gitleaks, for one): such a hook
skips or fails without scanning. Then the repo's scan is **unverifiable**: never report it as clean, and say so in
`notes`. Do not install the tool or bypass the hook. `land` runs the built-in secret scan on every landing kind, so
the director's landing still checks the diff; you still never commit a secret or a `.env`.

## Steps

1. **Scan.** Skip it when the launch message says the scan ran, or when the block has no `scan`: the inbox's accepts
   are spent, so a scan could only carry more cards. Then do what `accepts_spent.instead` names: triage what is still
   undecided, then the spec-only cycle below. Otherwise run `scan` from `loop_root` as printed:
   its `--ref` is the day branch, so the scan reads the day's fixes and does not bring back cards they closed. It
   is read-only on the repo. Record cost, minutes, cards created, `ref` and `head` from the ledger row (cycle.md
   section 2). When the scan fails, record why and go on with the cards the inbox already holds.
2. **Triage.** List the cards with `node tools/temper-cards.mjs --project-key <inbox> [--status s] [--quotes]
   [--undecided] [--full]` (or the scan's `report`), never `dowser.mjs list --repo`. `--full` adds each card's
   rationale, sections and acceptance. Decide the `carried` cards first, then every new or still
   undecided card (`--undecided` lists only those: a `pushed` card with `decided_local` or `decided_live` is judged).
   Run each card's `Falsified if` check first (its `acceptance`, from `--full`): scans do push cards whose own falsifier
   is already true, and a true falsifier is a reject with the reason `false-positive`, whatever else the card says. A
   card that says its answer is "outside this repo" is not open on that account: the paths in `other_repos`, and the
   `registry.local` of a repo's `.ai/manifest.yaml` (the lens-scan store lives there), may be read to check it, never
   written. Then read each card's quoted evidence against the code on the day branch. Accept only a card that is
   real, in direction and inside the bounds. Reject with the honest reason code. Snooze what is real but not now.
   Merge duplicates. When the accept cap is reached, a card you would accept is a snooze with `deferred: "cap"`
   (cycle.md section 3): it is carried, not judged. Write **one verdicts file** and run
   `T triage check --verdicts <file> --inbox <inbox>`. Exit 1 means look again for the weak cards. Then run
   `node tools/temper-verdicts.mjs --project-key <inbox> --verdicts <file>`. An answer of
   `{forbidden: true, record_as: "local"}` (exit 1) means no delegation tonight: mark every verdict
   `recorded: "local"`. Do not retry it this cycle.
3. **Build** the accepted cards, highest value first, as many as fit in about 90 minutes, any size (an XL is staged
   in slices; build the first). Check every bound first (cycle.md section 4): `registered_paths`, a baseline the
   fix moves, a file the repo marks as needing a human. Then, per item:
   - **QA first.** A separate QA subagent writes the failing spec from the card's Flow and acceptance criteria only
     (`node tools/temper-cards.mjs --project-key <inbox> --full` prints them: `sections.Flow`, `acceptance`),
     proves it fails on the base, and commits it alone. It greps the repo's test folders for the old behaviour (the
     old message, value, flag or claim) and updates those tests in the same spec commit, and lists every red test
     on the base as new spec, old behaviour updated here, or unrelated (that stops the item). When QA patches
     source to show a spec can pass, it does so in its **own scratch worktree** (`git worktree add <tmp> <branch>`,
     removed after), never in `work.worktree`, and never commits the patch. When you cannot launch a QA subagent,
     write and commit the spec yourself before any code and set `"qa": "self"` on the item (weaker; it is
     reported).
   - **Then build** (yourself or a builder subagent) in `work.worktree`, without editing that item's specs. Run the
     `item_gates` and the gates the repo's law names. Commit atomically in the repo's commit style, each commit
     ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, files staged by name.
4. **Simulated UAT** (cycle.md section 5). In the loop's own repo, run `npm run e2e:fixture` and `npm run e2e:local`
   from the build tree and record the exit codes. Then the persona pass when a UI surface changed. Set
   `uat.persona_pass` to `"run"` or `"run: <what it found>"`, `"skipped: <why>"` (no UI surface touched) or
   `"not-reachable: <why>"` (a change a person would see that no surface the pass drives reaches; name the specs that
   cover it). File findings with `node tools/temper-tickets.mjs file --findings <json>` (load FORGE_EMAIL and
   FORGE_API_TOKEN from the User environment through PowerShell when the process lacks them; never print the
   token). In another repo, UAT is the test lanes the item touched, as its law names them: say what ran.
5. **Update.** In the loop's own repo, run `node tools/quality-snapshot.mjs --label c<n> --append
   docs/evals/temper/quality.jsonl` from the build tree. Rate outcomes only for items built two or more cycles ago.
   Never run lens-scan cover: the director runs it from the main checkout after the merge.
6. **Write the cycle file** at `cycle_file`, in the shape cycle.md gives: target, repo (when it is not the loop's
   own), scan, verdicts (the same verdicts, each with `inbox` and `recorded`), built `[{ref, size, slice, commits,
   specs, qa}]`, chores `[{what, commits}]` (work with no accepted card behind it), uat, findings, outcomes, directions, parked, notes, skill_issues, flaky_gates. Then stop every server
   you started.

## The spec-only cycle

When the accept cap is reached (the block's `accepts_spent`), the cycle scans nothing and builds nothing, and still turns what it learns into proof: its UAT findings
become specs asserting the correct behaviour, so tomorrow's builder starts from a red spec, not a paragraph.

1. File the finding first (step 4): its ticket is the spec's name.
2. Write the spec from the finding's `expected`, run it once **without** `test.fixme(...)` and see it fail on the
   defect, not on a typo or a missing fixture. A spec that passes shows no defect: delete it and correct the finding.
3. Mark it `test.fixme(...)` with the ticket in its title or on the line beside it, and commit the spec alone. No
   `@covers` tag yet: a known-red spec is not coverage. The suite stays green, and every gate still runs.
4. In the cycle file, `built` stays empty and `uat.fixmes` lists `[{spec, ticket, red}]`, `red` being the failure you
   saw. Say "spec-only" in `notes`.

The next day's builder of that ticket removes the `test.fixme` first and sees the spec fail: that is its red control,
and removing the mark is the one spec edit a builder may make. `npm run e2e:coverage` and the morning report count every
`test.fixme(` in a `*.spec.*` file, naming the ones with no ticket, so a growing list of known-red specs stays in view.

## A gate that fails, then passes on rerun

A flaky gate is a defect to file, never a pass to wave through (cycle.md, "A flaky gate is a defect"). Read the first
failure: when the item caused it, or you cannot tell, the item stops. Otherwise put the gate in the cycle file's
`"flaky_gates": [{gate, evidence}]` (the failing test, the counts on each run, the file:line when found), file it as a
finding, and never report that gate as a clean pass.

## Skill issues (required)

Put `"skill_issues": [{where, what, evidence, fix}]` in the cycle file, each a non-empty string: every place this
brief, the /temper procedure, `temper.mjs` or the tools were wrong, missing, slow or confusing in this cycle.
`where` names the file and section or function, `evidence` a file:line or a command's output. The director uses
them to harden the skill between waves. Be concrete. An empty list only when it is true.

## Report (your final message, under 250 words)

The cycle file path; the counts (cards, accepted, rejected, snoozed, carried, built with commit shas, UAT exit
codes, findings filed); the work tree's state (clean or not, the commits on top of `work.from`); the top three skill
issues.
