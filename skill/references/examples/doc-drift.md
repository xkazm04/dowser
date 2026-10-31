# Doc drift - worked example cards

The cards the `doc-drift` pack (`lenses/doc-drift.md`, 0.3.2) points to. They are spread over
several lines here, one field per line, so each line stays readable; in
`<work>/doc-drift.jsonl` every card is **one line** (`JSON.stringify` of the object). Each one
passes `propose`'s validation and is scored by the store.

The first card is an H2 with one doc line, so it carries no view; its prediction has no
precedent, so the reason is the judge's own. The second is an H1 with three places, so it
carries the "doc says / code does" table, and its prediction quotes the closest precedent.

```json
{
  "lens": "doc-drift",
  "kind": "removed-still-documented",
  "topic": "api-auth-v1-docs",
  "anchors": ["docs/api/authentication.md","src/auth/index.ts"],
  "title": "API guide still teaches the login method that was removed in March",
  "rationale": "The API guide tells integrators to sign requests with v1 API keys. That path was removed and only OAuth tokens work now. New integrators follow the guide and fail on their first call.",
  "body": "## Summary\nRewrite the API authentication guide for OAuth tokens and remove the v1 key instructions.\n\n## Description\nThe guide says to send `X-Api-Key` (`docs/api/authentication.md:12`). The auth module now only reads bearer tokens (`src/auth/index.ts:19`); `git grep -n X-Api-Key -- ':!docs/**'` returns nothing, and commit 4be91c2 removed `apiKeyAuth`. Checks: no alias or fallback header in `src/auth/`, the guide is not version-scoped. Done means the guide shows the OAuth flow with a working curl example.\n\n## Flow\n- integrator reads the API guide\n- sends X-Api-Key as documented\n- server answers 401 with no hint about OAuth\n\n## Expected impact\nIntegrators succeed on the first call; auth-related support questions drop. Low risk: docs only.\n\n## Evaluation\nClaim: docs - the guide matches the only auth path the code accepts\nBefore: 1 documented header the code never reads; 0 OAuth examples in the guide\nAfter: 0 documented headers the code does not read; 1 working OAuth example\nMethod: count - grep for the documented header outside docs, plus the removal commit\nFalsified if: a gateway in front of the service still accepts X-Api-Key",
  "evidence": [{"type":"doc","ref":"docs/api/authentication.md:12","quote":"Send your key in the `X-Api-Key` header with every request."},{"type":"code","ref":"src/auth/index.ts:19","quote":"const token = req.headers.authorization?.replace('Bearer ', '');"},{"type":"git","ref":"4be91c2","quote":"remove apiKeyAuth (v1)"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/api/authentication.md"]},
  "confidence": "high",
  "confidence_why": "Sure, tier 1: the doc line, the code line and the removal commit agree, and no fallback reads the old header.",
  "doc_impact": ["docs/api/authentication.md","README.md"],
  "delivery_risk": {"blast":"low"},
  "impact": 8,
  "impact_why": "Tier 1, a documented step fails: the first API call answers 401 with the header the guide teaches.",
  "risk": 2,
  "predicted_verdict": "accept",
  "predicted_why": "No similar decision in near or outcomes. A sure tier-1 drift with both sides quoted and the removal commit found; nothing suggests the team would turn it down.",
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "doc-drift",
  "kind": "contradicted-by-code",
  "topic": "env-max-upload-default-docs",
  "anchors": ["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"],
  "title": "Configuration guide and admin page state the wrong upload size limit",
  "rationale": "The guide and the Confluence admin page say uploads default to 50 MB, but the code caps them at 10 MB. Admins plan around the wrong number and users hit a limit nobody told them about.",
  "body": "## Summary\nCorrect the documented default for MAX_UPLOAD_MB from 50 to 10 in both places, or decide which number is intended.\n\n## Description\n`docs/configuration.md:44` and Confluence page 48213 (Admin guide, edited 2026-02-03) document a 50 MB default. `src/config/limits.ts:7` sets 10, since commit 91d0a7e (`lower upload cap`, 2026-03-11). Checks: no override in `config/` or the deployment manifests, the guide is not version-scoped. Done means doc, page and code state one number, and the doc says how to raise it.\n\n## Flow\n- admin reads the configuration guide and leaves the default\n- user uploads a 30 MB file\n- upload fails at 10 MB, which no doc mentions\n\n## Expected impact\nAdmins set the limit knowingly; fewer surprise upload failures. If 50 was the intended value, the fix is in code and the blast radius grows.\n\n## Evaluation\nClaim: docs - documented default equals the code default\nBefore: doc 50 MB, page 50 MB, code 10 MB\nAfter: all three state the same value\nMethod: quote - the three lines read, plus the commit that changed the code\nFalsified if: a deployment config overrides the code default to 50 everywhere",
  "evidence": [{"type":"doc","ref":"docs/configuration.md:44","quote":"| `MAX_UPLOAD_MB` | `50` | Largest accepted upload. |"},{"type":"page","ref":"48213","quote":"Uploads are limited to 50 MB unless MAX_UPLOAD_MB is set.","url":"https://acme.atlassian.net/wiki/spaces/ADM/pages/48213"},{"type":"code","ref":"src/config/limits.ts:7","quote":"export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 10);"},{"type":"git","ref":"91d0a7e","quote":"lower upload cap"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["docs/configuration.md","src/config/limits.ts#MAX_UPLOAD_MB"]},
  "confidence": "high",
  "confidence_why": "Sure, tier 2: all values are quoted verbatim and no override was found; the page predates the code change.",
  "doc_impact": ["docs/configuration.md","Confluence 48213 Admin guide"],
  "delivery_risk": {"blast":"low"},
  "impact": 6,
  "impact_why": "Tier 2, a documented step fails: uploads between 10 and 50 MB are refused against the configuration guide.",
  "risk": 2,
  "predicted_verdict": "accept",
  "predicted_why": "Closest precedent \"Configuration guide states the wrong request timeout\" (5d0c2a7e91b3f468) accepted: a wrong default in the same guide was taken as a doc fix.",
  "artifacts": [{"kind":"table","message":"The guide and the admin page say 50 MB; the code enforces 10 MB","alt":"Table of three places that state the MAX_UPLOAD_MB default: the configuration guide says 50 MB, Confluence page 48213 says 50 MB, src/config/limits.ts sets 10 MB since commit 91d0a7e.","refs":["docs/configuration.md:44","48213","src/config/limits.ts:7","91d0a7e"],"data":{"columns":["Side","Place","Says"],"rows":[["doc","docs/configuration.md:44","50 MB default"],["page","Admin guide (48213)","50 MB default"],["code","src/config/limits.ts:7","10 MB default"],["git","91d0a7e","lowered to 10 MB"]],"highlight":[0,1]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```
