# Forge MCP contract, version 1 (`forge-mcp-1`)

This is the seam between the Dowser local skill and the Dowser Forge app (a separate spark). The Forge app
implements these five tools on its `rovo:mcp` server. `tools/mock-forge-mcp.mjs` implements the same five tools
locally, so the skill can be tested before Forge exists.

**Who calls what (D11).** The agent calls the tools. The harness (Claude Code or Codex CLI) owns the MCP
connection and its auth. The Dowser scripts never open a connection. They build the push payload (`outbox`)
and ingest what the tools return (`ingest-push`, `ingest-verdicts`, `ingest-sources`). The agent saves each
response verbatim to a work file and passes it with `--file`.

**Auth assumption.** The harness manages OAuth for the Forge app's `rovo:mcp` server: the person signs in
once, and the harness attaches the token to every call. Dowser holds no credentials. Whether `rovo:mcp` OAuth
works inside Claude Code and Codex CLI is not proven yet, and is the week-one spike. Until it is, the mock
server keeps the whole flow testable. The skill treats a missing tool as **unconnected**, not as an error.

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
  `docs/data-model.md`). The agent takes it from the `init` output. Forge maps it to a Jira project or
  inbox.
- **`fp`** is the 16-hex fingerprint of a proposal. It is the identity of a proposal across both sides.
- **`external_ref`** is the Jira issue key (`DOW-123`). **`external_url`** is a link to that issue.

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

Output: `{items: [{ref, title, url, body, created_at, labels?}]}`

| field | type | rule |
|---|---|---|
| `ref` | string | the Jira key (`SUP-1`) |
| `title` | string | the summary |
| `url` | string | link to the issue |
| `body` | string | the description as plain text, trimmed by Forge to a sensible length |
| `created_at` | string | ISO timestamp |
| `labels` | string[] | optional. Omitted when the issue has none |

### `dowser_sources_pages`

Input: `{query, space?}`. `query` is required free text. `space` is an optional Confluence space key.

Output: `{items: [{ref, title, url, body, updated_at}]}`. `ref` is the page id, `body` is the page as plain
text, and `updated_at` is the last edit time.

### `dowser_sources_goals`

Input: `{}`.

Output: `{items: [{ref, title, url, body, status?}]}`. These are the team's goals (TWG). `status` is the goal's
state as TWG names it (for example `on-track`, `at-risk`), and is omitted when the goal has none.

## `dowser_proposals_push`

The agent runs `outbox --run <run_id>`, calls this tool with that output **exactly as printed**, saves the
response, and runs `ingest-push --file <saved response>`.

Input:

```json
{"project_key": "github-com-Acme-Shop", "run_id": "r-20261027100000-ab12", "proposals": [ ... ]}
```

| field | type | rule |
|---|---|---|
| `project_key` | string | required |
| `run_id` | string | required. The Dowser run that pushed. Forge records it per push |
| `proposals` | object[] | required. Each a full `dowser-proposal/1` record (`skill/schema/dowser-proposal-1.schema.json`): identity, card, every evidence item, sizing, risk, provenance and triage fields, with `status` `verified` (a first push) or `pushed` (a re-push after evidence grew) |

Output: `{results: [{fp, result, external_ref?, external_url?, why?}]}`, one per input proposal, in input order.

| `result` | meaning | `external_ref` / `external_url` | `why` |
|---|---|---|---|
| `created` | a new Jira item was made | required | omitted |
| `updated` | an item for `(project_key, fp)` already existed. Its card and evidence were refreshed | required (the existing item) | omitted |
| `merged-existing` | Forge judged it the same work as an existing Jira item and did not create one | required (that existing item) | optional |
| `refused` | not accepted (invalid record, quota, policy) | omitted | required, one sentence |

**Idempotency.** Push is idempotent on `(project_key, fp)`. A re-push never creates a second item: it
updates the evidence and card of the existing one and returns `updated`. Evidence on the Forge side is a
union by evidence key (the same key rule as `docs/data-model.md`), never a replacement that loses rows.

**What `ingest-push` does locally.**

| `result` | local effect | outcome printed |
|---|---|---|
| `created`, `updated` | `external_ref`/`external_url` recorded. A `verified` item moves to `pushed` (CAS, decider `skill:dowser-sync`). A `pushed` item stays pushed | `pushed` or `updated` |
| `merged-existing` | if a local item already owns that `external_ref`, the item moves to `merged` with `merged_into` = that local fp | `merged` |
| `merged-existing` | if no local item owns it, the item is linked to that Jira item (`external_ref` set) and moves to `pushed`, so its verdicts arrive normally | `linked` |
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
  "decided_by": "forge:jane", "decided_at": "2026-10-27T10:00:00.000Z", "external_ref": "DOW-1"}],
 "cursor": "17"}
```

| field | type | rule |
|---|---|---|
| `verdicts[].fp` | string | required |
| `verdicts[].status` | string | required: `accepted`, `rejected`, `merged` or `snoozed` |
| `verdicts[].reason` | string | required for `rejected`: `false-positive`, `already-known`, `not-our-direction`, `not-worth-it`, `wrong-size` or `other`. Omitted otherwise |
| `verdicts[].note` | string | optional. Required when `reason` is `other` |
| `verdicts[].merged_into` | string | required for `merged`: the fp of the surviving proposal, or its Jira key. Omitted otherwise |
| `verdicts[].decided_by` | string | required: `forge:<jira-user>`. The name is `[A-Za-z0-9._@:-]+`, so a raw Atlassian account id (`712020:uuid`) passes unchanged |
| `verdicts[].decided_at` | string | required ISO timestamp of the decision in Jira. Unique per fp per decision |
| `verdicts[].external_ref` | string | required: the Jira key of the item |
| `cursor` | string | required. Opaque. Pass it back on the next pull. Returned even when `verdicts` is empty |

Verdicts are returned oldest first. A verdict appears once per decision; a changed decision is a new verdict
with a new `decided_at`.

**What `ingest-verdicts` does locally.** Each verdict goes through the store's compare-and-set `move` with
`by` = `decided_by`. The card's `decided_at` becomes the Jira one. It is idempotent per `(fp, decided_at)`:
re-ingesting the same file is a no-op (`already-applied`). A verdict that matches the local status already
is `in-sync`. An unknown `fp` (`unknown`), a malformed verdict (`invalid`) or a transition the local status
does not allow (`conflict`, with the `current` status) is reported and never forced; for example
`verified -> accepted` needs a `human:` decider, so a `forge:` acceptance of an item that is still `verified`
locally is a conflict. Exit 0 when every verdict applied or was already applied, 1 otherwise. The `cursor`
is stored in `sync_state` key `verdicts_cursor`, and `init` prints it as `verdicts_cursor`.

## Versioning

This is `forge-mcp-1`. An additive change (a new optional field, a new error code) keeps the version. A
removed or renamed field, a new required field, or a changed meaning makes `forge-mcp-2`, served alongside
version 1 until the skill moves.
