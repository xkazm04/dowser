# Moonshot scout: atlassian-app (forge/), 2026-11-04

The context map's `apps/forge/` path is stale; the real tree is `forge/`. Every path below is repo-relative.

---

## 1. Jira lifecycle event plane: accepted -> delivered / abandoned / recurred, automatically

- **spine:** shipped-outcome feedback loop
- **size:** XL
- **impact:** 9
- **effort:** 7
- **risk:** 5
- **confidence:** medium
- **impact_why:** This gives plan direction #6 ("close the shipped loop") an actual structure. Every accepted card gets a measured fate without anyone filling in a form, and that fate feeds lens learning, the demo arc ("it ships") and Technological Implementation, which breaks ties.

### Summary

The app subscribes to Jira issue events and keeps a delivery state per proposal in Forge SQL: `accepted -> in-progress -> delivered | abandoned`. A delivered finding whose fingerprint is pushed again becomes `recurred`. These fates go back to the skill as a new, additive kind of verdict-log event. Lens learning can then weight "accepted AND shipped" above "accepted".

### Description

**No Jira product events reach the app.** The only triggers are app install, app upgrade and a daily migrate (`forge/manifest.yml:187-199`).

**Delivery is read by polling, and only when someone opens the Learning tab.**
- `candidatesOf` runs one JQL status read per view, over the newest 200 accepted items (`forge/src/core/reflect.mjs:302-323`; `CANDIDATE_SCAN` at `:38`).
- Nothing stores the status, when it changed, or the resolution.

**The only source of an outcome is a person clicking a rating.**
- The rating path is `forge/src/core/reflect.mjs:439-447`, writing to `outcomes` (`forge/src/sql/migrations.mjs:169-182`).
- The ratings are `right`, `partly` and `wrong` (`forge/src/core/types.mjs:22`).
- An issue closed as "Won't do" looks the same as one that shipped until somebody rates it.

**A finding that comes back after its issue is Done goes unnoticed.**
- A push reopens only `snoozed` or `rejected` items (`forge/src/core/push.mjs:389`).
- An accepted item that recurs is only marked "grew" (`push.mjs:302-312`).
- Yet a finding that returns after Done is the clearest sign a fix did not hold.

**The skill side already exists.** The skill reads outcomes per lens (`skill/scripts/lib/memory.mjs:186-190`), so a richer outcome stream reaches the lens context without new plumbing there.

### Flow

1. **Subscribe to issue events.** Add `trigger` events `avi:jira:updated:issue` and `avi:jira:deleted:issue`, handled by `index.issueEvent`. The core filters events to issues whose key is in `proposals.issue_ref` (index at `migrations.mjs:79`).
2. **Add a delivery table.** Migration v026 creates `deliveries (ref PK, project_key, fp, issue_ref, state, status_name, resolution, started_at, done_at, recurred_at, updated_at)`. Every state move is compare-and-set.
3. **Map Jira state to a delivery state:**
   - status category done with resolution Done or Fixed -> `delivered`;
   - done with Won't do, Duplicate or Cannot reproduce -> `abandoned`;
   - indeterminate -> `in-progress`;
   - Done reopened -> back to `in-progress`.
4. **Detect recurrence in the push.** When a `delivered` accepted item is pushed again, set the state to `recurred` and `change_kind` to `recurred`, and show an inbox badge. The item is not reopened, because acceptance stays human.
5. **Extend the contract (additive).** Either `dowser_verdicts_pull` rows gain `kind: delivery` with `state` and `done_at`, or `reflect_sync` gains `deliveries[]`. The skill ingests either as machine outcomes with `decided_by: jira:<status>`.
6. **Update the Learning tab.** Show the accepted-to-delivered rate per lens and the median days from accept to done. `candidatesOf` reads the new table instead of calling JQL on every view. The daily trigger reconciles events that were missed: delivery can take up to 3 minutes and is not guaranteed.
7. **Test.** Run tests on node:sqlite against a fake event stream. The live check closes DOW-3 and confirms the next pull carries `delivered`.

### Expected impact

- Every accepted card gets a fate within minutes, with no human step.
- Lens precision can be weighted by what actually shipped.
- The demo can show the whole loop: scan, accept, Done, and the next scan knows.
- Recurrence catches fixes that did not hold.

### Evaluation

- **Claim:** accepted items get a fate that the machine observes, which lenses can learn from.
- **Before:**
  - 0 Jira product events subscribed (`manifest.yml:187-192`).
  - 1 outcome source: the manual rating.
  - 0 detections of a finding recurring after Done (`push.mjs:389`).
- **After:**
  - 3 fates recorded automatically: delivered, abandoned, recurred.
  - Outcome coverage of accepted items goes from "whoever rated" to every issue Dowser can read.
- **Method:** simulation, three cases walked.
  - **(a) DW-1 is accepted as DOW-2, and DOW-2 moves to Done.** Today nothing is stored, and the item shows as a candidate only when someone opens the Learning tab. After: the event writes `delivered`, and the skill learns it on its next pull.
  - **(b) An accepted item's issue is closed as Won't do.** Today it looks the same as shipped work. After: it is `abandoned`, which feeds the lens as a soft negative.
  - **(c) DOW-2 is Done, and the next scan pushes the same fp and anchors.** Today it is a silent "grew". After: it is `recurred`, with an inbox badge, and the skill is told.
- **Result:** better.
- **Gate:** architecture (an event trigger, a new table, and an additive contract kind).

- **unblocks:**
  - card 2's `work_report` can end in `delivered`;
  - card 4's doc-drift delivery;
  - lens-learning weights;
  - the demo arc's "it ships";
  - a nudge to the assignee to rate the outcome;
  - a per-lens delivery metric for judges.
- **depends_on:** nothing. It uses the existing `issue_ref`, and the `read:jira-work` scope is already granted.
- **fits_deadline:** yes. About 1.5 weeks, which fits plan weeks 3-4 ("the shipped loop"). Everything except one live event check can be tested off-site.

---

## 2. Agent work queue over MCP: coding agents pull accepted work and report it built

- **spine:** agent-addressable backlog queue
- **size:** XL
- **impact:** 9
- **effort:** 6
- **risk:** 5
- **confidence:** medium
- **impact_why:** This is the strongest story for "Best app with Atlassian MCP". Today MCP is a private sync pipe for one skill. With this card, any MCP client (Claude Code, Codex, Cursor, Rovo Dev) can ask Jira "what has the team approved for me to build, and with what evidence?" and report the result back, while the human gate stays in Jira.

### Summary

Add three MCP tools:

- `dowser_work_list {project_key, lens?, limit}`: accepted items that are not yet delivered, ordered by score.
- `dowser_work_get {ref}`: the card, its evidence pinned to `head_sha`, the Jira issue, the lens direction and the triage notes.
- `dowser_work_report {ref, pr_url?, commit_sha?, anchors_touched_json?, evidence_check_json?}`: posts a comment on the Jira issue as the app (after checking the caller's ADD_COMMENTS permission), writes a `work_reports` row, and can optionally move the issue to In Progress.

The skill gains a `/dowser build DW-12` path. After the change it re-verifies the original evidence quotes, which proves the finding is resolved.

### Description

**All eight MCP tools are scan plumbing:** sources, push, pull, areas, reflect and direction (`forge/manifest.yml:24-32`; `forge/src/core/app.mjs:47-49`).

**The actions an agent would want exist, but only for Rovo.**
- They are declared with `function: rovo` (`manifest.yml:103-130`; `ROVO_ACTIONS` at `app.mjs:52`).
- They are not listed under `rovo:mcp`, so an external coding agent cannot list an inbox, explain an item or act on one.

**The core already has the parts:**
- the full card with its evidence trail (`dowser_proposal_explain`, `app.mjs:350-365`);
- a Jira comment port behind a permission gate on the caller (`needJira` in `app.mjs`; `Jira.addComment` at `forge/src/core/ports.mjs:137`);
- evidence pinned to a commit (`evidence.head_sha`, `migrations.mjs:85-98`).

**There is no read for "work to do".** `reflect_sync` returns outcomes only to the skill that pushed them (`reflect.mjs:75-94`).

### Flow

1. **Contract.** Add the three tools to `forge-mcp-2` as additive tools with scalar inputs and `*_json` strings, and update `tools/mock-forge-mcp.mjs`.
2. **Core `work.mjs`:**
   - the list reuses the inbox order, filtered to `status=accepted`;
   - it leaves out items that card 1 marks `delivered`, or falls back to Jira's status if card 1 is not built;
   - the get reuses `getProposal` plus `directionTool`.
3. **`work_report`.** Open the item through `acc.proposal`, check ADD_COMMENTS on `issue_ref`, then build an ADF comment from `adf.mjs` with the PR link, the anchors touched and each evidence quote marked gone or still present. Write it to `work_reports` (v027, append-only).
4. **Skill.** `SKILL.md` gets a build-mode step:
   - call `work_get`;
   - make the change;
   - re-run `verify` on the stored quotes;
   - send the result as `evidence_check_json`.
5. **Surfaces.** The inbox and the issue panel show a "Built by agent" strip with the PR link and the evidence check. The Rovo agent gains `dowser_work_list` so it can answer "what is ready to build?".
6. **Live check.** Extend `tools/forge-live-e2e.mjs`: accept DW-3, have the agent pull and report it, and check that the comment appears on the issue.

### Expected impact

- MCP becomes a general backlog API for agents, with permission checks, instead of a pipe for one skill.
- The judging story becomes "scan, human approves in Jira, agent builds, Jira shows the proof".

### Evaluation

- **Claim:** an external MCP agent can go from approved work to a reported change through Dowser alone.
- **Before:**
  - 0 of 8 MCP tools read inbox items for an agent.
  - 3 Rovo-only actions are invisible to MCP (`manifest.yml:103-130`).
- **After:** 3 work tools, and a round trip that ends in a Jira comment carrying an evidence re-check.
- **Method:** simulation, three cases walked.
  - **(a) Claude Code in the repo asks what to build.** Today it can only push and pull. After: `work_list` returns DW-1 with its evidence.
  - **(b) Cursor, with no Dowser skill installed, calls `work_get DW-1`.** After: it gets the card, the quotes pinned to their commit and the Jira key, and it needs no local store.
  - **(c) An agent reports PR #12 for a person who cannot comment on the issue.** After: the tool answers `forbidden` with the reason, and nothing is written.
- **Result:** better.
- **Gate:** direction. It widens MCP beyond the skill seam, and acceptance must stay human.

- **unblocks:**
  - the MCP bonus segment of the demo;
  - a PR link on card 1's `delivered` state;
  - Rovo answers to "what is ready to build?";
  - a later link back from PRs.
- **depends_on:** nothing hard. Card 1 makes "not delivered" exact.
- **fits_deadline:** yes. About 1 week, reusing existing core reads; it fits plan weeks 3-5.

---

## 3. Dowser facts as native Jira data: indexed issue properties, JQL, a gadget and Automation

- **spine:** Jira-native finding properties
- **size:** L
- **impact:** 7
- **effort:** 5
- **risk:** 3
- **confidence:** high
- **impact_why:** Dowser's facts live only in Forge SQL and in the prose of the issue description. Making them indexed Jira data lets boards, filters, dashboards and Automation use them, which turns Dowser into an "App for Software Teams" rather than a side page. Native Jira integration also counts toward Technological Implementation.

### Summary

- **Issue property.** On accept, and on a merge into an existing Jira issue, write the issue entity property `dowser` = `{ref, fp, lens, kind, score, band, mvp, confidence, impact, delivery_state}`.
- **JQL.** Index the property with `jira:entityProperty`, so teams can query `issue.property[dowser].lens = "security-cra" AND ...band = "ranked"`.
- **Gadget.** Add a `jira:dashboardGadget` that shows lens yield and delivery rate.
- **Automation.** Add an `automation:actionProvider` action: "Ask Dowser for evidence on this issue".

### Description

- **What createIssue sends today.** Only project, type, summary, description and labels, and the label is set only for the sample (`forge/src/adapters/atlassian.mjs:124-137`; `ports.mjs:136,142`).
- **Where the score lives.** Score and lens appear only as a facts table inside the ADF description (`docs/contracts/forge-mcp-2.md`, Versioning, scan-finding/1).
- **What a merge leaves.** A merge into an existing Jira key leaves only a comment (`ports.mjs:137`), so no Jira query can find that issue as Dowser-backed.
- **How the issue panel finds its card.** By an `issue_ref` lookup inside the app's own SQL (`migrations.mjs:79`). Nothing outside the app can do the same.
- **What the manifest lacks.** No `entityProperty`, `dashboardGadget` or `automation:actionProvider` module (`forge/manifest.yml:16-209`).

### Flow

1. **Index the property.** Add `jira:entityProperty`: entity issue, key `dowser`, indexed fields `lens`, `kind`, `band`, `score` (number), `mvp`, `confidence`, `delivery_state` and `ref`.
2. **Write it.** Add a Jira port method `setIssueProperty`: PUT `/rest/api/3/issue/{key}/properties/dowser`, as the app, under the `write:jira-work` scope the app already has. Call it on accept, on a merge into a Jira key, and whenever card 1 changes the delivery state.
3. **Backfill.** The daily trigger writes the property on accepted issues that lack it. The write is idempotent.
4. **Gadget.** Build the `dashboardGadget` from the `reflect.data` readouts.
5. **Automation.** Add an `actionProvider` pointing to a new action, `dowser_issue_evidence {issue_key}`.
6. **Docs and check.** Add JQL recipes to `docs/forge-app.md`, and render the gadget in the fixture UI.

### Expected impact

- Teams can filter, report and automate on Dowser findings with tools they already use.
- Issues that were merged from a proposal become visible as Dowser-backed.

### Evaluation

- **Claim:** Dowser facts become Jira data that can be queried.
- **Before:** 0 Dowser fields can be queried with JQL. The only trace visible in Jira is the `dowser-sample` label, and only on sample issues (`ports.mjs:142`).
- **After:** about 8 indexed fields on every Dowser-backed issue, including merged ones.
- **Method:** simulation, three cases walked.
  - **(a) A lead wants every accepted security-cra item that is not done.** Today JQL cannot express it. After: one JQL filter.
  - **(b) DW-7 is merged into SHOP-12.** Today SHOP-12 carries only a comment. After: it carries the property and shows up in that filter.
  - **(c) An Automation rule should assign every new Dowser MVP issue to the tech lead.** Today there is nothing for the rule to trigger on. After: it triggers on the property.
- **Result:** better.
- **Gate:** none. The modules are additive, and every scope used is already granted.

- **unblocks:**
  - dashboards for the demo;
  - card 1's delivery states visible on boards;
  - routing by Automation;
  - screenshots for the Marketplace listing.
- **depends_on:** nothing. It is better with card 1.
- **fits_deadline:** yes, about 4-5 days.

---

## 4. Confluence doc-drift closure: page events, a drift banner, and a drafted fix

- **spine:** doc-drift resolution loop
- **size:** L
- **impact:** 7
- **effort:** 6
- **risk:** 5
- **confidence:** medium
- **impact_why:** The demo arc in the plan ends with "the docs update" (`docs/concepts/project-status-and-next-steps.md`, Next steps item 9), but Dowser can only read Confluence today.

### Summary

- **Page events.** Listen to `avi:confluence:updated:page` for pages that open or accepted proposals name. Record "page edited after accept" both as a delivery signal and as a request for the next scan to re-check.
- **Banner.** Show a `confluence:pageBanner` on any page with open drift.
- **"Draft the fix".** Post a footer comment that quotes the code evidence against the stale sentence. It never edits the page body.

### Description

- **Confluence presence today.** One byline item (`forge/manifest.yml:180-185`).
- **Scopes today.** Read-only (`manifest.yml:222-224`).
- **How the byline finds proposals.** A `LIKE` over `record_json` across every proposal (`forge/src/core/cards.mjs:335-342`). With no index from page to proposal, a page event cannot be routed cheaply.
- **Which pages to watch.** Already known from the lens direction for doc-drift, which carries `spaces` (forge-mcp-2, "Lens direction").

### Flow

1. **Index pages.** A new migration creates `page_links (page_id, proposal_id, source)`, filled at push time and backfilled once for older proposals. The byline then reads this table instead of using `LIKE`.
2. **Handle page edits.** On the page-update trigger, store a `page_edits` row and mark the linked doc-drift items "page changed since the decision". For an accepted item this makes it a delivery candidate, which the next scan's re-check of the quote confirms.
3. **Show the banner.** `pageBanner` reuses the byline data.
4. **Draft the fix.** Add the `write:confluence-content` scope. The action builds a footer comment in ADF from the stale claim, the code quote and a commit link. It first checks that the person may comment on the page.
5. **Tell the skill.** The verdicts pull carries `page_changed` for doc-drift items, and the skill re-checks those items first on its next run.

### Expected impact

- Doc-drift becomes the one lens with a fix people can see.
- The byline lookup becomes an indexed read instead of a scan.

### Evaluation

- **Claim:** doc-drift findings can be acted on and closed from inside Confluence.
- **Before:** 0 ways to write to Confluence and 0 Confluence events. Every page view runs one `LIKE` scan over all open and accepted proposals (`cards.mjs:338`).
- **After:** a banner, a drafted comment and page-edit events, all on an indexed lookup.
- **Method:** simulation, three cases walked.
  - **(a) DW-3 names page 164004, and the page's owner edits the page.** Today nothing happens. After: DW-3 shows "page changed", and the next scan re-verifies it.
  - **(b) Someone reads a page that has drifted.** Today they see the finding count only in the byline popup. After: a banner on the page.
  - **(c) A PM without edit rights clicks "Draft the fix".** After: the action is refused with the reason, and nothing is posted.
- **Result:** better.
- **Gate:** architecture (a new write scope, a new table and an event trigger).

- **unblocks:**
  - the demo arc's "the docs update";
  - card 1's delivery state for doc-drift;
  - retiring the byline `LIKE` scan.
- **depends_on:** card 1, optionally.
- **fits_deadline:** yes, if started by week 5. A scope change forces re-consent, so batch it before or with the production install in plan step 1.

---

## 5. Jira-project portfolio: many repos, one team view

- **spine:** multi-repo team portfolio
- **size:** L
- **impact:** 6
- **effort:** 5
- **risk:** 3
- **confidence:** medium
- **impact_why:** A real team owns several repos per Jira project. "What should WE build next" has no screen today.

### Summary

Add a `jira:projectPage`: a "Dowser" tab inside the Jira project. It rolls up every inbox whose `jira_project_key` is this project and shows:

- one combined ranked queue;
- a heat grid of repo by lens;
- cross-repo clusters: findings in different repos that cite the same ticket, page or goal;
- lens direction inherited from the project, so it is set once.

### Description

**The data model already allows many repos per Jira project, but no screen uses it.**
- An inbox has a repo key plus an optional `jira_project_key` (`migrations.mjs:28-36`).
- Access already follows the Jira project (`access.mjs:2-5,63-64`).

**Every view is per inbox.**
- The map and the Learning tab are per `project_key` (`app.mjs:107,109`).
- Directions are per inbox (`migrations.mjs:185-195`).

**Ticket and page refs are the only cross-repo join.**
- A fingerprint includes code anchors (`fingerprint.mjs:2-5`), so two repos never share a finding by fp.
- Non-code evidence refs, such as a ticket key or a page, are the only thing two repos can share. The `evidence` table stores `type` and `ref`, indexed on type (`migrations.mjs:85-100`).

**The manifest has only a global page** (`manifest.yml:156-170`).

### Flow

1. Add a `jira:projectPage` and a `portfolio.data {jira_project_key}` resolver. Access requires BROWSE_PROJECTS on that project.
2. Build the view from the existing reads: `listInbox` with `visible` limited to this project's inbox keys, plus a merged `mapData`.
3. Find clusters by grouping evidence refs of type ticket, page or goal and keeping those with more than one distinct `project_key`.
4. Store a project-level default direction as a `directions` row keyed `jira:<KEY>`. `direction_get` merges it under each inbox's own direction, as an additive change.
5. Check the screen in the fixture UI, then live on the DOW project.

### Expected impact

- One screen for the team.
- Cross-repo opportunities that a single-repo scan cannot name.
- Lens direction set in one place.

### Evaluation

- **Claim:** a team with more than one repo gets one prioritized view and signals that span repos.
- **Before:** the only cross-inbox view is "All inboxes" (`cards.mjs:228-230`), which has no map and no clusters. Direction is set per inbox only.
- **After:** a project tab with a combined queue, a heat grid, clusters and inherited direction.
- **Method:** simulation, three cases walked.
  - **(a) Inboxes shop-web and shop-api both belong to SHOP.** Today they are compared in two places. After: one queue.
  - **(b) Findings in both repos cite SHOP-88.** Today nothing links them. After: one cluster.
  - **(c) A lead wants to exclude csv items.** Today they set it per repo. After: they set it once.
- **Result:** better. The value of clusters is unmeasurable until a real multi-repo run exists.
- **Gate:** none.

- **unblocks:** a team-level demo, Marketplace positioning, and a goal rollup once Teamwork Graph lands.
- **depends_on:** nothing.
- **fits_deadline:** yes, about 4 days. It ranks after cards 1-3.

---

## Not proposed

**An in-app scan of tickets and pages with the Forge `llm` module.** It would give judges a scan without a local skill, but it reverses decision D1/D11 ("Scan pipeline on Forge... Dropped by design"). Gate: direction.

## Incidental S/M defects

1. `forge/src/core/reflect.mjs:38,302-305`: the 200-item `CANDIDATE_SCAN` is applied before the done-first sort, so an older accepted item whose issue is Done never becomes a rating candidate.
2. `forge/src/core/reflect.mjs:92`: the sync returns only the newest 200 outcomes, with no cursor. If more than 200 are recorded between two syncs, the oldest never reach the skill.
3. `forge/src/adapters/atlassian.mjs:164-183` with `forge/src/core/app.mjs:84`: issue status is read as the app, and an accept can target a `jira_project_key` given per call. The Learning tab can then show a status from a project the viewer cannot browse, which is a small information leak.
4. `forge/src/core/cards.mjs:338`: on every page view, the byline runs a `LIKE` scan over every open and accepted proposal in every inbox. Its cost grows linearly, and it is separate from the already-filed "bylineForPage reads cards one at a time".
5. `forge/src/core/push.mjs:389`: an accepted item whose issue is Done and that is pushed again is recorded only as "grew", with no signal that the finding came back. This is card 1's premise, listed here in case card 1 is not taken.
