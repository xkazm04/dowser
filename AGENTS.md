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
  - `install.mjs` installs the skill: `--harness claude|codex [--scope user|project] [--dev-link] [--dry-run]`.
- `tools/` holds development tools: the mock Forge MCP server, and `forge-live-e2e.mjs`, which drives
  the live Forge app through a headless Claude Code run.
  `local-forge.mjs` runs the real Forge core on node:sqlite on your machine: MCP on stdio for the skill,
  `POST /invoke` over HTTP for the UI (`npm run local:forge`, then `npm run local:ui`).
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

## Rules

- Plain ESM `.mjs` with `// @ts-check` and JSDoc. Zero runtime dependencies. Node 22.13 or newer (`node:sqlite`).
- **Never write into a scanned repository.** Memory lives in `~/.dowser/` (`DOWSER_HOME` in
  tests). Work files go in the OS temp folder.
- Store writes go through `skill/scripts/dowser.mjs` only. Every status move is
  compare-and-set. `evidence` and `transitions` are append-only.
- Absent values: omit the key. Never write `null`, and never write `0` for something unmeasured.
- Strings are English only. Card copy lives in the lens packs and `SKILL.md`, not in scripts.
