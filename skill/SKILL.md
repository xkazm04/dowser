---
name: dowser
description: "Use when someone types /dowser, asks what the product should build next, or wants evidence-backed backlog proposals from the repository they have checked out. /dowser [goal: <text> | area: <path or feature>] scans the current git repo through four lens packs - Opportunity, UX friction and wellbeing, Doc drift, Security and CRA - and produces at most 16 verified, fingerprinted backlog proposals, each a card with title, rationale, quoted evidence, effort range, confidence, doc impact and delivery risk. The runner pre-triages the cards (keep, reject with a reason, snooze, merge); survivors go to the Dowser inbox in Jira when the Dowser Forge tools are connected. Triage verdicts feed a per-project memory outside the repo, so later scans skip what was rejected and follow accepted rules. Two modes: dev (dense, evidence inline) and guided (plain language, for product people). Never edits the scanned repo."
argument-hint: "[goal: <text> | area: <path>]"
category: workflow
memory: user
version: 0.1.0
tags: backlog, product-discovery, triage, scan, jira
---
# Dowser

Dowser finds what a product should do next. It reads the checked-out repository through four
lenses, joins what it reads with tickets, pages and goals when Jira and Confluence are connected,
and writes backlog proposals that each carry their evidence. A person decides what happens to
every proposal. Dowser never decides for them.

Read this file top to bottom on every run. The details live in `references/` and `lenses/`.
Load them when a step names them.

## Where things are

- **Skill directory (`<skill-dir>`)** is the folder that contains this `SKILL.md`. Resolve it
  once, at the start, as an absolute path. Do not use any harness variable for it.
- **The only door to memory** is `node <skill-dir>/scripts/dowser.mjs <command> ...`. It prints
  JSON on stdout. The JSONL output of `propose` is the one exception.
- **The repo** is `git rev-parse --show-toplevel` from the runner's working directory. Pass it to
  every call as `--repo "<repo>"`.
- **Work files** (candidate JSONL files and saved tool responses) go in a temp folder outside
  the repo: `<os-temp>/dowser-<run_id>/`. Never write them inside the repo.

## Exit codes - assert on every call

| Code | Meaning | What you do |
| --- | --- | --- |
| 0 | ok | continue |
| 1 | partial (some lines invalid, some items refused) | read the output, report each refused line, continue |
| 2 | bad input or refused move | read the stated reason and current status; fix the input, or report the refusal; never retry blindly |
| 3 | store or connection unavailable, or the command is not built yet | stop that step; report it in plain words; never write the store any other way |

Check the exit code after every `dowser.mjs` call. A call whose code you did not check counts as
a failed step.

## Arguments

- none: sweep every lens over the repo.
- `goal: <text>`: a focused scan. Every lens judges against this goal. Pass it as
  `--focus "goal: <text>"`.
- `area: <path or feature>`: a focused scan limited to that part of the code. Pass it as
  `--focus "area: <path>"`.

A focused scan is **partial** by definition. Its summary says so and never says "all clear".

## 1. Mode - dev or guided

Run `prefs get mode verbosity`. If `mode` is absent, ask the runner once:

> How should Dowser talk to you? **Developer** (dense, file and line inline) or **Guided**
> (plain language, evidence behind "show evidence")?

Ask the runner with your harness's multiple-choice question tool if it has one, else with a
numbered list. Store the answer with `prefs set mode=dev` or `prefs set mode=guided`. Do not
ask again on later runs. The runner can say "switch to guided" at any time; store it the same way.
`verbosity` (default `short`) sets how much of each card triage shows (`references/cards.md`
"Rendering"); "compact" or "full cards" stores `prefs set verbosity=short|full`.

Both modes run the same pipeline. Only what you print differs. Guided rules (vocabulary,
preflight wording, ask-why) are in `references/guided-mode.md`. Load it now if mode is `guided`.

## 2. Preflight - before anything is written

Check these in order. On a failure, give **one** plain fix (guided: the exact wording in
`references/guided-mode.md`) and stop cleanly. Never start a run you already know will fail on
its environment halfway through.

1. **Inside a git repo.** `git rev-parse --show-toplevel` exits 0. If `git --version` fails
   too, git itself is missing: say that, not "not a project folder".
2. **Node 22.13 or newer.** `node --version` reports v22.13 or higher (the store needs `node:sqlite`).
3. **Memory reachable.** `dowser.mjs init --repo "<repo>"` exits 0. Keep `project_key` and `db`
   from its output. A code 3 means the memory folder cannot be written. Say so and stop.
4. **Forge connection.** Look in your own tool list for tools named `dowser_sources_tickets`,
   `dowser_sources_pages`, `dowser_sources_goals`, `dowser_proposals_push` and
   `dowser_verdicts_pull`. Harnesses add a server prefix (`mcp__dowser__`), and a non-production
   Forge install adds an environment suffix (`_development`, `_staging`), so match on the name
   with either added. Use whatever full names you found for every call below.
   - All five are present: **connected**. Two more are optional: `dowser_areas_push` (when it
     is missing, skip only the areas step, section 8) and `dowser_reflect_sync` (when it is
     missing, skip only the reflect steps, sections 3 and 8; rules are then decided locally
     and no outcomes arrive). A third, `dowser_direction_get`, is optional too: when it is
     missing, skip only the direction step (section 4).
   - Any is missing: **unconnected**. Tell the runner, before scanning, which lenses will be
     partial and why. Opportunity runs on code and docs only, at low confidence. Doc drift checks
     in-repo docs only. UX friction runs without user reports. Proposals stay local and are not
     pushed. Unconnected is a valid way to run. Do not stop for it.

## 3. Pull verdicts first (connected only)

Memory must reflect Jira before the scan, so a rejection made in Jira suppresses the item today.

1. Call `dowser_verdicts_pull` with `{project_key, cursor}`. Take the `cursor` from the
   `verdicts_cursor` field of the `init` output; omit `cursor` when that field is absent.
2. Save the tool response verbatim to `<work>/verdicts.json`.
3. Run `ingest-verdicts --file <work>/verdicts.json`. Exit 1 means some verdicts could not be
   applied (an unknown fingerprint, or a conflict). List them in the summary. Never force them.
   An accepted verdict carries the Jira issue the person created (`issue_ref`, `issue_url`). Show
   that issue key and link next to the card in the summary.

4. **Reflect** (skip when `dowser_reflect_sync` is missing). This brings back what people
   decided about the rules offered on an earlier run, and how accepted items turned out once
   built. Run the reflect sync below. Rules it accepted reach this run's `context`, and the
   outcomes show which patterns were accepted but turned out wrong.

**Reflect sync.** The order is `rules offer` -> `reflect export` -> call `dowser_reflect_sync` ->
`reflect ingest`. `rules offer` is the only command that creates offers, and the runner is shown
each new offer once, in section 7 step 5. So `rules offer` runs there and **not** here: the sync
in this section starts at `reflect export`, and the one in section 8 comes after the offers were
presented.

1. `reflect export`. It prints the tool arguments `{project_key, rules_json?, more?}`:
   the rules still `offered` (oldest first, at most 50, each with up to 10 titles of the items
   behind it). `rules_json` is omitted when nothing is offered. Call the tool anyway: decisions
   and outcomes come back in the same response. Export is read-only and repeatable.
2. Call `dowser_reflect_sync` with every field except `more`, exactly as printed. Save the
   response verbatim to `<work>/reflect.json`.
3. `reflect ingest --file <work>/reflect.json`. It prints
   `{rules_applied, rules_skipped, outcomes_added, outcomes_seen}`. A rule that is no longer
   `offered` locally is skipped, never overwritten, so a replay changes nothing. Exit 1 means an
   entry was malformed (listed under `invalid`); the rest is applied.
4. Report in one line: rules decided in Jira (accepted ones with their wording), new outcomes.
   Guided mode: "People rated N finished items since the last scan."

A rule the runner decides in the triage dialog (section 7) is decided locally; Forge's later
decision for the same rule is skipped. Whichever is first wins.

When the pull tool errors, say "could not read decisions from Jira" and go on unconnected for
the push step too. A half-synced memory must not push.

## 4. Start the run

1. Run `status --runs 20`. Pick the mode:
   - `focused` when `goal:` or `area:` was given;
   - `full` when no run has finished yet, or when the last full run is 14 or more days old.
     Label the second case "full re-anchor";
   - `incremental` otherwise.
2. Run `run start --mode <mode> --harness <claude-code|codex|other> --model <your model id>`,
   adding the same `--focus` value for a focused run. Keep `run_id`, `mode`, `base_sha` and
   `head_sha`. When it prints `fallback`, the last scanned version is gone from the history
   (a force-push or rebase): the run is `full`. Say so at once, before any lens starts, because
   a full scan takes longer (guided: "Dowser will read the whole project this time, because the
   version it read last time is no longer in the project's history."), and again in the summary.
3. An incremental run scans what changed: `git diff --name-only <base_sha>..<head_sha>`, plus
   the files those import, plus any doc that names them. If that list is empty, every lens is
   `ran` with zero emitted, and the summary says no code changed since the last scan.
4. **Direction** (connected only; skip silently when `dowser_direction_get` is missing). This
   is what the team set in Forge Settings for each lens of this inbox. Call
   `dowser_direction_get` with `{project_key, lens: "all"}`. Always send `lens`. Save the
   response verbatim to `<work>/direction.json` and run
   `ingest-direction --run <run_id> --file <work>/direction.json`. It prints
   `{run_id, lenses, skipped?}`. Exit 1 means a lens's direction was malformed (listed under
   `skipped`); the rest is cached. When the tool answers `unknown-project` (no push yet) or any
   other error, go on without direction. Every pack works without one. Do not tell the runner
   unless they asked.

## 5. Per lens

The lenses, in this order: `opportunity`, `ux-friction`, `doc-drift`, `security-cra`. Run them
one after another. If your harness has parallel subagents, each lens may gather and judge in a
subagent that returns its JSONL text. Only the main agent calls `propose`, one lens at a time.

For each lens, print one progress line (`<lens>: gathering (tickets 42, code)`), then:

1. **Load the pack.** Read `<skill-dir>/lenses/<lens>.md`: its frontmatter (`id`, `version`,
   `kinds`, `sources`, `requires_connection`, `budget`) and its body.
2. **Context pack.** Run `context --run <run_id> --lens <lens>`, adding `--focus` on a focused
   run. It returns `suppressed` (fingerprints never to re-propose), `near` (known items, so you
   do not re-word one into a "new" proposal), `rules` (accepted runner rules for this lens, which
   bind like the pack's own rules), `exemplars` (accepted proposals as the bar to match),
   `outcomes` (`{right, partly, wrong}`: how this lens's accepted items fared once built, absent
   when none was rated), `budget` and `since_sha`. Many `wrong` or `partly` outcomes mean the
   lens's accepted patterns did not deliver: propose fewer of that kind and say what makes this
   one different.
   `direction` (absent when the team set none) is the team's steer for this lens. Judge against
   it: `focus` narrows Gather and the hypotheses to those topics first; `exclude` removes any
   candidate on those topics before `propose`; `notes` is the team's intent, read it the way you
   read the pack's own guidance. A local `--focus` applies on top of it for this run only.
3. **Sources (connected only).** Call the lens's source tools named in its pack, with queries
   built from the pack's hypotheses. For `doc-drift`, when `direction.spaces` is set, call
   `dowser_sources_pages` once per space key with `space` set to it. Save each response verbatim to
   `<work>/<lens>-<type>.json`, then run
   `ingest-sources --run <run_id> --type ticket|page|goal --file <that file>`. Cite only the
   `ref` values it returns as `ticket`, `page` or `goal` evidence. For tickets it also returns
   `components`, `labels` and `created_at` when Jira has them: use them to group tickets for a
   demand table, and cite the ticket refs themselves.
   **Dependencies (security-cra).** Run `deps --run <run_id>`. It runs the dependency auditors this
   machine has (`npm audit` for a `package-lock.json`, `osv-scanner` for a lockfile it reads,
   `pip-audit` for `requirements*.txt` or `pyproject.toml`) in the root and in each manifest
   directory up to three levels below it, read-only, 60 s each, and caches every finding on the
   run. Directories it did not audit are listed under `not_audited`. Its output lists each auditor as `ran` (with `found`) or
   `skipped` (with `reason`). Cite only the `ref` values it returns as `dep` evidence. A skipped
   auditor is a gap: record the lens as `partial: <auditor> skipped (<reason>)`. Never report "no
   vulnerable dependencies" for an auditor that did not run.
4. **Gather tolerantly.** Do the pack's gather steps. A missing file, an empty grep or a source
   that errors is recorded and the lens goes on. It never aborts the run. Record each gap in
   one of three states: `ran` (every source available), `partial: <which source was missing and
   what that left unchecked>`, or `skipped: <reason>` (nothing to read at all, for example no
   UI code for UX friction).
5. **Read once, then judge.** Read the gathered files and collect evidence first. Form no
   verdict while you are still reading. Then walk the pack's **named hypotheses** one by one.
   For each one, say what you pointed it at (files, greps, tickets) and what you found. A
   hypothesis you did not point at anything is not covered. Do not count it.
6. **Write candidates.** Write each finding as one JSON line in `<work>/<lens>.jsonl`, in the
   card form in `references/cards.md`, with `lens`, a `kind` from the pack's `kinds`, a `topic`
   per the pack's naming rule, and `anchors`. Before writing a line, compare it with `near`.
   If it is the same work as a known item, reuse that item's `topic` and `anchors` exactly, so
   it lands as `evidence-grew` and not as a re-worded duplicate. `propose` itself answers
   `suppressed` for a fingerprint the memory holds back.
7. **Budget.** At most `budget` (4) lines per lens, and at most 16 per run. Rank by evidence
   strength times impact. Lines beyond the budget are **not written**. Count them as
   `truncated` for this lens, and keep their titles for the summary's "top N of M" line. Never
   drop silently.
8. **Propose.** Run
   `propose --run <run_id> --file <work>/<lens>.jsonl --kinds <lens>=<k1,k2,...>`, with the kinds
   copied from the pack's frontmatter. Each output line is `created`, `evidence-grew`,
   `suppressed`, `duplicate` or `invalid:<why>`. Exit 1 means some lines were invalid: fix those
   lines once and re-propose only them. A line that is still invalid is reported, not dropped
   silently.
9. **Progress line:** `<lens>: emitted <n>` (plus `, truncated <t>` when it applies). Guided:
   the wording in `references/guided-mode.md` "Progress"; this applies to every count line below.

A lens whose pack says `requires_connection: true` still runs unconnected, as `partial`, on code
and docs. Its candidates use `confidence: low` and name the missing source in `confidence_why`.
A lens is never reported as zero findings when it did not run. `skipped` and `partial` always
carry a reason.

## 6. Verify, then judge near-duplicates

1. Run `verify --run <run_id>`. It re-reads every `code` and `doc` quote at its path, and checks
   that every `ticket`, `page`, `goal` and `dep` ref was ingested by THIS run (`ingest-sources`
   or `deps`). Found quotes and ingested refs move the item to `verified`. A missing quote drops
   it with `verify-failed:<ref>`; a ref the run did not ingest drops it with
   `ref-not-ingested:<type>:<ref>` (an unconnected run ingests no tickets, pages or goals, so such
   a card never verifies). `git` and `sarif` evidence passes unchecked; the output says so. Print
   per lens: `<lens>: emitted <n>, verified <v>, dropped <d>`.
2. For each dropped item, look at why. If you mis-copied a line, fix the quote in a new
   candidate line, re-propose it and re-verify it once. Do not loop.
3. For each verified item, run `similar <fp>`. For each hit, judge whether the two describe the
   **same work** (same capability or defect, same place). Wording overlap alone does not count.
   - Same work, and the hit is open (`candidate`, `verified`, `pushed`) or `accepted`:
     `move <fp> --to merged --into <hit fp> --by agent:<harness>`. Tell the runner in the
     triage batch that it was folded in.
   - Same work, and the hit is `rejected` or `snoozed`: do **not** merge or reject it yourself.
     Show it in triage with "looks like <hit title>, <status> on <date> as <reason>". The
     runner decides.
   - Distinct: do nothing.

## 7. Pre-triage dialog

Load `references/triage.md` (statuses, moves, reason codes) and `references/cards.md`
(rendering). Then:

1. First show one overview table of every verified item: number, lens, title, size,
   confidence. Then show them in batches of at most 4 cards, rendered for the mode and
   `verbosity` (`references/cards.md` "Rendering"). The runner can keep or reject from the
   overview directly, or open any card by its number.
2. For each card, ask the runner, with the multiple-choice tool if your harness has one, else
   a numbered list:
   - **Keep**: no move. It stays `verified` and is pushed when connected.
   - **Reject**: ask for the reason code (guided: as the plain questions in
     `references/guided-mode.md` "Triage") (`false-positive`, `already-known`,
     `not-our-direction`, `not-worth-it`, `wrong-size`, `other`). `other` needs a short note:
     ask for it, and do not record the move without it. Record with
     `move <fp> --to rejected --by human:<name> --reason <code> [--note "<text>"]`.
   - **Snooze**: `move <fp> --to snoozed --by human:<name>`. It comes back only when its
     evidence grows.
   - **Merge**: ask into which item (a card in this batch or a known item), then
     `move <fp> --to merged --into <fp> --by human:<name>`.
3. Offer **"keep the rest"** at every batch. It ends the dialog with every remaining card
   kept, and no move is recorded for them.
4. `<name>` is the runner's name as they give it, or `runner` if they decline. Never record a
   human decision the runner did not make in this dialog.
5. **Rule offers.** After the dialog, run `rules offer`. Present each new offer **once**, as its
   draft text and the items it came from. The runner can accept it (optionally edited:
   `rules accept <id> --by human:<name> --text "<edited>"`), or decline it
   (`rules decline <id> --by human:<name>`). Do not offer a declined rule again. `rules offer`
   never returns it.

**Dowser never marks anything `accepted`.** Acceptance is a human act in Jira. If the runner
explicitly says, while offline, "accept this one", record
`move <fp> --to accepted --by human:<name>`. Never infer acceptance from "keep", from silence,
or from "looks good".

## 8. Push (connected only)

1. Run `outbox --run <run_id>`. It prints the tool arguments
   `{project_key, run_id, proposals_json, repo_url?, head_sha?, more?}`. `proposals_json` holds
   the verified, un-rejected items that were not pushed yet, plus pushed items whose evidence
   grew, at most 50 per call.
2. If `proposals_json` is `"[]"`, skip to step 6.
3. Call `dowser_proposals_push` with every field except `more`, exactly as printed. Do not edit
   them. Save the response verbatim to `<work>/push.json`.
4. Run `ingest-push --file <work>/push.json`. Exit 1 means some were refused. List each refused
   item with its `why`. They stay local and go out on the next push.
5. If the outbox printed `"more": true`, go back to step 1. Stop when `more` is absent.
6. **Areas** (skip when `dowser_areas_push` is missing). Run `areas --run <run_id>`, call
   `dowser_areas_push` with its output exactly as printed, and check the response is `{stored}`.
   There is no ingest step. This feeds the inbox's map of where the code changes most. If it
   errors, say so in one line and go on. Guided mode: "Dowser also sent a summary of which parts
   of the project change most often."
7. **Reflect** (skip when `dowser_reflect_sync` is missing). Run the reflect sync from
   section 3 again. The rule offers from section 7 step 5 now go to Forge, where a person can
   accept or decline them; their decision arrives on the next run's section 3. If the call
   errors, say so in one line and go on; the offers stay `offered` locally.

When the push tool errors, say so in plain words. Items stay `verified` locally and go out on
the next connected run. Never retry in a loop. A push puts items in the Dowser inbox in Jira; the
Jira issue appears only when a person accepts the item there.

## 9. Finish and summarize

1. Write the lens report to `<work>/lenses.json` and run
   `run finish --run <run_id> --lenses @<work>/lenses.json`. The `@` form avoids shell quoting.
   The JSON maps each lens to
   `{"state":"ran|skipped|partial","reason":"...","emitted":n,"verified":n,"dropped":n,"truncated":n}`.
   Omit `reason` only for `ran`. Omit a count only when it was never measured (a skipped lens
   has no `verified`). Never write 0 for a count you did not measure.
2. Print the summary:
   - the run's mode and scope (`full`, `full re-anchor`, `incremental since <date>`, or
     `focused on <goal/area> - partial`);
   - per lens: state, verified count, and "top N of M" when truncation happened;
   - skipped and partial lenses, each with its reason (guided: "Summary wording" in
     `references/guided-mode.md`);
   - triage outcome: kept, rejected, snoozed, merged; pushed, with inbox links when connected;
     accepted items with their Jira issue key and link;
   - unapplied verdicts and refused pushes, if any.
3. **No proposals is not "all clear".** Say what ran, against what, and what was skipped or
   partial, for example: "No proposals. Opportunity ran on code and docs only (not connected),
   UX friction and Security ran in full, Doc drift was partial (no Confluence)." Never write
   "all clear", "no issues" or "everything looks good".
4. **Share.** When the runner asks to share or export the results ("as markdown", "for a doc"),
   run `share --run <run_id>` and print its `markdown`. It lists evidence by ref, without
   quoted lines. Dev: as is. Guided: reword it with the vocabulary of `references/guided-mode.md`
   (lens names in words, no version ids, file paths or fingerprints). Do not save it into the
   project.

## 10. Ask-why

Any time after a run, when the runner asks why a proposal exists ("why this one?", "where did
that come from?"), run `show <fp>` and answer **only** from what it returns: the card, every
evidence row, and the transition history. Do not rescan or re-read the code to answer. If the
stored evidence does not answer the question, say so and offer a new scan. To find the `fp`,
use the card list printed in this session. In a later session, ask the runner which card they
mean, by its title or its Jira link.

## Invariants

- **Never edit, stage, commit or push the scanned repo.** No file is created inside it: no work
  files, no caches, no notes. Dowser reads it and runs read-only git commands only.
- **The agent never writes the store directly.** All memory goes through `dowser.mjs`. Never
  open the database file, run SQL, or hand-edit `~/.dowser`.
- **Never self-approve.** Only a human accepts, rejects, snoozes or merges into another person's
  item. The agent records a merge only for a same-work duplicate (section 6).
- **Unmeasured is not zero.** A lens that did not run is `skipped` with a reason. A source that
  was missing makes the lens `partial`. A value you did not compute is omitted, never `0` and
  never `null`.
- **Every claim quotes its evidence.** `code` and `doc` evidence quotes a line verbatim, and
  `verify` re-reads it. A proposal without evidence is not written.
- **Budget is fixed and disclosed.** 4 per lens and 16 per run, with "top N of M" whenever
  something was cut.
- **Exit code asserted on every script call.**

## References

- `references/cards.md` - the card: fields, five body sections, evidence rules, effort and
  confidence anchors, dev and guided rendering.
- `references/triage.md` - statuses and moves, reason codes, snooze, merge, resurfacing, rules,
  exemplars.
- `references/guided-mode.md` - preflight wording, vocabulary, ask-why patterns.
- `references/lens-authoring.md` - how a lens pack is built, versioned and forked.
- `lenses/opportunity.md`, `lenses/ux-friction.md`, `lenses/doc-drift.md`,
  `lenses/security-cra.md` - the four packs.
