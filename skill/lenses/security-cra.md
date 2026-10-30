---
id: security-cra
version: 0.3.1
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

**CRA items are product proposals, never legal advice.** Phrase them as work that helps meet an
obligation ("Add a published way to report vulnerabilities"), never as a verdict ("You are
non-compliant"). Every CRA card says in Description: "Whether and how the CRA applies to this
product is for your compliance owner to confirm." Facts to rely on: reporting obligations for
actively exploited vulnerabilities and severe incidents apply from 11 September 2026; the rest
(vulnerability handling, an SBOM, security updates, a coordinated disclosure policy) from 11
December 2027.

Never restate what a deterministic tool already owns: if CI runs a scanner, or the runner
supplies its SARIF or CycloneDX output, cite it and propose the work it implies.

## Direction

`context.direction` absent: everything below applies unchanged.

- **`focus`** maps each entry to hypotheses by its words: package, dependency, advisory, supply
  chain -> H1; injection, input, XSS, SQL, shell -> H2; secret, key, credential -> H3; CRA,
  compliance, disclosure, SBOM, update -> H4-H6. An entry that names a path or component limits
  gather steps 5-6 to it (`git grep ... -- <path>`) and H1 to packages imported there. Run the
  focused steps first. A focused candidate's `impact` is one above its rank's (at most 10); an
  off-focus one is still written and takes any slot its score earns. Focus never hides a finding.
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
   `composer.lock`, `*.csproj`, `packages.lock.json`. Note each ecosystem, lockfile and folder.
2. **Advisories: `deps --run <run_id>`.** This is the lens's only dependency source. It audits
   the root and every manifest directory up to three levels below it (an `auditors` entry below
   the root carries `dir`). Each `ref` is `<lockfile path>#<package>@<version>`; its `title` is
   `<advisory> <severity>`, and it carries `url` and, when the auditor knows it, `fixed_in`.
   Every `skipped` auditor makes the lens `partial: <tool> skipped (<reason>)`. An unaudited
   ecosystem, a `not_audited` directory (test or fixture paths, past the cap) or a deeper
   manifest leaves H1 unchecked there; the report says which. Never run an auditor yourself,
   never install, never guess CVEs from memory.
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
   Also `git ls-files "*.env" "*.pem" "*.key" "*.p12"`. Never print or store a secret: quote the
   line only up to the value (`const stripeKey = '`); `verify` matches a fragment. A hit in
   `test/`, fixtures, `*.example`, `*.sample` or docs, or a documented placeholder or test-mode
   key, is class E0: record it, no card.
6. **Risky patterns.** `git grep -n -E "eval\(|new Function\(|child_process|execSync\(|shell: ?true|shell=True|os\.system|innerHTML|dangerouslySetInnerHTML|v-html|(SELECT|INSERT|UPDATE|DELETE) .*(['\"] *\+|\$\{)|pickle\.loads|yaml\.load\(|verify ?= ?False|rejectUnauthorized: ?false|Math\.random\(\).*(token|secret)" -- ':!*test*' ':!*fixtures/*' ':!*.md'`.
   No bare `exec(` (in JS it is mostly `RegExp.exec`): `child_process` finds the imports, then
   read their calls. For each hit, read where its input comes from and give it an exposure class.
7. **CRA surface (docs and repo).** `SECURITY.md`, `.well-known/security.txt`, a
   vulnerability-disclosure section in README or docs, `CHANGELOG*` with security entries, an
   SBOM step in CI (`.github/workflows/*`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`: grep
   `cyclonedx|syft|spdx|sbom`), dependency update automation (`.github/dependabot.yml`,
   `renovate.json`), and the release or update mechanism (auto-update code, versioned releases).
   Record each obligation in place / partial / missing with a `path:line` or the empty search.
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
1-5 (the store ranks by score, top card = MVP, the rest in `reserve`); rank 6 stays no card.

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
reads `delivery_risk.blast`. `category` is `technical` (the default for this lens). Every card
carries your `predicted_verdict` (`accept`, `reject` or `defer`) and a `predicted_why`, after
reading `context`'s `near` (reasons, notes) and `outcomes` (notes). With a precedent, quote it
("SEC-12 already tracks it: rejected as already-known"); without one, give your own reason.

## Evidence rules

- H1: quote the manifest or lockfile line as `code` (so `verify` checks it), add each `dep` ref
  exactly as `deps` returned it, and a `code` quote of the import site that sets the exposure
  class. Description names the auditor, the advisory, the severity and the scope (runtime,
  transitive via which parent). No `deps` ref means no H1 card.
- H2: quote the sink line and the line where the input enters. Constant input is no finding.
- H3: the `quote` never contains the secret (gather step 5); `blast` is `high`. Propose to
  rotate the secret and move it out of the tree; purging history is the team's call.
- H4-H6: cite the search that found nothing (paths checked, greps run) in Description, plus one
  `doc` or `code` line that shows the product ships to users (a release workflow, an install
  doc). Absence claims are `confidence: medium` at most.

## Artifacts

- **Dependency table** (`table`) on an H1 card that cites 2 or more `dep` refs (one bump clears
  several packages or versions). Six columns (the view's cap): Package (`<name> <version>`),
  Advisory, Severity, Fixed in (the ref's `fixed_in`, or `none known`), Scope, Reached from; one
  row per `dep` ref, cells from `deps` titles and gather step 3; `highlight` the rows at E3.
  `refs` are those `dep` refs. One dep ref: no table.
- **Reach flow** (`flow`) on an H1 or H2 card whose input crosses 3 or more code hops from the
  entry point to the vulnerable call. One step per quoted `code` line, the vulnerable call marked
  `failure`. Two hops (entry and sink) fit in Description: no flow.
- **CRA obligation matrix** (`matrix`) on the highest-ranked H4-H6 card only, when gather step 7
  judged 3 or more obligations. Rows: the obligations; columns: Status, Found, Applies from;
  `level` 0 in place, 1-2 partial, 3 missing. An "in place" cell needs its line in the card's
  `evidence`; a "missing" cell needs its search in Description. Never on a second CRA card.
- No other view: otherwise omit `artifacts`.

## Topic naming

`<component-or-package>-<risk>` in kebab case: `lodash-prototype-pollution`,
`report-query-sql-injection`, `vulnerability-disclosure-policy`, `release-sbom`,
`stripe-key-in-config`. For a dependency, name the package, not the version, so that a later
version bump of the same issue keeps the fingerprint.

## Examples

Read `<skill-dir>/references/examples/security-cra.md` before the first card (H1 with the
dependency table, H4 with the matrix, H2 with a reach flow, H3 with no view). In the jsonl each
card is one line.

## No finding

```
security-cra: ran|partial (<e.g. osv-scanner skipped (not installed): H1 unchecked for Cargo.lock>) - no proposals.
Checked: H1 <deps auditors ran, n refs: each dev-only, unreached or below threshold>; H2 <n sinks read, classes>;
H3 <secret grep: n hits, all E0>; H4 <SECURITY.md present at ...>; H5 <SBOM step in ...>; H6 <...>.
Direction: <excluded / off-focus topics, or none set>.
```
