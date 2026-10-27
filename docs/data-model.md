# Dowser data model

The store is the single source of local memory. `skill/scripts/dowser.mjs` is its only writer, and the
agent never writes SQL. Code: `skill/scripts/lib/{model,store,fingerprint,verify,paths,git}.mjs`. Record
schema: `skill/schema/dowser-proposal-1.schema.json`.

## Location

`~/.dowser/projects/<project-key>/dowser.db`. `DOWSER_HOME` replaces `~/.dowser`. The project key is the
`origin` remote URL with the protocol, credentials and `.git` stripped and the host lowercased. Every
non-alphanumeric run becomes `-`, so `git@github.com:Acme/Shop.git` gives `github-com-Acme-Shop`. A repo
with no origin gets `local-` plus the first 12 hex of sha256(realpath(repo root)).

Nothing is ever written inside the scanned repo. Paths are compared by real path, and a store path inside
the repo is refused with exit 3.

The store is SQLite through `node:sqlite` (Node >= 22.13) with WAL and `PRAGMA user_version = 1`. The DDL
runs in one `BEGIN IMMEDIATE` transaction that re-reads the version. A file with another version is
refused.

## Tables

| table | role | keys |
|---|---|---|
| `runs` | one scan: `id`, `started_at`, `finished_at`, `head_sha`, `base_sha`, `mode` (`full\|incremental\|focused`), `focus`, `harness`, `model`, `status` (`running\|done\|failed`), `lenses_json` | PK `id` (`r-YYYYMMDDHHMMSS-xxxx`) |
| `proposals` | the current card: identity (`lens`, `kind`, normalized `topic`, `anchors_json`), card text, `effort_json`, `confidence`, `confidence_why`, `doc_impact_json`, `delivery_risk_json`, `provenance_json`, `asserted_json` (the evidence keys the newest propose line carried; internal, not part of the record), triage fields (`status`, `reason`, `note`, `merged_into`, `external_ref`, `external_url`, `decided_by`, `decided_at`), `first_run_id`, `last_run_id` | PK `fp`; `external_ref` UNIQUE where not null |
| `evidence` | **append-only**: `fp`, `run_id`, `type`, `ref`, `key`, `path`, `line` (hint), `quote`, `url`, `added_at`; one row per key, written when the key is first seen | UNIQUE (`fp`, `type`, `key`) |
| `transitions` | **append-only**: `fp`, `from_status` (NULL on creation), `to_status`, `by`, `at`, `reason`, `note`, `run_id`, `evidence_seq` | `evidence_seq` = max evidence id of the fp at the move |
| `rules` | offered and accepted prompt rules (`offered\|accepted\|declined`); logic in WP2 | PK `id` |
| `sources_cache` | tickets, pages and goals fetched per run; logic in WP4 | PK (`run_id`, `type`, `ref`) |
| `sync_state` | Forge sync bookkeeping: `verdicts_cursor`; `push_seq:<fp>` (evidence id at last push); `outbox:last` (ids actually sent); `verdict:<fp>@<decided_at>` (idempotency). See `docs/contracts/forge-mcp-2.md` | PK `key` |

Append-only is enforced twice. Triggers abort any UPDATE or DELETE on `evidence` and `transitions`, and a
test greps the sources for such statements.

`runs.lenses_json` holds one record per lens:
`{state: ran|skipped|partial, reason?, emitted?, verified?, dropped?, truncated?}`. A skipped or partial
lens needs a reason. When `truncated > 0`, `status` reports "top N of M", where N = `emitted` and
M = `emitted + truncated`.

## Proposal record (`dowser-proposal/1`)

- **Identity:** `fp`, `lens` (`opportunity|ux-friction|doc-drift|security-cra`), `kind`, `topic`, and
  `anchors[]`.
- **Card:** `title` (at most 80 chars), `rationale`, and `body`. The body is Markdown with `## Summary`,
  `## Description`, `## Flow`, `## Expected impact` and `## Evaluation`.
- **Evidence:** `evidence[]` of `{type: code|doc|git|ticket|page|goal|dep|sarif, ref, quote?, url?}`.
  `quote` is required for `code` and `doc`.
- **Sizing:** `effort{size: XS|S|M|L|XL, days_low?, days_high?, basis?[]}`, plus `confidence`
  (`low|medium|high`) and `confidence_why`.
- **Risk:** `doc_impact?[]` and `delivery_risk?{blast: low|medium|high, bus_factor?}`.
- **Provenance:** `provenance{lens_version, model?, harness?, run_id?, focus?}`. `propose` always stamps
  `run_id` from `--run`, so the agent may omit it. A line carrying a different `run_id` is overwritten, not
  refused, and that line's output gets a `note`. `model`, `harness` and `focus` default from the run.
- **Triage:** `status`, `reason?`, `note?`, `merged_into?`, `external_ref?`, `external_url?`,
  `decided_by` and `decided_at`. These are store-owned, so a propose line that carries one is
  invalid.

**Evidence key.** A `code` or `doc` item is identified by its path plus its whitespace-normalized quote,
as `<path>\n<quote>`. The path has forward slashes, no leading `./`, and no `:line` or `#L12`. The line is
only a hint, so a line shift is not new evidence. Every other type is identified by its trimmed `ref`.
"New evidence" anywhere in this document means a `(type, key)` the fingerprint never had.

**Absent values:** omit the key. `null` is never written, and `0` is never written for something
unmeasured. A missing `bus_factor` means it was not computed. A count of 0 is a real measurement.

## Statuses and transitions

```
(new) --propose--> candidate --verify--> verified --triage--> rejected(reason) | snoozed | merged(into) | pushed
                       \--verify--> dropped (note verify-failed:<ref>)          pushed --Forge--> accepted | rejected | merged | snoozed
verified --> accepted (offline acceptance; decider kind human only)
snoozed  --> verified (unsnooze) | candidate (resurfaced)
rejected --> candidate (resurfaced)
dropped  --> candidate (retry: propose added a new evidence key)
merged, accepted: terminal
```

Every move is a compare-and-set: `UPDATE proposals ... WHERE fp = ? AND status = ? RETURNING *`. It is
checked against `model.TRANSITIONS`, and each move appends one `transitions` row.

An illegal move, a stale `--from`, or an unknown fp is refused with exit 2. Stdout then carries
`{"error":"refused","fp","current","to"}`.

**Deciders** are `kind:name`:

- `human:<name>` for a person's call.
- `agent:<harness>` for the scanning agent, such as a same-work merge.
- `forge:<jira-user>` for verdicts pulled from Jira.
- `skill:dowser` and `skill:dowser-verify` for the store's own moves (creation, resurfacing, verify);
  `skill:dowser-sync` for moves the Forge ingest makes on its own (push results).
- A decider name may contain `:` so raw Atlassian account ids (`forge:712020:uuid`) pass; the kind is the text before the FIRST colon.

`model.DECIDER_GUARDS` restricts some moves by decider kind. `verified -> accepted` is allowed only for
`human:`. `pushed -> accepted` is open to every kind, because Forge verdicts arrive as `forge:`. A guarded
move with the wrong kind is refused like an illegal one: exit 2, with the current status.

A reject needs a reason code: `false-positive`, `already-known`, `not-our-direction`, `not-worth-it`,
`wrong-size` or `other`. `other` also needs a note. A merge needs `--into <existing fp>`.

## Fingerprint (exact tier)

```
fp = sha256(lens | kind | normTopic | sortedUniqueNormAnchors.join(',')).hex[0:16]
```

- `kind` must be one of the lens's kinds, which come from the lens pack frontmatter. They are passed with
  `--kinds <lens>=<k1,k2>` and never hardcoded.
- `normTopic` is lowercase kebab with diacritics folded and quotes dropped. Every other non-alphanumeric
  run becomes one `-`.
- An anchor is normalized to forward slashes with no leading `./`. `:line[:col]` suffixes and `#L12`
  fragments are stripped, and `#symbol` is kept.
- Title and body wording never enter the fingerprint.

The near tier (`similar`, merge judgement) is WP2's.

## propose outcomes

| outcome | when |
|---|---|
| `created` | new fp, inserted as `candidate` |
| `evidence-grew` | known fp and at least one new evidence key appended. The status is unchanged unless the item resurfaced (`resurfaced: {from, rule}`, now `candidate`). A `dropped` item with a new key always resurfaces |
| `suppressed` | fp is `snoozed` or `rejected` and the resurfacing rule did not fire (evidence is still appended) |
| `duplicate` | known fp, no new key; a re-asserted key or a line shift is a duplicate. A `dropped` item stays dropped |
| `invalid:<why>` | the line failed validation or fingerprinting; nothing written. Unparseable JSON is `invalid:json` |

A line may also carry `note` (the `provenance.run_id` overwrite). Card text is refreshed only while the item is a `candidate`, because a verified or pushed card is what a
person already saw.

## Resurfacing rule (D4)

`store.resurfaces(status, then, now)` is pure. `then` is the evidence snapshot when the item entered its
status, taken from that transition's `evidence_seq`. `now` is the snapshot after this proposal's refs were
appended.

`refs` counts distinct evidence keys.

- **snoozed:** any new evidence key (`now.refs > then.refs`) moves it to `candidate`.
- **dropped:** any new evidence key moves it to `candidate`, as a retry after a failed verify.
- **rejected:** a new evidence type AND `now.refs >= 2 * then.refs` moves it to `candidate`.
- Otherwise a snoozed or rejected item is `suppressed`.

## Verify (D8)

`verify --run <id>` checks every `candidate` whose `last_run_id` is the run. It checks only the evidence
the fingerprint's newest propose line carried (`store.assertedEvidence`), with that line's ref and line hint.
A quote an earlier line carried and the newest line no longer does is stale and is never re-checked. Every
such `code`/`doc` quote must be a whitespace-normalized substring of the file at the ref's path in the current
working tree.

- With a `:line` hint, the result is `near-line` (within ±30 lines) or `in-file` (anywhere in the file).
- If all quotes are found, the item becomes `verified`.
- If any quote is missing, the item becomes `dropped` with note `verify-failed:<ref>`.
- Other evidence types are reported as `unchecked`. The agent judges them.

## Exit codes (every script)

| code | meaning |
|---|---|
| 0 | ok |
| 1 | partial: some `propose` lines were invalid (each is reported, never dropped) |
| 2 | bad input, or a refused move (stdout names the current status) |
| 3 | store or connection unavailable, or the command is not implemented yet (`{"error":"not-implemented","package":"WP2\|WP4"}`) |
