# Forge MCP contract, version 2 (`forge-mcp-2`)

This is the seam between the Dowser local skill and the Dowser Forge app (`forge/`). The Forge app
implements these eight tools on its `rovo:mcp` server (the original six plus `dowser_reflect_sync` and
`dowser_direction_get`, added without a version change). `tools/mock-forge-mcp.mjs` implements the same tools locally, so the skill can be
tested without a Jira site.

**What changed from `forge-mcp-1`.** Version 1 was never deployed, so version 2 replaces it rather than
being served alongside it:

- A Forge `rovo:mcp` tool accepts only scalar inputs (`string`, `integer`, `number`, `boolean`). The push
  therefore takes `proposals_json`, a JSON string, in place of the `proposals` array.
- A push no longer creates a Jira issue. It files the proposal in the Dowser inbox. `external_ref` is the
  inbox item (`DW-12`), and the Jira issue appears only when a person accepts: the `accepted` verdict carries
  `issue_ref` and `issue_url`.
- The push gains `repo_url` and `head_sha`, so the inbox can link code evidence to the exact revision.
- A sixth tool, `dowser_areas_push`, sends per-directory churn and author counts for the opportunity map.

**Who calls what (D11).** The agent calls the tools. The harness (Claude Code or Codex CLI) owns the MCP
connection and its auth. The Dowser scripts never open a connection. They build the push payload (`outbox`)
and ingest what the tools return (`ingest-push`, `ingest-verdicts`, `ingest-sources`). The agent saves each
response verbatim to a work file and passes it with `--file`.

**Auth assumption.** The harness manages OAuth for the Forge app's `rovo:mcp` server: the person signs in
once, and the harness attaches the token to every call. Dowser holds no credentials. The server URL is
`https://mcp.atlassian.com/forge/<appId>`. Access from external clients (Claude Code, Codex CLI) is an
Atlassian early-access feature, and a site admin must enable it for the app (Admin > Apps > Sites >
Connected apps). It is unproven until the first smoke test; if it fails, the same tools still serve the
Rovo agent inside Jira, and the mock keeps the skill testable. The skill treats a missing tool as
**unconnected**, not as an error.

**Who decides.** Every tool runs as the signed-in person. Forge takes the caller from the invocation
context (`context.accountId`), never from an argument.

## Conventions

- **Transport.** MCP over the harness's transport, with tool names exactly as below. A harness may add a
  server prefix (`mcp__dowser__dowser_proposals_push`), so the skill matches on the name's ending.
- **Results.** A tool returns one JSON object. It is sent as `structuredContent` and also as a single `text`
  content item that holds the same JSON. The agent saves that JSON verbatim. The ingest commands also accept a
  saved MCP result envelope (`{content: [{type: "text", text}]}` or `{structuredContent}`) and unwrap it.
- **Absent values: omit the key.** `null` is never sent, and `0` is never sent for something unmeasured. This
  holds in both directions.
- **Timestamps** are ISO 8601 UTC strings (`2026-10-27T10:00:00.000Z`).
- **`project_key`** is the key Dowser derives from the repo's `origin` URL (`github-com-Acme-Shop`; see
  `docs/data-model.md`). The agent takes it from the `init` output. Forge keeps one inbox per
  `project_key` and creates it on the first push.
- **`fp`** is the 16-hex fingerprint of a proposal. It is the identity of a proposal across both sides.
- **`external_ref`** is the Dowser inbox item (`DW-12`, unique per installation). **`external_url`** is a
  link to that item in the inbox.
- **`issue_ref`** is the Jira issue key (`SHOP-123`) created when the item was accepted. **`issue_url`**
  is a link to it. Both appear only on an `accepted` verdict.
- **JSON-string inputs.** An input whose name ends in `_json` is a string holding JSON. Forge parses it
  and answers `bad-input` when it does not parse or has the wrong shape. Its parsed size is capped at
  4 MB.

## Errors

A failure the caller can act on is a tool result with `isError: true`. Its JSON is:

```json
{"error": "<code>", "message": "<one sentence for a person>"}
```

| `error` | meaning |
|---|---|
| `bad-input` | arguments are missing or have the wrong shape |
| `bad-cursor` | the `cursor` was not issued by this server, or it expired. Pull again without `cursor`; re-ingesting is idempotent |
| `unknown-project` | Forge has no inbox for `project_key` |
| `unauthorized` | the token is missing, expired or lacks scope. The harness signs in again |
| `unavailable` | Jira, Confluence or TWG did not answer. Retry on the next run, not in a loop |

A protocol fault (unknown method, malformed JSON-RPC) is a JSON-RPC `error`, not a tool result. When any tool
errors, the skill says so in plain words and continues **unconnected**. A failed `dowser_verdicts_pull` also
disables the push for that run (a half-synced memory must not push).

## Read tools (sources)

The agent calls these during a lens pass and then runs
`ingest-sources --run <run_id> --type ticket|page|goal --file <saved response>`. That caches the items in
`sources_cache` and prints `{run_id, type, cached, refs: [{type, ref, url, title}]}`. The agent cites only
those refs, as evidence `{type, ref, url}`. An item without `ref` is skipped and reported (exit 1).

### `dowser_sources_tickets`

Input:

```json
{"query": "export OR csv", "since": "2026-09-01T00:00:00Z", "limit": 50}
```

| field | type | rule |
|---|---|---|
| `query` | string | required. Free text; `OR` between terms means any of them |
| `since` | string | optional ISO timestamp. Only tickets created at or after it |
| `limit` | integer | required, at least 1. Forge may cap it (50 recommended) |

Output: `{items: [{ref, title, url, body, created_at?, labels?, components?}]}`

| field | type | rule |
|---|---|---|
| `ref` | string | the Jira key (`SUP-1`) |
| `title` | string | the summary |
| `url` | string | link to the issue |
| `body` | string | the description as plain text, trimmed by Forge to a sensible length |
| `created_at` | string | optional ISO timestamp. Omitted when Jira gives no valid creation date |
| `labels` | string[] | optional. Omitted when the issue has none |
| `components` | string[] | optional, the component names. Omitted when the issue has none |

An absent list is an omitted key, never `[]`. The skill's `ingest-sources` returns `components`, `labels` and
`created_at` in its `refs[]` rows so the agent can group tickets into a demand table; it caches only `ref`,
`title`, `url` and `body`.

### `dowser_sources_pages`

Input: `{query, space?}`. `query` is required free text. `space` is an optional Confluence space key.

Output: `{items: [{ref, title, url, body, updated_at}]}`. `ref` is the page id, `body` is the page as plain
text, and `updated_at` is the last edit time.

### `dowser_sources_goals`

Input: `{}`.

Output: `{items: [{ref, title, url, body, status?}]}`. These are the team's goals (TWG). `status` is the goal's
state as TWG names it (for example `on-track`, `at-risk`), and is omitted when the goal has none.

### `dowser_direction_get`

The eighth tool, additive to `forge-mcp-2`. A team steers each lens from Forge Settings, per inbox: what the
lens should focus on, what it should leave out, notes on the team's intent and, for Doc drift, which
Confluence spaces to search. The agent calls this once after `run start`, saves the response and runs
`ingest-direction --run <run_id> --file <saved response>`. That caches each lens's direction on the run, and
`context --run <run_id> --lens <lens>` then carries it as `direction`.

Input: `{project_key, lens?}`.

| field | type | rule |
|---|---|---|
| `project_key` | string | required. The inbox must exist (a push creates it), else `unknown-project` |
| `lens` | string | optional. One lens id, or `all` (the default) for every lens. When a transport gives no tool name, a call with `lens` is routed here by its shape (a bare `project_key` is a pull), so send `"all"` rather than omitting it |

Output:

```json
{"lenses": {"opportunity": {"focus": ["checkout", "exports"], "exclude": ["admin pages"], "notes": "Q4 is about retention."},
  "doc-drift": {"spaces": ["DOCS", "ENG"]}}}
```

| field | type | rule |
|---|---|---|
| `lenses` | object | one entry per lens that has a direction. A lens with nothing set is omitted, and `{}` means no direction at all |
| `lenses.<lens>.focus` | string[] | optional, at most 10 items, each one line of at most 120 characters. Topics the lens looks at first |
| `lenses.<lens>.exclude` | string[] | optional, at most 10 items, each one line of at most 120 characters. Topics the lens does not propose |
| `lenses.<lens>.notes` | string | optional, at most 2000 characters. The team's intent in their words |
| `lenses.<lens>.spaces` | string[] | optional, `doc-drift` only, at most 10 Confluence space keys (`^[A-Za-z0-9_~-]+$`). The agent passes each as `space` to `dowser_sources_pages` |

Each key is omitted when it is not set; an empty list is never sent. A direction is read-only over MCP: only
a person changes it, in Settings. A local `--focus` still applies on top of it for one run.

## `dowser_proposals_push`

The agent runs `outbox --run <run_id>`, calls this tool with that output **exactly as printed**, saves the
response, and runs `ingest-push --file <saved response>`.

Input:

```json
{"project_key": "github-com-Acme-Shop", "run_id": "r-20261027100000-ab12",
 "repo_url": "https://github.com/Acme/Shop", "head_sha": "3f2c...", "proposals_json": "[{...}]"}
```

| field | type | rule |
|---|---|---|
| `project_key` | string | required |
| `run_id` | string | required. The Dowser run that pushed. Forge records it per push |
| `proposals_json` | string | required. A JSON array; each element a full `dowser-proposal/1` record (`skill/schema/dowser-proposal-1.schema.json`): identity, card, every evidence item, sizing, risk, the optional `artifacts` (supporting views), provenance and triage fields, with `status` `verified` (a first push) or `pushed` (a re-push after evidence grew). At most 50 records |
| `repo_url` | string | optional. The repo's web URL, credentials stripped (`https://github.com/Acme/Shop`). Omitted when the repo has no `origin` |
| `head_sha` | string | optional. The commit the run scanned. Forge links `code`/`doc` evidence to `<repo_url>/blob/<head_sha>/<path>#L<line>` (GitHub) or `<repo_url>/src/<head_sha>/<path>#lines-<line>` (Bitbucket), and shows the plain ref for any other host |

Output: `{results: [{fp, result, external_ref?, external_url?, why?}]}`, one per input proposal, in input order.

| `result` | meaning | `external_ref` / `external_url` | `why` |
|---|---|---|---|
| `created` | a new inbox item was filed | required | omitted |
| `updated` | an item for `(project_key, fp)` already existed. Its card was refreshed and its evidence united | required (the existing item) | omitted |
| `merged-existing` | a person already merged this fp into another item in the inbox; no item was made | required (that surviving item) | optional |
| `refused` | not accepted (invalid record, quota, policy) | omitted | required, one sentence |

**Idempotency.** Push is idempotent on `(project_key, fp)`. A re-push never creates a second item: it
updates the card of the existing one, unites its evidence and returns `updated`. Evidence on the Forge side
is a union by evidence key (the same key rule as `docs/data-model.md`), never a replacement that loses rows.

**Reopening.** When an `updated` push grew the evidence of an item a person snoozed, the item returns to the
inbox as reopened. A rejected item returns only under the store's resurfacing rule (a new evidence type and
at least twice the evidence it had when rejected). An accepted or merged item only gains evidence. A reopen
writes no verdict; the item is simply open again.

**What `ingest-push` does locally.**

| `result` | local effect | outcome printed |
|---|---|---|
| `created`, `updated` | `external_ref`/`external_url` recorded. A `verified` item moves to `pushed` (CAS, decider `skill:dowser-sync`). A `pushed` item stays pushed | `pushed` or `updated` |
| `merged-existing` | if a local item already owns that `external_ref`, the item moves to `merged` with `merged_into` = that local fp | `merged` |
| `merged-existing` | if no local item owns it, the item is linked to that inbox item (`external_ref` set) and moves to `pushed`, so its verdicts arrive normally | `linked` |
| `refused` | status unchanged | `refused` with `why` |

An unknown `fp`, a malformed result, a ref that already belongs to another local item, or an item whose local
status is no longer `verified`/`pushed` is reported (`unknown`, `invalid`, `conflict`) and never forced.
Exit 0 when every result applied, 1 when any was refused, unknown, invalid or in conflict. Refused items stay
`verified` and go out on the next push.

**What goes into the outbox.** Every `verified` item that was not pushed yet, plus every `pushed` item whose
evidence grew since its last push. Pushed evidence is tracked in `sync_state` (`push_seq:<fp>` = the fp's
highest evidence id at its last push; `outbox` snapshots the ids it sent in `outbox:last`, and `ingest-push`
records those). Rejected, snoozed, merged, dropped and candidate items are never pushed.

## `dowser_verdicts_pull`

The agent calls it before every connected scan, saves the response, and runs
`ingest-verdicts --file <saved response>`.

Input: `{project_key, cursor?}`. `cursor` is the `verdicts_cursor` from the `init` output; omit it when
`init` printed none (the first pull returns every verdict).

Output:

```json
{"verdicts": [{"fp": "...", "status": "rejected", "reason": "already-known", "note": "tracked as SEC-12",
  "decided_by": "forge:712020:7d1c", "decided_at": "2026-10-27T10:00:00.000Z", "external_ref": "DW-1"},
  {"fp": "...", "status": "accepted", "decided_by": "forge:712020:7d1c", "decided_at": "2026-10-27T10:05:00.000Z",
  "external_ref": "DW-2", "issue_ref": "SHOP-41", "issue_url": "https://acme.atlassian.net/browse/SHOP-41"}],
 "cursor": "17"}
```

| field | type | rule |
|---|---|---|
| `verdicts[].fp` | string | required |
| `verdicts[].status` | string | required: `accepted`, `rejected`, `merged` or `snoozed` |
| `verdicts[].reason` | string | required for `rejected`: `false-positive`, `already-known`, `not-our-direction`, `not-worth-it`, `wrong-size` or `other`. Omitted otherwise |
| `verdicts[].note` | string | optional. Required when `reason` is `other` |
| `verdicts[].merged_into` | string | required for `merged`: the fp of the surviving proposal, or the Jira key of an existing issue the evidence was folded into. Omitted otherwise |
| `verdicts[].decided_by` | string | required: `forge:<accountId>`. The name is `[A-Za-z0-9._@:-]+`, so a raw Atlassian account id (`712020:uuid`) passes unchanged |
| `verdicts[].decided_at` | string | required ISO timestamp of the decision in Jira. Unique per fp per decision |
| `verdicts[].external_ref` | string | required: the inbox item (`DW-12`) |
| `verdicts[].issue_ref` | string | required for `accepted`: the Jira issue the accept created or updated. Omitted otherwise |
| `verdicts[].issue_url` | string | required for `accepted`: a link to that issue. Omitted otherwise |
| `cursor` | string | required. Opaque. Pass it back on the next pull. Returned even when `verdicts` is empty |

A verdict is recorded only after it has landed: an accept that could not create its Jira issue writes no
verdict, and the item stays open in the inbox. Verdicts made through the Rovo agent arrive the same way; the
decider is the person who asked the agent.

Verdicts are returned oldest first. A verdict appears once per decision; a changed decision is a new verdict
with a new `decided_at`.

**What `ingest-verdicts` does locally.** Each verdict goes through the store's compare-and-set `move` with
`by` = `decided_by`. The card's `decided_at` becomes the Jira one. It is idempotent per `(fp, decided_at)`:
re-ingesting the same file is a no-op (`already-applied`). A verdict that matches the local status already
is `in-sync`. An unknown `fp` (`unknown`), a malformed verdict (`invalid`) or a transition the local status
does not allow (`conflict`, with the `current` status) is reported and never forced; for example
`verified -> accepted` needs a `human:` decider, so a `forge:` acceptance of an item that is still `verified`
locally is a conflict. An `accepted` verdict also records `issue_ref` and `issue_url` on the local item.
Exit 0 when every verdict applied or was already applied, 1 otherwise. The `cursor` is stored in
`sync_state` key `verdicts_cursor`, and `init` prints it as `verdicts_cursor`.

## `dowser_areas_push`

The opportunity map joins proposals to how the code around them changes. After the push, the agent runs
`areas --run <run_id>`, calls this tool with that output exactly as printed, and needs no ingest step.

Input: `{project_key, run_id, areas_json}`.

| field | type | rule |
|---|---|---|
| `project_key` | string | required |
| `run_id` | string | required |
| `areas_json` | string | required. A JSON array of at most 200 `{path, files, churn_90d, authors_90d, last_change?}` |
| `areas_json[].path` | string | a repo-relative directory, at most two levels deep, forward slashes, no trailing slash (`src/checkout`) |
| `areas_json[].files` | integer | tracked files under the path, at least 1 |
| `areas_json[].churn_90d` | integer | commits touching the path in the 90 days before `head_sha` |
| `areas_json[].authors_90d` | integer | distinct author emails in those commits. Omitted when `churn_90d` is 0, since it was not measured |
| `areas_json[].last_change` | string | ISO timestamp of the newest commit touching the path. Omitted when there is none |

Output: `{stored}`, the number of areas kept. The set replaces the project's previous areas whole.

## `dowser_reflect_sync`

The seventh tool, additive to `forge-mcp-2`. The skill learns rules from what people reject ("do not
propose `csv` items for the opportunity lens again") and offers them for a person to accept or decline.
Forge is where the person decides. This tool is one idempotent round trip: the skill pushes its `offered`
rules and reads back every rule decided in Forge and the recorded outcomes of accepted items.

Input: `{project_key, rules_json?}`.

| field | type | rule |
|---|---|---|
| `project_key` | string | required. The inbox must exist (a push creates it), else `unknown-project` |
| `rules_json` | string | optional. A JSON array of at most 50 offered rules. Send `"[]"` (or omit it) to only read. When a transport gives no tool name, a call with `rules_json` is routed here by its shape, so send `"[]"` rather than omitting it |
| `rules_json[].id` | string | required, 1-64 characters of letters, digits and `. _ : -`. Unique per `project_key` |
| `rules_json[].lens` | string | required: `opportunity`, `ux-friction`, `doc-drift` or `security-cra` |
| `rules_json[].text` | string | required, 1-2000 characters. The draft wording |
| `rules_json[].titles` | string[] | optional, at most 10, the titles of the rejected items behind the rule. Omitted when there are none |
| `rules_json[].offered_at` | string | required ISO timestamp |

A single invalid rule refuses the whole call with `bad-input` (the message names its index) and stores nothing.

Output:

```json
{"rules": [{"id": "rule-3fa9", "lens": "opportunity", "state": "accepted", "text": "Do not propose csv items",
  "decided_by": "forge:712020:7d1c", "decided_at": "2026-10-27T11:00:00.000Z"}],
 "outcomes": [{"ref": "DW-2", "fp": "...", "rating": "partly", "note": "shipped without the filter",
  "issue_ref": "SHOP-41", "decided_by": "forge:712020:7d1c", "recorded_at": "2026-10-29T08:00:00.000Z"}]}
```

| field | type | rule |
|---|---|---|
| `rules[]` | | every rule a person decided in Forge, oldest decision first. Rules that are still `offered` are not returned |
| `rules[].state` | string | `accepted` or `declined` |
| `rules[].text` | string | the wording on file: the person's edit when they edited it while accepting, else the offered text |
| `rules[].decided_by`, `decided_at` | string | like a verdict: `forge:<accountId>` and an ISO timestamp |
| `outcomes[]` | | the newest 200 outcomes of the project, newest first. An outcome is how the person who owns the issue rates an accepted item |
| `outcomes[].rating` | string | `right`, `partly` or `wrong` |
| `outcomes[].note` | string | optional. Omitted when the person gave none |
| `outcomes[].ref`, `fp`, `issue_ref` | string | the inbox item, its fingerprint and the Jira issue it created |

**Idempotency and precedence.** Rules upsert by `(project_key, id)`. A rule that is still offered has its
`lens`, `text`, `titles` and `offered_at` refreshed by a later push. A rule a person has decided in Forge
is **never reverted** by a push, and its decided text is never overwritten: the Forge decision wins.
Repeating a call changes nothing. The skill applies the returned decisions the way it applies verdicts
(accepted rule: the lens prompt carries it; declined: it is never offered again).

**Notes on every decision.** `Verdict.note` was already optional. Forge now also accepts a note when a
person **accepts** or **snoozes** an item (in the inbox and through the Rovo agent), and it arrives in the
verdict like a reject note. A note is at most 2000 characters on every decision.

## Versioning

This is `forge-mcp-2`. An additive change (a new optional field, a new error code, a new tool) keeps the
version. A removed or renamed field, a new required field, or a changed meaning makes `forge-mcp-3`.

Additive amendments:

- **Supporting views (2026-10-28).** A record may carry `artifacts` (at most 3; `table`, `flow`,
  `before-after`, `matrix`). Forge validates them with the shared `validateCandidate`, so a push carrying an
  artifact whose `refs` are not in the record's own evidence is refused as `invalid`. Forge stores them with
  the card and renders them in the inbox, the issue panel and the issue that Accept creates.
- **Lens direction (2026-10-28).** An eighth tool, `dowser_direction_get {project_key, lens?}`, returns what a
  team set in Settings for each lens of the inbox (`focus`, `exclude`, `notes`, and `spaces` for doc-drift).
  A call carrying `lens` is routed to it by shape, so the skill sends `lens: "all"`.
- **Ticket fields (2026-10-28).** `dowser_sources_tickets` items gain optional `components` (component names);
  `created_at` is documented as optional, which the code already allowed. A skill that ignores the new key is
  unaffected.
