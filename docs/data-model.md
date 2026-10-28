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

The store is SQLite through `node:sqlite` (Node >= 22.13) with WAL and `PRAGMA user_version = 3`. The DDL
runs in one `BEGIN IMMEDIATE` transaction that re-reads the version. A file with another version is
refused.

**Migration.** Version 2 (forge-mcp-2) adds `proposals.issue_ref` and `proposals.issue_url`. `openStore`
upgrades a version 1 file in place, inside the same `BEGIN IMMEDIATE` transaction, after re-reading the
version: `ALTER TABLE proposals ADD COLUMN issue_ref TEXT`, the same for `issue_url`, then
`PRAGMA user_version = 2`. No row is rewritten, and both columns start NULL (absent). A new file is created
at the current version. Version 3 adds the `outcomes` table (below): `CREATE TABLE IF NOT EXISTS` plus its index and
triggers, then `PRAGMA user_version = 3`. An existing file is upgraded one step at a time (1 -> 2 -> 3) and no row is
rewritten. Any version other than 0 (new), 1, 2 or 3 is refused with exit 3.

## Tables

| table | role | keys |
|---|---|---|
| `runs` | one scan: `id`, `started_at`, `finished_at`, `head_sha`, `base_sha`, `mode` (`full\|incremental\|focused`), `focus`, `harness`, `model`, `status` (`running\|done\|failed`), `lenses_json` | PK `id` (`r-YYYYMMDDHHMMSS-xxxx`) |
| `proposals` | the current card: identity (`lens`, `kind`, normalized `topic`, `anchors_json`), card text, `effort_json`, `confidence`, `confidence_why`, `doc_impact_json`, `delivery_risk_json`, `provenance_json`, `asserted_json` (the evidence keys the newest propose line carried; internal, not part of the record), triage fields (`status`, `reason`, `note`, `merged_into`, `external_ref`, `external_url`, `decided_by`, `decided_at`), `issue_ref`, `issue_url` (v2: the Jira issue an `accepted` verdict carried; not part of the record), `first_run_id`, `last_run_id` | PK `fp`; `external_ref` UNIQUE where not null |
| `evidence` | **append-only**: `fp`, `run_id`, `type`, `ref`, `key`, `path`, `line` (hint), `quote`, `url`, `added_at`; one row per key, written when the key is first seen | UNIQUE (`fp`, `type`, `key`) |
| `transitions` | **append-only**: `fp`, `from_status` (NULL on creation), `to_status`, `by`, `at`, `reason`, `note`, `run_id`, `evidence_seq` | `evidence_seq` = max evidence id of the fp at the move |
| `rules` | offered and accepted prompt rules (`offered\|accepted\|declined`). `cluster_json` keeps the source fingerprints, who decided (`decided_by`: a human at the prompt, or `forge:<account>`) and, when the wording was edited, the original as `draft_text` | PK `id` |
| `outcomes` | **append-only** (v3): how an accepted item turned out once built, as a person rated it in Forge. `fp`, `ref` (the inbox item `DW-n`), `rating` (`right|partly|wrong`), `note`, `issue_ref`, `decided_by` (`forge:<account>`), `recorded_at`. Written only by `reflect ingest`. No foreign key on `fp`: an outcome may name an item this store never saw (it is kept, and not counted in `context`) | UNIQUE (`fp`, `recorded_at`), so a replayed sync adds nothing |
| `sources_cache` | tickets, pages and goals fetched per run; logic in WP4 | PK (`run_id`, `type`, `ref`) |
| `sync_state` | Forge sync bookkeeping: `verdicts_cursor`; `push_seq:<fp>` (evidence id at last push); `outbox:last` (ids actually sent); `verdict:<fp>@<decided_at>` (idempotency). See `docs/contracts/forge-mcp-2.md` | PK `key` |

Append-only is enforced twice. Triggers abort any UPDATE or DELETE on `evidence`, `transitions` and `outcomes`, and a
test greps the sources for such statements on the first two.

## Reflection (`reflect`)

The seam is the `dowser_reflect_sync` Forge tool (additive tool 7 of forge-mcp-2; wire types in
`forge/src/core/types.mjs`). Like every Forge tool the skill never calls it: the agent does, and the CLI prints and
reads the payloads.

- `reflect export` prints `{project_key, rules_json?, more?}`, the tool's arguments: the rules in state `offered`,
  oldest first, at most 50, each `{id, lens, text, titles?, offered_at}` with at most 10 titles. It writes nothing. It
  does not create offers (`rules offer` does, once, in the triage dialog), so run `rules offer` first. `rules_json` is
  omitted when nothing is offered; the call is still made, because decisions and outcomes come back in its answer.
  `more: true` means over 50 are offered; the agent does not pass it on.
- `reflect ingest --file <json>` applies the answer `{rules, outcomes}` and prints
  `{rules_applied, rules_skipped, outcomes_added, outcomes_seen}` (plus `invalid` and exit 1 for a malformed entry;
  the rest is applied). Each rule decision is a compare-and-set `offered -> accepted|declined` that records the
  Forge decider (a bare account id is stored as `forge:<id>`) and the decision time; Forge-edited wording replaces the
  draft on accept. A rule that is unknown or no longer `offered` is skipped, so a replay and a late decision for a rule
  the runner already settled change nothing. Each outcome is one `outcomes` row; `outcomes_seen` counts the response's
  outcomes, `outcomes_added` the new ones.
- `context` gains `outcomes: {right, partly, wrong}` per lens: the latest rating of each of the lens's items that
  has one. It is omitted when the lens has none. `show <fp>` lists the item's outcome rows (omitted when none).
  `status` is unchanged.
- A verdict `note` on an `accepted` or `snoozed` verdict is stored on the transition and on the card, like any other.

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
- **Supporting views:** `artifacts?[]`, at most 3, each `{kind: table|flow|before-after|matrix, message, alt,
  refs[], data}`. `refs` must name evidence refs on the same card. The kind-specific `data` shapes and
  caps are in `skill/references/cards.md` and the schema. The store keeps them in `artifacts_json`
  (store v4). A re-propose replaces them, the same as the other card fields.
- **Provenance:** `provenance{lens_version, model?, harness?, run_id?, focus?}`. `propose` always stamps
  `run_id` from `--run`, so the agent may omit it. A line carrying a different `run_id` is overwritten, not
  refused, and that line's output gets a `note`. `model`, `harness` and `focus` default from the run.
- **Triage:** `status`, `reason?`, `note?`, `merged_into?`, `external_ref?`, `external_url?`,
  `decided_by` and `decided_at`. These are store-owned, so a propose line that carries one is
  invalid. `external_ref` is the Dowser inbox item (`DW-12`) and `external_url` links to it.

`issue_ref` and `issue_url` are store columns, not record fields. `ingest-verdicts` sets them from an
`accepted` verdict (an accepted verdict without them is `invalid`). The push never sends them, and `show`
prints them beside `external_ref` when present.

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

## Areas (`areas --run <id> [--top 40]`)

`areas` prints the `dowser_areas_push` arguments `{project_key, run_id, areas_json}`. It reads git and the
run row only, and writes nothing: not the store and not the repo.

- **Areas** are the directories at depth 1 and 2 (`src`, `src/checkout`) in the tree of the run's
  `head_sha`. A top-level file belongs to no area.
- **`files`** is the number of files under the path in that tree (`git ls-tree -r <head_sha>`), so it is
  always at least 1.
- **`churn_90d`** is the number of non-merge commits reachable from `head_sha` that touched the path, with
  a committer date in the 90 days before the head commit's own date (not the wall clock).
- **`authors_90d`** is the number of distinct author e-mails (case-insensitive) in those commits. It is
  omitted when `churn_90d` is 0, because nothing was measured.
- **`last_change`** is the committer date of the newest commit that touched the path. It is omitted when
  there is none.

One `git log <head_sha> --since=<head date - 90d> --name-only` pass over the whole repo gives churn,
authors and in-window `last_change` for every area. Only a kept area with no churn costs one more
`git log -1 <head_sha> -- <path>`, for its `last_change`. Areas are ranked by `churn_90d` (descending), then
`files` (descending), then path, and capped at `--top` (default 40, at most 200). A run without a head commit
is refused with exit 2 (`no-head`).

## Exit codes (every script)

| code | meaning |
|---|---|
| 0 | ok |
| 1 | partial: some `propose` lines were invalid (each is reported, never dropped) |
| 2 | bad input, or a refused move (stdout names the current status) |
| 3 | store or connection unavailable, or the command is not implemented yet (`{"error":"not-implemented","package":"WP2\|WP4"}`) |
