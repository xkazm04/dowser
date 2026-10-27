---
product: "Dowser - evidence-backed backlog proposals from local repo scans"
stack: "unknown (greenfield; planned: TypeScript/Node scripts + an LLM-CLI skill, Forge app later)"
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

No gate exists yet: the repo has no manifest scripts. The first work package that adds a
`package.json` declares `typecheck` and `test` here and in `.ai/manifest.yaml` `capabilities`.

## Rituals

## Repo law

- Read README.md and docs/project-documentation.md first. The plan's lens table and proposal
  model are the product contract; the local-scan deviation is recorded in `.spark/Spark/ideas/`.
- Reuse before building: bp (`../bp`) and the registry skills `scan-sweep` / `lens-scan` already
  solve parts of scanning, proposals and triage. Name what you reused or why you did not.

## Question taste

- Wants the scanned repo left clean: rejected committed project memory in favour of local + Forge-synced (2026-10-27). Default to nothing written into a scanned repo.
- Accepts recommended options on architecture forks readily; spends attention on scope (picked all four gate lenses) - ask scope, decide plumbing.

## Skill improvement log
