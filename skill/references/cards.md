# The card - one shape for every proposal

Every proposal is one JSON line in the `dowser-proposal/1` shape. You write the candidate
fields below. `dowser.mjs` computes `fp` and owns every triage field (`status`, `reason`,
`note`, `merged_into`, `external_ref`, `external_url`, `decided_by`, `decided_at`). Never write
those yourself.

**Absent values: omit the key.** Never write `null`. Never write `0` or `""` for something you
did not measure.

## Fields you write

| Field | Rule |
| --- | --- |
| `lens` | `opportunity`, `ux-friction`, `doc-drift` or `security-cra` |
| `kind` | One value from the lens pack's `kinds`. Pick the closest one; never invent a new one. |
| `topic` | Stable kebab noun phrase for the capability or defect, from the pack's naming rule. Reuse a `near` item's topic when it is the same work. |
| `anchors` | `path#symbol` or `path` (repo-relative, forward slashes). **No line numbers, no wording.** 1-4 anchors: the places the work lands. |
| `title` | 80 characters or fewer, in product language. See the title rules below. |
| `rationale` | At most 3 sentences: why this, why now, for whom. No file paths in guided-facing text. |
| `body` | Markdown with exactly the five `## ` sections below, in order. |
| `evidence` | 1 or more `{type, ref, quote?, url?}`. The rules per type are below. |
| `effort` | `{size, days_low, days_high, basis}`. See the anchors below. |
| `confidence` | `low`, `medium` or `high`. |
| `confidence_why` | One sentence: what makes it this strong, and what would raise it. |
| `doc_impact` | Docs or pages that must change when it ships (repo paths or page refs). Omit the key if none; do not write `[]` for "not checked". |
| `delivery_risk` | `{blast: low|medium|high, bus_factor?}`. Include `bus_factor` only when you counted it (below). |
| `provenance` | `{lens_version, model, harness, focus?}`: the pack's `version`, your model id, the harness, and `focus` on a focused run. You may omit `run_id`: `propose` stamps it from `--run`, and overwrites a different one with a `note`. |

## Title

- 80 characters or fewer. Product language: what the user or team gets, not what the code does.
- A fix is imperative ("Let users recover from a failed card payment"). A gap is a noun phrase
  ("Export for reports that already have a CSV writer").
- No file names, function names, ticket keys or jargon in the title. Those belong in evidence.

## Body - five sections, in order, each present

```markdown
## Summary
One or two sentences: what to do and where it shows up for users. No reasoning.

## Description
What the product does today, why that is a gap or a defect, and what "done" looks like.
Cite evidence by its ref (`src/export/csv.ts:41`, `ticket SUP-118`) for every claim.

## Flow
- for a defect: user action -> what the code does -> what the user sees
- for a proposal: the steps the work takes, in build order

## Expected impact
Who notices, what changes for them, and how it would be measured. One sentence on what could
break.

## Evaluation
Claim: user | quality | security | compliance | docs - <what the proposal promises, one clause>
Before: <the figure today - a count, a reproduced behaviour, the sample you read - or "unmeasured: <why>">
After: <the figure expected once shipped, and how it would be taken>
Method: quote | count | probe | simulation - <what you actually did to get Before>
Falsified if: <the observation that would show this proposal is wrong>
```

`Method` uses the evidence ladder, from strongest to weakest:

- `count`: you enumerated the population (sites, tickets, pages) with a grep or a query and
  give the number.
- `probe`: you ran something read-only, such as an existing test, a CLI `--help` or a dependency
  audit, and quote its output.
- `quote`: you read the line and quote it, with no population count.
- `simulation`: you walked three concrete cases from this repo under today and after.

Take the highest rung you reached. If the rung above was within reach, say why you stopped.
Do not add extra sections; anything else goes under Description.

## Artifacts - optional supporting views

A card may carry up to three `artifacts`: small views that let the person triaging see the structure of
the claim at a glance. Attach one only when it does a job the five sections cannot. The test: three or
more lines of the body walk through a comparison, a sequence, a before/after or a grid of judgments.
Omit the key when there is none, and never write an empty list.

| kind | Use it for | `data` |
| --- | --- | --- |
| `table` | several items compared on the same attributes ("doc says / code does", package / advisory / fixed in) | `{columns[<=6], rows[<=12][one cell per column], highlight?[row indexes]}` |
| `flow` | a sequence of user or system steps with the failing or missing one marked | `{steps[2-8]: {label, mark?: friction\|failure\|missing\|new}}` |
| `before-after` | the same measure today and once shipped (steps, clicks, error path) | `{measure, before[<=8], after[<=8]}` |
| `matrix` | a grid of judgments (obligation x status, theme x goal) | `{rows[<=8], columns[<=6], cells[row][column]: {v, level?: 0-3}}` |

Every artifact also carries:

- `message`: the one thing it shows, one line, at most 120 chars, stated as a finding ("Two of three
  install steps name a flag the CLI removed"). It must describe the most visible feature of the view.
- `alt`: a text alternative of at most 400 chars. Give the view type, its topic and the key fact in
  neutral words, without your interpretation. It is all a screen reader, the Rovo agent or a broken
  renderer shows.
- `refs`: the refs of this card's own `evidence` that the view was drawn from, at least one.
  `propose` refuses a ref that is not in the card's evidence. A view only re-arranges evidence and
  never adds new claims.

Text inside a view is labels: two to six words per cell or step, numbers with units. Sentences belong
in the body. Do not attach a view that repeats the facts grid (effort, confidence, risk), and do not
decorate. A view with nothing to compare is noise, and noise counts against the lens's precision.

## Evidence - rules per type

| type | `ref` | `quote` | Notes |
| --- | --- | --- | --- |
| `code` | `path:line`, repo-relative | **required**, one line copied verbatim | `verify` re-reads it. A wrong quote drops the card. |
| `doc` | `path:line` of an in-repo doc | **required**, verbatim | Same as code. |
| `git` | a commit id, or `path` with a short log summary | optional | For "changed in", "removed in" and ownership claims. |
| `ticket` | the `ref` `ingest-sources` returned | optional, a short phrase | Add `url`. Cite only refs this run ingested: `verify` drops any other (`ref-not-ingested:ticket:<ref>`). |
| `page` | the `ref` `ingest-sources` returned | optional, the contradicted sentence | Add `url`. Same ingested-only rule. |
| `goal` | the `ref` `ingest-sources` returned | optional | Add `url`. Same ingested-only rule. |
| `dep` | the `ref` `deps` returned: `<manifest or lockfile>#<package>@<version>` | optional, the advisory id | Cite only refs `deps` returned this run; `verify` drops any other. Pair it with a `code` quote of the manifest or lockfile line. |
| `sarif` | `<file>#<ruleId>@<location>` | optional | Only from a SARIF or CycloneDX file the runner supplied. |

- Quote **one line**, verbatim: copy it, do not retype it. Trim leading indentation only. Never
  paraphrase inside `quote`.
- Every claim in Description cites a ref that is present in `evidence`.
- A count claim ("12 tickets mention it") lists at least 3 of them as evidence and states the
  query that produced the count in Description.
- Prefer two evidence types over five refs of one type. A second type is what makes a
  rejected item able to resurface (see `triage.md`).

## Effort

`{size, days_low, days_high, basis}`: `basis` lists the `path#symbol` locations the estimate is
based on. Anchors:

| size | days | Typical shape |
| --- | --- | --- |
| XS | 0.25 - 0.5 | a copy change, one guard, a config flag |
| S | 0.5 - 2 | one module, an existing pattern, tests beside it |
| M | 2 - 5 | 2-4 modules, or a new UI state with its tests |
| L | 5 - 15 | a new surface, a migration, or cross-team work |
| XL | 15+ | an initiative: split it before proposing, or say why it cannot be split |

`days_low` and `days_high` sit inside the size's band. If you cannot name a `basis` location,
the estimate is a guess: drop `confidence` to `low`.

## Confidence

| value | Meaning |
| --- | --- |
| `high` | Two or more evidence types agree, and the code quote shows the mechanism directly. |
| `medium` | One evidence type with a verbatim quote, plus a plausible link to the user or goal. |
| `low` | Inferred, a source missing (unconnected), or an effort with no basis. |

`confidence_why` names the strongest evidence and the one thing that would raise it.

## Delivery risk

- `blast`: `low` for one module and no shared contract; `medium` for a shared module, a public
  API or a schema with a migration; `high` for auth, payments, data deletion or a persisted
  format.
- `bus_factor`: the number of distinct authors in the last 12 months on the anchor paths:
  `git log --since=12.months --format=%ae -- <paths> | sort -u | wc -l`. Include it only when
  you ran that command. Omit it otherwise.

## Rendering

`verbosity: short` (the default) renders as below. `full` adds the body's Summary and
Description under the rationale. Either way the full write-up is one "open <n>" away.

### Dev mode

```
[opportunity, M, confidence high] Export for reports that already have a CSV writer
  Customers ask for CSV export; the serializer exists but no route exposes it.
  evidence: src/export/csv.ts:41 "export function toCsv(rows: Row[]): string {"
            ticket SUP-118 (+11 more), goal G-7
  effort M 2-4d (src/export/csv.ts#toCsv, src/routes/reports.ts)  blast low  bus factor 1
  fp 3fa9c2d1e07b4a55
```

### Guided mode

```
1. Export for reports that already have a CSV writer
   Customers ask for CSV export. Most of the work is already built and only needs to be
   switched on for reports.
   Size: a few days (M)   How sure: high - customer requests and the code agree
   [show evidence]
```

"show evidence" expands to the evidence list in plain words: "Customer request SUP-118 and 11
more", "The code that writes CSV files (src/export/csv.ts, line 41)". No fingerprint is shown in
guided mode. Keep it, so ask-why can find the item.
