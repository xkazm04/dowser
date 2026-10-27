---
id: security-cra
version: 0.1.0
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

## Gather

1. **Manifests and lockfiles.** `git ls-files` for `package.json`, `package-lock.json`,
   `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `Pipfile.lock`, `go.mod`,
   `go.sum`, `Cargo.toml`, `Cargo.lock`, `pom.xml`, `build.gradle*`, `Gemfile.lock`,
   `composer.lock`, `*.csproj`, `packages.lock.json`. Note which ecosystems exist and whether
   each has a lockfile.
2. **Known-vulnerable versions, read-only.** If the ecosystem tool is installed and needs no
   network write or install, run its audit in report mode and quote its output: `npm audit --json`
   (only with a lockfile; never `npm install` or `audit fix`), `pip-audit -r requirements.txt`,
   `cargo audit`, `govulncheck ./...`. If none can run, say so: the dependency hypothesis is
   then `partial`. Do not guess CVEs from memory.
3. **Runner-supplied reports (optional).** If the runner names a SARIF (`*.sarif`) or CycloneDX
   (`bom.json`, `*.cdx.json`) file, read it and cite entries as `sarif` or `dep` evidence.
4. **Secrets.** `git grep -n -I -E "(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*['\"][A-Za-z0-9/+_\-]{12,}['\"]|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}"`.
   Also `git ls-files "*.env" "*.pem" "*.key" "*.p12"`. Never print or store a secret. Quote
   only the part of the line before the value, for example `const stripeKey = '`. `verify`
   matches a substring of the line, so the shortened quote still verifies.
5. **Risky patterns.** `git grep -n -E "eval\(|new Function\(|child_process|exec(Sync)?\(|shell=True|os\.system|innerHTML|dangerouslySetInnerHTML|v-html|SELECT .*\+|\$\{.*\}.*(WHERE|where)|pickle\.loads|yaml\.load\(|verify ?= ?False|rejectUnauthorized: ?false|Math\.random\(\).*(token|id|secret)"`.
   Read each hit's data flow: is the input user-controlled?
6. **CRA surface (docs and repo).** `SECURITY.md`, `.well-known/security.txt`, a
   vulnerability-disclosure section in README or docs, `CHANGELOG*` with security entries, an
   SBOM step in CI (`.github/workflows/*`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`: grep
   `cyclonedx|syft|spdx|sbom`), dependency update automation (`.github/dependabot.yml`,
   `renovate.json`), and the release or update mechanism (auto-update code, a versioned release
   process).
7. **History.** `git log --since=12.months --format="%h %ad %s" --date=short | grep -i -E "security|cve|vuln|xss|inject"`
   shows how the team handles fixes. It informs the vulnerability-handling hypothesis.

Record what could not run (an audit tool missing, no lockfile) and go on.

## Hypotheses

- **H1 Known-vulnerable dependency:** an audit or a supplied report lists a dependency with a
  known vulnerability at a severity of high or more, and the vulnerable code is reachable or
  the package is a runtime dependency. Kind: `vulnerable-dependency`.
- **H2 Injectable sink:** user-controlled input reaches eval, a shell, SQL, HTML or a
  deserializer without validation. Kind: `risky-pattern`.
- **H3 Secret in the tree:** a credential, key or token is committed. Kind: `secret-exposure`.
- **H4 No way to report or handle vulnerabilities:** no `SECURITY.md` or `security.txt`, no
  disclosure contact, no recorded process for triaging reports. This bears on CRA reporting from
  September 2026. Kind: `vulnerability-handling-gap`.
- **H5 No SBOM:** no step produces a software bill of materials for releases. Kind: `sbom-gap`.
- **H6 No security update path:** the product has no way to ship security fixes to users
  separately or promptly (no versioned releases, no update mechanism, no dependency update
  automation). Kind: `update-mechanism-gap`.

## Evidence rules

- H1: quote the manifest or lockfile line as `code` (so `verify` checks it), add a `dep` ref
  `<lockfile>#<package>@<version>` with the advisory id and URL from the audit output, and, when
  you found it, a `code` quote of the import site. No audit output means no H1 card.
- H2: quote the sink line and the line where the input enters. A sink with only constant input is
  not a finding.
- H3: the evidence `quote` never contains the secret. Quote the line only up to the value, as
  in gather step 4, and set the card's `blast` to `high`. The proposal is to rotate the secret
  and move it out of the tree. Purging it from history is the team's call.
- H4-H6: cite the search that found nothing (paths checked, greps run) in Description, plus one
  `doc` or `code` line that shows the product ships to users (a release workflow, an install
  doc). Absence claims are `confidence: medium` at most.
- Severity words come from the audit or advisory, never from your own impression.

## Topic naming

`<component-or-package>-<risk>` in kebab case: `lodash-prototype-pollution`,
`report-query-sql-injection`, `vulnerability-disclosure-policy`, `release-sbom`,
`stripe-key-in-config`. For a dependency, name the package, not the version, so that a later
version bump of the same issue keeps the fingerprint.

## Examples

```jsonl
{"lens":"security-cra","kind":"vulnerable-dependency","topic":"billing-xml-parser-xxe","anchors":["services/billing/package.json","services/billing/src/invoices/import.ts#parseInvoiceXml"],"title":"Upgrade the billing service's XML parser past a known injection flaw","rationale":"The billing service imports customer invoice XML with a parser version that has a published external-entity flaw. The import accepts uploaded files, so the flaw is reachable. Fixing it also gives the team a first entry in its CRA vulnerability log.","body":"## Summary\nUpgrade the XML parser in the billing service and disable external entities in invoice import.\n\n## Description\n`services/billing/package.json:18` pins the parser at 3.2.1; `npm audit --json` reports advisory GHSA-xxxx-yyyy-zzzz (high) for versions below 3.4.0. Uploaded invoices reach the parser in `services/billing/src/invoices/import.ts:27`. Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, an actively exploited flaw like this one falls under the reporting duty that applies from 11 September 2026. Done means the parser is at 3.4.0 or later and a test feeds an external-entity payload.\n\n## Flow\n- bump the parser and regenerate the lockfile\n- set the external-entity option off in parseInvoiceXml\n- add a test with an external-entity payload that must be rejected\n\n## Expected impact\nUploaded invoices can no longer read server files. Parser upgrades can change whitespace handling in parsed amounts; the test suite must cover one real invoice.\n\n## Evaluation\nClaim: security - uploaded XML cannot trigger external-entity reads\nBefore: npm audit lists 1 high advisory on the billing parser\nAfter: npm audit lists 0 advisories on it; the entity test passes\nMethod: probe - npm audit run read-only on the committed lockfile\nFalsified if: the import path rejects XML before it reaches the parser","evidence":[{"type":"code","ref":"services/billing/package.json:18","quote":"\"fast-xml-kit\": \"3.2.1\","},{"type":"code","ref":"services/billing/src/invoices/import.ts:27","quote":"const doc = parseInvoiceXml(await file.text());"},{"type":"dep","ref":"services/billing/package-lock.json#fast-xml-kit@3.2.1","url":"https://github.com/advisories/GHSA-xxxx-yyyy-zzzz"}],"effort":{"size":"S","days_low":0.5,"days_high":1.5,"basis":["services/billing/package.json","services/billing/src/invoices/import.ts#parseInvoiceXml"]},"confidence":"high","confidence_why":"Audit output and a reachable upload path agree; a failing entity test would make it certain.","delivery_risk":{"blast":"high"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code","run_id":"<run_id>"}}
{"lens":"security-cra","kind":"vulnerability-handling-gap","topic":"vulnerability-disclosure-policy","anchors":["SECURITY.md","README.md"],"title":"Publish a way for researchers to report security problems","rationale":"The product ships to customers, but nothing tells a researcher where to report a vulnerability. A disclosure policy and contact is the first step of the vulnerability handling the CRA expects.","body":"## Summary\nAdd a SECURITY.md and a security.txt with a contact, a response time and a disclosure process.\n\n## Description\nThe README describes installing the product for customers (`README.md:9`). No `SECURITY.md`, `.well-known/security.txt` or disclosure section exists: `git ls-files SECURITY.md .well-known` returned nothing, and `git grep -n -i \"vulnerab\" -- README.md docs` returned nothing. Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, a coordinated vulnerability disclosure policy is part of the expected handling, and reporting duties apply from 11 September 2026. Done means a published contact, an acknowledgement time and an internal triage owner.\n\n## Flow\n- write SECURITY.md: scope, contact, expected response time, disclosure timeline\n- serve /.well-known/security.txt pointing to it\n- name an internal owner and a tracker label for incoming reports\n\n## Expected impact\nResearchers report privately instead of publicly; the team has a record to build CRA reporting on. Risk: a published contact needs someone to answer it.\n\n## Evaluation\nClaim: compliance - a documented vulnerability intake exists\nBefore: 0 disclosure documents; 0 security contacts in docs\nAfter: 1 policy, 1 security.txt, 1 named owner\nMethod: count - file and grep searches over the tree\nFalsified if: a company-wide disclosure policy already covers this product and is linked from its site","evidence":[{"type":"doc","ref":"README.md:9","quote":"Customers install the agent with the installer from the downloads page."}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["SECURITY.md"]},"confidence":"medium","confidence_why":"An absence found by search; a company-level policy outside the repo could exist, and confirming that would settle it.","doc_impact":["README.md"],"delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code","run_id":"<run_id>"}}
```

## No finding

```
security-cra: ran|partial (<e.g. no audit tool for pip: H1 unchecked for Python>) - no proposals.
Checked: H1 <ecosystems audited, n advisories below high>; H2 <n sinks read, all constant input>;
H3 <secret grep: 0 hits>; H4 <SECURITY.md present at ...>; H5 <SBOM step in ...>; H6 <...>.
```

Changelog: 0.1.0 - first pack.
