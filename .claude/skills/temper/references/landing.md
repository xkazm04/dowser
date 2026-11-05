# Landing

Each repo lands only through `T land --repo <name>`, under its own law (charter `repos[].landing`). Always run
`--dry-run` first. It prints the checks and the steps and changes nothing (bp's dry run fetches but does not rebase).
Production, tags and releases are never part of a landing. The guard denies them in every repo.

## Dowser: `loop-ff`

- `T day start` cuts `loop/<date>` from master and records the base. Each green `cycle end` records its head as the
  last green commit.
- `T land` checks, on `loop/<date>`: a clean tree, no open cycle, master an ancestor (a fast-forward is possible),
  the gates (`typecheck`, `test`, `e2e:coverage`, plus `forge:typecheck`, `forge:test` and `forge:check-shared` when
  forge/ changed, plus the charter's gates), and fixture and local e2e results newer than HEAD with a pass and no fail.
  A live fail blocks; live unverifiable does not.
- **Green:** `git checkout master`, `git merge --ff-only loop/<date>`, `git push origin master`. When forge/ changed,
  it then runs `npm run forge:build-ui`, `forge deploy -e development --non-interactive`, and
  `forge install list --json`, in PowerShell with the User-scope `FORGE_EMAIL` and `FORGE_API_TOKEN` (the token is
  never printed). More than one installation row is a failed landing (`stage: install list`); report it, because the
  deploy is live on development.
- **Red:** `git reset --hard <last green>`, where the last green is the last green cycle head that is still on the
  branch, else the day's base. The day records are put back after the reset, uncommitted. Commit them. A red day stays
  on its branch and never reaches master.

## bp: `rebase-push`

- `T repo start --repo bp` makes `temper/<date>` from origin/master, in a worktree under `~/.temper/worktrees/`.
- `T land --repo bp`: fetch, rebase onto origin/master (a conflict aborts the rebase and is red: resolve it in the
  worktree, keeping both sides' intent), then the charter's gates (`npm run check`) and the built-in secret scan of
  `origin/master...HEAD`. The scan flags an env file in the diff (never `.env.example`) and known token shapes in
  added lines, and it names only files and patterns. When all are green, it runs `git push origin HEAD:master`. When
  any is red, nothing is pushed.
- `.env` is never committed or printed.

## personas: `commit-only`

- `T repo start --repo personas --paths <globs>` runs `scripts/active-runs.mjs check` (a live conflict refuses), makes
  `temper/<date>` in a worktree, and registers the run. `T repo end` completes it. `day end` refuses while it is
  registered.
- Builders run `npm run verify:affected -- --files <files>` per item. `T land --repo personas` runs
  `npm run gate -- --cold` and records the result. It **never pushes**. The operator merges the branch.

## After a landing

`day.json` keeps each landing (`decision`, `ok`, `stage`, `pushed`, `deployed`, `target`, `reasons`). The next
morning's report shows them under "Commits and landings".
