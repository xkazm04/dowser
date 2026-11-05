# Landing

Each repo lands only through `T land --repo <name>`, under its own law (charter `repos[].landing`). Always run
`--dry-run` first. It prints the checks and the steps and changes nothing (bp's dry run fetches but does not rebase).
Production, tags and releases are never part of a landing. The guard denies them in every repo.

## Dowser: `loop-ff`

- `T day start` cuts `loop/<date>` from master and records the base. Each green `cycle end` records its head as the
  last green commit.
- `T land` checks, on `loop/<date>`: a clean tree, no open cycle, master an ancestor (a fast-forward is possible),
  the gates (`typecheck`, `test`, `e2e:coverage`, plus `forge:typecheck`, `forge:test` and `forge:check-shared` when
  forge/ changed, plus the charter's gates), the built-in secret scan of `master...loop/<date>` (`checks.secret_scan`;
  a hit is red), and fixture and local e2e results newer than HEAD with a pass and no fail. A live fail blocks; live
  unverifiable does not.
- **Dependencies first.** Before the gates, `land` (dry run included: it touches only `node_modules`) checks root,
  `forge` and `forge/static/app`: when a folder's `package-lock.json` is not what its `node_modules/.package-lock.json`
  says is installed, it runs `npm ci` there (`checks.deps`). A failed `npm ci` is a reason not to land. Cycle 1 of
  2026-11-05 went red only because the main checkout's root `node_modules` predated a merge that added
  `@playwright/test`.
- **Green:** `git checkout master`, `git merge --ff-only loop/<date>`, `git push origin master`. When forge/ changed,
  it then stops leftover vite dev servers, runs `npm ci --prefix forge`, `npm ci --prefix forge/static/app` and
  `npm run forge:build-ui` (see below), then `forge deploy -e development --non-interactive`, and
  `forge install list --json`, in PowerShell with the User-scope `FORGE_EMAIL` and `FORGE_API_TOKEN` (the token is
  never printed). More than one installation row is a failed landing (`stage: install list`); report it, because the
  deploy is live on development.
- **Install and build before the deploy.** A deploy ships what is installed and built at that moment. On 2026-11-05 a
  deploy went out with a stale UI bundle because `npm ci --prefix forge/static/app` failed on files that leftover vite
  dev servers held open. So the landing first stops every vite dev server whose command line is inside this checkout
  (Windows: `Get-CimInstance Win32_Process` for node.exe, each stopped by its PID with its child tree; a `vite build`,
  vitest, and other checkouts are left alone), records their PIDs (`stopped_vite`), then installs both packages and
  builds the UI. A server that does not stop (`stage: stop vite`), a failed `npm ci` (`stage: npm ci --prefix <dir>`)
  or a failed build (`stage: build-ui`) ends the landing there: master is pushed, nothing is deployed, and the landing
  is `ok: false`. Fix the cause (stop the server, rerun the install), then deploy by hand from master only with the
  operator's go-ahead.
- **Red:** `git reset --hard <last green>`, where the last green is the last green cycle head that is still on the
  branch, else the day's base. The day records are put back after the reset, uncommitted. Commit them. A red day stays
  on its branch and never reaches master.

## bp: `rebase-push`

- `T repo start --repo bp` makes `temper/<date>` from origin/master, in a worktree under `~/.temper/worktrees/`.
- `T land --repo bp` refuses only while bp's own cycle is open (another repo's open cycle does not block it, so it
  can land as soon as a bp cycle is green). Dowser's `land` still waits for every repo, because it switches the
  checkout that holds all the day records.
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
- `T repo paths --repo personas --add a,b` widens the registered paths for a later cycle. It runs
  `active-runs.mjs check --json` on the new paths (a live entry of another session refuses, before anything is
  written), then, because the ledger script has no update command and is its only writer, completes the day's entry
  and registers it again under the same slug with every path. The day keeps one active entry. `day.json` records the
  paths; a day started before it did needs `--paths <the paths given at repo start>` as well.
- Builders run `npm run verify:affected -- --files <files>` per item. `T land --repo personas` runs
  `npm run gate -- --cold` and the built-in secret scan of the branch since its base, and records both. personas'
  own pre-commit scan skips silently when gitleaks is not installed, so its hook is never read as the scan. It
  **never pushes**. The operator merges the branch.
- personas' gates lint `src/` only: for a change to `scripts/*.mjs` the cold gate reports eslint `ok` with "no lintable
  files". Those files are linted only by the pre-commit eslint-staged hook, so never read the cold gate as covering
  them; say so in the cycle's `uat`.

## Secret scanning on every landing kind

`loop-ff`, `rebase-push` and `commit-only` all run the built-in secret scan of the branch's diff and record it in
`checks.secret_scan`; a hit is red. On `loop-ff` a hit with no other reason stops the landing and resets nothing
(`decision: "red"`, no steps): the scan matches shapes, so what a hit really is stays the operator's call. Test
fixtures build fake credentials at run time, so the repo's own lines do not trip it. A repo's own secret-scan hook that depends on a tool that is missing (gitleaks)
scans nothing, so it is **unverifiable**, never clean: a charter gate that runs it and fails because the tool is
not recognized is red (`<gate> failed (environmental: command not recognized)`), and a hook that skips silently is
never read as the scan.

## After a landing

`day.json` keeps each landing (`decision`, `ok`, `stage`, `pushed`, `deployed`, `target`, `reasons`). The next
morning's report shows each in its repo's Summary line (`landed: pushed <sha> to <ref>`, or `not landed (on <branch>)`)
and as the `Landing:` line of the repo's group under "Commits".
