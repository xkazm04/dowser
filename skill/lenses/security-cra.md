---
id: security-cra
version: 0.3.0
name: Security and CRA
kinds: [vulnerable-dependency, risky-pattern, secret-exposure, vulnerability-handling-gap, sbom-gap, update-mechanism-gap]
sources: [code, docs, git, deps, sarif]
optional_sources: [sarif]
requires_connection: false
budget: 4
---
# Security and CRA

## What it finds

Vulnerabilities and risky patterns in the code and its dependencies, and gaps against the EU
Cyber Resilience Act (CRA) obligations that apply to products with digital elements. Example
from the plan: "Exploitable dependency in billing service; CRA reporting applies".

**CRA items are product proposals, never legal advice.** Phrase them as work that would help
the team meet an obligation ("Add a published way to report vulnerabilities"). Never phrase
them as a verdict ("You are non-compliant"). Every CRA card says in Description: "Whether and
how the CRA applies to this product is for your compliance owner to confirm." Facts to rely
on: manufacturers' reporting obligations for actively exploited vulnerabilities and severe
incidents apply from 11 September 2026; the remaining obligations apply from 11 December 2027.
They include vulnerability handling, an SBOM, security updates and a coordinated disclosure
policy.

The lens does not restate findings a deterministic tool already owns. If the repo runs a
scanner in CI, or the runner supplies its SARIF or CycloneDX output, cite that output, and
propose the work it implies, not the finding again.

## Direction

`context.direction` absent: everything below applies unchanged.

- **`focus`** maps each entry to hypotheses by its words: package, dependency, advisory, supply
  chain -> H1; injection, input, XSS, SQL, shell -> H2; secret, key, credential -> H3; CRA,
  compliance, disclosure, SBOM, update -> H4-H6. An entry that names a path or component limits
  gather steps 5-6 to it (`git grep ... -- <path>`) and H1 to packages imported there. Run the
  focused steps first. A focused candidate's `impact` is one above what its rank alone gives
  (at most 10), so it wins the store's slots at equal rank; off-focus candidates are still
  written and take any slot their score earns, the rest landing in `reserve`. Focus orders, it
  never hides a real finding.
- **`exclude`** removes, before the jsonl is written, every candidate whose topic, package,
  anchor path or hypothesis matches an entry (case-insensitive). Name each one in the summary as
  `excluded by direction: <topic> (rank <n>)`. Never drop one silently, and say so plainly when
  an excluded item is rank 1.
- **`notes`** is the team's intent and moves ranks, never evidence rules. "SaaS only, nothing
  installed by customers" lowers H5 and H6; "we sell in the EU" raises H4-H6; "the admin CLI is
  internal" confirms operator-only exposure. Notes never turn a skipped auditor into "clean".

## Gather

1. **Manifests and lockfiles.** `git ls-files` for `package.json`, `package-lock.json`,
   `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `pyproject.toml`, `poetry.lock`,
   `Pipfile.lock`, `go.mod`, `Cargo.lock`, `pom.xml`, `build.gradle*`, `Gemfile.lock`,
   `composer.lock`, `*.csproj`, `packages.lock.json`. Note each ecosystem, whether it has a
   lockfile, and the directory it sits in.
2. **Advisories: `deps --run <run_id>`.** This is the lens's only dependency source. It audits
   the root and every manifest directory up to three levels below it (an `auditors` entry below
   the root carries `dir`). Each `ref` is `<lockfile path>#<package>@<version>`; its `title` is
   `<advisory> <severity>`, and it carries `url` and, when the auditor knows it, `fixed_in`.
   Every `skipped` auditor makes the lens `partial: <tool> skipped (<reason>)`. An ecosystem no
   auditor ran on, a directory in `not_audited` (test or fixture paths, past the cap) or a
   manifest deeper than three levels leaves H1 unchecked there, and the report says which. Never run an
   auditor yourself, never install, never guess CVEs from memory.
3. **Scope and reach of each dep ref.** Dev-only: in `package-lock.json` the entry
   `"node_modules/<pkg>"` carries `"dev": true` (`git grep -n -A6 '"node_modules/<pkg>"' -- package-lock.json`),
   or the package sits under `devDependencies`, `requirements-dev*.txt` or a poetry dev group.
   Transitive: find the parent with `git grep -n '"<pkg>"' -- package-lock.json`. Import sites:
   `git grep -n -E "(require\(|from |import )['\"]<pkg or parent>['\"/]" -- . ":!test" ":!tests" ":!**/*.test.*"`.
   Follow each import site to its entry point (route, upload, webhook, CLI argv, job) and give it
   an exposure class (Ranking).
4. **Runner-supplied reports (optional).** If the runner names a SARIF (`*.sarif`) or CycloneDX
   (`bom.json`, `*.cdx.json`) file, read it and cite entries as `sarif` evidence. `dep` evidence
   is only what `deps` returned this run.
5. **Secrets.** `git grep -n -I -E "(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*['\"][A-Za-z0-9/+_\-]{12,}['\"]|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}"`.
   Also `git ls-files "*.env" "*.pem" "*.key" "*.p12"`. Never print or store a secret. Quote
   only the part of the line before the value, for example `const stripeKey = '`. `verify`
   matches a substring of the line, so the shortened quote still verifies. A hit in `test/`,
   fixtures, `*.example`, `*.sample` or docs, or a documented placeholder or test-mode key, is
   class E0: record it, no card.
6. **Risky patterns.** `git grep -n -E "eval\(|new Function\(|child_process|exec(Sync)?\(|shell=True|os\.system|innerHTML|dangerouslySetInnerHTML|v-html|SELECT .*\+|\$\{.*\}.*(WHERE|where)|pickle\.loads|yaml\.load\(|verify ?= ?False|rejectUnauthorized: ?false|Math\.random\(\).*(token|id|secret)"`.
   For each hit, read where its input comes from and give it an exposure class.
7. **CRA surface (docs and repo).** `SECURITY.md`, `.well-known/security.txt`, a
   vulnerability-disclosure section in README or docs, `CHANGELOG*` with security entries, an
   SBOM step in CI (`.github/workflows/*`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`: grep
   `cyclonedx|syft|spdx|sbom`), dependency update automation (`.github/dependabot.yml`,
   `renovate.json`), and the release or update mechanism (auto-update code, a versioned release
   process). For each obligation record in place / partial / missing with a `path:line` or the
   search that found nothing: this is the matrix source.
8. **History.** `git log --since=12.months --format="%h %ad %s" --date=short | grep -i -E "security|cve|vuln|xss|inject"`
   shows how the team handles fixes. It informs the vulnerability-handling hypothesis.

Record what could not run (an auditor skipped, no lockfile, a nested manifest) and go on.

## Hypotheses

- **H1 Known-vulnerable dependency:** `deps` lists a package at critical or high that ships
  (not dev-only), or at moderate when user input from the network reaches it. Kind:
  `vulnerable-dependency`.
- **H2 Injectable sink:** user-controlled input reaches eval, a shell, SQL, HTML or a
  deserializer without validation. Kind: `risky-pattern`.
- **H3 Secret in the tree:** a live credential, key or token is committed in a shipped or
  deployed file. Kind: `secret-exposure`.
- **H4 No way to report or handle vulnerabilities:** no `SECURITY.md` or `security.txt`, no
  disclosure contact, no recorded process for triaging reports. This bears on CRA reporting from
  11 September 2026. Kind: `vulnerability-handling-gap`.
- **H5 No SBOM:** no step produces a software bill of materials for releases. Kind: `sbom-gap`.
- **H6 No security update path:** the product has no way to ship security fixes to users
  separately or promptly (no versioned releases, no update mechanism, no dependency update
  automation). Kind: `update-mechanism-gap`.

## Ranking - choosing under the budget

Exposure class of a dependency or sink: **E3** unauthenticated network input (request, upload,
webhook, URL) reaches it; **E2** an authenticated user's input, or code shipped to clients;
**E1** operator only (admin CLI argv, env, build or cron config); **E0** not shipped (dev-only
package, tests, fixtures, examples, docs). E0 is never a card. Severity is the word in the
`deps` title, never your impression; `unknown` (pip-audit) ranks as moderate and says so.

1. H3 live secret in a shipped or deployed file.
2. H1 critical/high at E3; H2 at E3.
3. H4, when a `doc` or `code` line shows the product ships to users (reporting duty in force).
4. H1 critical/high at E2 or E1, or shipped with no import path found; H2 at E2.
5. H6, then H5 (December 2027 obligations); H1 moderate at E3.
6. Anything else (H2 at E1, low severity, constant input): no card, named in the report.

Ties go to the higher evidence rung (`count`, `probe` over `quote`), then the smaller effort.
One card per upgrade: packages fixed by one bump share a card. Write every candidate of ranks
1-5: the store keeps the budget's 4 ranked slots (the lens's top card is its MVP) and files the
rest in `reserve`, named in the summary. Never cut a card yourself; rank 6 stays no card.

## Impact, risk and the predicted verdict

Set `impact` (1-10) from the rank and the exposure class, with `impact_why` naming both in one
line ("critical advisory, E3: the upload route decodes with it"):

| Rank | Finding | impact |
| --- | --- | --- |
| 1 | H3 live secret in a shipped or deployed file | 10 |
| 2 | H1 critical/high at E3 | 9 |
| 2 | H2 at E3 | 8 |
| 3 | H4 while the product ships to users | 7 |
| 4 | H1 critical/high at E2; H2 at E2 | 6 |
| 4 | H1 critical/high at E1, or shipped with no import path found | 5 |
| 5 | H6 | 5 |
| 5 | H5; H1 moderate at E3 | 4 |

`risk` is the risk of making the change, not the severity: a patch bump with tests is 2, a
minor bump or a new release step 5, a major bump or a changed auth flow 8. Omit it and the store
reads `delivery_risk.blast`. `category` is `technical` (the default for this lens). Before
writing a card, read `context`'s `near` (with each reason and note) and `outcomes` (with notes):
set `predicted_verdict` and a `predicted_why` that names the closest precedent ("SEC-12 already
tracks it: rejected as already-known"). With no precedent, omit both; the store records `defer`.

## Evidence rules

- H1: quote the manifest or lockfile line as `code` (so `verify` checks it), add each `dep` ref
  exactly as `deps` returned it, and a `code` quote of the import site that sets the exposure
  class. Description names the auditor, the advisory, the severity and the scope (runtime,
  transitive via which parent). No `deps` ref means no H1 card.
- H2: quote the sink line and the line where the input enters. A sink with only constant input is
  not a finding.
- H3: the evidence `quote` never contains the secret. Quote the line only up to the value, as
  in gather step 5, and set the card's `blast` to `high`. The proposal is to rotate the secret
  and move it out of the tree. Purging it from history is the team's call.
- H4-H6: cite the search that found nothing (paths checked, greps run) in Description, plus one
  `doc` or `code` line that shows the product ships to users (a release workflow, an install
  doc). Absence claims are `confidence: medium` at most.

## Artifacts

A view is attached only when it does a job the body cannot. Otherwise omit `artifacts`.

- **Dependency table** (`table`) on an H1 card that cites 2 or more `dep` refs (one bump clears
  several packages or versions). Columns: Package, Version, Advisory, Severity, Fixed in, Scope, Reached
  from (`Fixed in` is the ref's `fixed_in`, or `none known`); one row per `dep` ref on the card, cells copied from `deps` titles and gather step 3;
  `highlight` the rows at E3. `refs` are those `dep` refs. One dep ref: no table.
- **Reach flow** (`flow`) on an H1 or H2 card whose input crosses 3 or more code hops from the
  entry point to the vulnerable call. One step per quoted `code` line, the vulnerable call marked
  `failure`. Two hops (entry and sink) fit in Description: no flow.
- **CRA obligation matrix** (`matrix`) on the highest-ranked H4-H6 card only, when gather step 7
  judged 3 or more obligations. Rows: the obligations; columns: Status, Found, Applies from;
  `level` 0 in place, 1-2 partial, 3 missing. An "in place" cell needs its line in the card's
  `evidence`; a "missing" cell needs its search in Description. Never on a second CRA card.

## Topic naming

`<component-or-package>-<risk>` in kebab case: `lodash-prototype-pollution`,
`report-query-sql-injection`, `vulnerability-disclosure-policy`, `release-sbom`,
`stripe-key-in-config`. For a dependency, name the package, not the version, so that a later
version bump of the same issue keeps the fingerprint.

## Examples

H1 with a dependency table, H4 with the obligation matrix, H2 with a reach flow, and H3 with no
view (one file, one line: nothing to compare).

```jsonl
{"lens":"security-cra","kind":"vulnerable-dependency","topic":"fast-xml-kit-external-entity","anchors":["package.json","src/invoices/import.ts#parseInvoiceXml"],"title":"Upgrade the invoice XML parser past two known advisories","rationale":"Customer invoice uploads reach an XML parser with a high advisory, and the parser pulls in a second vulnerable package. One parser bump clears both, and it gives the team a first entry in a CRA vulnerability log.","body":"## Summary\nUpgrade fast-xml-kit to 3.4.0 and disable external entities in invoice import.\n\n## Description\n`deps` (npm-audit) reports `package-lock.json#fast-xml-kit@3.2.1` at GHSA-4x5v-9q2m-hw3c high and its runtime dependency `package-lock.json#xml-entities@1.0.4` at GHSA-7c2f-pp8r-jm5w moderate. `package.json:18` pins the parser; uploaded invoices reach it at `src/invoices/import.ts:27`, so both are exposed to unauthenticated uploads. Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, an actively exploited flaw like this falls under the reporting duty that applies from 11 September 2026. Done means the parser is at 3.4.0 or later and a test feeds an external-entity payload.\n\n## Flow\n- bump fast-xml-kit and regenerate the lockfile\n- set the external-entity option off in parseInvoiceXml\n- add a test with an external-entity payload that must be rejected\n\n## Expected impact\nUploaded invoices can no longer read server files. Parser upgrades can change whitespace handling in parsed amounts; the suite must cover one real invoice.\n\n## Evaluation\nClaim: security - uploaded XML cannot trigger external-entity reads\nBefore: deps lists 2 advisories on the parser chain (1 high, 1 moderate)\nAfter: deps lists 0 on it; the entity test passes\nMethod: probe - dowser deps (npm audit --package-lock-only) on the committed lockfile\nFalsified if: the import path rejects XML before it reaches the parser","evidence":[{"type":"code","ref":"package.json:18","quote":"\"fast-xml-kit\": \"3.2.1\","},{"type":"code","ref":"src/invoices/import.ts:27","quote":"const doc = parseInvoiceXml(await file.text());"},{"type":"dep","ref":"package-lock.json#fast-xml-kit@3.2.1","quote":"GHSA-4x5v-9q2m-hw3c"},{"type":"dep","ref":"package-lock.json#xml-entities@1.0.4","quote":"GHSA-7c2f-pp8r-jm5w"}],"artifacts":[{"kind":"table","message":"One parser bump clears both advisories on the invoice upload path","alt":"Table of 2 dependency advisories: fast-xml-kit 3.2.1 high and xml-entities 1.0.4 moderate, both runtime, both reached from invoice upload.","refs":["package-lock.json#fast-xml-kit@3.2.1","package-lock.json#xml-entities@1.0.4"],"data":{"columns":["Package","Version","Advisory","Severity","Fixed in","Scope","Reached from"],"rows":[["fast-xml-kit","3.2.1","GHSA-4x5v-9q2m-hw3c","high","3.4.0","runtime","invoice upload"],["xml-entities","1.0.4","GHSA-7c2f-pp8r-jm5w","moderate","1.0.6","runtime via fast-xml-kit","invoice upload"]],"highlight":[0,1]}}],"effort":{"size":"S","days_low":0.5,"days_high":1.5,"basis":["package.json","src/invoices/import.ts#parseInvoiceXml"]},"confidence":"high","confidence_why":"Audit output and a reachable upload path agree; a failing entity test would make it certain.","delivery_risk":{"blast":"high"},"provenance":{"lens_version":"0.2.3","model":"<model id>","harness":"claude-code"}}
{"lens":"security-cra","kind":"vulnerability-handling-gap","topic":"vulnerability-disclosure-policy","anchors":["SECURITY.md","README.md"],"title":"Publish a way for researchers to report security problems","rationale":"The product ships to customers, but nothing tells a researcher where to report a vulnerability. Of the four practices checked it is the one tied to the CRA reporting duty already in force.","body":"## Summary\nAdd a SECURITY.md and a security.txt with a contact, a response time and a disclosure process.\n\n## Description\nThe README describes installing the product for customers (`README.md:9`). No `SECURITY.md`, `.well-known/security.txt` or disclosure section exists: `git ls-files SECURITY.md .well-known` returned nothing, and `git grep -n -i \"vulnerab\" -- README.md docs` returned nothing. No SBOM step exists either (`git grep -n -i -E \"cyclonedx|syft|spdx|sbom\" -- .github` returned nothing). Releases are versioned (`.github/workflows/release.yml:3`) and dependency updates are automated (`.github/dependabot.yml:1`). Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, a coordinated vulnerability disclosure policy is part of the expected handling, and reporting duties apply from 11 September 2026. Done means a published contact, an acknowledgement time and an internal triage owner.\n\n## Flow\n- write SECURITY.md: scope, contact, expected response time, disclosure timeline\n- serve /.well-known/security.txt pointing to it\n- name an internal owner and a tracker label for incoming reports\n\n## Expected impact\nResearchers report privately instead of publicly; the team has a record to build CRA reporting on. Risk: a published contact needs someone to answer it.\n\n## Evaluation\nClaim: compliance - a documented vulnerability intake exists\nBefore: 0 disclosure documents; 0 security contacts in docs\nAfter: 1 policy, 1 security.txt, 1 named owner\nMethod: count - file and grep searches over the tree\nFalsified if: a company-wide disclosure policy already covers this product and is linked from its site","evidence":[{"type":"doc","ref":"README.md:9","quote":"Customers install the agent with the installer from the downloads page."},{"type":"code","ref":".github/workflows/release.yml:3","quote":"tags: ['v*']"},{"type":"code","ref":".github/dependabot.yml:1","quote":"version: 2"}],"artifacts":[{"kind":"matrix","message":"Two of four practices are missing, and disclosure is the one tied to reporting from 2026","alt":"Matrix of 4 CRA-related practices by status, where found and date: disclosure missing (2026-09-11), SBOM missing (2027-12-11), versioned releases in place, dependency updates in place.","refs":["README.md:9",".github/workflows/release.yml:3",".github/dependabot.yml:1"],"data":{"rows":["Vulnerability disclosure","SBOM for releases","Security update path","Dependency updates"],"columns":["Status","Found","Applies from"],"cells":[[{"v":"missing","level":3},{"v":"no SECURITY.md or security.txt"},{"v":"reporting 2026-09-11"}],[{"v":"missing","level":3},{"v":"no sbom step in .github"},{"v":"2027-12-11"}],[{"v":"in place","level":0},{"v":"release.yml tag trigger"},{"v":"2027-12-11"}],[{"v":"in place","level":0},{"v":"dependabot.yml"},{"v":"2027-12-11"}]]}}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["SECURITY.md"]},"confidence":"medium","confidence_why":"An absence found by search; a company-level policy outside the repo could exist, and confirming that would settle it.","doc_impact":["README.md"],"delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.3","model":"<model id>","harness":"claude-code"}}
{"lens":"security-cra","kind":"risky-pattern","topic":"report-query-sql-injection","anchors":["src/reports/query.ts#ordersFor"],"title":"Parameterise the orders report query built from a URL parameter","rationale":"A public report URL passes its customer parameter through two functions into string-built SQL. Any visitor can read or change other customers' orders.","body":"## Summary\nReplace the string-built orders query with a parameterised one.\n\n## Description\nThe route reads `req.query.customer` (`src/routes/reports.ts:14`), passes it unchanged to `buildReport` (`src/reports/build.ts:8`), which hands it to `ordersFor`, where it is concatenated into SQL (`src/reports/query.ts:31`). No validation sits on that path. Done means the query uses a bound parameter and a test with a quote in the customer id passes.\n\n## Flow\n- bind the customer id as a query parameter in ordersFor\n- add a test with `' OR 1=1 --` as the customer id\n\n## Expected impact\nThe report can no longer be used to read or alter other rows. Risk: low, one query changes.\n\n## Evaluation\nClaim: security - the report query cannot be injected through its URL\nBefore: 1 string-built query reached from an unauthenticated route\nAfter: 0; the injection test passes\nMethod: quote - read the 3 lines from entry to sink\nFalsified if: a middleware rejects non-numeric customer ids before the route","evidence":[{"type":"code","ref":"src/routes/reports.ts:14","quote":"const customer = req.query.customer;"},{"type":"code","ref":"src/reports/build.ts:8","quote":"const rows = await ordersFor(customer);"},{"type":"code","ref":"src/reports/query.ts:31","quote":"return db.query(\"SELECT * FROM orders WHERE customer = '\" + customer + \"'\");"}],"artifacts":[{"kind":"flow","message":"The URL parameter reaches string-built SQL in three hops with no check","alt":"Flow of 3 steps: report route reads the customer parameter, buildReport passes it on, ordersFor concatenates it into SQL (marked failure).","refs":["src/routes/reports.ts:14","src/reports/build.ts:8","src/reports/query.ts:31"],"data":{"steps":[{"label":"GET /reports reads customer"},{"label":"buildReport passes it on"},{"label":"ordersFor concatenates SQL","mark":"failure"}]}}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["src/reports/query.ts#ordersFor"]},"confidence":"high","confidence_why":"The full path from the URL to the sink is read and quoted; an injection test would make it certain.","delivery_risk":{"blast":"medium"},"provenance":{"lens_version":"0.2.3","model":"<model id>","harness":"claude-code"}}
{"lens":"security-cra","kind":"secret-exposure","topic":"stripe-key-in-config","anchors":["config/production.js"],"title":"Rotate the live payment key committed in production config","rationale":"A live-format payment key sits in the deployed production config, so anyone with read access to the repository can charge or refund through the account.","body":"## Summary\nRotate the payment key and load it from the environment.\n\n## Description\n`config/production.js:12` assigns a live-format key literal (value not reproduced here). The file is loaded by the server at start. Done means the key is rotated, the literal is gone and the server reads it from an environment variable.\n\n## Flow\n- rotate the key in the payment provider's dashboard\n- read it from an environment variable in config/production.js\n- decide whether to purge it from history\n\n## Expected impact\nA leaked repository no longer exposes the payment account. Risk: a deploy without the new variable fails at start, which is the safe failure.\n\n## Evaluation\nClaim: security - no live credential is committed\nBefore: 1 live-format key literal in a deployed file\nAfter: 0; the secret grep returns no hit outside tests\nMethod: count - secret grep over the tree\nFalsified if: the key was already revoked by the provider","evidence":[{"type":"code","ref":"config/production.js:12","quote":"stripeKey: '"}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["config/production.js"]},"confidence":"high","confidence_why":"The key format marks it live and the file is deployed; only the provider can say if it was revoked.","delivery_risk":{"blast":"high"},"provenance":{"lens_version":"0.2.3","model":"<model id>","harness":"claude-code"}}
```

## No finding

```
security-cra: ran|partial (<e.g. osv-scanner skipped (not installed): H1 unchecked for Cargo.lock>) - no proposals.
Checked: H1 <deps auditors ran, n refs: each dev-only, unreached or below threshold>; H2 <n sinks read, classes>;
H3 <secret grep: n hits, all E0>; H4 <SECURITY.md present at ...>; H5 <SBOM step in ...>; H6 <...>.
Direction: <excluded / off-focus topics, or none set>.
```
