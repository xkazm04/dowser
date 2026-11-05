# /temper - day records

`/temper` (`.claude/skills/temper/`) is the daily loop. The operator starts one long session a day in the Dowser
repo. After a morning report and at most three questions, it runs Scan -> Triage -> Build -> Simulated UAT -> Update
cycles until the charter's end time, the usage window or the 8 h wall. This folder holds what each day leaves behind.
These are operator records, not Dowser runner surfaces, so they have no guided-mode form.

## Protocol

### Files

| file | written by | what |
|---|---|---|
| `<date>.jsonl` | `temper.mjs cycle end`, `cycle reverify` | one row per cycle, and a reverify row per re-check (below) |
| `<date>.md` | `temper.mjs report` | the morning report: Needs you (at most 3 questions), commits and landings, UAT verified vs self-reported, scans and costs, verdicts (live and local-only apart, and the cards carried to tomorrow), the bar per module, direction proposals, parked items |
| `modules.json` | `temper.mjs modules bar` | the stability bar per module, `next` (the least-stable), and the pending direction proposals |
| `quality.jsonl` | `tools/quality-snapshot.mjs --append` | one structural snapshot per cycle; the bar's quality part compares the last two. `tests`, `tests_fail` and `tests_status` are the skill suite, `forge_tests`, `forge_tests_fail` and `forge_tests_status` the Forge suite; a row without the `forge_` fields predates them (not measured) |
| `resolved.json` | `temper.mjs proposals resolve` | lens-scan proposals whose fix landed, `{commit, subject, resolved_at, by, status_then, tier, note?}` per id |

The working state is not committed. It lives in `<dowser>/.temper/` (gitignored): `charter.json`, `day.json`,
`cycle-<repo>.json` (one open cycle per repo) and `directions.json`. The scan ledger, the ticket memory, the Dowser homes, the chrome profile and the
other repos' worktrees are in the Temper home `~/.temper/` (`TEMPER_HOME`).

### A cycle row

```json
{"kind": "cycle", "n": 2, "date": "2026-11-05", "repo": "dowser", "target": "inbox-ui", "begun_at": "...", "ended_at": "...",
 "head": "<sha>", "green": false, "red_because": ["test failed", "e2e local: stale"],
 "verified": {"deps": {".": {"state": "installed", "why": "..."}, "forge": {"state": "in sync"}},
              "gates": {"typecheck": "pass", "test": "fail", "e2e:fixture": "pass", "e2e:local": "pass"},
              "uat": {"fixture": {"state": "fresh", "pass": 40, "fail": 0, "unverifiable": 0, "flaky": 0}, "local": {"state": "stale"}, "live": {"state": "missing"}},
              "quality": {"state": "appended", "head": "<sha>"}},
 "quota": {"decided": 2, "share": 0, "ok": true, "day": {"dowser-temper": {"decided": 12, "share": 0.25, "ok": true}}},
 "self_reported": {"scan": {...}, "verdicts": [{"ref": "DW-50", "verdict": "reject", "reason": "duplicate", "inbox": "dowser-temper",
                   "recorded": "local", "decided_by": "delegate:temper"}], "built": [...], "outcomes": [...], "directions": [...], "parked": [...],
                   "skill_issues": [{"where": "temper.mjs cycleEnd", "what": "...", "evidence": "...", "fix": "..."}]}}
```

- **verified.deps** (Dowser only): per folder of root (`.`), `forge` and `forge/static/app`, `in sync`, `installed`
  (the lockfile drifted from `node_modules/.package-lock.json`, so `npm ci` ran first, with the drift as `why`) or
  `failed` (with `exit`; it makes the row red). A folder without a lockfile is left out.
- **verified.gates**: Dowser's `typecheck` and `test`, `e2e:fixture` and `e2e:local` (unless a charter land gate
  already runs them) and the charter's land gates; another repo's row holds only its charter land gates.
- **verified.quality** (Dowser only): the quality-snapshot row for this cycle, `present`, `appended` (cycle end ran
  it), `no row written` or `failed`. It never makes a row red.
- **self_reported.skill_issues**: what the runner learned about the loop itself, each exactly `{where, what,
  evidence, fix}`. `report` lists them under "Skill issues", grouped by `where`, newest first.

### A reverify row

`temper.mjs cycle reverify --n <n>` re-runs the same checks on cycle n's unchanged tree (after an environmental red)
and appends a row of its own. The cycle row is never rewritten.

```json
{"kind": "reverify", "n": 2, "date": "2026-11-05", "repo": "dowser", "target": "inbox-ui", "at": "...", "head": "<sha>", "of_head": "<cycle's sha>",
 "before": {"green": false, "red_because": ["npm ci in . failed (exit 1; ...)"]}, "green": true, "verified": {"deps": {...}, "gates": {...}, "uat": {...}}}
```

- `head` may be past `of_head` only by record-only commits (under `docs/evals/temper/`). `before` is the cycle's
  newest verdict before this one. The newest row per cycle (cycle or reverify) is what the bar, `report` and `land`
  read; a green Dowser reverify moves the day's last green to `head`.

- **Verified vs self-reported.** `verified` is what temper.mjs read itself: the gates' exit codes, and the e2e
  result files newer than the cycle's start. `self_reported` is the director's cycle file, as written. A row is
  `green` only when the verified gates and UAT are green. Fixture and local are required every cycle. A live fail
  blocks; live unverifiable (nobody signed in) does not. The report keeps the two columns apart.
- **Verdicts.** Every verdict is decided by `delegate:temper`. `recorded: "live"` means Forge recorded it through
  `temper-verdicts`. `recorded: "local"` means the inbox had no valid delegation (the tool answered forbidden), so the
  verdict is kept here only, and the live inbox keeps its cards undecided. Both obey a floor of 20% reject or snooze
  per inbox per day (today's earlier verdicts plus this cycle's; a card decided again counts once, at its newest
  verdict; a merge is neither accept nor reject and stays out of the share) and the charter's daily caps per inbox (`repos[].caps`, default 10 accepts and 30 rejects; snoozes and
  merges count against rejects). A snooze with `deferred: "cap"` (real, but the day's accept cap is reached) counts
  apart as `carried` (`quota.carried`): out of the floor and the rejects cap, valid only at the accept cap, listed in
  the report as "carried to tomorrow" and asked about first the next morning. Delegate verdicts teach Dowser's memory
  but never count toward trust.
- **The bar** is in `.claude/skills/temper/references/bar.md`. A part counts only when it is verified.

### Landing authority

The loop lands only through `temper.mjs land --repo <name>`, under each repo's own landing law (charter
`repos[].landing`):

- Dowser (`loop-ff`) fast-forwards master from `loop/<date>`, pushes origin master, and deploys Forge development
  when the day's gates and UAT are green. A red day is reset to its last green commit and stays on its branch.
- bp (`rebase-push`) rebases `temper/<date>` onto origin/master. It pushes HEAD:master only when `npm run check` and
  the secret scan are clean.
- personas (`commit-only`) commits on `temper/<date>` in a worktree and never pushes. Its land runs the gates and
  the same built-in secret scan (its own hook skips the scan when gitleaks is missing).

Production deploys, tags and releases stay the operator's in every repo. The PreToolUse guard
(`.claude/skills/temper/scripts/guard.mjs`) denies them, and it denies any push that a repo's landing does not permit.

### A dry run

`node tools/temper-dryrun.mjs` chains charter init -> day start -> cycle begin -> modules bar -> cycle end -> report
-> land --dry-run on a throwaway repo, with an injected gate runner and no network. `npm test` runs it.

## Tools

Three tools connect the /temper loop to the live Dowser inbox and to Jira, and `temper-cards` reads a scan home. They
are operator and loop tools, not Dowser runner surfaces, so they have no guided-mode form. All of them print JSON and exit 0 (done), 1 (a call failed,
or a verdict was refused) or 2 (bad arguments).

### Credentials and the live server

- **Jira** (`temper-tickets`): Jira REST v3 with basic auth from `FORGE_EMAIL` and `FORGE_API_TOKEN`, read from the
  process environment. On the operator's machine they are User environment variables, and a PowerShell session does
  not always carry them. Load them first, and never print the token:

  ```powershell
  $env:FORGE_EMAIL=[Environment]::GetEnvironmentVariable('FORGE_EMAIL','User')
  $env:FORGE_API_TOKEN=[Environment]::GetEnvironmentVariable('FORGE_API_TOKEN','User')
  ```

  `JIRA_SITE` overrides the site (default `https://dowser.atlassian.net`).
- **The live `dowser` MCP server** (`temper-scan`, `temper-verdicts`): it is registered in `~/.claude.json` for the
  main Dowser checkout (an http server signed in by OAuth). A headless `claude -p` in a scan clone or a worktree does
  not see that registration, so `tools/live-mcp.mjs` copies the same entry into an `--mcp-config` file and passes
  `--strict-mcp-config`. Claude Code keys the stored OAuth token by the server's name and config, so the identical
  entry reuses the sign-in: no second login. `DOWSER_MCP_URL` overrides the lookup. A development install suffixes
  every tool (`dowser_verdicts_record_development`); the prompts match the base name or the suffixed one.

### temper-scan - a connected scan of a local repo

```
node tools/temper-scan.mjs --repo <path> --project-key <k> [--ref r] [--focus "goal: .."|"area: .."]
                           [--budget-usd n] [--model m] [--lenses a,b] [--hide <path>]... [--keep] [--dry-run]
```

- It uses dogfood's mechanics (`tools/scan-workspace.mjs`): a clone of one committed ref of the repo in the OS temp
  folder, with `--hide` paths left out by a sparse checkout, and the skill installed there at project scope. The run
  is one headless `claude -p` scan with `--setting-sources project,local`. **The scanned repo is never written.**
- **The ref is the day's work, not master.** `--ref` names it. Without it, the scan reads the /temper day file of
  the checkout the tool belongs to (`.temper/day.json`, with `.temper/charter.json` for the repos' paths;
  `TEMPER_ROOT` overrides the checkout in tests): Dowser's `loop/<date>` when `--repo` is that checkout, and a started
  build repo's `temper/<date>` (bp, personas) when `--repo` is its charter path or its day worktree. A repo not
  started today, or no open day, scans HEAD. A day branch the repo lacks fails the scan. `cycle begin` prints every
  scan command with its `--ref`, because a master scan brings back the cards the day already fixed.
- `--project-key` is the live inbox key. It must pass the push's rule (`PROJECT_KEY_RE`), must not be the sample's
  reserved `dowser-sample`, and must be lowercase with single hyphens. The clone's origin is set to it, so the
  skill's project key is exactly this key. The inbox therefore carries no repo link (`repo_url` is absent).
- Dowser's memory for the key lives in `DOWSER_HOME = ~/.temper/homes/<project-key>` (`TEMPER_HOME` overrides
  `~/.temper`). The next scan of the same key pulls the verdicts and follows the rules.
- The scan keeps every card (the delegate triages later, through `temper-verdicts`), pushes it to the inbox and
  sends the areas.
- Each scan appends one row to `~/.temper/scans.jsonl`: `{ts, repo, ref, ref_from, head, sha, project_key, focus?, ok, minutes,
  cost_usd?, turns?, cards: {created, moved, pushed, by_status}, report}`. `ref` is the scanned branch (or commit),
  `ref_from` how it was chosen (`flag`, `day` or `head`), `head` and `sha` the short and full commit. `report` is
  `~/.temper/scans/<stamp>-<project-key>.json`: the row, the scan's summary and each card the scan created or moved,
  `{fp, ref?, url?, status, lens, title, evidence: [{type, ref, path?, line?}], created}`.
- To list a scan home's cards later, run `node tools/temper-cards.mjs --project-key <k> [--status s] [--lens l]
  [--quotes]`. `dowser.mjs list --repo <path>` on the real checkout reads another project (its origin) and lists
  nothing.
- `--dry-run` clones, installs and prints the plan (inbox key, Dowser home, ledger, MCP server). It does not call
  Claude and writes nothing under the Temper home.
- The scan denies `ScheduleWakeup`. A scan that set a 30-minute fallback heartbeat while its lens agents ran held
  `claude -p` open long after the run was done.
- First measurement (n=1, 2026-11-05): bp@93f30b0 into `bp-temper` with `--budget-usd 8`, all four lenses.
  The scan cost $7.86, the run itself took 11 minutes, and the process ran for 33 minutes because of the heartbeat
  above. It pushed 10 cards (DW-36 to DW-45). A full four-lens scan of a mid-size repo needs a budget near $8.

### temper-tickets - UAT findings as DOW issues

```
node tools/temper-tickets.mjs file --findings <json> [--project DOW] [--issue-type <name>] [--dry-run]
node tools/temper-tickets.mjs list [--all] [--project DOW]
node tools/temper-tickets.mjs close <KEY>... [--project DOW]
```

- A findings file is an array, or `{findings: [...]}`, of
  `{title, surface, steps: [..], expected, actual, screenshot?, spec?, fp?}`. `surface` says where the finding was
  seen (`fixture #/inbox`), `spec` names the Playwright spec that found it, and `screenshot` is a path. The
  screenshot goes in the body as text and is not uploaded.
- **Fingerprint:** `fp` when given (12 hex), else the first 12 hex of sha256 over the normalized surface, spec and
  title (case and whitespace folded). A reworded actual result is the same finding.
- Each issue gets the labels `temper-uat` and `temper-fp-<fp>` and an ADF body: the surface, the steps as an ordered
  list, expected, actual, the screenshot and spec, and the fingerprint. The issue type is `--issue-type`, else the
  first of Bug or Task that the project has (from `createmeta`).
- **Dedupe:** a finding is not filed again while an unresolved issue (status category not Done) carries its
  fingerprint label. Jira search is eventually consistent, so each filing is also remembered in
  `~/.temper/tickets.json` (fp to key). A remembered key is read back directly before the JQL search. Once its
  ticket is Done, a recurring finding is filed as a new issue.
- `list` shows the unresolved `temper-uat` issues (`--all` includes Done ones). `close` moves an issue to a
  Done-category status and refuses an issue without the `temper-uat` label.
- `--dry-run` validates the findings and prints the plan with no network call.

### temper-verdicts - delegated triage through `dowser_verdicts_record`

```
node tools/temper-verdicts.mjs --project-key <k> --verdicts <json> [--retry] [--dry-run]
```

- A verdicts file is an array of `{ref, verdict: accept|reject|snooze|merge, reason?, note?, into?, until?, inbox?,
  recorded?}` (docs/contracts/forge-mcp-2.md). `ref` is `DW-n`. A reject needs a reason, and `other` needs a note.
  `reason` goes only with a reject: a snooze says why in `note`. A merge needs `into`. `until` (YYYY-MM-DD) goes only
  with a snooze. One verdict per ref. `inbox` (it must equal `--project-key`) and `recorded` (`live` or `local`) are
  the cycle file's keys: they are checked and never sent, so the same file passes `temper.mjs triage check`.
- It calls `dowser_verdicts_record` with `{project_key, verdicts_json}` through headless `claude -p` on the live
  server. When the answer has `more`, it sends the verdicts that have no result yet again, until every verdict has
  one.
- Forge records each verdict as `delegate:temper`. It refuses a verdict when the inbox's delegation (Jira Settings)
  is absent or expired, when the day's caps are reached, or in the sample inbox. A refusal is reported with its
  `why` and the tool exits 1.
- A `forbidden` answer (no valid delegation) prints `{project_key, recorded: 0, forbidden: true, record_as:
  "local", why}` and exits 1. It is remembered per inbox per day in `~/.temper/verdicts-forbidden.json`, so a later
  call that day answers the same without a `claude -p` run. `--retry` asks Forge again.
- `--dry-run` prints the tool arguments without a call.
