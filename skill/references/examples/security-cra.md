# Security and CRA - worked example cards

The cards the `security-cra` pack (`lenses/security-cra.md`, 0.3.2) points to. They are spread
over several lines here, one field per line, so each line stays readable; in
`<work>/security-cra.jsonl` every card is **one line** (`JSON.stringify` of the object). Each
one passes `propose`'s validation and is scored by the store.

H1 with a dependency table, H4 with the obligation matrix (predicted `defer`, quoting a snoozed
precedent), H2 with a reach flow, and H3 with no view (one file, one line: nothing to compare).
The H1 card's minor bump is `risk` 5 with `blast` `medium`; the H3 card omits `risk`, so the
store reads its `blast` `high` as 8. The H3 quote stops before the value, as gather step 5 says.

```json
{
  "lens": "security-cra",
  "kind": "vulnerable-dependency",
  "topic": "fast-xml-kit-external-entity",
  "anchors": ["package.json","src/invoices/import.ts#parseInvoiceXml"],
  "title": "Upgrade the invoice XML parser past two known advisories",
  "rationale": "Customer invoice uploads reach an XML parser with a high advisory, and the parser pulls in a second vulnerable package. One parser bump clears both, and it gives the team a first entry in a CRA vulnerability log.",
  "body": "## Summary\nUpgrade fast-xml-kit to 3.4.0 and disable external entities in invoice import.\n\n## Description\n`deps` (npm-audit) reports `package-lock.json#fast-xml-kit@3.2.1` at GHSA-4x5v-9q2m-hw3c high and its runtime dependency `package-lock.json#xml-entities@1.0.4` at GHSA-7c2f-pp8r-jm5w moderate. `package.json:18` pins the parser; uploaded invoices reach it at `src/invoices/import.ts:27`, so both are exposed to unauthenticated uploads. Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, an actively exploited flaw like this falls under the reporting duty that applies from 11 September 2026. Done means the parser is at 3.4.0 or later and a test feeds an external-entity payload.\n\n## Flow\n- bump fast-xml-kit and regenerate the lockfile\n- set the external-entity option off in parseInvoiceXml\n- add a test with an external-entity payload that must be rejected\n\n## Expected impact\nUploaded invoices can no longer read server files. Parser upgrades can change whitespace handling in parsed amounts; the suite must cover one real invoice.\n\n## Evaluation\nClaim: security - uploaded XML cannot trigger external-entity reads\nBefore: deps lists 2 advisories on the parser chain (1 high, 1 moderate)\nAfter: deps lists 0 on it; the entity test passes\nMethod: probe - dowser deps (npm audit --package-lock-only) on the committed lockfile\nFalsified if: the import path rejects XML before it reaches the parser",
  "evidence": [{"type":"code","ref":"package.json:18","quote":"\"fast-xml-kit\": \"3.2.1\","},{"type":"code","ref":"src/invoices/import.ts:27","quote":"const doc = parseInvoiceXml(await file.text());"},{"type":"dep","ref":"package-lock.json#fast-xml-kit@3.2.1","quote":"GHSA-4x5v-9q2m-hw3c"},{"type":"dep","ref":"package-lock.json#xml-entities@1.0.4","quote":"GHSA-7c2f-pp8r-jm5w"}],
  "effort": {"size":"S","days_low":0.5,"days_high":1.5,"basis":["package.json","src/invoices/import.ts#parseInvoiceXml"]},
  "confidence": "high",
  "confidence_why": "Audit output and a reachable upload path agree; a failing entity test would make it certain.",
  "delivery_risk": {"blast":"medium"},
  "impact": 9,
  "impact_why": "High advisory at E3: unauthenticated invoice uploads reach the parser.",
  "risk": 5,
  "predicted_verdict": "accept",
  "predicted_why": "No similar decision in near or outcomes. A high advisory on an unauthenticated upload path with a fixed version available is rarely turned down.",
  "artifacts": [{"kind":"table","message":"One parser bump clears both advisories on the invoice upload path","alt":"Table of 2 dependency advisories: fast-xml-kit 3.2.1 high and xml-entities 1.0.4 moderate, both runtime, both reached from invoice upload.","refs":["package-lock.json#fast-xml-kit@3.2.1","package-lock.json#xml-entities@1.0.4"],"data":{"columns":["Package","Advisory","Severity","Fixed in","Scope","Reached from"],"rows":[["fast-xml-kit 3.2.1","GHSA-4x5v-9q2m-hw3c","high","3.4.0","runtime","invoice upload"],["xml-entities 1.0.4","GHSA-7c2f-pp8r-jm5w","moderate","1.0.6","runtime via fast-xml-kit","invoice upload"]],"highlight":[0,1]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "security-cra",
  "kind": "vulnerability-handling-gap",
  "topic": "vulnerability-disclosure-policy",
  "anchors": ["SECURITY.md","README.md"],
  "title": "Publish a way for researchers to report security problems",
  "rationale": "The product ships to customers, but nothing tells a researcher where to report a vulnerability. Of the four practices checked it is the one tied to the CRA reporting duty already in force.",
  "body": "## Summary\nAdd a SECURITY.md and a security.txt with a contact, a response time and a disclosure process.\n\n## Description\nThe README describes installing the product for customers (`README.md:9`). No `SECURITY.md`, `.well-known/security.txt` or disclosure section exists: `git ls-files SECURITY.md .well-known` returned nothing, and `git grep -n -i \"vulnerab\" -- README.md docs` returned nothing. No SBOM step exists either (`git grep -n -i -E \"cyclonedx|syft|spdx|sbom\" -- .github` returned nothing). Releases are versioned (`.github/workflows/release.yml:3`) and dependency updates are automated (`.github/dependabot.yml:1`). Whether and how the CRA applies to this product is for your compliance owner to confirm; if it does, a coordinated vulnerability disclosure policy is part of the expected handling, and reporting duties apply from 11 September 2026. Done means a published contact, an acknowledgement time and an internal triage owner.\n\n## Flow\n- write SECURITY.md: scope, contact, expected response time, disclosure timeline\n- serve /.well-known/security.txt pointing to it\n- name an internal owner and a tracker label for incoming reports\n\n## Expected impact\nResearchers report privately instead of publicly; the team has a record to build CRA reporting on. Risk: a published contact needs someone to answer it.\n\n## Evaluation\nClaim: compliance - a documented vulnerability intake exists\nBefore: 0 disclosure documents; 0 security contacts in docs\nAfter: 1 policy, 1 security.txt, 1 named owner\nMethod: count - file and grep searches over the tree\nFalsified if: a company-wide disclosure policy already covers this product and is linked from its site",
  "evidence": [{"type":"doc","ref":"README.md:9","quote":"Customers install the agent with the installer from the downloads page."},{"type":"code","ref":".github/workflows/release.yml:3","quote":"tags: ['v*']"},{"type":"code","ref":".github/dependabot.yml:1","quote":"version: 2"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["SECURITY.md"]},
  "confidence": "medium",
  "confidence_why": "An absence found by search; a company-level policy outside the repo could exist, and confirming that would settle it.",
  "doc_impact": ["README.md"],
  "delivery_risk": {"blast":"low"},
  "impact": 7,
  "impact_why": "H4 while the product ships to users: no SECURITY.md, security.txt or disclosure contact.",
  "risk": 2,
  "predicted_verdict": "defer",
  "predicted_why": "Closest precedent \"Add an SBOM step to the release workflow\" (7be2c9d04f1a3e65) snoozed: CRA items waited for the compliance owner.",
  "artifacts": [{"kind":"matrix","message":"Two of four practices are missing, and disclosure is the one tied to reporting from 2026","alt":"Matrix of 4 CRA-related practices by status, where found and date: disclosure missing (2026-09-11), SBOM missing (2027-12-11), versioned releases in place, dependency updates in place.","refs":["README.md:9",".github/workflows/release.yml:3",".github/dependabot.yml:1"],"data":{"rows":["Vulnerability disclosure","SBOM for releases","Security update path","Dependency updates"],"columns":["Status","Found","Applies from"],"cells":[[{"v":"missing","level":3},{"v":"no SECURITY.md or security.txt"},{"v":"reporting 2026-09-11"}],[{"v":"missing","level":3},{"v":"no sbom step in .github"},{"v":"2027-12-11"}],[{"v":"in place","level":0},{"v":"release.yml tag trigger"},{"v":"2027-12-11"}],[{"v":"in place","level":0},{"v":"dependabot.yml"},{"v":"2027-12-11"}]]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "security-cra",
  "kind": "risky-pattern",
  "topic": "report-query-sql-injection",
  "anchors": ["src/reports/query.ts#ordersFor"],
  "title": "Parameterise the orders report query built from a URL parameter",
  "rationale": "A public report URL passes its customer parameter through two functions into string-built SQL. Any visitor can read or change other customers' orders.",
  "body": "## Summary\nReplace the string-built orders query with a parameterised one.\n\n## Description\nThe route reads `req.query.customer` (`src/routes/reports.ts:14`), passes it unchanged to `buildReport` (`src/reports/build.ts:8`), which hands it to `ordersFor`, where it is concatenated into SQL (`src/reports/query.ts:31`). No validation sits on that path. Done means the query uses a bound parameter and a test with a quote in the customer id passes.\n\n## Flow\n- bind the customer id as a query parameter in ordersFor\n- add a test with `' OR 1=1 --` as the customer id\n\n## Expected impact\nThe report can no longer be used to read or alter other rows. Risk: low, one query changes.\n\n## Evaluation\nClaim: security - the report query cannot be injected through its URL\nBefore: 1 string-built query reached from an unauthenticated route\nAfter: 0; the injection test passes\nMethod: quote - read the 3 lines from entry to sink\nFalsified if: a middleware rejects non-numeric customer ids before the route",
  "evidence": [{"type":"code","ref":"src/routes/reports.ts:14","quote":"const customer = req.query.customer;"},{"type":"code","ref":"src/reports/build.ts:8","quote":"const rows = await ordersFor(customer);"},{"type":"code","ref":"src/reports/query.ts:31","quote":"return db.query(\"SELECT * FROM orders WHERE customer = '\" + customer + \"'\");"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["src/reports/query.ts#ordersFor"]},
  "confidence": "high",
  "confidence_why": "The full path from the URL to the sink is read and quoted; an injection test would make it certain.",
  "delivery_risk": {"blast":"medium"},
  "impact": 8,
  "impact_why": "H2 at E3: a public report URL parameter reaches string-built SQL.",
  "risk": 5,
  "predicted_verdict": "accept",
  "predicted_why": "No similar decision in near or outcomes. An injectable query on a public URL with a one-query fix is the kind of card a team takes.",
  "artifacts": [{"kind":"flow","message":"The URL parameter reaches string-built SQL in three hops with no check","alt":"Flow of 3 steps: report route reads the customer parameter, buildReport passes it on, ordersFor concatenates it into SQL (marked failure).","refs":["src/routes/reports.ts:14","src/reports/build.ts:8","src/reports/query.ts:31"],"data":{"steps":[{"label":"GET /reports reads customer"},{"label":"buildReport passes it on"},{"label":"ordersFor concatenates SQL","mark":"failure"}]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "security-cra",
  "kind": "secret-exposure",
  "topic": "stripe-key-in-config",
  "anchors": ["config/production.js"],
  "title": "Rotate the live payment key committed in production config",
  "rationale": "A live-format payment key sits in the deployed production config, so anyone with read access to the repository can charge or refund through the account.",
  "body": "## Summary\nRotate the payment key and load it from the environment.\n\n## Description\n`config/production.js:12` assigns a live-format key literal (value not reproduced here). The file is loaded by the server at start. Done means the key is rotated, the literal is gone and the server reads it from an environment variable.\n\n## Flow\n- rotate the key in the payment provider's dashboard\n- read it from an environment variable in config/production.js\n- decide whether to purge it from history\n\n## Expected impact\nA leaked repository no longer exposes the payment account. Risk: a deploy without the new variable fails at start, which is the safe failure.\n\n## Evaluation\nClaim: security - no live credential is committed\nBefore: 1 live-format key literal in a deployed file\nAfter: 0; the secret grep returns no hit outside tests\nMethod: count - secret grep over the tree\nFalsified if: the key was already revoked by the provider",
  "evidence": [{"type":"code","ref":"config/production.js:12","quote":"stripeKey: '"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["config/production.js"]},
  "confidence": "high",
  "confidence_why": "The key format marks it live and the file is deployed; only the provider can say if it was revoked.",
  "delivery_risk": {"blast":"high"},
  "impact": 10,
  "impact_why": "Rank 1: a live-format payment key in a deployed config file.",
  "predicted_verdict": "accept",
  "predicted_why": "Closest precedent \"Rotate the mail API key committed in staging config\" (0e93b7a6c15d2f84) accepted: committed live keys were rotated.",
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```
