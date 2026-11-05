# The charter and the daily start

## Day 1: the charter dialog

The charter is the operator's standing instruction. It lives in `.temper/charter.json`. Only
`temper.mjs charter init`, run in this dialog with the operator present, writes it. The guard denies every other
write, and it asks the operator to confirm the init command itself.

The charter does **not** rank themes. Directions come from the loop's own proposals (expansion.md). A draft with a
`themes` key is refused.

Ask, one topic at a time, then write the draft JSON to the OS temp folder:

| key | ask | notes |
|---|---|---|
| `repos` | Which repos does the loop scan, and which does it build? | 1-4 entries. One is `{name: "dowser", path: <this checkout>}`. Each entry is `{name, path, inbox_key, build, landing, gates, ledger?, caps?}`. |
| `repos[].landing` | How does this repo land? | `{kind: loop-ff \| rebase-push \| commit-only, branch?, push?, deploy?}`. Dowser is `loop-ff` (loop/<date>, ff master, push, Forge development deploy). bp is `rebase-push` (temper/<date>, rebase onto origin/master, push HEAD:master only when its gates and the secret scan are clean). personas is `commit-only` (temper/<date> in a worktree, never pushed). |
| `repos[].gates` | What must be green before it lands? | Command lines, run in the repo's worktree at land time. `{run, when: "item"}` is a per-item gate the builder runs, for example personas' `npm run verify:affected -- --files {files}`. |
| `repos[].ledger` | Does the repo keep an active-runs ledger? | personas: `.claude/active-runs.md`. `repo start` checks and registers through its `scripts/active-runs.mjs`; `repo end` completes the entry. |
| `repos[].caps` | Local triage caps | `{accepts_per_day, rejects_per_day}`, default 10 / 30. They apply when an inbox has no delegation; snoozes and merges count against rejects, as in Forge. |
| `until` | When does the day end? | A local time, `YYYY-MM-DDTHH:MM`. Without it, the day is `limits.wall_min` long (default 480). |
| `limits.usage_window` | Your plan's usage window | Text only: the window itself is detected from rate-limit errors (long-run.md). |
| `out_of_bounds` | Anything the loop must not touch? | Paths or topics. Production deploys, tags and releases are always off limits; the guard enforces that. |
| `delegation` | Which inboxes did you delegate in Jira Settings, and until when? | `{<inbox_key>: {until}}`. Remind the operator: Jira, Dowser, Settings, "Delegated triage", once per inbox. Without it, triage is recorded locally only. |
| `live.profile` | The live sign-in profile | Default `~/.temper/chrome-profile`. Sign in with `node e2e/live/sign-in.mjs`. Until then, the live suite is unverifiable. |

Then run (bash form; PowerShell: `$env:TEMPER_CHARTER_DIALOG='1'; node ...`), with nothing chained:

```
TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs charter init --from <draft.json> --operator "<name>"
```

The command refuses to run without `--operator` (exit 2) and outside the dialog (exit 1). Show the operator the
stored charter (`T charter show`).

## Every morning: the start dialog

1. `T report --date <yesterday>` writes `docs/evals/temper/<yesterday>.md` from the ledger, including the landing.
   Show the "Needs you" section first, then the rest.
2. Ask the report's `questions`, at most three, in this order: the delegation (expired, expiring, or local-only
   verdicts), the direction approvals, the live sign-in, and the parked items. The rest wait under "Also waiting".
3. Record the operator's direction answers through
   `TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs day start --approve a,b --veto c`. The
   operator may reorder directions by approving only the first. Approvals given in any other way are refused.
4. When the operator changes the standing instruction (a repo, the end time, a delegation date), run charter init
   again with the new draft.
