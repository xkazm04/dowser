# Moonshot round 2026-11-04 - all groups (lens: moonshot-architect, ad-hoc)

Three read-only group scouts (scan-skill, core, atlassian-app) produced 15 L/XL cards. Their full
decks, with every `path:line` premise, are in `scan-skill.md`, `core.md` and `atlassian-app.md`
in this folder. Every Evaluation is `Method: simulation`: nothing was built or measured. Treat this
file as the never-re-propose list for the next develop or moonshot round.

Ranking: `impact x (1 + 0.25 x (corroboration - 1))`. A card that other cards depend on is moved up.
Corroboration counts the scouts that reached the same spine on their own.
Personas was unreachable, so there was no decision memory. The operator triaged every card in the terminal on 2026-11-04 (decisions below).

## Top 5

| # | Idea | Spine | Scouts | Size | Impact | Plan direction | Gate | Decision |
|---|---|---|---|---|---|---|---|---|
| 1 | Delivery truth: Jira issue events + evidence re-check at each scan -> delivered / abandoned / recurred | shipped-outcome feedback loop | 3 (SS#2, core#1, app#1) | XL | 9 | #6 shipped loop (design for it) | architecture | accepted 2026-11-04 |
| 2 | Agent work queue over MCP: `work_list` / `work_get` / `work_report`; phase 2: scan requests from Jira | bidirectional MCP work queue | 3 (SS#1, SS#3, app#2) | XL | 9 | #3 MCP bonus | direction | accepted 2026-11-04 |
| 3 | Forge as memory of record: `dowser_memory_pull` + `hydrate`, so a fresh or CI store keeps the team's verdicts | portable team memory | 1 (core#3) | L | 9 | prerequisite of #4 scheduled scans | architecture | accepted 2026-11-04 |
| 4 | Proposal-quality ledger: accept rate, ranked vs reserve, prediction agreement, outcome right-rate per lens version | proposal-quality measurement | 1 (core#2) + uses #1 | L | 8 | #5 scan quality | direction | accepted 2026-11-04 |
| 5 | Dowser facts as indexed Jira issue properties (JQL, gadget, Automation) | Jira-native finding data | 1 (app#3) | L | 7 | #6 / #9 | none | accepted 2026-11-04 |

## The other 10, held

| Idea | Source | Size | Impact | Why it was not in the top 5 | Decision |
|---|---|---|---|---|---|
| Open lens registry (packs, not a hardcoded list in about 25 files) | SS#4 | XL | 7 | high value after the deadline; only partly fits Dec 22 | accepted |
| Procedure engine (the CLI drives the run) | SS#5 | XL | 7 | risky before the freeze; revisit after idea 2 lands | rejected |
| Proposal relationship graph (edges) | core#4 | L | 7 | strengthens "decide by precedent"; Forge side is a stretch | accepted |
| Org-scope taste across repos | core#5 | XL | 7 | depends on ideas 3 and 4; does not fit Dec 22 | rejected |
| Confluence doc-drift closure (page events, banner, draft fix) | app#4 | L | 7 | new write scope forces re-consent; batch it with production if taken | accepted |
| Jira-project portfolio across repos | app#5 | L | 6 | ranks after ideas 1-5 for judging value | rejected |
| In-app scan on Forge LLM (scan without the local skill) | app, not proposed | - | - | reverses decisions D1/D11; needs a direction call | rejected |

## Incidental S/M defects (for the stabilize loop)

All accepted on 2026-11-04 except the one marked REJECTED.

- `skill/scripts/lib/verify.mjs:186-188`: a card whose only evidence is git or sarif verifies with nothing checked.
- `skill/scripts/lib/verify.mjs:3`: verify reads the working tree, not the scanned commit.
- `skill/scripts/lib/predict.mjs:79-90`: `closestPrecedent` re-reads every decided row for each candidate (two scouts).
- `skill/scripts/lib/share.mjs:13`: the summary regex expects `\n`; with CRLF line endings the "Proposed:" line is dropped.
- `skill/scripts/lib/memory.mjs:114-116`: one broken pack fails `packKinds` for every lens.
- `skill/scripts/lib/sync.mjs:402-404,435`: the first connected run from a fresh store exits 1 with no hint why.
- `skill/scripts/lib/memory.mjs:377`, `:181-184`: N+1 queries.
- `docs/data-model.md:4`: the "Code:" list is stale since the store split.
- REJECTED: `forge/src/core/reflect.mjs:38,302-305`: the limit of 200 is applied before Done items are sorted first.
- `forge/src/core/reflect.mjs:92`: the outcome sync returns the newest 200 with no cursor.
- `forge/src/adapters/atlassian.mjs:164-183`: issue status is read as the app (a viewer may see a status from a project they cannot browse).
- `forge/src/core/cards.mjs:338`: the byline runs a `LIKE` scan over all inboxes on every page view.
