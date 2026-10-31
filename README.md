# Dowser

Dowser finds what your product should do next. It joins user pain, code capability and
organizational intent into evidence-backed backlog proposals.

**Status: design.** The original plan (cloud scans on Forge, Codegeist 2026) is in
[docs/project-documentation.md](docs/project-documentation.md). The working deviation: scans run
**locally**, as a skill in an LLM CLI (Claude Code, Codex CLI) against a checked-out repo. The
skill carries the procedures and a per-project memory that learns from triage, and its scripts
connect to the core architecture.

## Use

### Install

You need Node.js 22.13 or newer and either Claude Code or Codex CLI. From a clone of this
repository:

```sh
node skill/install.mjs --harness claude              # -> ~/.claude/skills/dowser
node skill/install.mjs --harness codex               # -> $CODEX_HOME/skills/dowser (~/.codex/skills/dowser)
node skill/install.mjs --harness codex --dry-run     # print the plan, change nothing
node skill/install.mjs --check --harness claude      # is a newer release out? (npm run check-update)
```

`--scope project` installs into the current folder instead (`.claude/skills/dowser` or
`.agents/skills/dowser`). `--dev-link` links the installed skill to this checkout, so edits apply
at once. `--check [--from <git url or path>]` compares the installed copy with the newest release
tag (see Updating). Exit codes: 0 ok (for `--check`: checked, behind or not), 2 bad arguments,
3 cannot install (for `--check`: nothing installed, or no source to compare with), 4 `--check`
could not list the release tags.

### Updating

A copy install does not follow this repository. It records what it is in `install.json` beside the
skill (version, harness, scope, install time, and the source commit and repository). `node
skill/install.mjs --check --harness claude` (or `npm run check-update`) lists the source's release
tags (`vX.Y.Z`) and prints a notice when a newer one exists. It is the only network call, made only
when you ask; no scan checks for updates. To update, `git pull` here and run the installer again
with the same arguments. A `--dev-link` install follows the checkout, so `git pull` alone updates
it. Security fixes go to the newest release only: see [SECURITY.md](SECURITY.md).

### First run

Open Claude Code or Codex CLI inside the project you want to scan, and type:

```
/dowser                       # sweep the whole project
/dowser goal: self-serve reporting
/dowser area: src/checkout
```

(In Codex, ask for the skill by name if `/dowser` is not offered: "use the dowser skill".)

On the first run Dowser asks whether you want **developer** or **guided** mode, and remembers the
answer. It checks the environment, then runs four lenses: Opportunity, UX friction and
wellbeing, Doc drift, and Security and CRA. It re-checks every quoted line of evidence against
the code, scores every proposal and shows you the top 16 (each lens's top pick first); the rest
are kept in reserve, never thrown away. You keep, reject (with a reason), snooze or merge
each one, except the cards Dowser pre-sorts: where its predictions have earned trust (technical
findings such as doc drift and security start there), a ranked card it expects you to accept
skips this dialog and goes to the inbox marked "machine pre-triaged". Dowser names those cards
when it skips them, and you still accept, reject or snooze each one in Jira; Dowser never
accepts anything itself. When the Dowser Forge app is connected, the proposals you kept go to the Dowser inbox
in Jira, and the decisions made there come back into Dowser's memory before the next scan.

Without the Forge connection Dowser still runs, on code and docs only. It tells you which lenses
were partial and why. To connect the Jira inbox, install the Dowser for Jira app on your site
([docs/forge-app.md](docs/forge-app.md#install-on-a-development-site)), then add its MCP server to
Claude Code or Codex ([Connect an external MCP client](docs/forge-app.md#connect-an-external-mcp-client)).

The first scan reads the whole project. Later scans read only what changed since the last one,
with a full scan again every 14 days, or when the last scanned version is gone from the history.

Dowser never changes the project it scans. Its memory lives in `~/.dowser/`, outside the project.

### Developer or guided

| | Developer | Guided |
| --- | --- | --- |
| For | people who read code | product managers and others who do not |
| Triage | an overview table of every proposal first, then the cards | the same, in plain words |
| Cards | file and line inline, fingerprint shown | title and rationale first, evidence behind "show evidence" |
| Setup problems | the failing check | one plain-language fix at a time |
| Words | git and code terms | no "commit", "diff" or "SHA" |

Switch at any time by saying "switch to guided" (or "developer"). Cards are short by default; say
"full cards" to add each card's summary and description, or "compact" to go back. Say "share as markdown"
to get the kept proposals of the last scan as markdown for a doc or a slide (evidence by reference, no
quoted code). Teams that must not send source lines to Jira set `prefs set quotes=omit`: pushed cards
then carry a hash of each quoted line instead of its text (SECURITY.md). Ask "why this one?" about any
proposal: Dowser answers from the evidence it stored and does not rescan.

## Develop

Security problems: see [SECURITY.md](SECURITY.md). Gates: `npm run typecheck` and `npm test`. Layout and rules for agents are in
[AGENTS.md](AGENTS.md). Design runs live in `.spark/` (gitignored); the overlay is
`.claude/spark/config.md`.
