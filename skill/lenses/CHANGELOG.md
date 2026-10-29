# Lens pack changelog

One section per pack, newest version last. The agent never reads this file during a scan; the packs carry
only what a scan needs. Rules for recording a version (fixture score, hand-verified precision, each with its
`n` and date) are in `references/lens-authoring.md` "Measuring a lens".

## opportunity (Opportunity)

- 0.1.0 - first pack.
- 0.2.0 - demand-led: ticket sweep before code, themes by component/label/ask over a stated 90-day window, Ranking puts demand tier above code readiness (baseline: a flag-gated build with weak demand outranked a half-served demand cluster); Direction, Sources, Artifacts (demand table, goal-fit matrix); examples at 0.2.0, one per view and one without.
  Measured 2026-10-28 (tools/lens-eval.mjs, fixture v2, default model, n = 2 runs of 4 cards): recall at budget 1.0 both runs (0.1.0: 0.75), precision 1.0, decoy hits 0, direction violations 0, views 0/0 (the demand-table trigger did not fire on an 8-ticket card: open). The CSV-export finding was proposed merged into an order-history card; the 90-day window left out its older tickets.
- 0.2.1 - the demand-table trigger is a check before `propose` (it did not fire on an 8-ticket card in 2 of 2 runs); slow-burning demand is re-counted over 180 days and reported beside the 90-day count; examples at 0.2.1. Measured 2026-10-29 (tools/lens-eval.mjs, fixture v3, default model, n = 1 run of 4 cards): recall at budget 1.0, precision 1.0, priority-1 2/2, focus 1/1, decoy hits 0, direction violations 0, views valid 1/1 (the demand table fired; 0.2.0: 0/0 on fixture v2).

## ux-friction (UX friction and wellbeing)

- 0.1.0 - first pack.
- 0.2.0 - direction (focus orders Gather, exclude reported, notes rank); tickets grouped by component/label with a stated window and tagged blocked or annoyed; choosing under the budget by tier, reach and evidence; recovery checked one level up; flow view on every flow defect, before-after for step counts, WCAG table for multi-site H4; four examples, one without a view. Measured 2026-10-28 (tools/lens-eval.mjs, fixture v2, default model, n = 1 run of 4 cards): recall at budget 1.0, precision 1.0, priority-1 3/3, decoy hits 0, direction violations 0, views valid 4/4 (0.1.0 on the same fixture: views 3/3).

## doc-drift (Doc drift)

- 0.1.0 - first pack.
- 0.2.0 - direction (focus, exclude, notes, spaces per Confluence space), ingested-only page refs with `updated_at`, step 7 disconfirm checks (still-supported path, scoped, historical, override), ranking by reader harm then certainty, "doc says / code does" table on H1/H4 and multi-place H2.
  Measured 2026-10-28 (tools/lens-eval.mjs, fixture v2, default model, n = 1 run of 4 cards): recall at budget 1.0, precision 1.0, priority-1 2/2, decoy hits 0, direction violations 0, views valid 4/4 (0.1.0 on the same fixture: same recall and precision, views 0/0).

## security-cra (Security and CRA)

- 0.1.0 - first pack.
- 0.2.0 - `deps` as the only dependency source (skipped auditor = partial); scope and reach per dep ref; exposure classes and a ranked budget; direction (focus, exclude, notes); dependency table, reach flow and CRA obligation matrix views. Measured 2026-10-28 (tools/lens-eval.mjs, fixture v2, default model, n = 2 runs of 4 cards): recall at budget 1.0, precision 1.0, decoy hits 0 (dev-only critical and test key cleared), direction violations 0, views 1/1 both runs (0.1.0: 0/0). The lodash advisory was cut at rank 4 with its reason (constant template, unreachable); the fixture's priority-1 label for it is under review.
- 0.2.1 - dependency table gains a `Fixed in` column from the `deps` ref's `fixed_in` (`none known` when absent); `deps` refs now carry `url` and `fixed_in`.
- 0.2.2 - `deps` audits manifest directories below the root (workspaces, apps, services; three levels, test and fixture paths reported as `not_audited`); refs carry the lockfile path.
- 0.2.3 - off-focus candidates fill slots the focused ones leave empty (dogfood wave 3: a high advisory sat in the summary with all 4 slots free).
