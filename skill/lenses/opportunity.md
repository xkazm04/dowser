---
id: opportunity
version: 0.2.1
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

Demand leads. The lens starts from what many users ask for and then looks for the code that
half-serves it. A half-built capability that few people ask for is a lead, not a finding.

Unconnected, the lens runs `partial` on code and docs only. It can still find built-but-hidden
capabilities and documented promises the code does not keep. It cannot claim user demand.
Every candidate is then `confidence: low`, and `confidence_why` says "not connected: tickets
and goals unchecked".

## Direction

`context.direction` is the team's steer from Forge Settings. Absent, everything below runs as
written.

- **focus**: run one Gather step 2 query per focus topic, before the code-led queries, and in
  steps 3-6 read the paths and symbols that match a focus term first. In Ranking, a focus topic
  wins a tie within the same demand tier. It does not lift a weak-demand lead into a card.
- **exclude**: drop any candidate whose topic, theme, component or label matches an excluded
  topic before `propose`. Tickets in an excluded theme are not moved to another theme to
  inflate it. Never drop silently: the lens report lists `excluded by direction: <topic> (<n>
  tickets, <window>)`.
- **notes**: the team's intent in their words. When notes name an outcome or goal, treat it as
  goal fit in Ranking, and say in `confidence_why` when it decided the order. Notes never create
  demand and never relax an evidence rule.
- A local `--focus` applies on top of direction for this run only.

## Gather

Window: tickets created in the last 90 days, so `since` is today minus 90 days. On an
incremental run, use the later of that date and the `since_sha` commit date. State the window
in every demand claim.

1. **Demand sweep (connected).** Before reading code, call `dowser_sources_tickets` with
   `{query: "feature request OR please add OR would be great OR is there a way OR can you add", since, limit: 50}`
   and `{query: "workaround OR manually OR by hand OR ask support OR copy paste", since, limit: 50}`.
   Save each response and run `ingest-sources --run <run_id> --type ticket --file <saved>`.
   Group the returned `refs[]` by `components`, then by `labels`, then (for tickets with
   neither) by the ask in the title. Every group of 3 or more is a **demand theme**.
2. **Theme counts (connected).** For each demand theme, and each focus topic, send one query
   built from its words and synonyms (`"export OR csv OR spreadsheet OR download"`) with the
   same `since` and `limit: 50`, then ingest it. The count of a theme is the de-duplicated
   tickets across its queries whose `created_at` is inside the window; list undated tickets
   separately. A response of 50 items means "at least 50".
   **Slow-burning demand.** Re-run a theme's query once with `since` = today minus 180 days when
   the 90-day count is 3-9 and the theme has a mechanism in step 3, or when its tickets bunch at
   the window's start (3 or more `created_at` in the first 14 days). Ingest it and report both
   counts, each with its window (`6 in 90 days, 14 in 180 days`). Tier by the 90-day count;
   the 180-day count goes in Description and in the demand table's `Tickets` cell, and it
   moves the tier up one step only when the 90-day count is at least half of the 180-day count
   (demand is not fading).
3. **Mechanism per theme (code).** For each demand theme, search the code for the nouns and
   verbs of the ask: `git grep -n -i -E "<theme terms>" -- ':!**/*test*'`. Record what exists:
   a full path, a helper with no caller, a flag-gated path, or nothing.
4. **Capability inventory (code).** List entry points: `git ls-files` filtered to routes,
   controllers, handlers, CLI commands, pages and public exports, for example
   `**/routes/**`, `**/api/**`, `**/pages/**`, `**/commands/**`, `src/index.*`. Then grep for
   capabilities that are not exposed:
   `git grep -n -E "export (async )?function (to|export|import|convert|generate|sync|bulk|batch|schedule)"`,
   and check their callers with `git grep -n "<symbol>" -- ':!**/*test*'`. A capability whose
   only callers are tests or one internal job is a lead.
5. **Flags, stubs and doc promises.** `git grep -n -i -E "feature.?flag|isEnabled\(|TODO|FIXME|not (yet )?implemented|coming soon"`,
   and `README*`, `docs/**/*.md`, `CHANGELOG*` for "planned", "roadmap", "not yet". For each
   lead from steps 4-5 that no demand theme covers, send one theme query (step 2) to measure
   its demand. A lead with no ticket query behind it cannot be ranked.
6. **Recent direction (git).** `git log --since=90.days --name-only --format=%s | sort | uniq -c | sort -rn | head -40`
   shows where work is going. On an incremental run, start from the changed files.
7. **Goals (connected).** Call `dowser_sources_goals` with `{}` once, then
   `ingest-sources --run <run_id> --type goal --file <saved-response>`.

When a step yields nothing, record it ("no feature flags found", "tickets query X: 0 results")
and go on.

## Sources

- Cite only the `ref` values `ingest-sources` returned this run, as `ticket` or `goal`
  evidence with their `url`. `verify` drops a card that cites any other ref
  (`ref-not-ingested`). A ticket you remember from another run is not evidence.
- The ticket rows carry `components`, `labels` and `created_at` when Jira has them. They are
  the grouping and the window. Do not invent a component for a ticket that has none: group it
  by its ask and say so.
- A goal row may carry `status`. A goal marked done is not a goal gap.
- Unconnected: steps 1, 2 and 7 are skipped, the lens is `partial: tickets and goals
  unavailable (H2, H3, H4, H5 demand unchecked)`.

## Hypotheses

- **H1 Built but hidden:** a capability exists in code (step 4), a demand theme or a doc
  promises it, and no route or UI exposes it. A flag or a stub alone is a lead: it becomes a
  card only with measured demand or a goal behind it. Kind: `expose-capability`.
- **H2 One step short:** a demand theme asks for a variant of an existing feature (a format, a
  filter, a bulk form), and step 3 found most of the mechanism. This is the lens's main finding.
  Kind: `extend-capability`.
- **H3 Recurring ask with nothing behind it:** 5 or more tickets in the window ask for the same
  thing and step 3 found no mechanism. Only propose it if the ask maps to a goal, otherwise it
  belongs to roadmap triage. Kind: `missing-capability`.
- **H4 Goal with no work:** a stated goal has no code path, flag or recent change serving it.
  Kind: `goal-gap`.
- **H5 Manual workaround:** tickets or docs describe users doing by hand what one existing call
  could do (copy-paste between screens, "ask support to run X"). Kind: `workflow-shortcut`.

Report every hypothesis with what it was pointed at. H3, H4 and H5 are unchecked when
unconnected, and the lens report says so.

## Ranking

Fill the budget in this order, and never by how finished the code is:

1. **Demand tier** of the candidate's theme in the window: strong (10 or more tickets, or 3 or
   more components), medium (5-9), weak (1-4), none. A goal-gap card ranks as medium when its
   goal is active.
2. **Goal fit**: the theme serves an ingested goal, or the direction notes' outcome.
3. **Focus**: a direction focus topic.
4. **Code readiness**: how much of the mechanism exists. It sets effort and breaks ties. It
   never lifts a candidate over a higher demand tier.

A half-built, flag-gated capability with weak demand loses to a strong theme the code serves
in part. Name the losers in the lens report: `ranked <topic> (<n> tickets) over <topic> (<n>)`.

## Evidence rules

- Every candidate quotes at least one `code` line: the capability, or the place it would plug
  in.
- A demand claim (H1-H3, H5) cites at least 3 `ticket` refs, and Description states the
  queries, the window, the grouping key (component, label or ask) and the total count.
  Unconnected, a demand claim is not allowed, only a "capability exists" claim.
- H4 cites the `goal` ref and the strongest evidence that nothing serves it: the search you
  ran, and its empty result, in Description.
- Do not count duplicate tickets from one customer as separate demand. When the title or body
  names the same account, count it once and say so.

## Artifacts

Attach a view only when it does a job the body cannot (`references/cards.md` "Artifacts").

**Check before `propose`, once per demand card:** count the tickets in its Description and the
groups it names. 8 or more tickets, or 2 or more groups: the card carries a demand table. A card
that meets the trigger without one is incomplete; add it, or say in the lens report why the
numbers do not hold. Fewer: no view.

- **Demand table** (`table`). Attach when the demand claim spans 2 or more groups or 8 or more
  tickets. Columns: `Component or label`, `Tickets (<window>)`, `Cited`, `Code today`; one row
  per group, an `All` row last, `highlight` on the group the first delivery serves. Every count
  also appears in Description. `refs`: the cited ticket refs and the code ref. One group of
  fewer than 8 tickets fits in one Description line: no view.
- **Goal-fit matrix** (`matrix`). Attach to a goal-gap card when 2 or more of the goal's
  outcomes were checked against 3 or more signals, or to any card weighed against 2 or more
  ingested goals. Rows: outcomes or goals. Columns: the signals checked (`Code path`, `Flag`,
  `Commits 90d`, `Tickets 90d`). Cells: two to four words, `level` 0 none to 3 strong. `refs`:
  the goal refs and any code ref a cell names.
- At most one of each per card. Never a view that restates effort, confidence or one number.

## Topic naming

`<capability>-<object>` in kebab case, naming what users would get, not how the code does it:
`csv-export-reports`, `bulk-invite-users`, `saved-filters-search`. No ticket keys, no file
names, no adjectives. Reuse a `near` item's topic when it is the same capability.

## Examples

A demand table (12 tickets in 3 groups), a goal-fit matrix (H4), and a card with no view (one
group of 7 tickets). Each line passes `validateCandidate`.

```jsonl
{"lens":"opportunity","kind":"expose-capability","topic":"csv-export-reports","anchors":["src/export/csv.ts#toCsv","src/routes/reports.ts"],"title":"Export for reports that already have a CSV writer","rationale":"Twelve tickets in 90 days ask to export reports to a spreadsheet, most from the Reports area. A CSV writer already exists but only an internal job uses it. Exposing it serves the self-serve reporting goal.","body":"## Summary\nAdd a CSV download to the reports page using the existing CSV writer.\n\n## Description\nThe CSV writer exists (`src/export/csv.ts:41`) and is called only by the nightly audit job. The reports route has no export action (`src/routes/reports.ts:8`). The queries `feature request OR please add` and `export OR csv OR spreadsheet OR download`, since 2026-07-30 (90 days), returned 12 export tickets: component Reports 7 (SUP-118, SUP-131, SUP-140), component Billing 3 (SUP-152), label export with no component 2. Goal G-7 names self-serve reporting. Done means a Download CSV action on every report.\n\n## Flow\n- add a GET /reports/:id/export.csv route that calls toCsv\n- add a Download CSV button to the report header\n- test: a report with 3 rows exports 3 data lines plus a header\n\n## Expected impact\nCustomers export without asking support; export tickets should stop arriving. Large reports could time out if streamed naively.\n\n## Evaluation\nClaim: user - customers can export any report themselves\nBefore: 12 tickets in 90 days ask for export; 0 routes call toCsv\nAfter: 1 route calls toCsv; new export tickets per month taken from the same query\nMethod: count - ticket query plus git grep for toCsv callers\nFalsified if: the tickets ask for a format CSV cannot carry, such as charts","evidence":[{"type":"code","ref":"src/export/csv.ts:41","quote":"export function toCsv(rows: Row[]): string {"},{"type":"code","ref":"src/routes/reports.ts:8","quote":"router.get('/reports/:id', showReport);"},{"type":"ticket","ref":"SUP-118","url":"https://example.atlassian.net/browse/SUP-118"},{"type":"ticket","ref":"SUP-131","url":"https://example.atlassian.net/browse/SUP-131"},{"type":"ticket","ref":"SUP-140","url":"https://example.atlassian.net/browse/SUP-140"},{"type":"ticket","ref":"SUP-152","url":"https://example.atlassian.net/browse/SUP-152"},{"type":"goal","ref":"G-7","url":"https://example.atlassian.net/goals/G-7"}],"effort":{"size":"M","days_low":2,"days_high":4,"basis":["src/export/csv.ts#toCsv","src/routes/reports.ts"]},"confidence":"high","confidence_why":"Twelve tickets across two components, a goal and the code agree; a sample export on real report data would raise it further.","doc_impact":["docs/reports.md"],"delivery_risk":{"blast":"low","bus_factor":1},"artifacts":[{"kind":"table","message":"7 of 12 export asks in 90 days come from Reports, where a CSV writer exists","alt":"Table of export tickets created in the last 90 days, grouped by Jira component: Reports 7, Billing 3, label export without a component 2, all 12. The code has a CSV writer, toCsv, and no route that calls it.","refs":["SUP-118","SUP-131","SUP-140","SUP-152","src/export/csv.ts:41"],"data":{"columns":["Component or label","Tickets (90 days)","Cited","Code today"],"rows":[["Reports","7","SUP-118, SUP-131, SUP-140","toCsv, no route"],["Billing","3","SUP-152","toCsv, no route"],["label: export","2","none","toCsv, no route"],["All","12","4","1 writer, 0 routes"]],"highlight":[0]}}],"provenance":{"lens_version":"0.2.1","model":"<model id>","harness":"claude-code"}}
{"lens":"opportunity","kind":"goal-gap","topic":"retention-nudges-new-accounts","anchors":["src/jobs/scheduler.ts","src/notify/digest.ts"],"title":"No work serves the first-30-days retention goal","rationale":"Goal G-4 commits to keeping new accounts active in their first month. None of its three outcomes has a code path, a flag or a recent change behind it. The scheduler and a digest stub are where the work would start.","body":"## Summary\nStart the first-30-days retention goal with a trial-end reminder on the existing scheduler.\n\n## Description\nGoal G-4 (active) names three outcomes: an onboarding checklist, a trial-end reminder and a weekly usage digest. `git grep -n -i -E \"onboarding|checklist|trial.?end|reminder\" -- ':!**/*test*'` returned nothing; `git log --since=90.days` touches none of these. The only trace is a stub (`src/notify/digest.ts:3`). The daily scheduler (`src/jobs/scheduler.ts:15`) can carry a reminder job. Done means one outcome ships and the goal has a code path.\n\n## Flow\n- add a trial-end reminder job to the daily scheduler\n- send it three days before the trial ends\n- test: an account 3 days from trial end gets one reminder\n\n## Expected impact\nThe goal gets its first delivered outcome; trial accounts are reminded before they lapse. A reminder sent to converted accounts would annoy them, so the job checks the plan.\n\n## Evaluation\nClaim: goal - G-4 has at least one outcome with a code path\nBefore: 0 of 3 outcomes have a code path, flag or commit in 90 days\nAfter: 1 of 3 outcomes has a code path\nMethod: count - the same git grep and git log per outcome\nFalsified if: another service outside this repo already sends these reminders","evidence":[{"type":"goal","ref":"G-4","url":"https://example.atlassian.net/goals/G-4"},{"type":"code","ref":"src/jobs/scheduler.ts:15","quote":"scheduler.every('1d', runDailyJobs);"},{"type":"code","ref":"src/notify/digest.ts:3","quote":"// TODO: weekly usage digest"}],"effort":{"size":"M","days_low":2,"days_high":4,"basis":["src/jobs/scheduler.ts","src/notify/digest.ts"]},"confidence":"medium","confidence_why":"The goal and the empty searches agree; another service could send reminders, which only the goal owner can rule out.","delivery_risk":{"blast":"low"},"artifacts":[{"kind":"matrix","message":"None of goal G-4's three outcomes has code, a flag or a commit in 90 days","alt":"Matrix of goal G-4's three outcomes against three signals: code path, feature flag and commits in the last 90 days. Onboarding checklist and trial-end reminder show none for all three. Weekly usage digest has a TODO stub in code, no flag and no commits.","refs":["G-4","src/notify/digest.ts:3"],"data":{"rows":["Onboarding checklist","Trial-end reminder","Weekly usage digest"],"columns":["Code path","Flag","Commits 90d"],"cells":[[{"v":"none","level":0},{"v":"none","level":0},{"v":"none","level":0}],[{"v":"none","level":0},{"v":"none","level":0},{"v":"none","level":0}],[{"v":"TODO stub","level":1},{"v":"none","level":0},{"v":"none","level":0}]]}}],"provenance":{"lens_version":"0.2.1","model":"<model id>","harness":"claude-code"}}
{"lens":"opportunity","kind":"workflow-shortcut","topic":"bulk-invite-users","anchors":["src/users/invite.ts#inviteUser","src/admin/users-page.tsx"],"title":"Invite a whole team at once instead of one person at a time","rationale":"Admins invite people one by one and ask support to load lists. The invite function already loops safely over addresses in the signup job. A bulk form saves admins minutes per new team.","body":"## Summary\nLet admins paste a list of emails on the users page and invite them in one action.\n\n## Description\n`inviteUser` handles one address (`src/users/invite.ts:22`); the signup job already calls it in a loop with rate limiting. The users page offers only a single email field (`src/admin/users-page.tsx:57`). The query `workaround OR manually OR ask support`, since 2026-07-30 (90 days), returned 7 tickets, all component Admin, asking support to add lists of users (SUP-201, SUP-207, SUP-219). Done means a paste box that invites up to 100 addresses and reports failures per address.\n\n## Flow\n- reuse the signup job's loop as an inviteMany helper\n- add a paste box and a result list to the users page\n- test: 3 valid and 1 invalid address yield 3 invites and 1 named error\n\n## Expected impact\nAdmins onboard a team in one step; support stops loading lists by hand. A large paste could hit the email rate limit, so the existing limiter must stay in the path.\n\n## Evaluation\nClaim: user - admins invite a team in one action\nBefore: 1 address per action; 7 support tickets in 90 days for manual list loads\nAfter: up to 100 addresses per action; manual-load tickets from the same query\nMethod: count - ticket query plus reading the users page\nFalsified if: most list loads come from an SSO directory sync this would not replace","evidence":[{"type":"code","ref":"src/users/invite.ts:22","quote":"export async function inviteUser(email: string, role: Role) {"},{"type":"code","ref":"src/admin/users-page.tsx:57","quote":"<input type=\"email\" name=\"invite\" />"},{"type":"ticket","ref":"SUP-201","url":"https://example.atlassian.net/browse/SUP-201"},{"type":"ticket","ref":"SUP-207","url":"https://example.atlassian.net/browse/SUP-207"},{"type":"ticket","ref":"SUP-219","url":"https://example.atlassian.net/browse/SUP-219"}],"effort":{"size":"S","days_low":1,"days_high":2,"basis":["src/users/invite.ts#inviteUser","src/jobs/signup.ts","src/admin/users-page.tsx"]},"confidence":"medium","confidence_why":"Medium demand in one component and the code agree, but no goal names onboarding speed; an admin interview would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.1","model":"<model id>","harness":"claude-code"}}
```

## No finding

```
opportunity: ran|partial (<reason>) - no proposals.
Window: <since> to <today>. Demand themes: <theme> <n>, <theme> <n> | none of 3 or more.
Checked: H1 <what was pointed at, e.g. 14 exported functions, all called by a route>;
H2 <...>; H3 <...|unchecked: not connected>; H4 <...|unchecked: not connected>; H5 <...>.
Excluded by direction: <topic> (<n> tickets) | none.
```

Changelog: 0.1.0 - first pack.
0.2.1 - the demand-table trigger is a check before `propose` (it did not fire on an 8-ticket card in 2 of 2 runs); slow-burning demand is re-counted over 180 days and reported beside the 90-day count; examples at 0.2.1. Measured 2026-10-29 (tools/lens-eval.mjs, fixture v3, default model, n = 1 run of 4 cards): recall at budget 1.0, precision 1.0, priority-1 2/2, focus 1/1, decoy hits 0, direction violations 0, views valid 1/1 (the demand table fired; 0.2.0: 0/0 on fixture v2).
0.2.0 - demand-led: ticket sweep before code, themes by component/label/ask over a stated 90-day window, Ranking puts demand tier above code readiness (baseline: a flag-gated build with weak demand outranked a half-served demand cluster); Direction, Sources, Artifacts (demand table, goal-fit matrix); examples at 0.2.0, one per view and one without.
Measured 2026-10-28 (tools/lens-eval.mjs, fixture v2, default model, n = 2 runs of 4 cards): recall at budget 1.0 both runs (0.1.0: 0.75), precision 1.0, decoy hits 0, direction violations 0, views 0/0 (the demand-table trigger did not fire on an 8-ticket card: open). The CSV-export finding was proposed merged into an order-history card; the 90-day window left out its older tickets.
