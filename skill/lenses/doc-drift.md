---
id: doc-drift
version: 0.1.0
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

## Gather

1. **In-repo docs.** `git ls-files "*.md" "*.mdx" "*.rst" "*.adoc" "docs/**" "README*" "CHANGELOG*" "openapi*.{yaml,yml,json}"`.
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
   For removed or renamed symbols, grep the docs for the old name. On an incremental run, start
   from the changed files.
5. **Examples.** Code blocks in docs that call the product's API or CLI: compare the arguments
   with the current signature or `--help` output (a read-only run is allowed if the CLI is
   already built; never install or build to check).
6. **Confluence pages (connected).** Call `dowser_sources_pages` with
   `{query: "<product name> OR <top module names>"}` and, when the runner named a space,
   `space`. Run one query per removed or renamed symbol from step 4. Then
   `ingest-sources --type page`.

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

## Evidence rules

- Always a pair: the doc line (`doc`, quoted verbatim, or a `page` ref with the contradicted
  sentence as `quote`) **and** the code line that contradicts it (`code`, quoted). H2 cites the
  empty search instead of a code line: state the exact grep and its zero result in Description,
  and add the `git` ref of the commit that removed it when you found one.
- H3 cites the `git` change and the `code` line it added, and states the doc search that found
  nothing.
- `doc_impact` lists every doc and page that must change. For this lens it is never omitted.
- Do not propose prose style fixes. Only factual drift counts.

## Topic naming

`<doc-subject>-<drift>` in kebab case, naming the documented thing: `api-auth-v1-docs`,
`cli-export-flag-docs`, `env-max-upload-default-docs`, `quickstart-example-imports`. Keep the
same topic when the same doc subject drifts again.

## Examples

```jsonl
{"lens":"doc-drift","kind":"removed-still-documented","topic":"api-auth-v1-docs","anchors":["docs/api/authentication.md","src/auth/index.ts"],"title":"API guide still teaches the login method that was removed in March","rationale":"The API guide tells integrators to sign requests with v1 API keys. That path was removed and only OAuth tokens work now. New integrators follow the guide and fail on their first call.","body":"## Summary\nRewrite the API authentication guide for OAuth tokens and remove the v1 key instructions.\n\n## Description\nThe guide says to send `X-Api-Key` (`docs/api/authentication.md:12`). The auth module now only reads bearer tokens (`src/auth/index.ts:19`); `git grep -n X-Api-Key -- ':!docs/**'` returns nothing, and commit 4be91c2 removed `apiKeyAuth`. Done means the guide shows the OAuth flow with a working curl example.\n\n## Flow\n- integrator reads the API guide\n- sends X-Api-Key as documented\n- server answers 401 with no hint about OAuth\n\n## Expected impact\nIntegrators succeed on the first call; auth-related support questions drop. Low risk: docs only.\n\n## Evaluation\nClaim: docs - the guide matches the only auth path the code accepts\nBefore: 1 documented header the code never reads; 0 OAuth examples in the guide\nAfter: 0 documented headers the code does not read; 1 working OAuth example\nMethod: count - grep for the documented header outside docs, plus the removal commit\nFalsified if: a gateway in front of the service still accepts X-Api-Key","evidence":[{"type":"doc","ref":"docs/api/authentication.md:12","quote":"Send your key in the `X-Api-Key` header with every request."},{"type":"code","ref":"src/auth/index.ts:19","quote":"const token = req.headers.authorization?.replace('Bearer ', '');"},{"type":"git","ref":"4be91c2","quote":"remove apiKeyAuth (v1)"}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/api/authentication.md"]},"confidence":"high","confidence_why":"The doc line, the code line and the removal commit agree; a Confluence copy of the guide would widen the doc impact.","doc_impact":["docs/api/authentication.md","README.md"],"delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code"}}
{"lens":"doc-drift","kind":"contradicted-by-code","topic":"env-max-upload-default-docs","anchors":["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"],"title":"Configuration guide states the wrong upload size limit","rationale":"The guide says uploads default to 50 MB, but the code caps them at 10 MB. Admins plan around the wrong number and users hit a limit nobody told them about.","body":"## Summary\nCorrect the documented default for MAX_UPLOAD_MB from 50 to 10, or decide which number is intended.\n\n## Description\n`docs/configuration.md:44` documents a 50 MB default. `src/config/limits.ts:7` sets 10. The change came with commit 91d0a7e (`lower upload cap`). Done means doc and code state one number, and the doc says how to raise it.\n\n## Flow\n- admin reads the configuration guide and leaves the default\n- user uploads a 30 MB file\n- upload fails at 10 MB, which no doc mentions\n\n## Expected impact\nAdmins set the limit knowingly; fewer surprise upload failures. If 50 was the intended value, the fix is in code and the blast radius grows.\n\n## Evaluation\nClaim: docs - documented default equals the code default\nBefore: doc 50 MB, code 10 MB\nAfter: both state the same value\nMethod: quote - both lines read, plus the commit that changed the code\nFalsified if: a deployment config overrides the code default to 50 everywhere","evidence":[{"type":"doc","ref":"docs/configuration.md:44","quote":"| `MAX_UPLOAD_MB` | `50` | Largest accepted upload. |"},{"type":"code","ref":"src/config/limits.ts:7","quote":"export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 10);"},{"type":"git","ref":"91d0a7e","quote":"lower upload cap"}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"]},"confidence":"high","confidence_why":"Both values are quoted verbatim; a check of deployment configs would rule out an override.","doc_impact":["docs/configuration.md"],"delivery_risk":{"blast":"low","bus_factor":2},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code"}}
```

## No finding

```
doc-drift: ran|partial (pages not connected: Confluence unchecked) - no proposals.
Checked: <n> docs, <m> concrete claims checked against code (H1/H2); <k> changes in 120 days
checked for docs (H3); <j> examples compared (H4); H5 <...>.
```

Changelog: 0.1.0 - first pack.
