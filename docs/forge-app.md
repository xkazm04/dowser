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
| `rovo:mcp` | `dowser-mcp` | `mcp` | The six forge-mcp-2 tools, for Claude Code and Codex CLI |
| `action` (x6) | `dowser_sources_tickets`, `dowser_sources_pages`, `dowser_sources_goals`, `dowser_proposals_push`, `dowser_verdicts_pull`, `dowser_areas_push` | `mcp` | The tools themselves. `rovo:mcp` lists them |
| `action` (x3) | `dowser_inbox_list`, `dowser_proposal_explain`, `dowser_verdict_record` | `rovo` | The Rovo agent's actions |
| `rovo:agent` | `dowser-agent` | - | Lists and explains proposals, and records verdicts for the person chatting with it |
| `rovo:skill` | `dowser-skill` | - | The read actions as a skill for other agents |
| `jira:globalPage` | `dowser-inbox` | `resolver` | The inbox, the opportunity map and settings (Custom UI) |
| `jira:issuePanel` | `dowser-evidence` | `resolver` | The evidence trail on an accepted issue |
| `confluence:contentBylineItem` | `dowser-doc-impact` | `resolver` | The proposals that cite or affect a page |
| `trigger` | `dowser-migrate` | `migrate` | Forge SQL migrations on install and upgrade |
| `sql` | `main` | - | The Forge SQL database (MySQL dialect, TiDB) |

### Code layout (design F7)

- `forge/src/index.js` holds the entry points. It reads the caller and the action key and then hands over.
- `forge/src/core/` is pure and Forge-free:
  - `app.mjs` is the one dispatch door. It checks the account, validates input and maps every failure to
    `{error, message}`.
  - `push.mjs`, `verdicts.mjs`, `areas.mjs`, `sources.mjs` and `cards.mjs` hold the tool and resolver logic.
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
| `inboxes` | One row per `project_key`, holding the repo URL and the accept target (Jira project and issue type) |
| `proposals` | One row per `(project_key, fp)`. Holds the status, the record and the decision stamp |
| `evidence` | Append-only, one row per evidence key. Each row carries the `head_sha` of the push that added it |
| `verdicts` | Append-only verdict log. Its seq is the pull cursor |
| `pushes` | One row per push call |
| `areas` | Per-directory churn and authors for the opportunity map. Each push replaces the project's set |

Forge SQL has no multi-statement transactions. `@forge/sql` sends each statement as its own request, and
the query policy allows one statement per request. The core is correct without transactions:

- Every status move is a compare-and-set.
- Ids come from a compare-and-set counter (no `AUTO_INCREMENT`).
- Inserts check first and are also guarded by a UNIQUE constraint.
- A decision whose verdict row did not land is rebuilt from the decision stamp before the next pull.
- An accept creates the Jira issue before it changes any state. If Jira fails, nothing is written and the
  item stays open.

## Install on a development site

You need Node 22, the Forge CLI (`npm install -g @forge/cli`), and an Atlassian Cloud developer site with
Jira, Confluence and Rovo enabled.

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
the first call that hits a missing table runs the migrations once and retries. Logs: `forge logs`.

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
   items by scan run.
5. Triage in **Apps > Dowser > Inbox**: accept, reject with a reason, snooze or merge. Or ask the Dowser
   agent in Rovo ("What should we build next?"). The next scan pulls the verdicts back.

## Surfaces

One Custom UI bundle (`forge/static/app`, Vite + React 19) serves every Dowser surface. The module picks
the surface. Inside the **Dowser** global page, the page route (`inbox`, `map`, `settings`) picks the tab.
The surfaces call the backend only through `call()` in `src/api.js`, which uses the resolver keys in
`forge/src/core/types.mjs`.

### Inbox (Apps > Dowser > Inbox)

The inbox reads like a pull request for the backlog. It is a queue grouped by push, not a sortable table.

- **Groups.** Each heading names one push: its date, the short head commit, the run id, and how many cards
  are **New**, **Evidence grew** or **Reopened**. Cards keep the server's order inside a group.
- **Filters.** Status chips (default **Open**) and lens chips. When more than one repository pushes here,
  an **Inbox** picker selects one repository, or all of them.
- **Card.** Each card shows its ref (`DW-n`), lens, title and rationale. It also shows effort (size, day
  range, and the basis behind a disclosure) and confidence with its reason. Delivery risk shows the blast
  radius and the bus factor. A missing bus factor reads "not measured", never 0, and a bus factor of 1 gets
  a "single owner" flag. Doc impact comes next. The evidence list links code and doc lines to the scanned
  commit and shows their quote as code. Tickets, pages and goals link to their source.
- **Actions.**
  - **Accept** opens a dialog with the target Jira project and issue type, filled in from the inbox
    setting. It previews the issue summary and description. When the accept succeeds, the issue key shows
    as a link.
  - **Merge** picks another open or accepted proposal by ref or title, or takes a typed Jira key.
  - **Reject** takes one of six reasons: false positive, already known, not our direction, not worth it,
    wrong size, other. Other needs a note.
  - **Snooze** holds the card until its evidence grows.
- **Bulk.** Tick cards to reject them all with one reason, or to snooze them all.
- **Keyboard.** `j`/`k` move, `x` selects, `a` accepts, `r` rejects, `s` snoozes, `m` merges, `?` shows
  help. The keys work only when no dialog or text field has focus.
- A decided card leaves the view. The other cards stay where they are. A failed action shows its message
  on the card, and the card stays. **Load more** fetches the next page (50 cards).
- An empty view names the last push and its lenses. To get new proposals, run `/dowser` in Claude Code or
  Codex, in the repository.

### Settings (Apps > Dowser > Settings)

Each inbox has one row: the repository's project key and URL, a Jira project and an issue type. **Save**
stores them. Accept files issues there unless the Accept dialog overrides them for one proposal.

### Evidence panel (on a Jira issue)

On an issue that Dowser created at Accept, the **Dowser evidence** panel shows the card read-only: its
evidence trail, doc impact, delivery risk and triage history. On any other issue, it says "This issue did
not come from Dowser."

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
pushes, every evidence type, one reopened card, and one card with no bus factor. The URL hash picks what
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

In the fake, the Billing project refuses issue creation and the Jira key `NOPE-1` fails a merge, so you can
see both error states. The production build (`npm run forge:build-ui`) never includes the fixture. Build
with it before every `forge deploy`.

### Opportunity map (Jira: Apps > Dowser > Opportunity map)

The map shows where one repository's proposals concentrate, next to how often that code changes. Pick the
inbox at the top right (it starts on the inbox with the most open proposals).

- **Proposals by area and lens.** A table: one row per area (a directory the local skill measured with
  `dowser areas` and pushed with `dowser_areas_push`), one column per lens. The number in a cell is the open
  proposals in that area for that lens; accepted ones show below it. The darker the blue, the more open
  proposals, and the number is always printed. Rows sort by open proposals, then by commits.
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

### Links into the inbox

`<site>/jira/apps/<appId>/<envId>/inbox?ref=DW-12` opens the inbox focused on DW-12 (the card scrolls into
view and takes keyboard focus). If DW-12 is not in the loaded page (decided, or further down the queue), it
opens in a read-only card dialog instead.
