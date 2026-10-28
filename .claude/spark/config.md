---
product: "Dowser - evidence-backed backlog proposals from local repo scans"
stack: "Node 22+ ESM .mjs + JSDoc (skill, zero-dep); Forge app in forge/ (Node backend, Forge SQL, Custom UI React + Vite)"
vault: []
vault_subdir: Spark
context_map: context-map.json
base_branch: master
active_runs_ledger: ""
locale_count: 1
---

# Spark overlay - dowser

Scaffolded 2026-10-27 for a greenfield repo. The vault is `<repo>/.spark/` (gitignored). The
context map is provisional until the first scaffold commit.

## Gates

- `npm run typecheck`: `tsc -p jsconfig.json --noEmit` (checkJs, strict) over `skill/**/*.mjs` and `tools/**/*.mjs`.
- `npm test`: `node --test "skill/scripts/tests/*.test.mjs"`. Tests use mkdtemp dirs and `DOWSER_HOME`, and clean up.
- when `forge/` changes: `npm run forge:typecheck`, `npm run forge:test`, `npm run forge:check-shared` (the shared copies of `skill/scripts/lib/{model,fingerprint}.mjs` must match; after editing either, run `npm --prefix forge run sync-shared`).
- when `forge/static/app/` changes: `npm run forge:build-ui`.
- when `forge/manifest.yml` changes and `forge whoami` succeeds: `forge lint` in `forge/`.

## Rituals

## Repo law

- Read README.md and docs/project-documentation.md first. The plan's lens table and proposal
  model are the product contract; the local-scan deviation is recorded in `.spark/Spark/ideas/`.
- Reuse before building: bp (`../bp`) and the registry skills `scan-sweep` / `lens-scan` already
  solve parts of scanning, proposals and triage. Name what you reused or why you did not.

## Question taste

- Wants the scanned repo left clean: rejected committed project memory in favour of local + Forge-synced (2026-10-27). Default to nothing written into a scanned repo.
- Accepts recommended options on architecture forks readily; spends attention on scope (picked all four gate lenses) - ask scope, decide plumbing.
- On product-capability questions picks the richer option even against the recommendation (forge-app: Rovo records verdicts; area stats pushed from the skill; all four v1 surfaces). Do not default-recommend the lean option there; state the cost and let the operator pick (2026-10-27).

## Skill improvement log

- 2026-10-27 local-scan-skill: a brief that declares both a status transition table and resurfacing rules must cross-check them (builders found 3 contradictions); write the table FROM the rules.
- 2026-10-27 local-scan-skill: a parallel builder briefed against another package's BRIEF (not its code) surfaced command-set gaps early - keep doing it for doc/procedure packages.
- 2026-10-27 local-scan-skill: Windows - leave the worktree (cd to main checkout) before `git worktree remove`, or the session cwd lock fails the delete.
- 2026-10-27 forge-app: platform scout must state the store's atomicity unit (Forge SQL has no transactions); the brief assumed one and WP2 redesigned write-back mid-build.
- 2026-10-27 forge-app: derive UI-facing resolver fields from each surface's state list (empty, grouped, changed) before fan-out - the UI builder found two missing fields.
- 2026-10-27 forge-app: on Windows write files with the Write tool (or Python newline='
'); Python text mode wrote CRLF into shared modules and Bash heredocs with long content failed twice.
- 2026-10-28 forge-reflect-ui: verify a Director-committed contract by grepping every new key before fan-out; a str.replace on a JSDoc block missed on indentation and WP1 had to add the resolver keys.
- 2026-10-28 forge-reflect-ui: a port-based core (forge/src/core + ports.mjs) let a local real-core server be built with zero core edits; prefer port-level fakes over contract mocks for e2e.
