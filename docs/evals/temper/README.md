# /temper - day records

## Tools

Three tools connect the /temper loop to the live Dowser inbox and to Jira. They are operator and loop tools, not
Dowser runner surfaces, so they have no guided-mode form. All three print JSON and exit 0 (done), 1 (a call failed,
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
node tools/temper-scan.mjs --repo <path> --project-key <k> [--focus "goal: .."|"area: .."] [--budget-usd n]
                           [--model m] [--lenses a,b] [--hide <path>]... [--keep] [--dry-run]
```

- It uses dogfood's mechanics (`tools/scan-workspace.mjs`): a clone of the repo's committed HEAD in the OS temp
  folder, with `--hide` paths left out by a sparse checkout, and the skill installed there at project scope. The run
  is one headless `claude -p` scan with `--setting-sources project,local`. **The scanned repo is never written.**
- `--project-key` is the live inbox key. It must pass the push's rule (`PROJECT_KEY_RE`), must not be the sample's
  reserved `dowser-sample`, and must be lowercase with single hyphens. The clone's origin is set to it, so the
  skill's project key is exactly this key. The inbox therefore carries no repo link (`repo_url` is absent).
- Dowser's memory for the key lives in `DOWSER_HOME = ~/.temper/homes/<project-key>` (`TEMPER_HOME` overrides
  `~/.temper`). The next scan of the same key pulls the verdicts and follows the rules.
- The scan keeps every card (the delegate triages later, through `temper-verdicts`), pushes it to the inbox and
  sends the areas.
- Each scan appends one row to `~/.temper/scans.jsonl`: `{ts, repo, head, project_key, focus?, ok, minutes,
  cost_usd?, turns?, cards: {created, moved, pushed, by_status}}`.
- `--dry-run` clones, installs and prints the plan (inbox key, Dowser home, ledger, MCP server). It does not call
  Claude and writes nothing under the Temper home.

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
node tools/temper-verdicts.mjs --project-key <k> --verdicts <json> [--dry-run]
```

- A verdicts file is an array of `{ref, verdict: accept|reject|snooze|merge, reason?, note?, into?, until?}`
  (docs/contracts/forge-mcp-2.md). `ref` is `DW-n`. A reject needs a reason, and `other` needs a note. A merge
  needs `into`. `until` (YYYY-MM-DD) goes only with a snooze. One verdict per ref.
- It calls `dowser_verdicts_record` with `{project_key, verdicts_json}` through headless `claude -p` on the live
  server. When the answer has `more`, it sends the verdicts that have no result yet again, until every verdict has
  one.
- Forge records each verdict as `delegate:temper`. It refuses a verdict when the inbox's delegation (Jira Settings)
  is absent or expired, when the day's caps are reached, or in the sample inbox. A refusal is reported with its
  `why` and the tool exits 1.
- `--dry-run` prints the tool arguments without a call.
