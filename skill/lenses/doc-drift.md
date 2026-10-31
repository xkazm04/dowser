---
id: doc-drift
version: 0.3.2
name: Doc drift
kinds: [contradicted-by-code, removed-still-documented, undocumented-change, stale-example, missing-doc]
sources: [code, docs, git, pages]
optional_sources: []
requires_connection: false
budget: 4
---
# Doc drift

## What it finds

Docs that current code or recent work contradicts: a guide that documents behaviour the code no
longer has, a removed feature still explained, a shipped change nobody wrote down, an example
that would fail if run. Example from the plan: "API guide still documents v1 auth, removed in
March". Doc drift is also where the loop closes: every shipped proposal changes docs, and this
lens catches the ones that did not change.

Unconnected, the lens runs `partial` on in-repo docs (README, `docs/`, code comments that serve
as docs) and reports Confluence pages as unchecked.

`skipped: no documentation found` only when the repo has no README, no docs folder, and no
Confluence pages were reachable.

## Direction

`context --lens doc-drift` may carry `direction`. Absent, run the pack as written.

- **`focus`** (topics). Gather them first: in step 1 list the docs whose path or headings name a
  focus term before the rest; in step 4 run the git log a second time on the paths those docs
  name; in step 6 add each focus term to the page query. At equal certainty and reader harm
  (see "Choosing under the budget"), a focus candidate ranks above one outside the focus. The
  rest of the repo is still read: focus orders the work, it does not hide a first-run break.
- **`exclude`** (topics). Before writing `<work>/doc-drift.jsonl`, remove every candidate whose
  `topic`, documented subject or primary doc matches an excluded term. Removed candidates are
  not reserved: list them in the lens report as `excluded by direction: <topic> (<term>)`.
  Never drop one silently.
- **`notes`** (the team's intent). Read them as part of this pack. They may move a doc between
  reader-harm tiers ("integrators first" lifts the API reference to tier 1; "the admin guide is
  frozen" drops it to tier 3). Say in `confidence_why` when a note changed a card's rank.
- **`spaces`** (Confluence space keys). They replace the unscoped page search; see Sources.

## Sources

- **Pages, per space.** Connected and `direction.spaces` set: for each space key, call
  `dowser_sources_pages` with `{query: "<product name> OR <top module names>", space: "<key>"}`,
  then once more per removed or renamed symbol from step 4 (at most 3 per space). Save each
  response verbatim to `<work>/doc-drift-page-<key>[-<n>].json` and run
  `ingest-sources --run <run_id> --type page --file <that file>`. Search no space outside the
  list. Without `spaces`, make the same calls once without `space` (or with the space the
  runner named). A space that errors is a gap: `partial: space <key> unreachable`. A space that
  answers with no pages is `ran`, and the report says `<key>: 0 pages`.
- **Cite only ingested refs.** A `page` ref is a `ref` that `ingest-sources` returned this run.
  `verify` drops any other (`ref-not-ingested:page:<ref>`). Quote the contradicted sentence from
  the page `body` in the saved response. The page's `updated_at` against the date of the code
  change is evidence of staleness: state both dates in Description.
- **Unconnected.** No page calls, no page evidence. The report names Confluence as unchecked.

## Gather

1. **In-repo docs.** `git ls-files "*.md" "*.mdx" "*.rst" "*.adoc" "docs/**" "README*" "CHANGELOG*" "openapi*.{yaml,yml,json}" ':!*fixtures/*' ':!*tests/*' ':!*test/*'`.
   Test and fixture folders are sample input, not docs (a fixture's README describes a fake
   product). Tag each doc with a reader-harm tier now (see "Choosing under the budget").
2. **Claims that can be checked.** In each doc, collect statements that name a concrete thing:
   commands and flags (lines in code fences starting with `$`, `npm`, `npx`, `curl`, the
   product's CLI name), endpoints (`GET /`, `POST /`), config keys and env vars (`[A-Z][A-Z0-9_]{3,}`),
   function and option names in backticks, version numbers, defaults ("defaults to"), limits.
3. **Check each claim against code.** `git grep -n -F "<name>"` for the flag, env var, route or
   symbol outside docs (`-- ':!*.md' ':!docs/**'`). Zero hits for a named thing is a lead. A hit
   with a different default or signature is a lead.
4. **Recent changes nobody documented (git).**
   `git log --since=120.days --format="%h %ad %s" --date=short -- ':!*.md' ':!docs/**' | head -60`
   and `git log --since=120.days --diff-filter=D --name-only --format="%h %s"` (deleted files).
   For removed or renamed symbols, grep the docs for the old name. For a new flag, route, env var
   or config key, grep the docs for it (H3). On an incremental run, start from the changed files.
5. **Examples.** Code blocks in docs that call the product's API or CLI: compare the arguments,
   field names and imports with the current signature, route handler or `--help` output (a
   read-only run is allowed if the CLI is already built; never install or build to check).
6. **Confluence pages (connected).** As in Sources. Check page claims the same way as steps 2-5.
7. **Disconfirm every lead.** Before a lead becomes a candidate, look for the reason it is not
   drift, and record which check cleared or confirmed it:
   - **Still-supported path.** The documented flag, header, route or option is still read
     through an alias, a compat shim, a deprecation branch, a fallback (`?? old`, `|| legacy`) or
     a version switch. A doc for a path the code still accepts is correct, even when a newer
     path exists. At most it lacks a deprecation note, which is not drift.
   - **Scoped doc.** The doc says which version, platform or edition it covers ("for 1.x",
     "self-hosted only"), and that one still ships.
   - **Historical doc.** CHANGELOG entries, release notes, ADRs and migration guides describe
     the past on purpose. An old name there is not drift.
   - **Override.** A config file, env default or deployment manifest sets the documented value.
   - **Generated or vendored doc.** Fix the generator or skip it.
   A lead that a check clears is not proposed; count it in the report under `cleared`.
   Record steps that found nothing and go on.

## Hypotheses

- **H1 Contradicted:** a doc states a default, signature, limit or behaviour that the code
  now does differently. Kind: `contradicted-by-code`.
- **H2 Ghost feature:** a doc explains a command, endpoint, option or env var that no longer
  exists in code. Kind: `removed-still-documented`.
- **H3 Silent change:** a change in the last 120 days added or changed user-visible behaviour
  (a new flag, route or config key) that no doc mentions. Kind: `undocumented-change`.
- **H4 Broken example:** a doc example would fail against today's code (wrong arguments, renamed
  import, removed field). Kind: `stale-example`.
- **H5 Undocumented surface:** a public entry point (an exported API, a CLI command, a route used
  by clients) has no doc at all, and tickets or pages show people asking how to use it. Kind:
  `missing-doc`.

## Choosing under the budget

Rank every surviving candidate by **reader harm**, then **certainty**, and write each one: the
store ranks by score (4 per lens first, top card = MVP; free run slots go to the best of any
lens) and files the rest in `reserve`. Harm reaches it as `impact`, certainty as `confidence`.

- **Reader harm.** Tier 1: the first-run path - README install and quickstart, getting started,
  auth setup, the first example a new user copies. Tier 2: reference read in daily work -
  configuration, API and CLI reference, admin guides. Tier 3: rarely read - contributor notes,
  internal design docs, archived or deep pages. A drift that makes a documented step fail
  (an error, a 4xx, a rejected flag) ranks above one that only misleads, inside its tier.
- **Certainty.** `sure`: both sides quoted, they cannot both be true, and no step 7 check
  applies. `likely`: one side is inferred (a zero-hit grep, a page dated before the change).
  A lead that is neither is not proposed.
- **Order.** Tier 1 sure, tier 2 sure, tier 1 likely, tier 2 likely, tier 3 sure, tier 3
  likely. At a tie, `direction.focus` first, then the claim with more copies in `doc_impact`.
- **One card per doc subject.** Claims on the same documented thing with one fix (one table of
  defaults, one example) are one card with a row each in the view. Distinct subjects are
  distinct cards, even in one file.
- Never cut a candidate yourself: the store decides ranked or `reserve`, and the run summary
  names the reserve in its "top N of M" line.

## Impact, risk and the predicted verdict

Set `impact` (1-10) from the reader-harm tier, with `impact_why` naming the tier and the harm in
one line ("first-run: step 3 fails with an unknown flag"):

| Reader harm | A documented step fails | Only misleads |
| --- | --- | --- |
| Tier 1 (first run) | 8 | 6 |
| Tier 2 (daily reference) | 6 | 4 |
| Tier 3 (rarely read) | 3 | 2 |

Certainty sets `confidence`, not impact: `sure` is medium or high, `likely` is low. `risk` is the
risk of making the change (a doc edit 2; a doc edit that needs a code or release change 5);
omit it and the store reads `delivery_risk.blast`. `category` is `technical` (the default for
this lens); set `product` when the drift misleads users about what the product does (a technical card may move to product, never the reverse). Every card carries your `predicted_verdict` (`accept`, `reject` or `defer`) and a
`predicted_why`, after reading `context`'s `near` (reasons, notes) and `outcomes` (notes). With
a precedent, quote it ("typo-level fixes were rejected as not-worth-it"); without one, give
your own reason (`references/cards.md`).

## Evidence rules

- Always a pair: the doc line (`doc`, quoted verbatim, or a `page` ref with the contradicted
  sentence as `quote`) **and** the code line that contradicts it (`code`, quoted). H2 cites the
  empty search instead of a code line: state the exact grep and its zero result in Description,
  and add the `git` ref of the commit that removed it when you found one.
- H3 cites the `git` change and the `code` line it added, and states the doc search that found
  nothing.
- Description names the step 7 checks you ran and what each found ("no alias in
  `src/cli/args.ts`, no override in `config/`"). `confidence: high` only for `sure`.
- `doc_impact` lists every doc and page that must change. For this lens it is never omitted.
- Do not propose prose style fixes. Only factual drift counts.

## Artifacts

One view serves this lens: the **"doc says / code does" table** (`table`), both sides of the
contradiction with their places, so triage can check the claim without opening files.

- **Attach** to every `contradicted-by-code` and `stale-example` card, and to a
  `removed-still-documented` card when two or more docs or pages still name the ghost.
- **One claim:** `columns: ["Side", "Place", "Says"]`, one row per place: each doc or page copy,
  then the code line (and the removal commit for H2). `highlight` the doc rows that are wrong.
- **Several claims in one card:** `columns: ["Claim", "Doc says", "Code does"]`, one row per
  claim, with `refs` covering both sides of every row.
- `refs` are the card's own `doc`, `page`, `code` and `git` refs the rows were drawn from. Cells
  are labels (`50 MB default`, `X-Api-Key header`), never sentences.
- **No view** for `undocumented-change` and `missing-doc` (one side is absence; the body says it),
  nor for an H2 with a single doc line. Never a second view that repeats the first.

## Topic naming

`<doc-subject>-<drift>` in kebab case, naming the documented thing: `api-auth-v1-docs`,
`cli-export-flag-docs`, `env-max-upload-default-docs`, `quickstart-example-imports`. Keep the
same topic when the same doc subject drifts again.

## Examples

Read `<skill-dir>/references/examples/doc-drift.md` before the first card (an H2 with no view,
an H1 with the table). In the jsonl each card is one line.

## No finding

```
doc-drift: ran|partial (pages not connected: Confluence unchecked | space <key> unreachable) - no proposals.
Checked: <n> docs, <m> concrete claims checked against code (H1/H2); <k> changes in 120 days
checked for docs (H3); <j> examples compared (H4); H5 <...>. Pages: <key>: <p> pages, ...
Cleared by step 7: <c> leads (<check>: <doc>). Excluded by direction: <topics or none>.
```
