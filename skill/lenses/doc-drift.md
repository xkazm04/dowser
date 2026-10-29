---
id: doc-drift
version: 0.2.0
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
  not truncated: list them in the lens report as `excluded by direction: <topic> (<term>)`.
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

1. **In-repo docs.** `git ls-files "*.md" "*.mdx" "*.rst" "*.adoc" "docs/**" "README*" "CHANGELOG*" "openapi*.{yaml,yml,json}"`.
   Tag each doc with a reader-harm tier now (see "Choosing under the budget").
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

Rank every surviving candidate by **reader harm**, then **certainty**. Write the top 4.

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
- Candidates past 4 are truncated; keep their titles for the "top 4 of M" line.

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

One view kind serves this lens: the **"doc says / code does" table** (`table`). It shows the two
sides of the contradiction next to each other, each with its place, so triage can check the
claim without opening files.

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

The first line is an H2 with one doc line, so it carries no view. The second is an H1 with three
places, so it carries the table.

```jsonl
{"lens":"doc-drift","kind":"removed-still-documented","topic":"api-auth-v1-docs","anchors":["docs/api/authentication.md","src/auth/index.ts"],"title":"API guide still teaches the login method that was removed in March","rationale":"The API guide tells integrators to sign requests with v1 API keys. That path was removed and only OAuth tokens work now. New integrators follow the guide and fail on their first call.","body":"## Summary\nRewrite the API authentication guide for OAuth tokens and remove the v1 key instructions.\n\n## Description\nThe guide says to send `X-Api-Key` (`docs/api/authentication.md:12`). The auth module now only reads bearer tokens (`src/auth/index.ts:19`); `git grep -n X-Api-Key -- ':!docs/**'` returns nothing, and commit 4be91c2 removed `apiKeyAuth`. Checks: no alias or fallback header in `src/auth/`, the guide is not version-scoped. Done means the guide shows the OAuth flow with a working curl example.\n\n## Flow\n- integrator reads the API guide\n- sends X-Api-Key as documented\n- server answers 401 with no hint about OAuth\n\n## Expected impact\nIntegrators succeed on the first call; auth-related support questions drop. Low risk: docs only.\n\n## Evaluation\nClaim: docs - the guide matches the only auth path the code accepts\nBefore: 1 documented header the code never reads; 0 OAuth examples in the guide\nAfter: 0 documented headers the code does not read; 1 working OAuth example\nMethod: count - grep for the documented header outside docs, plus the removal commit\nFalsified if: a gateway in front of the service still accepts X-Api-Key","evidence":[{"type":"doc","ref":"docs/api/authentication.md:12","quote":"Send your key in the `X-Api-Key` header with every request."},{"type":"code","ref":"src/auth/index.ts:19","quote":"const token = req.headers.authorization?.replace('Bearer ', '');"},{"type":"git","ref":"4be91c2","quote":"remove apiKeyAuth (v1)"}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/api/authentication.md"]},"confidence":"high","confidence_why":"Sure, tier 1: the doc line, the code line and the removal commit agree, and no fallback reads the old header.","doc_impact":["docs/api/authentication.md","README.md"],"delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"claude-code"}}
{"lens":"doc-drift","kind":"contradicted-by-code","topic":"env-max-upload-default-docs","anchors":["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"],"title":"Configuration guide and admin page state the wrong upload size limit","rationale":"The guide and the Confluence admin page say uploads default to 50 MB, but the code caps them at 10 MB. Admins plan around the wrong number and users hit a limit nobody told them about.","body":"## Summary\nCorrect the documented default for MAX_UPLOAD_MB from 50 to 10 in both places, or decide which number is intended.\n\n## Description\n`docs/configuration.md:44` and Confluence page 48213 (Admin guide, edited 2026-02-03) document a 50 MB default. `src/config/limits.ts:7` sets 10, since commit 91d0a7e (`lower upload cap`, 2026-03-11). Checks: no override in `config/` or the deployment manifests, the guide is not version-scoped. Done means doc, page and code state one number, and the doc says how to raise it.\n\n## Flow\n- admin reads the configuration guide and leaves the default\n- user uploads a 30 MB file\n- upload fails at 10 MB, which no doc mentions\n\n## Expected impact\nAdmins set the limit knowingly; fewer surprise upload failures. If 50 was the intended value, the fix is in code and the blast radius grows.\n\n## Evaluation\nClaim: docs - documented default equals the code default\nBefore: doc 50 MB, page 50 MB, code 10 MB\nAfter: all three state the same value\nMethod: quote - the three lines read, plus the commit that changed the code\nFalsified if: a deployment config overrides the code default to 50 everywhere","evidence":[{"type":"doc","ref":"docs/configuration.md:44","quote":"| `MAX_UPLOAD_MB` | `50` | Largest accepted upload. |"},{"type":"page","ref":"48213","quote":"Uploads are limited to 50 MB unless MAX_UPLOAD_MB is set.","url":"https://acme.atlassian.net/wiki/spaces/ADM/pages/48213"},{"type":"code","ref":"src/config/limits.ts:7","quote":"export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 10);"},{"type":"git","ref":"91d0a7e","quote":"lower upload cap"}],"artifacts":[{"kind":"table","message":"The guide and the admin page say 50 MB; the code enforces 10 MB","alt":"Table of three places that state the MAX_UPLOAD_MB default: the configuration guide says 50 MB, Confluence page 48213 says 50 MB, src/config/limits.ts sets 10 MB since commit 91d0a7e.","refs":["docs/configuration.md:44","48213","src/config/limits.ts:7","91d0a7e"],"data":{"columns":["Side","Place","Says"],"rows":[["doc","docs/configuration.md:44","50 MB default"],["page","Admin guide (48213)","50 MB default"],["code","src/config/limits.ts:7","10 MB default"],["git","91d0a7e","lowered to 10 MB"]],"highlight":[0,1]}}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"]},"confidence":"high","confidence_why":"Sure, tier 2: all values are quoted verbatim and no override was found; the page predates the code change.","doc_impact":["docs/configuration.md","Confluence 48213 Admin guide"],"delivery_risk":{"blast":"low","bus_factor":2},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"claude-code"}}
```

## No finding

```
doc-drift: ran|partial (pages not connected: Confluence unchecked | space <key> unreachable) - no proposals.
Checked: <n> docs, <m> concrete claims checked against code (H1/H2); <k> changes in 120 days
checked for docs (H3); <j> examples compared (H4); H5 <...>. Pages: <key>: <p> pages, ...
Cleared by step 7: <c> leads (<check>: <doc>). Excluded by direction: <topics or none>.
```
