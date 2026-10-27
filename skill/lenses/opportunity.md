---
id: opportunity
version: 0.1.0
name: Opportunity
kinds: [expose-capability, extend-capability, missing-capability, goal-gap, workflow-shortcut]
sources: [code, docs, git, tickets, goals]
optional_sources: []
requires_connection: true
budget: 4
---
# Opportunity

## What it finds

Recurring user asks that the code almost supports, and stated goals that no work serves. The
lens joins three things nobody holds at once: what users ask for (tickets), what the code can
already do, and where the company says it is going (goals). Example from the plan: "40 tickets
ask for export; an internal CSV serializer exists - expose it, about 2 days, supports goal X".

Unconnected, the lens runs `partial` on code and docs only. It can still find built-but-hidden
capabilities and documented promises the code does not keep. It cannot claim user demand.
Every candidate is then `confidence: low`, and `confidence_why` says "not connected: tickets
and goals unchecked".

## Gather

1. **Capability inventory (code).** List entry points: `git ls-files` filtered to routes,
   controllers, handlers, CLI commands, pages and public exports, for example
   `**/routes/**`, `**/api/**`, `**/pages/**`, `**/commands/**`, `src/index.*`. Read the
   largest and most-imported ones (`git grep -c "import .*<module>"` gives a rough fan-in).
2. **Internal-only capabilities.** Grep for capabilities that exist but are not exposed:
   `git grep -n -E "export (async )?function (to|export|import|convert|generate|sync|bulk|batch|schedule)"`.
   Then check whether any route, UI or command calls them:
   `git grep -n "<symbol>" -- ':!**/*test*'`. A capability whose only callers are tests or one
   internal job is a lead.
3. **Flags and stubs.** `git grep -n -i -E "feature.?flag|isEnabled\(|TODO|FIXME|not (yet )?implemented|coming soon"`.
   A switched-off flag around finished code is a lead.
4. **Docs promises.** `README*`, `docs/**/*.md`, `CHANGELOG*`: claims about planned or partial
   features ("planned", "roadmap", "not yet").
5. **Recent direction (git).** `git log --since=90.days --name-only --format=%s | sort | uniq -c | sort -rn | head -40`
   shows where work is going. On an incremental run, start from the changed files.
6. **Tickets (connected).** Call `dowser_sources_tickets` with `{query, limit: 50}`, once per
   capability theme from steps 1-4 (for example `"export OR csv OR download"`), plus one open query
   for the most common asks (`{query: "feature request OR please add OR would be great", limit: 50}`).
   Add `since` from the context pack's `since_sha` date on an incremental run. Then
   `ingest-sources --type ticket`.
7. **Goals (connected).** Call `dowser_sources_goals` with `{}` once, then
   `ingest-sources --type goal`.

When a step yields nothing, record it ("no feature flags found", "tickets query X: 0 results")
and go on.

## Hypotheses

- **H1 Built but hidden:** a capability exists in code (step 2), and users ask for it (tickets)
  or a doc promises it, but no route or UI exposes it. Kind: `expose-capability`.
- **H2 One step short:** users repeatedly ask for a variant of an existing feature (a format, a
  filter, a bulk form), and the code already holds most of the mechanism. Kind:
  `extend-capability`.
- **H3 Recurring ask with nothing behind it:** 5 or more tickets ask for the same thing and the
  code holds no mechanism. Only propose it if the ask maps to a goal, otherwise it belongs to
  roadmap triage. Kind: `missing-capability`.
- **H4 Goal with no work:** a stated goal has no code path, flag or recent change serving it.
  Kind: `goal-gap`.
- **H5 Manual workaround:** tickets or docs describe users doing by hand what one existing call
  could do (copy-paste between screens, "ask support to run X"). Kind: `workflow-shortcut`.

Report every hypothesis with what it was pointed at. H3, H4 and H5 are unchecked when
unconnected, and the lens report says so.

## Evidence rules

- Every candidate quotes at least one `code` line: the capability, or the place it would plug
  in.
- A demand claim (H1-H3, H5) cites at least 3 `ticket` refs and states the query and the total
  count in Description. Unconnected, a demand claim is not allowed, only a "capability exists"
  claim.
- H4 cites the `goal` ref and the strongest evidence that nothing serves it: the search you
  ran, and its empty result, in Description.
- Do not count duplicate tickets from one customer as separate demand.

## Topic naming

`<capability>-<object>` in kebab case, naming what users would get, not how the code does it:
`csv-export-reports`, `bulk-invite-users`, `saved-filters-search`. No ticket keys, no file
names, no adjectives. Reuse a `near` item's topic when it is the same capability.

## Examples

```jsonl
{"lens":"opportunity","kind":"expose-capability","topic":"csv-export-reports","anchors":["src/export/csv.ts#toCsv","src/routes/reports.ts"],"title":"Export for reports that already have a CSV writer","rationale":"Customers keep asking to export reports to a spreadsheet. A CSV writer already exists but only an internal job uses it. Exposing it serves the self-serve reporting goal.","body":"## Summary\nAdd a CSV download to the reports page using the existing CSV writer.\n\n## Description\nThe CSV writer exists (`src/export/csv.ts:41`) and is called only by the nightly audit job (`src/jobs/audit.ts:12`). The reports route has no export action (`src/routes/reports.ts:8`). Tickets SUP-118, SUP-131 and SUP-140 ask for spreadsheet export; the query `export OR csv` returned 12. Goal G-7 names self-serve reporting. Done means a Download CSV action on every report.\n\n## Flow\n- add a GET /reports/:id/export.csv route that calls toCsv\n- add a Download CSV button to the report header\n- test: a report with 3 rows exports 3 data lines plus a header\n\n## Expected impact\nCustomers export without asking support; export tickets should stop arriving. Large reports could time out if streamed naively.\n\n## Evaluation\nClaim: user - customers can export any report themselves\nBefore: 12 tickets in 90 days ask for export; 0 routes call toCsv\nAfter: 1 route calls toCsv; new export tickets per month taken from the same query\nMethod: count - ticket query plus git grep for toCsv callers\nFalsified if: the tickets ask for a format CSV cannot carry, such as charts","evidence":[{"type":"code","ref":"src/export/csv.ts:41","quote":"export function toCsv(rows: Row[]): string {"},{"type":"code","ref":"src/routes/reports.ts:8","quote":"router.get('/reports/:id', showReport);"},{"type":"ticket","ref":"SUP-118","url":"https://example.atlassian.net/browse/SUP-118"},{"type":"ticket","ref":"SUP-131","url":"https://example.atlassian.net/browse/SUP-131"},{"type":"ticket","ref":"SUP-140","url":"https://example.atlassian.net/browse/SUP-140"},{"type":"goal","ref":"G-7","url":"https://example.atlassian.net/goals/G-7"}],"effort":{"size":"M","days_low":2,"days_high":4,"basis":["src/export/csv.ts#toCsv","src/routes/reports.ts"]},"confidence":"high","confidence_why":"Tickets, a goal and the code agree; a sample export on real report data would raise it further.","doc_impact":["docs/reports.md"],"delivery_risk":{"blast":"low","bus_factor":1},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code","run_id":"<run_id>"}}
{"lens":"opportunity","kind":"workflow-shortcut","topic":"bulk-invite-users","anchors":["src/users/invite.ts#inviteUser","src/admin/users-page.tsx"],"title":"Invite a whole team at once instead of one person at a time","rationale":"Admins invite people one by one and ask support to load lists. The invite function already loops safely over addresses in the signup job. A bulk form saves admins minutes per new team.","body":"## Summary\nLet admins paste a list of emails on the users page and invite them in one action.\n\n## Description\n`inviteUser` handles one address (`src/users/invite.ts:22`); the signup job already calls it in a loop with rate limiting (`src/jobs/signup.ts:30`). The users page offers only a single email field (`src/admin/users-page.tsx:57`). Tickets SUP-201, SUP-207 and SUP-219 ask support to add lists of users. Done means a paste box that invites up to 100 addresses and reports failures per address.\n\n## Flow\n- reuse the signup job's loop as an inviteMany helper\n- add a paste box and a result list to the users page\n- test: 3 valid and 1 invalid address yield 3 invites and 1 named error\n\n## Expected impact\nAdmins onboard a team in one step; support stops loading lists by hand. A large paste could hit the email rate limit, so the existing limiter must stay in the path.\n\n## Evaluation\nClaim: user - admins invite a team in one action\nBefore: 1 address per action; 7 support tickets in 90 days for manual list loads\nAfter: up to 100 addresses per action; manual-load tickets from the same query\nMethod: count - ticket query plus reading the users page\nFalsified if: most list loads come from an SSO directory sync this would not replace","evidence":[{"type":"code","ref":"src/users/invite.ts:22","quote":"export async function inviteUser(email: string, role: Role) {"},{"type":"code","ref":"src/admin/users-page.tsx:57","quote":"<input type=\"email\" name=\"invite\" />"},{"type":"ticket","ref":"SUP-201","url":"https://example.atlassian.net/browse/SUP-201"},{"type":"ticket","ref":"SUP-207","url":"https://example.atlassian.net/browse/SUP-207"},{"type":"ticket","ref":"SUP-219","url":"https://example.atlassian.net/browse/SUP-219"}],"effort":{"size":"S","days_low":1,"days_high":2,"basis":["src/users/invite.ts#inviteUser","src/jobs/signup.ts","src/admin/users-page.tsx"]},"confidence":"medium","confidence_why":"Tickets and code agree, but no goal names onboarding speed; an admin interview would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"claude-code","run_id":"<run_id>"}}
```

## No finding

```
opportunity: ran|partial (<reason>) - no proposals.
Checked: H1 <what was pointed at, e.g. 14 exported functions, all called by a route>;
H2 <...>; H3 <...|unchecked: not connected>; H4 <...|unchecked: not connected>; H5 <...>.
```

Changelog: 0.1.0 - first pack.
