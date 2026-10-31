# Opportunity - worked example cards

The cards the `opportunity` pack (`lenses/opportunity.md`, 0.3.2) points to. They are spread over
several lines here, one field per line, so each line stays readable; in
`<work>/opportunity.jsonl` every card is **one line** (`JSON.stringify` of the object). Each one
passes `propose`'s validation and is scored by the store.

A demand table (12 tickets in 3 groups, a precedent quoted), a goal-fit matrix (H4, predicted
`defer` with the judge's reason), and a card with no view (one group of 7 tickets). The first
card sets `risk` 5 for a new public route, so its `blast` is `medium` to match; the second omits
`risk` and the store reads its `blast`.

```json
{
  "lens": "opportunity",
  "kind": "expose-capability",
  "topic": "csv-export-reports",
  "anchors": ["src/export/csv.ts#toCsv","src/routes/reports.ts"],
  "title": "Export for reports that already have a CSV writer",
  "rationale": "Twelve tickets in 90 days ask to export reports to a spreadsheet, most from the Reports area. A CSV writer already exists but only an internal job uses it. Exposing it serves the self-serve reporting goal.",
  "body": "## Summary\nAdd a CSV download to the reports page using the existing CSV writer.\n\n## Description\nThe CSV writer exists (`src/export/csv.ts:41`) and is called only by the nightly audit job. The reports route has no export action (`src/routes/reports.ts:8`). The queries `feature request OR please add` and `export OR csv OR spreadsheet OR download`, since 2026-07-30 (90 days), returned 12 export tickets: component Reports 7 (SUP-118, SUP-131, SUP-140), component Billing 3 (SUP-152), label export with no component 2. Goal G-7 names self-serve reporting. Done means a Download CSV action on every report.\n\n## Flow\n- add a GET /reports/:id/export.csv route that calls toCsv\n- add a Download CSV button to the report header\n- test: a report with 3 rows exports 3 data lines plus a header\n\n## Expected impact\nCustomers export without asking support; export tickets should stop arriving. Large reports could time out if streamed naively.\n\n## Evaluation\nClaim: user - customers can export any report themselves\nBefore: 12 tickets in 90 days ask for export; 0 routes call toCsv\nAfter: 1 route calls toCsv; new export tickets per month taken from the same query\nMethod: count - ticket query plus git grep for toCsv callers\nFalsified if: the tickets ask for a format CSV cannot carry, such as charts",
  "evidence": [{"type":"code","ref":"src/export/csv.ts:41","quote":"export function toCsv(rows: Row[]): string {"},{"type":"code","ref":"src/routes/reports.ts:8","quote":"router.get('/reports/:id', showReport);"},{"type":"ticket","ref":"SUP-118","url":"https://example.atlassian.net/browse/SUP-118"},{"type":"ticket","ref":"SUP-131","url":"https://example.atlassian.net/browse/SUP-131"},{"type":"ticket","ref":"SUP-140","url":"https://example.atlassian.net/browse/SUP-140"},{"type":"ticket","ref":"SUP-152","url":"https://example.atlassian.net/browse/SUP-152"},{"type":"goal","ref":"G-7","url":"https://example.atlassian.net/goals/G-7"}],
  "effort": {"size":"M","days_low":2,"days_high":4,"basis":["src/export/csv.ts#toCsv","src/routes/reports.ts"]},
  "confidence": "high",
  "confidence_why": "Twelve tickets across two components, a goal and the code agree; a sample export on real report data would raise it further.",
  "doc_impact": ["docs/reports.md"],
  "delivery_risk": {"blast":"medium"},
  "impact": 9,
  "impact_why": "Strong: 12 tickets in 90 days across 3 groups, +1 for goal G-7 (self-serve reporting).",
  "risk": 5,
  "predicted_verdict": "accept",
  "predicted_why": "Closest precedent \"Export for invoices that already have a PDF writer\" (a41f07c3d2e95b18) accepted: exposing an existing writer was taken when demand was strong.",
  "artifacts": [{"kind":"table","message":"7 of 12 export asks in 90 days come from Reports, where a CSV writer exists","alt":"Table of export tickets created in the last 90 days, grouped by Jira component: Reports 7, Billing 3, label export without a component 2, all 12. The code has a CSV writer, toCsv, and no route that calls it.","refs":["SUP-118","SUP-131","SUP-140","SUP-152","src/export/csv.ts:41"],"data":{"columns":["Component or label","Tickets (90 days)","Cited","Code today"],"rows":[["Reports","7","SUP-118, SUP-131, SUP-140","toCsv, no route"],["Billing","3","SUP-152","toCsv, no route"],["label: export","2","none","toCsv, no route"],["All","12","4","1 writer, 0 routes"]],"highlight":[0]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "opportunity",
  "kind": "goal-gap",
  "topic": "retention-nudges-new-accounts",
  "anchors": ["src/jobs/scheduler.ts","src/notify/digest.ts"],
  "title": "No work serves the first-30-days retention goal",
  "rationale": "Goal G-4 commits to keeping new accounts active in their first month. None of its three outcomes has a code path, a flag or a recent change behind it. The scheduler and a digest stub are where the work would start.",
  "body": "## Summary\nStart the first-30-days retention goal with a trial-end reminder on the existing scheduler.\n\n## Description\nGoal G-4 (active) names three outcomes: an onboarding checklist, a trial-end reminder and a weekly usage digest. `git grep -n -i -E \"onboarding|checklist|trial.?end|reminder\" -- ':!**/*test*'` returned nothing; `git log --since=90.days` touches none of these. The only trace is a stub (`src/notify/digest.ts:3`). The daily scheduler (`src/jobs/scheduler.ts:15`) can carry a reminder job. Done means one outcome ships and the goal has a code path.\n\n## Flow\n- add a trial-end reminder job to the daily scheduler\n- send it three days before the trial ends\n- test: an account 3 days from trial end gets one reminder\n\n## Expected impact\nThe goal gets its first delivered outcome; trial accounts are reminded before they lapse. A reminder sent to converted accounts would annoy them, so the job checks the plan.\n\n## Evaluation\nClaim: goal - G-4 has at least one outcome with a code path\nBefore: 0 of 3 outcomes have a code path, flag or commit in 90 days\nAfter: 1 of 3 outcomes has a code path\nMethod: count - the same git grep and git log per outcome\nFalsified if: another service outside this repo already sends these reminders",
  "evidence": [{"type":"goal","ref":"G-4","url":"https://example.atlassian.net/goals/G-4"},{"type":"code","ref":"src/jobs/scheduler.ts:15","quote":"scheduler.every('1d', runDailyJobs);"},{"type":"code","ref":"src/notify/digest.ts:3","quote":"// TODO: weekly usage digest"}],
  "effort": {"size":"M","days_low":2,"days_high":4,"basis":["src/jobs/scheduler.ts","src/notify/digest.ts"]},
  "confidence": "medium",
  "confidence_why": "The goal and the empty searches agree; another service could send reminders, which only the goal owner can rule out.",
  "delivery_risk": {"blast":"low"},
  "impact": 6,
  "impact_why": "Goal gap on an active goal (G-4, first-30-days retention): no code path, flag or recent change serves it.",
  "predicted_verdict": "defer",
  "predicted_why": "No similar decision in near or outcomes. The goal is active, but which outcome to serve first is a product call the evidence cannot make.",
  "artifacts": [{"kind":"matrix","message":"None of goal G-4's three outcomes has code, a flag or a commit in 90 days","alt":"Matrix of goal G-4's three outcomes against three signals: code path, feature flag and commits in the last 90 days. Onboarding checklist and trial-end reminder show none for all three. Weekly usage digest has a TODO stub in code, no flag and no commits.","refs":["G-4","src/notify/digest.ts:3"],"data":{"rows":["Onboarding checklist","Trial-end reminder","Weekly usage digest"],"columns":["Code path","Flag","Commits 90d"],"cells":[[{"v":"none","level":0},{"v":"none","level":0},{"v":"none","level":0}],[{"v":"none","level":0},{"v":"none","level":0},{"v":"none","level":0}],[{"v":"TODO stub","level":1},{"v":"none","level":0},{"v":"none","level":0}]]}}],
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```

```json
{
  "lens": "opportunity",
  "kind": "workflow-shortcut",
  "topic": "bulk-invite-users",
  "anchors": ["src/users/invite.ts#inviteUser","src/admin/users-page.tsx"],
  "title": "Invite a whole team at once instead of one person at a time",
  "rationale": "Admins invite people one by one and ask support to load lists. The invite function already loops safely over addresses in the signup job. A bulk form saves admins minutes per new team.",
  "body": "## Summary\nLet admins paste a list of emails on the users page and invite them in one action.\n\n## Description\n`inviteUser` handles one address (`src/users/invite.ts:22`); the signup job already calls it in a loop with rate limiting. The users page offers only a single email field (`src/admin/users-page.tsx:57`). The query `workaround OR manually OR ask support`, since 2026-07-30 (90 days), returned 7 tickets, all component Admin, asking support to add lists of users (SUP-201, SUP-207, SUP-219). Done means a paste box that invites up to 100 addresses and reports failures per address.\n\n## Flow\n- reuse the signup job's loop as an inviteMany helper\n- add a paste box and a result list to the users page\n- test: 3 valid and 1 invalid address yield 3 invites and 1 named error\n\n## Expected impact\nAdmins onboard a team in one step; support stops loading lists by hand. A large paste could hit the email rate limit, so the existing limiter must stay in the path.\n\n## Evaluation\nClaim: user - admins invite a team in one action\nBefore: 1 address per action; 7 support tickets in 90 days for manual list loads\nAfter: up to 100 addresses per action; manual-load tickets from the same query\nMethod: count - ticket query plus reading the users page\nFalsified if: most list loads come from an SSO directory sync this would not replace",
  "evidence": [{"type":"code","ref":"src/users/invite.ts:22","quote":"export async function inviteUser(email: string, role: Role) {"},{"type":"code","ref":"src/admin/users-page.tsx:57","quote":"<input type=\"email\" name=\"invite\" />"},{"type":"ticket","ref":"SUP-201","url":"https://example.atlassian.net/browse/SUP-201"},{"type":"ticket","ref":"SUP-207","url":"https://example.atlassian.net/browse/SUP-207"},{"type":"ticket","ref":"SUP-219","url":"https://example.atlassian.net/browse/SUP-219"}],
  "effort": {"size":"S","days_low":1,"days_high":2,"basis":["src/users/invite.ts#inviteUser","src/jobs/signup.ts","src/admin/users-page.tsx"]},
  "confidence": "medium",
  "confidence_why": "Medium demand in one component and the code agree, but no goal names onboarding speed; an admin interview would raise it.",
  "delivery_risk": {"blast":"low"},
  "impact": 6,
  "impact_why": "Medium: 7 tickets in 90 days ask to invite a list, all in the Admin component.",
  "risk": 2,
  "predicted_verdict": "accept",
  "predicted_why": "No similar decision in near or outcomes. The mechanism exists and the demand is measured; a small admin shortcut is the kind of card teams keep.",
  "provenance": {"lens_version":"0.3.2","model":"<model id>","harness":"claude-code"}
}
```
