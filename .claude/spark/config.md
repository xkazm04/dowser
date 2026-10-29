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
  `forge:typecheck` does NOT cover `static/app` and the build does not catch a ReferenceError: also render the
  changed screen in the fixture UI (`npm --prefix forge/static/app run dev:fixture` on a port of your own) and
  exercise the changed path, headless (Playwright) or by eye. (A dialog shipped crashing on open in hardening
  wave 8; the build was green.)
- when `forge/manifest.yml` changes and `forge whoami` succeeds: `forge lint` in `forge/`.

## Rituals

## Repo law

- Every runner-facing output (a summary line, a triage step, a shared document, a dialog) names its guided-mode
  form in the same change (`skill/references/guided-mode.md`). Missed four times in the hardening campaign.
- Doc sync greps for the OLD claim about the changed behaviour (the sentence the docs used to say), not for the
  new function's name, across docs/, SKILL.md, references, lens packs, README.md and SECURITY.md. Missed three times.
- A change that crosses the skill/Forge seam changes both sides AND every test double of either side
  (`tools/mock-forge-mcp.mjs`, `forge/static/app/src/dev/`), and asserts the seam in
  `skill/scripts/tests/local-forge-e2e.test.mjs`. (Supporting views never reached the inbox for days: each side's
  tests passed alone.)

- Read README.md and docs/project-documentation.md first. The plan's lens table and proposal
  model are the product contract; the local-scan deviation is recorded in `.spark/Spark/ideas/`.
- Reuse before building: bp (`../bp`) and the registry skills `scan-sweep` / `lens-scan` already
  solve parts of scanning, proposals and triage. Name what you reused or why you did not.
- Windows authoring: write and edit files with the Write/Edit tools. Bash heredocs with long or quoted content,
  `python3 - <<EOF` fallbacks and line-filter rewrites of CSS have each corrupted or silently skipped edits
  (2026-10-27, 2026-10-28 twice). Shell edits only for one-line, regex-free substitutions.
- UI builder briefs: author repo files directly (no out-of-repo generators), and re-take and VIEW the
  primary-viewport screenshot after the last CSS change, after `document.fonts.ready`.

## Question taste

- Wants the scanned repo left clean: rejected committed project memory in favour of local + Forge-synced (2026-10-27). Default to nothing written into a scanned repo.
- Accepts recommended options on architecture forks readily; spends attention on scope (picked all four gate lenses) - ask scope, decide plumbing.
- On surface/scope multi-selects picks every surface offered (forge-ui-prototypes took all four; 2026-10-28). Offer full coverage as the recommendation when cost allows.
- At the go-gate of a spark framed as "a plan for tomorrow", picked Build now over Park (2026-10-28). Offer Build as a real option, with its cost, even when the spark says plan.
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
- 2026-10-28 forge-ui-prototypes: a router-level variant contract (pages/modules override, fallback to current, DEV-only import) let three UI builders run in parallel with zero shared edits - reuse for multi-direction prototypes.
- 2026-10-28 forge-ui-prototypes: UI builders listed screenshots they "took but did not view" and one shipped a wrapped toolbar at the PRIMARY viewport; UI briefs must require the primary-viewport shot re-taken and viewed after the last CSS change, after document.fonts.ready.
- 2026-10-28 forge-ui-prototypes: two builders generated committed CSS from scratchpad-only sources; UI briefs must say "author repo files directly, no out-of-repo generators".
- 2026-10-28 live verification: a CDP tab created with background:true throttles timers (~1/min) and hung a 2-min script for 2 h; drive live pages in a foreground tab with focus emulation and a hard timeout.
- 2026-10-28 lens-quality-plan: liveness applies to writers too - trace a new record field to every store that persists it; the skill store's one-column-per-field layout would have dropped `artifacts` silently (caught at the Director's contract commit, not by the scout).
- 2026-10-28 lens-quality-plan: check that a measuring instrument can fail before building on it; the first fixture seeded no more findings than the 4-card budget, so three baselines scored 1.0 and the run paid for a re-baseline.
- 2026-10-28 lens-quality-plan: nine builders in one checkout with zero collisions - disjoint file scopes, Director-committed stubs for shared entry points, and a NEW test file per builder instead of a shared one.
