# Dowser — Project Documentation

Oct 27, 2026 · @Kazi

Dowser finds what your product should do next: it joins user pain, code capability and organizational intent into evidence-backed backlog proposals, built on Forge for Codegeist 2026.

## Vision

AI dev tools make implementation cheap, so the bottleneck moves to deciding what to build. Developers can now ship almost anything; product and business teams still struggle to supply ideas that are high-quality, innovative and good for users.

Dowser closes that gap. Code is the source of truth for what the product does; users' tickets and feedback say what they need; goals and decisions say where the company is going. No single person holds all three. Dowser joins them and proposes concrete, evidenced work.

The gap is real and unserved:

- **AI Backlog for Jira** (3rd place Software Teams, Best Rovo Apps, Codegeist 2025) only groomed an existing backlog: topics, sprints, duplicates. It never read docs or code, and its Marketplace listing is now archived.
- **Requirements-to-stories generators** (e.g. Publicis Sapient Slingshot) decompose documents someone already wrote. They don't discover what nobody has written down yet.

Positioning: not a backlog generator, but a **reconciliation loop** between what users need, what the code can do, and what Jira tracks.

## How it works

Three sources feed seven lenses; triage decides what reaches Jira, and its reasons tune the lenses.

&#91;embedded content: Dowser loop · 3 sources, 7 lenses, 4 stages, 2 feedback loops\]

The triage inbox is the accented stage: it is where human judgment enters and where the product learns. Shipped work changes code and docs, so the next scan starts from the new state.

## Lenses

The full design scope is seven lenses; the demo should lead with three. A lens is a versioned scan template (prompt pack + evidence rules) that teams fork and tune.

| # | Lens | Inputs | Finds | Example proposal | Demo |
| --- | --- | --- | --- | --- | --- |
| 1 | Opportunity | JSM tickets, feedback, code capabilities, goals | Recurring user asks the code almost supports | "40 tickets ask for export; an internal CSV serializer exists — expose it, \~2 days, supports goal X" | Lead |
| 2 | UX friction and wellbeing | Code paths, UI strings, error handling, tickets | Dead ends, confusing errors, dark patterns, accessibility gaps | "Checkout error gives no recovery path; 12 tickets mention it" | Lead |
| 3 | Doc drift | Confluence pages, code, shipped work | Docs contradicted by current code or recent work | "API guide still documents v1 auth, removed in March" | Lead |
| 4 | Security and CRA | Code, dependencies, optional SARIF/CycloneDX from CI | Vulnerabilities, risky patterns, CRA-relevant obligations | "Exploitable dependency in billing service; CRA reporting applies" | Strong 4th |
| 5 | Tech debt and architecture | Code, commit history, incidents | Hotspots where complexity and churn meet, dead code | "Payments module: highest churn, 3 incidents — refactor before feature X" | Full scope |
| 6 | Decision consistency | Recorded decisions, code, open work | Code or backlog that contradicts a live decision | "New Redis usage conflicts with decision of 2026-03-12" | Full scope |
| 7 | Delivery risk | Ownership graph, dependencies, incidents | Blast radius per proposal; knowledge concentration (bus factor) | Attribute on every proposal, plus the overview map | Overview wow |

Why these three lead: Opportunity carries the vision, UX and wellbeing makes it human, and Doc drift shows the loop closing on every shipped item. Security and CRA is the best fourth if time allows; it adds technical credibility and a timely EU angle (CRA reporting obligations apply from September 2026). Lenses 1–6 produce proposals; delivery risk (lens 7) and doc impact (from lens 3) are also attributes every proposal carries.

## Proposal model and triage

Every proposal must show its evidence trail, or judges and users will dismiss it as brainstorm output. Triage quality, not scan quality, is the moat.

Each proposal carries:

| Field | Content |
| --- | --- |
| Title and rationale | What to do and why, in product language |
| Evidence | Links to tickets, file and line, doc paragraph, goal or decision |
| Effort estimate | Range, with the code locations it is based on |
| Confidence | How strongly the evidence supports the proposal |
| Doc impact | Pages that must change when it ships |
| Delivery risk | Blast radius and bus-factor flag for the affected area |
| Provenance | Lens, template version, model used, scan run |
| Fingerprint | Stable hash so re-scans update instead of duplicating |

The triage inbox works like a pull request for the backlog: each scan shows a diff of proposed adds, merges into existing issues, closes and re-scopes.

- **Accept:** creates or updates the Jira issue with evidence attached.
- **Merge:** folds new evidence into an existing issue instead of creating a duplicate.
- **Reject with a reason:** the reason is stored and tunes the lens template for that team.
- **Snooze:** resurfaces only if the evidence grows.

Re-scans are idempotent: an unchanged fingerprint never creates a new proposal, and growing evidence raises confidence on the existing one.

## Architecture on Forge

Dowser is one Forge app with three user surfaces, a scan pipeline, and agent interfaces. Module names below follow the Codegeist resources; limits and availability are week-one spikes.

| Layer | Component | Forge mechanism | Purpose |
| --- | --- | --- | --- |
| UI | Triage inbox | Jira global page | PR-style backlog diff: accept, merge, reject, snooze |
| UI | Evidence panel | Jira issue panel | Evidence trail, doc impact and delivery risk on accepted items |
| UI | Doc impact | Confluence page surface | Shows proposals and shipped work that make this page stale |
| UI | Opportunity map | Jira global page tab | Overview of lenses, hotspots and bus factor — the demo wow moment |
| Agents | Dowser agent | rovo:agent + rovo:action / rovo:skill | Chat: "what should we build next for goal X?", explain a proposal, run a lens |
| Agents | Coding-agent tools | rovo:mcp + open-source skill.md | Claude Code or Cursor file evidence-backed proposals and read context mid-session |
| Context | Teamwork Graph | TWG API (read) + connector (write) | Read goals, people, work; write scan findings and proposals as graph objects |
| Scan | Pipeline | Scheduled trigger + async queue | Incremental scans: diff since last run, chunked per lens |
| Scan | Optional CI runner | Webtrigger | Large repos scan in Bitbucket Pipelines or GitHub Actions and post results |
| Scan | Code access | Bitbucket API; GitHub via egress or TWG connector | Read repository content |
| Models | BYOM gateway | Egress to customer endpoints; Atlassian-hosted LLMs as default if available | Company chooses its model provider; EU-friendly |
| Config | Lens templates | YAML prompt packs in a repo, synced into the app | Versioned, forkable, tuned by triage feedback |
| State | Proposals and fingerprints | Forge storage | Idempotent re-scans, triage history |

Design principle: templates and triage history are versioned like code, so a team can review, fork and roll back how Dowser reasons about its product.

## Hackathon fit

Dowser targets 1st place in its category plus all four $1,500 bonus tracks. Deadline: Dec 22, 2026, 12:00 PST.

**Category:** Software Teams is the safe fit ("issue triage that actually understands what matters"). Business Teams is worth considering: a product-owner pitch may stand out where fewer entries are deeply technical. Decide by end of week 2.

| Bonus track | How Dowser qualifies |
| --- | --- |
| Best Agents | rovo:agent plus reusable rovo:action / rovo:skill modules other agents can call |
| Best app with Atlassian MCP | rovo:mcp tools for coding agents, shipped with an open-source skill.md |
| Best Teamwork Graph integration | Reads goals, people and work; writes findings and proposals into the graph |
| Best Marketplace published app | Listing submitted by week 7; link to the review ticket in the submission |

| Judging criterion (20% each) | How Dowser scores |
| --- | --- |
| Technological implementation | Forge across Jira, Confluence, Bitbucket, Rovo, MCP and TWG; idempotent scan pipeline |
| Design | One coherent loop; the triage inbox and opportunity map as polished surfaces |
| Potential impact | Addresses the post-AI bottleneck: deciding what to build; every proposal evidenced |
| Innovation | Reconciliation of user pain, code capability and intent — not grooming, not generation |
| Presentation | Demo arc: a scan surfaces an opportunity no PM had found, it ships, the docs update |

## 8-week plan

The core loop and three demo lenses are done by Dec 1; the full seven-lens scope and agent interfaces by Dec 15; the last week is for polish and the video.

&#91;embedded content: Dowser build plan · 8 weeks, 2 gates\]

The Dec 1 gate protects the Design score: if the core isn't demo-ready, lenses 4–7 ship as template stubs rather than delaying polish. Decide the category (Software vs Business Teams) by Nov 10.

## Risks and week-one spikes

The biggest risk is breadth: seven lenses in eight weeks can cost the Design score if the core loop isn't polished first. The plan guards this with a gate: the three demo lenses and the triage inbox must be demo-ready by end of week 5, before the other four lenses start.

| Risk | Mitigation |
| --- | --- |
| Generic-looking AI ideas hurt Impact | Mandatory evidence trail and effort estimate on every proposal; curated demo data |
| Breadth dilutes Design | Week-5 gate; lenses 4–6 share one template engine, so each is mostly a prompt pack |
| Forge execution limits on whole-repo scans | Incremental diff scans, async queue, optional CI runner |
| BYOM egress costs the "Runs on Atlassian" posture | Offer Atlassian-hosted LLMs as default tier if available; BYOM as opt-in |
| Native Atlassian AI already creates items from Confluence | Demo shows the delta: discovery across sources, dedupe and reconciliation |
| Marketplace review latency | Submit listing by week 7 |

Week-one spikes:

- [ ] Teamwork Graph API: which entity types can be read and written; connector setup
- [ ] rovo:mcp module limits and auth model
- [ ] Forge egress, Atlassian-hosted LLM availability, function and queue time limits
- [ ] Bitbucket and GitHub code access paths for incremental scans
- [ ] Atlassian's native AI work-item creation from Confluence, to define the demo delta
- [ ] Name conflicts: no "Dowser" app found on the Atlassian Marketplace; a small AI dataset-selection tool named Dowser launched on Product Hunt in January 2026, in a different domain. List as "Dowser for Jira"; run a formal EUIPO/USPTO trademark search before any commercial launch.

## Sources

- [Codegeist 2026 overview](https://codegeist2026.devpost.com/)
- [Codegeist 2026 resources](https://codegeist2026.devpost.com/resources)
- [Introducing AI Backlog for Jira (Atlassian Community)](https://community.atlassian.com/forums/App-Central-articles/Introducing-AI-Backlog-for-Jira-FREE-Promo-Code-included/ba-p/3202762)
- [AI Backlog for Jira — archived Marketplace listing](https://marketplace.atlassian.com/apps/533390074)
- [Publicis Sapient Slingshot Backlog AI](https://www.publicissapient.com/resources/demos/backlogai)
- [Codegeist 2025 winners](https://www.atlassian.com/blog/developer/meet-the-winners-of-codegeist-2025-atlassian-williams-racing-edition)
- [Dowser on Product Hunt (name check)](https://www.producthunt.com/products/dowser/launches)
