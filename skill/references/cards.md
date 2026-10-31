# The card - one shape for every proposal

Every proposal is one JSON line in the `dowser-proposal/2` shape (`schema/dowser-proposal-2.schema.json`;
the scan-finding/1 fields of `docs/contracts/scan-finding-1.md`). You write the candidate fields
below. `dowser.mjs` computes `fp` and owns every triage field (`status`, `reason`, `note`,
`merged_into`, `external_ref`, `external_url`, `decided_by`, `decided_at`) and every computed
field (`score`, `score_parts`, `band`, `mvp`, `mvp_rule`, `mvp_why`, `predicted_by`,
`pretriaged_by`). Never write those yourself: a line that carries one is refused.

**Absent values: omit the key.** Never write `null`. Never write `0` or `""` for something you
did not measure.

## Fields you write

| Field | Rule |
| --- | --- |
| `lens` | `opportunity`, `ux-friction`, `doc-drift` or `security-cra` |
| `kind` | One value from the lens pack's `kinds`. Pick the closest one; never invent a new one. |
| `topic` | Stable kebab noun phrase for the capability or defect, from the pack's naming rule. Reuse a `near` item's topic (and anchors) when it is the same work; `near` lists accepted items too. |
| `anchors` | `path#symbol` or `path` (repo-relative, forward slashes). **No line numbers, no wording.** 1-4 anchors: the places the work lands. |
| `title` | 80 characters or fewer, in product language. See the title rules below. |
| `rationale` | At most 3 sentences: why this, why now, for whom. No file paths in guided-facing text. |
| `body` | Markdown with exactly the five `## ` sections below, in order. |
| `evidence` | 1 or more `{type, ref, quote?, url?}`. The rules per type are below. |
| `effort` | `{size, days_low, days_high, basis}`. See the anchors below. |
| `confidence` | `low`, `medium` or `high`. |
| `confidence_why` | One sentence: what makes it this strong, and what would raise it. |
| `doc_impact` | Docs or pages that must change when it ships (repo paths or page refs). Omit the key if none; do not write `[]` for "not checked". |
| `delivery_risk` | `{blast: low|medium|high}`. Leave `bus_factor` out: the store measures it at `verify` (below). |
| `provenance` | `{lens_version, model, harness, focus?}`: the pack's `version`, your model id, the harness, and `focus` on a focused run. You may omit `run_id`: `propose` stamps it from `--run`, and overwrites a different one with a `note`. |
| `impact` | 1-10, from the lens pack's "Impact" table: defects, how bad if left (10 = data loss, breach, an outage on a main path); opportunities, the value if done. Omit it only when you cannot judge it: the card is then **unscored** and ranks after every scored card. |
| `impact_why` | One line, at most 200 characters: the reason for the number. Required with `impact`. |
| `risk` | 1-10, the risk of **making the change** (blast radius x irreversibility), never the severity. Omit it and the store reads `delivery_risk.blast` (low 2, medium 5, high 8). When you set both, they agree (see "Delivery risk"). |
| `category` | `technical` (the codebase's own quality) or `product` (what users get). Omit it for the lens default: doc-drift and security-cra `technical`, opportunity and ux-friction `product`. You may move a card `technical` -> `product`, never `product` -> `technical`: category picks the trust slice and technical slices start at L1, so the store stores a product lens's card as `product` whatever the line says and reports `clamped: {category: {asked, stored}}` on the propose line (counted as `clamped` in the summary). |
| `predicted_verdict` | **Required on every card.** `accept`, `reject` or `defer`: your verdict as the lens judge, what you expect the person to decide, before they see it. Read `context`'s `near` (reasons and notes) and `outcomes` (notes) first. Having no precedent is no reason to leave it out: judge the card on its own evidence. `defer` is a verdict too (the person must weigh something the evidence cannot), never a placeholder. The store records yours as given and never replaces it; a line without one is flagged `no-predicted-verdict` and gets the precedent's decision or `defer`, which trust cannot act on. |
| `predicted_why` | **Required with the verdict**, at most 300 characters: the reason. When `near` or `outcomes` holds a precedent, quote it by title and fp with its decision ("Closest precedent \"Rotate the mail API key\" (0e93b7a6c15d2f84) accepted: ..."). Without one, say so and give your own reason ("No similar decision in near or outcomes. A high advisory on a public path is rarely turned down."). When your text names no precedent (no fp, not the found one's title), the store appends the one it found: as `closest precedent` when its decision matches your verdict, as `counter-precedent` when it contradicts it (a snoozed item on a predicted `accept`). A precedent you named is kept as written; nothing is appended. |

`effort` may also carry `score` (1-10); omit it and the store maps `size` (XS 1, S 2, M 4, L 7,
XL 10). From impact, confidence, effort and risk the store computes `score` (`scan-score/1`,
`lib/scan-score.mjs`) with its breakdown `score_parts`, and at `verify` it allocates the run's
slots (`band` ranked or reserve, `mvp` on each lens's top card). You never rank by cutting: write
every card the pack says to write.

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
  paraphrase inside `quote`. `verify` looks for the quote as a whitespace-normalized substring of
  the file (near the `:line` you give, else anywhere in it), so:
  - **A fragment** of a long line is fine: copy a contiguous run of it, at least the part that
    carries the claim (`const stripeKey = '` for a secret, the clause of a long sentence). Never
    join pieces from two places with `...`.
  - **A JSDoc or block-comment line** (` * Returns null when ...`): quote the text after the
    ` * ` prefix, or the line with it; never two comment lines joined, because the `*` of the
    second line sits between them in the file.
  - **An absence** (no route, no doc, no `SECURITY.md`) has no line to quote. Do not invent one:
    state the exact search and its empty result in Description, and quote the nearest real line
    that shows the place (the file that would hold it, the caller that lacks it).
  - Point `:line` at the line you quoted. `verify` reports the line it found the quote on
    (`line`, with your hint as `claimed_line` when they differ) and flags `drift` when the hint
    is more than 3 lines off.
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
- `risk` and `blast` are one scale: the store reads a missing `risk` as low 2, medium 5, high 8,
  and the packs' risk anchors (a doc or copy edit 2, a new route, step or minor bump 5, a change
  to auth, billing, consent or a major bump 8) are those same values. A `risk` you set falls in
  its blast's band: 1-3 `low`, 4-6 `medium`, 7-10 `high`. When they disagree, fix the one you
  judged less carefully; never leave a `risk` 5 on a `blast` `high` card.
- `bus_factor`: **leave it out; the store measures it.** At `verify` it counts the distinct
  author e-mails of the non-merge commits that touched the card's anchor paths in the **90 days
  before the run's head commit**, and writes that into `delivery_risk.bus_factor` (a measured
  value wins over any the card carried). 90 days is the window of `dowser areas`
  (`authors_90d`, the Map's "Authors 90d" and its bus-factor flag), so a card and the area it
  lands in report the same count from the same git pass. With no commit in the window on the
  anchors, the card has no bus factor (not measured, never 0).

## Rendering

`verbosity: short` (the default) renders as below. `full` adds the body's Summary and
Description under the rationale. Either way the full write-up is one "open <n>" away.

### Dev mode

```
[opportunity, MVP, score 56.9, M, confidence high] Export for reports that already have a CSV writer
  Customers ask for CSV export; the serializer exists but no route exposes it.
  impact 7/10 - 14 tickets in 90 days ask for it   predicted accept (an export card was accepted)
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
   Worth: 7 of 10 - 14 customers asked in three months   Top pick for Opportunity
   [show evidence]
```

A card without `impact` shows "unscored" (dev) or "Worth: not judged" (guided), never 0. A card
in reserve is listed by title only, under "also found" (`references/guided-mode.md`).

"show evidence" expands to the evidence list in plain words: "Customer request SUP-118 and 11
more", "The code that writes CSV files (src/export/csv.ts, line 41)". No fingerprint is shown in
guided mode. Keep it, so ask-why can find the item.
