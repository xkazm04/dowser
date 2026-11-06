# Dowser for Jira (the Forge app)

Dowser for Jira is the Forge app in `forge/`. It receives the local skill's verified proposals over a
`rovo:mcp` server and files them in a triage inbox inside Jira. The inbox reads like a pull request for the
backlog. A Jira issue is created only when a person accepts a proposal. Every verdict made in the inbox, in
the evidence panel or through the Rovo agent flows back to the skill through the same contract,
[`forge-mcp-2`](contracts/forge-mcp-2.md). The app also serves Jira tickets, Confluence pages and Teamwork
Graph goals to the skill as scan sources.

## Module map

| Manifest module | Key | Function | What it does |
|---|---|---|---|
| `rovo:mcp` | `dowser-mcp` | `mcp` | The thirteen forge-mcp-2 tools, for Claude Code and Codex CLI |
| `action` (x13) | `dowser_sources_tickets`, `dowser_sources_pages`, `dowser_sources_goals`, `dowser_proposals_push`, `dowser_verdicts_pull`, `dowser_areas_push`, `dowser_reflect_sync`, `dowser_direction_get`, `dowser_memory_pull`, `dowser_work_list`, `dowser_work_get`, `dowser_work_report`, `dowser_verdicts_record` | `mcp` | The tools themselves. `rovo:mcp` lists them |
| `action` (x3) | `dowser_inbox_list`, `dowser_proposal_explain`, `dowser_verdict_record` | `rovo` | The Rovo agent's actions |
| `rovo:agent` | `dowser-agent` | - | Lists and explains proposals, and records verdicts for the person chatting with it |
| `rovo:skill` | `dowser-skill` | - | The read actions as a skill for other agents |
| `jira:globalPage` | `dowser-inbox` | `resolver` | The inbox, the opportunity map, the Learning tab (route `reflect`) and settings (Custom UI) |
| `jira:issuePanel` | `dowser-evidence` | `resolver` | The evidence trail on an accepted issue |
| `confluence:contentBylineItem` | `dowser-doc-impact` | `resolver` | The proposals that cite or affect a page, and Draft the fix |
| `confluence:pageBanner` | `dowser-doc-banner` | `resolver` | One line on a page a Doc drift item names |
| `trigger` | `dowser-page-events` | `page-event` | Page edits of linked pages (doc-drift closure) |
| `jira:entityProperty` | `dowser-issue-property` | - | Indexes the `dowser` issue property for JQL (see "Dowser facts in JQL") |
| `trigger` | `dowser-migrate` | `migrate` | Forge SQL migrations on install and upgrade |
| `trigger` | `dowser-issue-events`, `dowser-issue-deleted` | `issue-event` | Delivery truth: status/resolution changes and deletes of issues Dowser created or merged into (filtered on the `dowser` issue property), recorded as delivered / abandoned / in progress (`core/delivery.mjs`, v027) |
| `scheduledTrigger` | `dowser-migrate-daily` | `migrate` | Daily migrations, then the issue-property backfill (at most 50 items a day) |
| `sql` | `main` | - | The Forge SQL database (MySQL dialect, TiDB) |

### Code layout (design F7)

- `forge/src/index.js` holds the entry points. It reads the caller and the action key and then hands over.
- `forge/src/core/` is pure and Forge-free:
  - `app.mjs` is the one dispatch door. It checks the account, validates input and maps every failure to
    `{error, message}`.
  - `push.mjs`, `verdicts.mjs`, `areas.mjs`, `sources.mjs`, `cards.mjs` and `reflect.mjs` hold the tool and
    resolver logic. `names.mjs` resolves display names, and `observe.mjs` writes the call log.
  - `store.mjs` does row access, and `adf.mjs` converts to and from ADF.
  - The core runs against the ports in `ports.mjs`.
- `forge/src/adapters/` maps the ports to the platform: `forge-sql.mjs` to `@forge/sql`, and
  `atlassian.mjs` to `@forge/api` (`requestJira`, `requestConfluence` and `requestTeamworkGraph`).
- `forge/src/sql/migrations.mjs` holds the schema as one-statement migrations, applied in order by
  `migrationRunner`.
- `forge/src/shared/` holds byte-copies of the skill's pure modules: `validateCandidate`, `fingerprint`,
  `evidenceKey` and `resurfaces`. `npm run forge:check-shared` fails when a copy drifts.
- `forge/test/` runs the core against node:sqlite with the real migrations and a fake Jira.

### Data (Forge SQL)

| Table | Contents |
|---|---|
| `counters` | `ref` is the last `DW-<n>` issued (one counter per installation). `seq:<project_key>` is the last verdict seq |
| `inboxes` | One row per `project_key`, holding the repo URL, the accept target (Jira project and issue type) and the delegated triage (`delegate_until`, `delegate_accepts_per_day`, `delegate_rejects_per_day`, v032-v034; NULL = off) |
| `proposals` | One row per `(project_key, fp)`. Holds the status, the record and the decision stamp |
| `evidence` | Append-only, one row per evidence key. Each row carries the `head_sha` of the push that added it |
| `verdicts` | Append-only verdict log. Its seq is the pull cursor |
| `pushes` | One row per push call. `scanned_at` is set only on the sample load's pushes: when the scan it replays ran |
| `areas` | Per-directory churn and authors for the opportunity map. Each push replaces the project's set |
| `rules` | Rules the skill offered, one row per `(project_key, id)`. While `offered` a later sync refreshes the text; once a person accepted or declined it (`decided_by`, `decided_at`) a sync never reverts it |
| `outcomes` | One row per accepted item (`ref` is the key): the owner's rating (`right`, `partly`, `wrong`), an optional note and the issue |
| `tool_calls` | One row per `<surface>:<tool>` (`mcp:` or `rovo:`): how many calls reached the app and the newest one's time. Written once per call at the dispatch door; a failed write never fails the call. The setup checklist reads the `mcp:` rows |

Forge SQL has no multi-statement transactions. `@forge/sql` sends each statement as its own request, and
the query policy allows one statement per request. The core is correct without transactions:

- Every status move is a compare-and-set.
- Ids come from a compare-and-set counter (no `AUTO_INCREMENT`).
- Inserts check first and are also guarded by a UNIQUE constraint.
- A decision whose verdict row did not land is rebuilt from the decision stamp before the next pull.
- An accept creates the Jira issue before it changes any state. If Jira fails, nothing is written and the
  item stays open. When Jira refuses the create (400), the answer names the field keys Jira's `errors` listed
  (never their values, which can quote issue content) and suggests another project or issue type.

Because each statement is a request (30-60 ms), the store works in sets. A push reads the fps it carries in one
`IN` query, takes a block of DW numbers with one compare-and-set, and writes proposals and evidence with multi-row
`INSERT`s, split to stay under 512 KiB and 5000 parameters a statement. A held card is updated only when it changed.
An inbox page reads its evidence and its push heads once each. One statement is atomic, so a multi-row `INSERT`
that hits a duplicate (a concurrent push filed the fp first) wrote nothing and is retried row by row. A 50-card push
with 3 evidence items each costs about 12 statements, an unchanged re-push about 7, and an inbox page under 10.

### Ports

The core runs against these ports (`ports.mjs`); the adapters map them to the platform.

- `Db`: Forge SQL. `Jira`: create issue, add comment, list projects, and `issueStatuses(keys)`, which
  reads the status name and status category (`new`, `indeterminate`, `done`) of issues, as the user: the
  Learning tab must not show the status of an issue in a project the viewer cannot browse.
- `Users`: `names(accountIds)` reads display names through `/rest/api/3/user/bulk`, as the app. It is best
  effort. A failed batch or a missing name leaves the name out and never fails the call.
- `Perms`: `mine(keys, on?)` asks Jira's `/rest/api/3/mypermissions` **as the user** whether they hold
  BROWSE_PROJECTS, CREATE_ISSUES, ADD_COMMENTS or ADMINISTER, on one project or issue. `core/access.mjs` uses
  it for inbox access: an inbox opens for whoever may browse its Jira project, for its creator until a
  project is set (`inboxes.created_by`, migration v018), and for Jira admins. The dispatch door
  (`core/app.mjs`) checks it before every handler, and checks the caller's own Create issues / Add comments
  before accept and merge make the app write to Jira. The project list for Settings and the accept dialog is
  also read as the user. Contract: "Inbox access" in `contracts/forge-mcp-2.md`.
- `Sources`, `Links`.

Each Custom UI module calls only its own resolver keys (`MODULE_KEYS` in `core/app.mjs`): the issue panel
only `panel.forIssue`, the Confluence byline `byline.forPage` and `byline.draftFix` (which posts Draft the fix
as a page comment), the banner only `byline.forPage`, the inbox page everything else.

### The Learning tab backend (reflection)

Three resolvers serve the Learning tab (page route `reflect`), and tool 7 serves the skill.

| Key | Does |
|---|---|
| `reflect.data` `{project_key}` | What the tab shows, derived from the existing tables plus `rules` and `outcomes`: `rejects` by lens and reason, the newest 10 decision `notes`, the newest 8 `pushes` with today's status of their items, `lens_yield`, `rules`, `candidates`, `outcomes`, `verdicts_by` (the verdict log counted apart for people and a delegate, which the digest reads), and `trust` (table `trust`, migration v023: the skill's per-slice trust as its last `dowser_reflect_sync` sent it, with `updated_at`; omitted until it sends one). `totals` by status is sent too, and the tab does not show it |
| `rule.decide` `{project_key, id, state, text?}` | Moves a rule `offered` -> `accepted` or `declined` as the caller (compare-and-set). `text` replaces the draft and goes only with accept. A rule that is no longer offered is refused with its current state |
| `outcome.record` `{ref, rating, note?}` | Records how an accepted item turned out, once per ref, as the caller. It refuses an item that is not accepted and never overwrites. It answers the outcome and the refreshed candidates |

Choices the data makes:

- **Push retro.** An item belongs to the push in which it first appeared (`proposals.first_run_id`), not
  the latest push that grew it (`last_run_id`). `last_run_id` moves an item to a newer push whenever its
  evidence grows, so the older scan's yield would shrink on its own. `open`, `accepted`, `rejected` and
  `snoozed` are the status of those items today. Merged items count in no column. Pushes of one `run_id`
  (a run over 50 records is several calls) are one row. `dup_rate` is `updated / (created + updated)` and is
  omitted when the push had neither.
- **Time to triage** (goal G-1: a scan triaged in under 10 minutes). Once none of a push's items is open and at
  least one is accepted, rejected or snoozed, the row carries two figures, both whole minutes rounded up.
  `deciding_minutes` runs from the first of those decisions (`first_decided_at`) to the last (`decided_at`): the
  time spent deciding, and the figure G-1 reads. `triage_minutes` runs from the run's earliest push to the last
  decision, so it also counts the time the inbox waited (a scan pushed on Friday and decided on Monday). The
  Learning tab shows "Decided in N min", then "(N min after the push)" when the two differ. Otherwise all four
  keys are omitted; a push of merged items only has none of them.
- **Lens yield.** Only lenses that proposed at least one item appear. A lens with no row was not run, which
  is not the same as proposing nothing.
- **Notes** come from the verdict log (accept, reject and snooze decisions that carry a note), newest first.
- **Candidates** are accepted items with no outcome. Their Jira status is read once per call for the 200
  newest. Items whose issue is done come first, then the rest by newest decision, at most 20. If Jira cannot
  be read, or no longer returns an issue, the candidate answers `issue_status: "unknown"` and
  `done: false`. The call never fails for it.
- **Names.** `decided_by_name` is added to `proposal.get` and `panel.forIssue` history rows and to the
  Learning data. The verdicts the skill pulls carry no names.

### Logging

The dispatch door writes one JSON line to the Forge log (`forge logs`) for every tool, resolver and Rovo
call: `{"dowser":"call","surface":"tool|resolver|rovo","key":"dowser_verdicts_pull","project":"<12 hex>","ok":true,"ms":12}`.
A failed call carries `"ok":false,"error":"<code>"`. A failed resolver call also writes a
`{"dowser":"resolver-error", ...}` line with the key, the error code and `project`, never the message. A line
never carries a payload body, a note, a message, a token or an account id. `project` (the first 12 hex of the
sha256 of the project key, which names the repo) is present when the call has one. An unexpected failure is
logged by its error name and code only, and a resolver key refused for its module writes a `module-denied`
line.

## Install on a development site

You need the Forge CLI (`npm install -g @forge/cli`), and an Atlassian Cloud developer site with Jira,
Confluence and Rovo enabled. CLI 15 needs Node 22.23.4+ or 24.22.1+ (older releases trust compromised
certificates); the skill itself still runs on 22.13+. On Windows ARM64 the CLI's `cloudflared` dependency
fails its install script (Cloudflare ships no ARM64 Windows binary), so install with
`npm install -g @forge/cli --ignore-scripts`; everything but `forge tunnel` works.
`forge skills install --agent claude --scope user` adds Atlassian's Forge skills and the Forge and ADS
MCP servers to Claude Code; user scope keeps them out of this repo.

```sh
cd forge
npm install
npm run build:ui                 # builds static/app/dist, the Custom UI resource
forge login                      # an API token from id.atlassian.com
forge register                   # writes the real app.id into manifest.yml (replaces the placeholder)
forge lint
forge deploy                     # development environment
forge install --site <your-site>.atlassian.net --product jira
forge install --site <your-site>.atlassian.net --product confluence   # connects Confluence to the same installation
forge install list                                                     # one row: Jira (required) + Confluence
```

The manifest declares `app.compatibility` (Jira required, Confluence optional), so Confluence joins the
Jira installation instead of getting its own. That matters: Forge SQL is one database per installation,
and the MCP endpoint binds to one installation. With two installations, a push over MCP landed in the
Confluence database while the Jira inbox read the Jira one (seen on 2026-10-28). If `forge install list`
shows two rows, uninstall the Confluence one (`forge uninstall -i <id>`) and install it again.

A non-production environment adds a suffix to every MCP tool name (`dowser_verdicts_pull_development`).
The skill matches the name with or without it.

The install fires `avi:forge:installed:app`, and the `migrate` function creates the tables. Forge sends
`avi:forge:upgraded:app` only for a major version. If a later deploy adds a migration in a minor version,
the first call that hits a missing table or column runs the migrations once and retries. Logs: `forge logs`.

## Connect an external MCP client

1. **Enable it on the site.** External MCP access is an early-access feature and is off by default. A
   site admin turns it on for each install. In the admin console as of 2026-10-28 (Atlassian's guides
   still describe an older layout): admin.atlassian.com > your organization > **Apps** > **Sites** >
   your site (expand **Sites** to see it) > **Connected apps** > expand the **Dowser** row > **View app
   details** on each **Dowser DEV** row (one per Jira and Confluence install) > **Details** tab > section
   **TOOLS** > **Enable tools**, then confirm. It is one switch for all tools; there is no per-tool list.
   The Rovo agent inside Jira can use the tools without this step.
2. **Server URL.** Use `https://mcp.atlassian.com/forge/<appId>`. `<appId>` is the UUID after
   `ari:cloud:ecosystem::app/` in `manifest.yml`. Checked on 2026-10-28: it answers 401 with OAuth
   protected-resource metadata, so clients discover sign-in by themselves (`/forge/v1/<appId>` is 404).
3. **Claude Code:**

   ```sh
   claude mcp add --transport http dowser https://mcp.atlassian.com/forge/<appId>
   ```

   Run `/mcp` in Claude Code to sign in. The harness keeps the OAuth token, and Dowser holds no credentials.
4. **Codex CLI.** Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.dowser]
   url = "https://mcp.atlassian.com/forge/<appId>"
   ```

   Then sign in with `codex mcp login dowser`.
5. **Smoke test.** Ask the agent to call `dowser_verdicts_pull` with your `project_key`. Before the first
   push, the expected answer is `{"error": "unknown-project", ...}`.

Every tool runs as the signed-in person. Dowser decides who that is from the invocation, never from an
argument. The source tools also read Jira, Confluence and Teamwork Graph as that person, so a scan sees
only what the person can see. The first source call may ask the person to allow the app to act for them.

## Teamwork Graph allowlisting

`dowser_sources_goals` reads goals through the Teamwork Graph API (Forge preview). The app must be
allowlisted for that API. To request it, send Atlassian support the app id from `manifest.yml` and a
one-line use case ("read the site's goals as scan sources for backlog proposals"). Do this in week one,
because approval takes time. Until the app is allowlisted, the tool answers `unavailable` with a message
that names the allowlist, and the skill continues without goals.

## Judges' setup

1. Install the app on your site, following the install steps above. Alternatively, use the
   installation link the team provides.
2. In Jira, open **Apps > Dowser > Settings**. For each inbox, choose the Jira project and issue type that
   an accept creates issues in.
3. Optional: to drive Dowser from Claude Code, enable external MCP access for the app (see
   "Connect an external MCP client" above) and add the server.
4. Run the Dowser skill on a repository (`skill/SKILL.md`). Its push fills the inbox, and the inbox groups
   items by scan run. Without a local skill, load the sample inbox instead (see "Sample inbox" below).
5. Triage in **Apps > Dowser > Inbox**: accept, reject with a reason, snooze or merge. Or ask the Dowser
   agent in Rovo ("What should we build next?"). The next scan pulls the verdicts back.

## Sample inbox

A judge who has no coding agent connected can still see a real inbox. **Load the sample** on the inbox's
first-run screen (resolver `sample.load`) files a real Dowser scan of Dowser's own public repository
(`https://github.com/xkazm04/dowser`) into an inbox with the reserved key `dowser-sample`.

- **Where it comes from.** `forge/src/sample/self-scan.json` (`dowser-sample/1`) is bundled with the app. It
  holds the scan's verified cards (ranked and reserve, quotes included: the code is public), the areas of the
  opportunity map, the scan's trust levels, and the `source`: repo URL, the scanned commit, when the scan ran and
  its run id. Evidence links point at that commit on GitHub, so it must be a pushed commit.
- **How it loads.** The same core push code a scan uses files it (`pushProposals` in pushes of 50 cards, then
  `pushAreas`, then `reflectSync` with the trust), so the cards, the map and the Learning tab behave as for a
  scan. The person who loads it is its creator. Each call has a 12 s budget of its own: past it, no new step
  (a push of cards, the areas, the trust) starts, and the answer is `{project_key, created, more: true}`. The
  first step always runs, so every call makes progress. The UI calls `sample.load` again until the answer has
  no `more`. A load cut short any other way (a timeout) is completed by the next call too. A complete sample
  answers `{project_key, created: 0, already: true}` and writes nothing.
- **All inboxes leaves it out.** The sample never mixes into an all-inbox view: `inbox.list` without a
  `project_key` (and Rovo's `dowser_inbox_list`, and the Confluence byline) lists no sample card, unless the
  sample is the only inbox the caller can see. Its summary still comes back in `inboxes[]` with `sample: true`,
  so the inbox picker can offer it, and its counts are its own inbox's.
- **How it is marked.** The key is the sample predicate (there is no flag column). Its inbox summary carries
  `sample: true` and `source`; every card of it carries `sample: true`, set by the server. No MCP tool can
  write to the key (contract: "dowser-sample is reserved for the sample inbox"), so a scan never lands in it.
- **Accept creates a real issue.** Accepting a sample card creates a Jira issue in the chosen project with the
  label `dowser-sample`, and its description opens with "Created from Dowser sample data: a scan of Dowser's
  own public repository." (A project whose create screen has no Labels field gets the issue without the label.)
- **Who may open it.** Everyone who can use the app (core/access.mjs): several evaluators on one site all see
  the one sample, and a second person who presses Load gets it (`already: true`), not a refusal. A Jira write
  from it (accept, merge) still needs the person's own Jira permission.
- **Remove.** `sample.remove` deletes every row of the sample in every table (proposals, evidence, verdicts,
  pushes, areas, rules, outcomes, directions, trust, deliveries, work reports, page links, its verdict counter, the
  inbox). Only the person who loaded it or a Jira admin may remove it. Issues that accepted sample cards created
  stay in Jira; the answer counts them (`issues_kept`). DW numbers are not reused, so a reload numbers its cards anew.
- **Load time.** A push files its cards as sets (see "Data (Forge SQL)" above), so a load costs about a dozen
  statements per push of 50 cards plus a few for the areas and the trust: 40 cards with 3 evidence rows each is
  under 40 statements, 1-2 s at 30-60 ms a statement, and finishes in one call. The 12 s budget stays as the
  guard for a larger sample or a slow store.
- **Re-capture after a later scan.** Scan a clean clone with the dogfood harness and an empty world, keeping
  the clone (`node tools/dogfood.mjs --seed <empty world> --keep`), then:

  ```
  node tools/sample-capture.mjs --home <the scan's DOWSER_HOME> --repo <the kept clone> \
    --repo-url https://github.com/xkazm04/dowser --out forge/src/sample/self-scan.json
  ```

  It reads the newest done run (or `--run <id>`) through the skill's own modules, checks every card and area as
  the Forge push would, and writes a deterministic file. Commit it and deploy.

### Setup checklist (`setup.status`)

The first-run screen also shows how to connect a coding agent: the app's MCP URL
(`https://mcp.atlassian.com/forge/<appId>`, from the app context) and whether any MCP tool call has reached
the app. That second line reads **calls seen**, not "enabled": whether an admin turned external MCP access on
cannot be read by the app, so the honest signal is the `mcp:` rows of `tool_calls` (`calls`, and once there is
one, `last_at` and `last_tool`). `calls: 0` is a measured count. `sample.loaded` says whether the sample inbox
exists.

## Surfaces

One Custom UI bundle (`forge/static/app`, Vite + React 19) serves every Dowser surface. The module picks
the surface. Inside the **Dowser** global page, the page route (`inbox`, `map`, `reflect`, `settings`) picks the tab.
The surfaces call the backend only through `call()` in `src/api.js`, which uses the resolver keys in
`forge/src/core/types.mjs`. The page routes are `inbox`, `map`, `reflect` (Learning) and `settings`.

### Inbox (Apps > Dowser > Inbox)

The inbox is a queue you scan on the left and a reading pane you decide in on the right. It is grouped by
push, not a sortable table.

- **Toolbar.** One row from 960px (two below): the **Inbox** picker (one repository, or all of them), the status control (default
  **Open**; every status shows its count, and the counts move as you decide), the lens filter, **Pre-triaged** (only
  the cards the scan pre-triaged on its own, `inbox.list {pretriaged: true}`), the last push and `?` for the keyboard help.
  When the inbox was opened filtered to an area (a Map cell, or `?area=` in the link), an **Area: <path>** chip
  shows; its clear button drops the filter, and picking another inbox clears it too (`inbox.list {project_key,
  area}`; `area` needs `project_key`). Jira's sidebar carries the navigation between Inbox, Opportunity map,
  Learning and Settings.
- **Queue.** Each sticky heading names one push by date and time and counts its **New**, **Evidence grew**
  and **Reopened** items; the commit and run id are in its tooltip. Each row shows the title, lens, ref,
  change marker, the stored score (or **unscored**, never 0), effort size, confidence and evidence strength.
  Rows keep the server's order inside a group (scan-finding/1): each lens's top card first, marked **MVP**, then
  the ranked cards by the score the skill stored (Forge never recomputes it), unscored after every scored card,
  then the push's reserve folded as "**N in reserve**" (verified, scored, over the scan's budget; it opens by
  click, or by itself while `j`/`k` walk into it). A card the skill's trust gate pre-triaged is marked
  **Pre-triaged**: accepting it stays a person's click (or, where a person switched on delegated triage, the delegate's, marked as such). Cards pushed before scan-finding/1 keep the older order
  (confidence, evidence count, first seen) among themselves.
- **Reading pane.** The selected proposal: title (with the **MVP of <lens>**, **In reserve** and **Machine
  pre-triaged** markers when they apply). An open card that came back says why under its title, from the card's
  `delta` (computed at read time from the rows `inbox.list` already reads, so no extra statement): a reopened card
  says how many evidence items are new since the decision and the decision it had ("1 new evidence item since it
  was rejected as Already known on 27 Oct 2026: same as DW-1"; the row is open again, so the prior status is
  derived from its stamp: a reason means rejected, else snoozed; a dated snooze back on its day says so with no new
  evidence), and a card whose evidence grew says how many items the latest push brought. Each such item is marked
  **New** in the evidence list (`new: true`). A new or decided card has neither; `proposal.get` and the Rovo
  explain carry the same fields, and the Rovo list's compact item carries `new_evidence`. Then the rationale, then a facts grid with the score and its scan-score/1
  breakdown ("Unscored" with the reason when it has none), impact and its reason, the predicted verdict with who
  predicted it and the precedent it quotes, effort (size, 1-10 effort, day range, basis), confidence with its
  reason, evidence strength, delivery risk (1-10 risk of the change, blast radius, bus factor) and doc impact. A missing bus factor
  reads "not measured", never 0, and a bus factor of 1 gets a "single owner" flag. When the card carries
  supporting views (`artifacts`, up to three), **Supporting views** comes next. Each view shows its message in
  bold, then the view, then "From" and the evidence refs it was drawn from. A view with an unknown kind or
  broken data shows its text alternative instead, and a card without views has no such section:
  - A **table** has a set-apart header and light row dividers. Number columns are right-aligned, highlighted rows
    are tinted and bold, and a wide table scrolls sideways in its own box.
  - A **flow** is a numbered list of steps. A marked step shows a glyph in place of its number and names the mark:
    Friction, Failure, Missing or New.
  - A **before/after** puts the measure on top, then **Today** and **After** in two columns whose lines align.
  - A **matrix** is a grid of shaded cells, and each cell prints its value.

  The evidence is open: code
  and doc lines link to the scanned commit and show their quote as code; tickets, pages and goals link to their
  source. The full write-up and the triage history follow; when the history fails to load, it says "The history
  could not load." with **Retry**, and selecting the card again also fetches it again (a failure is never
  cached). The decision bar stays at the bottom of the pane.
  Below 900px there is no pane: the selected row opens in place.
- **Actions.**
  - **Accept** opens a dialog with the target Jira project and issue type, filled in from the inbox
    setting. It previews the issue summary and description, in the issue's own order. When the accept succeeds,
    the issue key shows as a link. In the issue, the card's Description section is headed **Details**, because Jira already
    titles the field Description. **Accepted issue:** the description opens with a **facts table** (Impact n/10 and
    its reason; Score with its breakdown in one line, or "unscored"; Confidence and why; Effort n/10 with size and
    days; Risk n/10 with the blast radius; Lens / kind; "MVP of the <lens> lens" when it is one; each value clipped
    to 300 characters), then the rationale, then **Expected benefit** (the impact and its reason, then the body's
    Expected impact), then **Where it is and how to reproduce** (every code and doc place the card names, linked to
    the scanned commit when the inbox has a repository URL, and the anchors no evidence covers, then the body's Flow
    steps), then the rest of the card body, then
    **Supporting views** when the card has any, then **Evidence**, then "Proposed by Dowser (DW-n)". Each view is
    its message in bold, the view, then "From <refs>" in italics. A table or matrix becomes a Jira table, and a
    highlighted row is bold. A flow becomes a numbered list, and a marked step ends with "(friction)", "(failure)",
    "(missing)" or "(new)". A before/after becomes a table with the measure on top and Today / After columns.
    A view that cannot be drawn becomes its text alternative.
  - **Merge** picks another open or accepted proposal by ref or title, or takes a typed Jira key. When the
    accepted proposals fail to load, the dialog says "Accepted proposals could not load, so only open ones are
    listed." with **Retry**; "No matching proposal." shows only for a real empty result.
  - When the Accept dialog cannot list the Jira projects, it says so with **Retry**, which reloads both lists.
  - **Reject** takes one of six reasons: false positive, already known, not our direction, not worth it,
    wrong size, other. Other needs a note.
  - **Snooze** holds the card until its evidence grows. An optional **Until** date (a day after today) also
    brings it back: it comes back at the first scan on or after that day, or earlier when its evidence grows.
    The verdict carries the date as `snooze_until`, and the skill wakes the item on its first run start on or
    after that day and pushes it again. That push reopens the inbox item even with no
    new evidence (Forge does not reopen it on the date by itself). The core checks "after today" against the
    earliest time zone (UTC-12), so a person west of UTC can still pick tomorrow in the evening, and "the day
    has come" against the latest (UTC+14), matching a runner whose local date is ahead of UTC. A snoozed card
    with a date, and its snooze row in the triage history, say "Comes back at the first scan on or after <date>".
- **Bulk.** Tick rows to reject them all with one reason, or to snooze them all with one optional **Until**
  date for every ticked item (no note).
- **Keyboard.** `j`/`k` move the selection, `x` ticks, `a` accepts, `r` rejects, `s` snoozes, `m` merges,
  `u` undoes a reject or snooze while its notice shows, `?` shows help. In an open dialog, `Ctrl+Enter`
  confirms and `1`-`6` pick a reject reason. The keys work only when no text field has focus.
- A decided row leaves the queue and the selection moves to the next one. A failed action shows its message,
  and the row stays. **Load more** fetches the next page (50 items).
- An empty view names the last push. To get new proposals, run `/dowser` in Claude Code or
  Codex, in the repository.

### Learning (Apps > Dowser > Learning)

A digest first: a few plain sentences written from the data (the last push and its repeat rate, how much was
accepted, how many verdicts a delegate recorded apart from people's when it recorded any, the most common reason
to say no, what is waiting). Then **Needs you**: rule offers to accept (the text
is editable) or decline, and accepted items to rate (**Right call**, **Partly**, **Wrong call**, with an optional
note), the ones whose Jira issue is done first. Each item to rate also says what became of it: Jira's fate as
issue events report it (Done, or closed without the work / deleted), and the code at the last scan (the skill's
`delivery` re-check: the quoted problem still present, partly gone, or gone). "Jira says Done, but the quoted
problem is still in the code" leads, and an item a later scan found again after delivery says the problem came back. Then the supporting detail: lens yield, reject reasons with the
latest decision notes, the scan retro with the trend over recent pushes, and **Trust**: per slice (lens, category,
size) the level against its ceiling (Dowser's is 1), how often the scan's predicted verdict matched yours and over
how many decisions, then the level changes with their reasons (earned at 90 % of 20, lost on a reject of a
pre-triaged card). The skill computes trust in its store and sends it with `dowser_reflect_sync` (`trust_json`);
Forge only shows it.

### Settings (Apps > Dowser > Settings)

The same page shell as Learning and the map: a bar with the page title, then the content. Each inbox has one
row: the repository's project key and URL, its open count, a Jira project and an issue type. **Save**
stores them. Accept files issues there unless the Accept dialog overrides them for one proposal. The inboxes
(`settings.get`) and the Jira projects (`jira.projects`) load separately: when Jira cannot list the projects,
a warning with **Retry** shows above the table, the rows still render, and their selectors are disabled,
showing the saved project or "Projects unavailable". Lens direction below works either way.

Below the accept-target table, **Lens direction** lets a team steer each lens of each inbox. Every inbox lists
the four lenses as one-line disclosures: the lens name and what is set (`Focus: ... · Leave out: ... · Spaces:
... · Notes`), or "Not set". Opening one shows **Focus on** and **Leave out** (one topic per line, up to 10,
each up to 120 characters), **Notes for the scan** (up to 2000 characters) and, for Doc drift only,
**Confluence spaces to search** (one space key per line, up to 10; empty searches every space). **Save**
replaces that lens's direction whole and shows "Saved." or the server's message inline; **Clear** (shown when
something is set) deletes it. Resolvers: `direction.get {project_key}` -> `{lenses}` and
`direction.set {project_key, lens, focus?, exclude?, notes?, spaces?}` -> `{lens, direction?}`; rows live in
the `directions` table (one per inbox and lens, last writer wins, a clear deletes the row). The skill reads the
same data at run start through the MCP tool `dowser_direction_get` and hands each lens its direction in
`context`; a runner's local `--focus` still applies on top for that one run. A scan that is not connected runs
without direction.

#### Delegated triage

Between the accept targets and Lens direction, **Delegated triage** lets a person hand one inbox's triage to
Temper, Dowser's daily improvement loop, for a while. Each inbox except the sample has one block: a line that says
what holds now ("Temper may accept and reject in this inbox until 31 Dec 2026: at most 3 accepts and 10 rejects,
snoozes or merges a day (UTC)", or "Off. Temper records nothing in this inbox.", or "Ended on <date>. ..."), then
**Until (the last day)**, **Accepts a day, at most** and **Rejects, snoozes and merges a day, at most** (whole
numbers 0 to 200), **Switch on** / **Save** and **Switch off**. A failed save shows the server's message inline.

- **Who sets it.** Only this page: `settings.set {project_key, delegate_until, delegate_accepts_per_day,
  delegate_rejects_per_day}` sets it whole, `settings.set {project_key, delegate_until: ""}` switches it off, and
  only the inbox global page may call that resolver (`MODULE_KEYS`). No MCP tool and no Rovo action writes it, so
  the delegate can never extend its own mandate (`forge/test/delegate.test.mjs` asserts it). The caller must be
  able to open the inbox; the sample inbox takes no delegation. `settings.get` shows it on each inbox summary (the
  three `delegate_*` keys, or none of them).
- **What it allows.** The MCP tool `dowser_verdicts_record` (`docs/contracts/forge-mcp-2.md`) records verdicts as
  `delegate:temper` (via `mcp`) while the delegation holds: through `delegate_until`, a UTC day, and within the
  day's caps, counted from the verdict log per UTC day (accepts against one cap; rejects, snoozes and merges
  against the other). It is a gate in front of the inbox's own decision path (`core/verdicts.mjs`, the same one
  the Rovo agent uses): the caller is still the signed-in account, and its inbox access and Jira permissions
  apply as for a person. An accept's Jira issue carries the label `dowser-delegate`, and its description opens with
  a line saying Temper (delegate) accepted it, not a person, so the mark holds where a project refuses the label.
- **How it shows.** The triage history in the inbox, the evidence panel and the card dialog shows a delegate's
  decision as the chip **Decided by Temper (delegate)**, never as a name. The Learning digest counts the
  delegate's verdicts apart from people's (`reflect.data` `verdicts_by`). The skill learns from them (precedents,
  rules), but they never count toward trust: the ladder stays human-earned.
- **Deploy note.** The columns come from migrations v032-v034. A minor deploy does not run migrations; the first
  `settings.set` with a delegation hits the missing column, migrates once and retries (`withSchema`), or the daily
  migrate adds them. Check the first delegation save on a site after deploy.

### Evidence panel (on a Jira issue)

On an issue that Dowser created at Accept, the **Dowser evidence** panel shows the reading-pane content in one
column, read-only: the facts, the supporting views (stacked, one per row), the evidence trail, doc impact, delivery risk and triage history. On any other issue, it says "No Dowser
evidence you can view here." and "Either Dowser did not propose this issue, or its proposal is in a Dowser inbox
you cannot open. A Jira admin can tell you which." The wording is true in both cases and never names the inbox.

### Dowser facts in JQL

Accept, and a merge into an existing Jira issue, write the issue property `dowser` as the app
(`core/issue-property.mjs`): `ref`, `fp`, `lens`, `kind`, `confidence`, `category`, `impact`, `score`,
`band`, `mvp` (`yes`/`no`) and `via` (`accepted`/`merged`). A fact the card does not carry is left out. The
`jira:entityProperty` module indexes each field under a `dowser*` alias:

```text
dowserLens = "security-cra" AND statusCategory != Done
dowserBand = "ranked" ORDER BY dowserScore DESC
dowserMvp = "yes" AND project = SHOP
dowserVia = "merged"
```

The write is best effort: the decision is the record, a failed write is logged (`what: issue property`), and the
daily trigger writes what is missing (`issue_prop_at`, migration v026), 50 a day by id after a stored cursor that
wraps at the end, so a row that keeps failing never holds back newer ones; a 404 (issue deleted or moved) is final
and marks the row done. A merge into an issue that an accepted card
created does not overwrite that card's property. Jira re-indexes a new module's fields only for properties written
after the deploy; the backfill covers the items decided before it.

### Theme and accessibility

Colours, surfaces and fonts are Atlassian design tokens, so the Jira light and dark themes both apply
(`view.theme.enable()`). Buttons are real buttons. Dialogs are modal: focus stays inside, Escape closes
them, and focus goes back to the button that opened them. Focus is always visible.

### Running the UI outside Jira

```sh
npm --prefix forge/static/app install
npm --prefix forge/static/app run dev:fixture      # or VITE_DOWSER_FIXTURE=1 npm --prefix forge/static/app run dev
```

The fixture swaps `@forge/bridge` for an in-memory fake (`src/dev/bridge.js`). The fake serves three
pushes, every evidence type, one reopened card, one card with no bus factor, and every kind of supporting view
(DW-14, DW-9, DW-6, DW-11, DW-1), with one malformed view on DW-10 that shows its text alternative. The URL hash picks what
you see:

| Hash | Shows |
| --- | --- |
| `#inbox` | the inbox (default) |
| `#settings` | the settings page |
| `#panel` | the evidence panel on an accepted issue |
| `#panel-none` | the evidence panel on an issue that is not from Dowser |
| `&fail=<resolver key>` | that resolver fails |
| `&empty` | no proposals |
| `&slow` | every call takes 1.5 s, to show the loading state |
| `&page=<n>` | inbox page size (default 4, small so **Load more** shows) |
| `&mode=dark` / `&mode=light` | the colour mode (default: the OS setting) |

In the fake, the Billing project refuses issue creation and the Jira key `NOPE-1` fails a merge, so you can
see both error states. The production build (`npm run forge:build-ui`) never includes the fixture. Build
with it before every `forge deploy`.

### Run it locally (the real core, no Jira site)

`tools/local-forge.mjs` runs the app's own core (`src/core`, every call through `app.mjs` `runTool` and
`runResolver`) over the app's own migrations, on a node:sqlite file. Only the ports are local
(`tools/local-forge/ports.mjs`): a Jira whose issues live in the same file (project `DOW`, issue type
`10001`, keys `DOW-<n>`, a new issue is `To Do`), display names (`local-user` is "Local Operator") and scan
sources from a seed. The mock (`tools/mock-forge-mcp.mjs`) reimplements the contract; this runs the real thing.

```sh
npm run local:forge     # terminal 1: HTTP on 127.0.0.1:4710, db in <os tmp>/dowser-local-forge/forge.db
npm run local:ui        # terminal 2: the Custom UI (vite --mode local-forge) at http://127.0.0.1:5173, POSTing to :4710
curl -s -X POST http://127.0.0.1:4710/invoke -H 'content-type: application/json' -d '{"key":"inbox.list","payload":{}}'
```

To point the skill at the same data, register the MCP side as a stdio server, for example
`claude mcp add dowser-local -- node tools/local-forge.mjs --stdio`. Both processes share the default db
file (WAL and a busy timeout), so a push over MCP shows in the UI on reload.

| Flag | Meaning |
| --- | --- |
| `--stdio` | MCP server (JSON-RPC 2.0, newline-delimited) with the thirteen forge-mcp-2 tools; logs go to stderr. `dowser_verdicts_record` needs a delegation, which only `POST /invoke settings.set` sets, as in Forge |
| `--http <port>` | `POST /invoke {key, payload, module?}` -> the resolver result (`via` is `panel` for module `dowser-evidence`); `0` picks a free port |
| `--db <file>` | the SQLite file; refused inside this repository |
| `--seed <file>` | `{tickets?, pages?, goals?, projects?: [{key, name, issue_types}], users?: {<id>: <name>}}` |
| `--account <id>` | the account every call runs as (default `local-user`); deciders are `forge:<id>`, and `delegate:temper` for `dowser_verdicts_record` |
| `--reset` | delete the db file first |

Dev-only endpoints: `POST /dev/jira-status {key, category: new|indeterminate|done, name?}` simulates an
issue moving (for the Learning tab's "done first" candidates), `GET /dev/state` gives row counts, and
`GET /browse/<key>` shows a local issue with its comments. CORS allows any `localhost` or `127.0.0.1` origin;
the server binds 127.0.0.1 only. Inbox links point at `http://127.0.0.1:5173/#inbox&ref=<ref>`.
`skill/scripts/tests/local-forge-e2e.test.mjs` drives the whole loop through both doors.

### Opportunity map (Jira: Apps > Dowser > Opportunity map)

The map shows where one repository's proposals concentrate, next to how often that code changes. Pick the
inbox at the right of the title bar (it starts on the inbox with the most open proposals). Like the other
pages, it has no tabs of its own: Jira's sidebar carries the navigation.

- **Proposals by area and lens.** A table: one row per area (a directory the local skill measured with
  `dowser areas` and pushed with `dowser_areas_push`), one column per lens. The number in a cell is the open
  proposals in that area for that lens; accepted ones show below it. The darker the blue, the more open
  proposals, and the number is always printed. Rows sort by open proposals, then by commits. A cell with open
  proposals is a link: it opens the inbox filtered to that area and lens (`inbox?project=&lens=&area=`), and the
  inbox lists exactly the cell's count.
  - **Commits 90d** counts the commits that touched the area in the 90 days before the scanned commit.
  - **Authors 90d** counts distinct authors in those commits. **Bus factor 1** marks an area that only one
    person changed. "Not measured" means the area had no commits in the window, so authors were not counted.
- **Effort vs confidence.** One dot per open proposal: across, the effort size (XS to XL); up, the
  confidence (low to high). The dot's colour and shape give its blast radius (circle low, square medium,
  triangle high, hollow circle not measured). The shaded corner (small effort, high confidence) is the cheap,
  sure work. Point at or tab to a dot to read it; select it to open the card with its evidence and triage
  history, then **Open in the inbox** to decide it. **As a list** shows the same dots as text.
- Empty: "No areas yet - the map fills after the next scan from Claude Code or Codex." The map needs a scan
  that pushed areas (`dowser areas`, then `dowser_areas_push`).

### Doc impact on Confluence pages (the Dowser byline)

On a Confluence page, the **Dowser** item in the byline opens a list of the open and accepted proposals that
name this page: as page evidence (the quote is shown) or in their doc impact ("Listed in doc impact"). Each
ref opens the Dowser inbox in Jira; an accepted proposal also links to its Jira issue. A page no proposal
names says "No Dowser proposals mention this page."

**Doc-drift closure** (`core/doc-drift.mjs`). The byline reads the page index `page_links` (v030: page evidence and
numeric `doc_impact` entries, filled at every push, backfilled once by the daily trigger), not a scan of every
proposal. On a Doc drift item the byline offers **Draft the fix as a comment**: a footer comment on the page, posted
as the person (`write:comment:confluence`, asUser, so Confluence decides whether they may comment), with the finding
and the code lines that disagree with the page; it never edits the page body. The `dowser-page-events` trigger
records the newest edit of a linked page (`page_edits`, v031; every page update on the site arrives, an unlinked page
costs one indexed read), and an item decided before that edit says "This page was edited after the decision: the
next scan re-checks it." The **page banner** (`confluence:pageBanner`) shows one dismissable line on a page that an
open or accepted Doc drift item names, and nothing anywhere else.

### Links into the inbox

`<site>/jira/apps/<appId>/<envId>/inbox?ref=DW-12` opens the inbox focused on DW-12 (the card scrolls into
view and takes keyboard focus). If DW-12 is open, fits the current filters and sits further down the queue,
it is placed above the loaded pages under "Linked proposal, from a later page" and selected, with **Accept**,
**Reject**, **Snooze** and **Merge**; when **Load more** reaches its page it moves back into its push's group,
listed once. A decided DW-12, or one in another inbox, still opens in a read-only card dialog.

`inbox?project=<key>&lens=<lens>&area=<path>` opens the inbox filtered to that inbox, lens and area (any of
the three may be left out; `area` needs `project`). The map's heat cells link this way, and the toolbar shows
the area as a clearable **Area:** chip.
