# Dowser - project status and next steps

As of 2026-10-29 (week 1 of the 8-week plan in `docs/project-documentation.md`; Codegeist deadline
Dec 22, 2026, 12:00 PST). Written for a fresh session that picks the work up with no other context.
Read this first, then `AGENTS.md`, then the documents it points to.

## Where the project stands

Dowser runs as two halves joined by one contract:

- **The local skill** (`skill/`): runs inside Claude Code or Codex against a checked-out repository,
  scans it through four lens packs, verifies every quoted evidence string, and keeps triage memory in
  `~/.dowser/`. Shipped.
- **The Forge app "Dowser for Jira"** (`forge/`): receives verified proposals over a `rovo:mcp`
  server, shows them in a Jira triage inbox, creates the Jira issue on Accept, and returns every
  verdict to the skill. Built, deployed to the development environment, and verified end to end on
  a live site.
- **The seam**: `docs/contracts/forge-mcp-2.md` (eight tools: the original six plus
  `dowser_reflect_sync` and `dowser_direction_get`; scalar inputs). `tools/mock-forge-mcp.mjs`
  is its executable spec for tests; `tools/forge-live-e2e.mjs` drives the live app.

Gates on `master`: root `npm run typecheck` clean and `npm test` green; `npm run forge:typecheck`
clean, `npm run forge:test` green, `npm run forge:check-shared` clean, `npm run forge:build-ui` green
(test counts change every wave; `node tools/quality-snapshot.mjs` prints the current ones).

A ten-wave hardening campaign, in which Dowser scans itself and the agent plays the team, is under way:
`docs/evals/campaign/README.md` (protocol) and the newest `wave-NN.md` (where it stands).

## Reconciliation against the original plan

The product plan (`docs/project-documentation.md`) assumed scanning would run on Forge. The first
design spark moved the scan to the user's machine; the second built the Forge half. The table maps
each planned item to what exists.

| Planned item | Status | Notes |
| --- | --- | --- |
| Triage inbox (Jira global page) | Done, live-verified | Run-diff groups, Accept / Merge / Reject / Snooze, deep link `?ref=DW-n`, pages of 50 |
| Evidence panel (Jira issue panel) | Done, live-verified | Opened from the issue's "View app actions" menu as "Dowser evidence" |
| Doc impact (Confluence) | Done, live-verified | Byline item on every page; lists proposals whose evidence or `doc_impact` names the page |
| Opportunity map | Done, live-verified | Lens x area heat table, churn / authors / bus-factor flag, effort vs confidence plot |
| Coding-agent tools (`rovo:mcp` + skill.md) | Done, live-verified | Claude Code connected over OAuth; push, pull and areas round trip proven |
| Rovo agent + actions + rovo:skill | Built, NOT tested live | `dowser-agent` can list, explain and record verdicts (`via:rovo`) |
| Teamwork Graph goals (read) | Built, BLOCKED | Needs Atlassian to allowlist the app id; the tool answers `unavailable` until then |
| TWG write (findings into the graph) | Not built | Non-goal of the Forge spark; the TWG bonus track accepts read OR write |
| Scan pipeline on Forge, BYOM, CI webtrigger, code access from Forge | Dropped by design | The scan runs locally through the skill (decision D1/D11 of the local-scan spark) |
| Lenses 1-4 (Opportunity, UX friction, Doc drift, Security and CRA) | Done | `skill/lenses/` |
| Lenses 5-6 (Tech debt, Decision consistency) | Not started | Planned as prompt packs on the same template engine; Dec 1 gate allows stubs |
| Lens 7 Delivery risk | Partial | Map shows churn, authors and bus factor; the per-proposal `delivery_risk` attribute shows "Not measured" because no lens fills it yet |
| Proposal model (fingerprint, evidence, effort, confidence, provenance) | Done | `skill/scripts/lib/model.mjs`, shared with Forge as byte copies |
| Reject reasons tune the lens | Done (local) | Rule offers after 3 matching rejections; exemplars from accepted items |
| Marketplace listing by week 7 | Not started | Needs a production deploy, app sharing enabled, listing copy, review ticket |
| Category decision (Software vs Business Teams) | Open | Plan says decide by Nov 10 |
| Demo video (< 5 min) and judges' setup | Not started | Setup steps drafted in `docs/forge-app.md` |

Week-one spikes from the plan: `rovo:mcp` limits and auth model are answered (see below); TWG
entity access is answered in part (goals readable once allowlisted); Forge egress / hosted LLM and
Bitbucket / GitHub code access are moot after the move to a local scan; Atlassian's native work-item
creation (the demo delta) and the trademark search are still open.

## Facts a new session needs

**Site and app**

- Site: `https://dowser.atlassian.net` (Jira + Confluence, Rovo active). Org admin: the operator.
- App id: `68371a5c-644f-4311-b1c8-8d9582995796`, environment `development`, one installation
  (`3321a54e-0602-4626-b9df-cb24ee6fc1f7`) with Jira required and Confluence connected
  (`app.compatibility` in `forge/manifest.yml`). `forge install list` must show ONE row.
- Inbox page: `https://dowser.atlassian.net/jira/apps/68371a5c-644f-4311-b1c8-8d9582995796/646b63dc-cbf7-4575-b2ff-dfac59ca68c6/inbox`
- Test data on the site: Jira project `DOW` ("Dowser Test", created for the smoke test; Accept target
  for the fixture inbox), issue `DOW-1`, inbox items `DW-1` (accepted), `DW-2` (snoozed), `DW-3`
  (open, names Confluence page 164004). Fixture inbox key: `github-com-xkazm04-dowser-e2e`.

**Forge CLI on this machine (Windows arm64)**

- Installed with `npm i -g @forge/cli --ignore-scripts` (14.2.0) because the `cloudflared`
  postinstall has no arm64 build. Consequence: `forge tunnel` does not work; deploy and read
  `forge logs` instead. Upgrading to 15.x needs the same flag; the CLI changelog of 2026-10-26 asks
  for Node 24.22.1+, and this machine has 24.22.0.
- Credentials: the User environment variables `FORGE_EMAIL` and `FORGE_API_TOKEN`. A shell started
  before they were set must load them first (never print the token):
  `$env:FORGE_EMAIL=[Environment]::GetEnvironmentVariable('FORGE_EMAIL','User'); $env:FORGE_API_TOKEN=[Environment]::GetEnvironmentVariable('FORGE_API_TOKEN','User')`
- The same token works for Jira REST basic auth (used to create the `DOW` project).
- `forge register`, `forge create` and Developer Space prompts need a real terminal (not a
  non-interactive tool shell). `forge register` also reformats `manifest.yml` and broke a description
  containing a comma; check the diff after any CLI command that rewrites the manifest.

**MCP connection**

- Server URL: `https://mcp.atlassian.com/forge/68371a5c-644f-4311-b1c8-8d9582995796` (the `/forge/v1/`
  variant is 404). Registered for this project with `claude mcp add --transport http dowser <url>`;
  `/mcp` signs in over OAuth. `claude mcp list` shows the state.
- The admin switch that exposes the tools: admin.atlassian.com > organization **dowser** > Apps >
  Sites > **dowser** (expand Sites) > Connected apps > expand **Dowser** > View app details >
  Details tab > section **TOOLS** > **Enable tools**. It is enabled now. Atlassian's own guides
  still describe an older layout.
- A development install suffixes every tool name: `dowser_verdicts_pull_development`. `SKILL.md`
  matches with or without the suffix. Production names carry no suffix.
- A Claude Code session sees MCP tools only if the server existed when the session started. To call
  them from an older session, run a headless `claude -p` from this repository, as
  `tools/forge-live-e2e.mjs` does.

**Platform behaviour learned the hard way**

- Forge SQL is one database per installation, and has no transactions (one statement per request).
  Write-back is built from compare-and-set moves, UNIQUE constraints and `repairVerdicts` before
  each pull; see the WP2 notes in `forge/src/core/`.
- Separate Jira and Confluence installations get separate databases, and the MCP endpoint binds to
  one of them. That is why `app.compatibility` exists in the manifest. Verified: after the merge,
  Jira inbox, MCP and the Confluence byline read the same data.
- Custom UI runs in an iframe on `*.cdn.prod.atlassian-dev.net`; Atlaskit components were avoided
  because their runtime-injected styles risk the Custom UI CSP. Styling uses token CSS variables.

**Browser testing**

The Jira and Confluence surfaces were tested by driving a dedicated Chrome
(`chrome.exe --remote-debugging-port=9222 --user-data-dir=<temp profile>`, operator signed in once)
from `playwright-core` scripts over CDP. Two traps: the app iframe is an out-of-process frame that is
not attached after a reconnect, so do a whole flow (open dialog, click, confirm) in ONE connection;
and Jira's sidebar groups need a DOM click, not a coordinate click.

## Gaps found in the live test (not fixed)

1. **Snooze has no confirmation and no undo**: one click moves the item. Add an undo toast (a
   verdict reversal needs a server path; today there is none) or a confirm step.
2. **Triage history shows "Jira user 5ec6bff9..."** instead of a display name. Resolve account ids
   (asApp `/rest/api/3/user/bulk`) when building the panel and inbox history.
3. **Decided cards keep the "NEW" badge** under the Accepted / Snoozed filters. The change label
   should only show on open items.
4. **Accept dialog preview shows raw markdown** (`## Summary`). The created issue is correct (ADF),
   so render the preview from the same ADF builder.
5. **`decided_by` from the Rovo path and `merge` into an existing Jira key** were not exercised live.
6. **No local `forge logs` output for resolver calls**: logs showed only the migrate function. Add a
   structured log line per tool call and per resolver error so live failures are diagnosable.

## Next steps, in order

Ordered by what protects the Dec 1 gate first (core loop + three demo lenses demo-ready), then the
bonus tracks, then polish.

1. **Fix the six live-test gaps above.** Small, contained, each in `forge/`; redeploy with
   `forge deploy -e development --non-interactive` and recheck with the browser approach.
2. **First real `/dowser` run on a real repository** (open follow-up of the local-scan spark):
   install the skill into a project, run the four lenses against a mid-size repo, push to the live
   inbox, and measure the duplicate rate across three reruns (the fingerprint risk). This is the
   first test of scan QUALITY; everything so far tested plumbing.
3. **Test the Rovo agent live**: ask it to list the inbox, explain `DW-3`, and accept or reject one
   item; confirm the verdict reaches the skill on the next pull with `via:rovo`.
4. **File the Teamwork Graph allowlist request** with Atlassian (app id above). Until it lands, the
   goals source answers `unavailable` and the Opportunity lens runs without goals. Decide whether the
   TWG bonus track needs more than goal reads.
5. **Test the two remaining source tools live** (`dowser_sources_tickets`, `dowser_sources_pages`)
   with real tickets and pages on the site; seed the site with demo data that tells the demo story
   (user tickets that the code almost supports, a stale Confluence page).
6. **Category decision by Nov 10** (Software Teams vs Business Teams).
7. **Lenses 5-7** after the Dec 1 gate, or as stubs if the gate is at risk: Tech debt and
   architecture, Decision consistency, and a lens (or a skill step) that fills `delivery_risk` per
   proposal from the areas data.
8. **Production path for judges and the Marketplace (week 7, Dec 8-14):** `forge deploy -e
   production`, enable app sharing in the developer console ("Distribute your apps"), write the
   install link and judges' setup (they must enable tools themselves under Connected apps), Marketplace
   listing as "Dowser for Jira", trademark search before any commercial launch.
9. **Demo and video (last week):** curated demo repository and site data, the arc from the plan
    (a scan surfaces an opportunity no PM had found, it ships, the docs update).

## Open follow-ups carried from the design sparks

- Byline count in the byline title via `dynamicProperties` (today the count shows only in the popup).
- Map cells link to the inbox filtered by area and lens.
- Error codes `not-found` / `conflict` in the contract (additive, so still forge-mcp-2).
- Share the lens kind lists with Forge so a push checks kind-in-lens.
- `rules offer` should also return pending unanswered offers; `similar` tuning (local skill).

## Where things are

| What | Where |
| --- | --- |
| Product plan, scoring and timeline | `docs/project-documentation.md` |
| Forge install, MCP setup, surfaces | `docs/forge-app.md` |
| The seam | `docs/contracts/forge-mcp-2.md` |
| Local memory model | `docs/data-model.md` |
| Live end-to-end driver | `tools/forge-live-e2e.mjs` |
| Design decisions and retros (local only, gitignored) | `.spark/Spark/ideas/{local-scan-skill,forge-app}.md` |
