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

You need Node.js 22 or newer and either Claude Code or Codex CLI. From a clone of this
repository:

```sh
node skill/install.mjs --harness claude              # -> ~/.claude/skills/dowser
node skill/install.mjs --harness codex               # -> $CODEX_HOME/skills/dowser (~/.codex/skills/dowser)
node skill/install.mjs --harness codex --dry-run     # print the plan, change nothing
```

`--scope project` installs into the current folder instead (`.claude/skills/dowser` or
`.agents/skills/dowser`). `--dev-link` links the installed skill to this checkout, so edits apply
at once. Exit codes: 0 ok, 2 bad arguments, 3 cannot install.

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
the code and shows you at most 16 proposals. You keep, reject (with a reason), snooze or merge
each one. When the Dowser Forge app is connected, the proposals you kept go to the Dowser inbox
in Jira, and the decisions made there come back into Dowser's memory before the next scan.

Without the Forge connection Dowser still runs, on code and docs only. It tells you which lenses
were partial and why.

Dowser never changes the project it scans. Its memory lives in `~/.dowser/`, outside the project.

### Developer or guided

| | Developer | Guided |
| --- | --- | --- |
| For | people who read code | product managers and others who do not |
| Cards | file and line inline, fingerprint shown | title and rationale first, evidence behind "show evidence" |
| Setup problems | the failing check | one plain-language fix at a time |
| Words | git and code terms | no "commit", "diff" or "SHA" |

Switch at any time by saying "switch to guided" (or "developer"). Ask "why this one?" about any
proposal: Dowser answers from the evidence it stored and does not rescan.

## Develop

Gates: `npm run typecheck` and `npm test`. Layout and rules for agents are in
[AGENTS.md](AGENTS.md). Design runs live in `.spark/` (gitignored); the overlay is
`.claude/spark/config.md`.
