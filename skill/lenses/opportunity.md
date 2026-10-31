---
id: opportunity
version: 0.3.2
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

Unconnected, the lens runs `partial` on code and docs: it can find hidden capabilities and
unkept doc promises, never claim demand. Every candidate is then `confidence: low`, and
`confidence_why` says "not connected: tickets and goals unchecked".

## Direction

`context.direction` is the team's steer from Forge Settings. Absent, run everything as written.

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

Window: `since` is today minus 90 days (incremental: the later of that and the `since_sha`
commit date). State the window in every demand claim.

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
   **Slow-burning demand.** Re-run a theme's query once over 180 days when the 90-day count is
   3-9 and step 3 finds a mechanism, or when 3 or more tickets fall in the window's first 14
   days. Ingest it; report both counts with windows (`6 in 90 days, 14 in 180 days`) in
   Description and the table's `Tickets` cell. Tier by the 90-day count, one step up only when
   it is at least half the 180-day count (demand is not fading).
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

A step that yields nothing is recorded ("tickets query X: 0 results") and you go on.

## Sources

- Cite only the `ref` values `ingest-sources` returned this run, as `ticket` or `goal`
  evidence with their `url`; `verify` drops any other (`ref-not-ingested`).
- Ticket rows carry `components`, `labels` and `created_at` when Jira has them: the grouping
  and the window. Never invent a component: group such a ticket by its ask and say so.
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

Report every hypothesis with what it was pointed at (unconnected: as Sources says).

## Ranking

Rank in this order, and never by how finished the code is:

1. **Demand tier** of the candidate's theme in the window: strong (10 or more tickets, or 3 or
   more components), medium (5-9), weak (1-4), none. A goal-gap card ranks as medium when its
   goal is active.
2. **Goal fit**: the theme serves an ingested goal, or the direction notes' outcome.
3. **Focus**: a direction focus topic.
4. **Code readiness**: how much of the mechanism exists. It sets effort and breaks ties. It
   never lifts a candidate over a higher demand tier.

A half-built, flag-gated capability with weak demand loses to a strong theme the code serves
in part. Name the losers in the lens report: `ranked <topic> (<n> tickets) over <topic> (<n>)`.
Write every evidenced candidate: the store ranks by score (top card = MVP), the rest go to
`reserve`. The order above reaches the store through `impact`.

## Impact, risk and the predicted verdict

Set `impact` (1-10) from the **demand tier**, with `impact_why` naming the tier, the ticket
count and the window in one line ("strong: 14 tickets in 90 days, 3 components"):

| Demand tier | impact |
| --- | --- |
| strong (10+ tickets, or 3+ components) | 8 |
| medium (5-9), or a goal-gap on an active goal | 6 |
| weak (1-4) | 4 |
| none (unconnected: a capability-exists claim) | 2 |

Add 1 when the theme serves an ingested goal or the direction notes' outcome (at most 9). Code
readiness never raises impact: it lowers `effort`. `risk` is the risk of making the change
(exposing an internal call behind a flag 2, a new public route 5, a change to billing or auth 8);
omit it and the store reads `delivery_risk.blast`. `category` is `product`, this lens's default, and
stays so: the store clamps a `technical` label back to `product` (`clamped` on the propose line), so no opportunity card skips the person's gate. Every card carries your `predicted_verdict` (`accept`, `reject` or `defer`) and a
`predicted_why`, after reading `context`'s `near` (reasons, notes) and `outcomes` (notes). With
a precedent, quote it ("an export card was accepted and rated right"); without one, give your
own reason (`references/cards.md`).

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

- **Demand table** (`table`). **Check before `propose`, once per demand card:** 8 or more
  tickets, or 2 or more groups, in its Description: the card carries one, or the lens report says
  why the numbers do not hold. Fewer: no view. Columns: `Component or label`, `Tickets
  (<window>)`, `Cited`, `Code today`; one row per group, an `All` row last, `highlight` on the
  group the first delivery serves. Every count also appears in Description. `refs`: the cited
  ticket refs and the code ref.
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

Read `<skill-dir>/references/examples/opportunity.md` before the first card (a demand table, a
goal-fit matrix, a card with no view). In the jsonl each card is one line.

## No finding

```
opportunity: ran|partial (<reason>) - no proposals.
Window: <since> to <today>. Demand themes: <theme> <n>, <theme> <n> | none of 3 or more.
Checked: H1 <what was pointed at, e.g. 14 exported functions, all called by a route>;
H2 <...>; H3 <...|unchecked: not connected>; H4 <...|unchecked: not connected>; H5 <...>.
Excluded by direction: <topic> (<n> tickets) | none.
```
