# AGENTS.md - Dowser

Dowser finds what a product should do next. A skill runs inside Claude Code or Codex CLI against
a repository the user has checked out. It scans that repository through four lens packs
(Opportunity, UX friction and wellbeing, Doc drift, Security and CRA) and writes verified,
fingerprinted backlog proposals. A person pre-triages them, and the survivors are pushed to the
Dowser Forge inbox in Jira when it is connected.

## Layout

- `skill/` is the distributable. The installer copies this folder.
  - `SKILL.md` is the procedure the agent follows (dev and guided modes).
  - `references/` holds the card, triage, guided-mode and lens-authoring rules.
  - `lenses/` holds the four lens packs (versioned frontmatter, plus prompt and evidence rules).
  - `scripts/dowser.mjs` is the single CLI and the only writer of the store. Its modules are in
    `scripts/lib/` and its tests in `scripts/tests/`.
  - `schema/dowser-proposal-2.schema.json` is the proposal wire format (scan-finding/1 fields; `-1` kept readable).
  - `install.mjs` installs the skill: `--harness claude|codex [--scope user|project] [--dev-link] [--dry-run] [--force]` (a copy whose files changed since install is refused without `--force`); `--check` compares an installed copy against the latest release tag.
- `tools/` holds development tools: the mock Forge MCP server, and `forge-live-e2e.mjs`, which drives
  the live Forge app through a headless Claude Code run.
  `local-forge.mjs` runs the real Forge core on node:sqlite on your machine: MCP on stdio for the skill,
  `POST /invoke` over HTTP for the UI (`npm run local:forge`, then `npm run local:ui`).
- `e2e/` holds the Playwright specs over the Custom UI: `fixture`, `local` (the real core) and `live` projects,
  with three-state results and a coverage ratchet (`npm run e2e:coverage`). See `e2e/README.md`.
- `forge/` is the Forge app (Dowser for Jira): `manifest.yml`, backend in `src/` (pure logic in `src/core/`, Forge adapters in `src/adapters/`, copies of the skill's pure modules in `src/shared/`), Custom UI in `static/app/`, Rovo prompt and skill in `rovo/`.
- `docs/` holds the product plan (`project-documentation.md`), `data-model.md`, `forge-app.md` and
  `contracts/forge-mcp-2.md`, the seam to the Forge app. **Start a new session with
  `docs/concepts/project-status-and-next-steps.md`**: where the project stands and what comes next.
- `.spark/` is the design vault (gitignored). Design decisions for the local scan skill are in
  `.spark/Spark/ideas/local-scan-skill.md`.

## Gates

Run both before you hand back work:

- `npm run typecheck`: `tsc` in checkJs mode over `skill/**/*.mjs` and `tools/**/*.mjs`.
- `npm test`: `node --test "skill/scripts/tests/*.test.mjs"`.
- When `forge/` changes: `npm run forge:typecheck` (backend and Custom UI), `npm run forge:test`,
  `npm run forge:check-shared`; when `forge/static/app/` changes, also `npm run forge:build-ui` and render the changed
  screen in the fixture UI (`npm --prefix forge/static/app run dev:fixture`): typecheck does not catch runtime-only failures.

## Rules

- Plain ESM `.mjs` with `// @ts-check` and JSDoc. Zero runtime dependencies. Node 22.13 or newer (`node:sqlite`).
- **A scan never writes into the scanned repository.** Memory lives in `~/.dowser/` (`DOWSER_HOME` in
  tests). Work files go in the OS temp folder. Build mode (`SKILL.md` section 12, `/dowser build DW-n`)
  is the one exception: it edits the repo for one accepted item because the runner asked, and never
  commits, pushes or merges on its own.
- Store writes go through `skill/scripts/dowser.mjs` only. Every status move is
  compare-and-set. `evidence` and `transitions` are append-only.
- Absent values: omit the key. Never write `null`, and never write `0` for something unmeasured.
- Strings are English only. Card copy lives in the lens packs and `SKILL.md`, not in scripts.

## Temper (daily loop)

`/temper` (`.claude/skills/temper/`) is the operator's daily loop: one long session that scans, triages as
`delegate:temper`, builds, runs simulated UAT and updates the stability bar per module. Its records are in
`docs/evals/temper/` (protocol: `docs/evals/temper/README.md`).

- **Landing authority.** The loop may push master and deploy Forge **development** only through
  `node .claude/skills/temper/scripts/temper.mjs land`, and only when that day's gates and UAT are green. Other repos
  land under their own law from the charter: bp rebases and pushes master when `npm run check` and the secret scan
  are clean; personas commits on a branch and never pushes. Never production, never a tag, never a release: those stay
  the operator's.
- `.temper/charter.json` is written only by the start dialog (`charter init` with the operator present). The
  PreToolUse guard `.claude/skills/temper/scripts/guard.mjs` (registered in `.claude/settings.json`) denies other
  writes, production deploys, tags, releases, force pushes, and pushes to a branch that a repo's landing does not
  permit.
- Outside a temper day, this file's other rules hold as written: build mode still never commits, pushes or merges on
  its own.
