# Moonshot scout: group core (proposal model and triage memory)

Read: docs/concepts/project-status-and-next-steps.md, AGENTS.md, docs/data-model.md, docs/evals/campaign/REPORT.md,
skill/scripts/lib/{memory,predict,sync,reflect,verify,git,scan-score,trust,store-core}.mjs, forge/src/core/reflect.mjs.

The store already records the full life of a proposal: the prediction, the verdict, the Jira issue and the outcome
rating. Every one of those facts flows only into prose for the next lens prompt. Nothing measures them, reconciles
them, or shares them. The cards below turn that unused memory into platform capabilities.

---

## 1. Detect shipped work from git and from changed evidence, and close the loop to Jira

- spine: shipped-outcome feedback loop
- size: L | impact 9 | effort 6 | risk 4 | confidence high
- impact_why: the plan names this demo arc itself ("it ships, the docs update"). It turns outcome rating from a
  chore into an observed fact, and it is the only measured "did it work" signal Dowser could have.

## Summary
On every run, check each `accepted` card against the repository. Look for commits that name its Jira key or DW
ref, and re-check its quoted evidence: did the quoted code change or disappear? Write the result to a new
append-only `deliveries` table, and send it to Forge. The outcome prompt can then say "shipped in abc123, 3 of 4
quotes changed, 11 days after accept" instead of asking a person cold.

## Description
- `issue_ref` is written (skill/scripts/lib/sync.mjs:425-426, store-core.mjs:120) and read back only by `show`
  (memory.mjs:272). No skill code uses it to look for delivery.
- `verify` re-checks only the run's `candidate` cards (verify.mjs:168-178; docs/data-model.md:267). An accepted
  card's quotes are never checked again, even though `findQuote` (verify.mjs:60) is a pure, reusable check.
- The git access exists, but `commitsSince` (git.mjs:163-187) returns only email, date and paths. With no sha and no
  subject, it cannot match "DOW-41" in a commit message.
- Forge reads the Jira status of accepted items only to order the manual rating prompt
  (forge/src/core/reflect.mjs:295-315). Two cases are invisible: an issue marked done with no code change, and a
  code change with no closed issue.
- In the campaign, the agent playing the team typed every outcome rating (58 accepted: 48 right, 10 partly;
  REPORT.md).

## Flow
1. git.mjs: add `commitsMentioning(root, base, head, refs[])`, which returns `{sha, at, subject, paths}` from
   `git log --format=%H%x1f%cI%x1f%s` plus a `--grep` for each batch of refs.
2. Store v7: add an append-only `deliveries` table `{fp, run_id, signal: commit|evidence-changed|evidence-gone|anchor-touched,
   sha?, at, detail_json}` with UNIQUE (fp, signal, sha), so replaying a run adds nothing.
3. Add `reconcile --run`, called by `run finish`. For every accepted fp: find the commits that mention it, re-run
   `findQuote` on its asserted code and doc evidence, and intersect its anchor paths with `diffNames(base, head)`.
4. Derive a delivery state per fp: `not-started`, `in-progress`, or `shipped` (every quote changed or gone, or a
   commit names the card). Record the lead time from accept to the first and the last commit, and compare the
   actual days with `effort.days_low/high` (model.mjs:131).
5. Add `deliveries_json` to `reflect export` (an additive forge-mcp-2 field). The Forge outcome prompt shows these
   facts up front, and the Reflect tab lists "shipped, unrated" first.
6. The contextPack `outcomes` section gains `shipped_unrated` and the measured effort error per lens, as measured
   facts rather than notes.
7. Doc-drift hook: when a shipped card's `doc_impact` pages were not touched by its commits, the next run gets a
   doc-drift lead.

## Expected impact
Every accepted card gets a delivery fact observed by the machine. The demo's third act ("it ships, the docs update")
becomes a real screen instead of narration. Card 2's effort calibration gets its ground truth.

## Evaluation
- Claim: accepted cards gain an observed delivery state without anyone entering it.
- Before: no code path in the skill reads `issue_ref` or re-checks accepted evidence (grep over
  skill/scripts/lib, 2026-11-04). All 58 campaign outcomes were rated by hand.
- After: on the next run, every accepted card whose code moved gets a `deliveries` row. Predicted coverage is at
  least 80% of the campaign's 58 accepted items, because each was built in this repo within one wave.
- Method: simulation, three cases walked.
  (a) DW-37 (RECORD_KEYS dropped `artifacts`): the fix edits the quoted line, so `findQuote` fails and the card goes
  to `evidence-changed`, then `shipped`. Correct.
  (b) A doc-drift card fixed by rewriting a paragraph: the quote is gone, so the card reads `shipped`. Correct, and
  the doc-impact check is satisfied.
  (c) An accepted card whose Jira issue was closed as "won't do" with no code change: there is no commit and the
  quotes are intact, so it stays `not-started` while Jira says done. The mismatch shows up as a signal, which is
  the intent.
  Edge case: an unrelated refactor changes the quotes and produces a false `shipped`. The rule above mitigates it
  by requiring either a commit that names the ref or a change to every quote.
- Result: better
- Gate: architecture (store v7 and an additive reflect field)

- unblocks: card 2 (effort and outcome calibration need ground truth); plan step 9 (the demo arc); a Forge
  "Shipped" column or Map overlay; suggested outcome ratings
- depends_on: none (the verdict pull already stores issue_ref)
- fits_deadline: yes. Local git work plus one additive reflect field, about 1.5 weeks. It fits the plan's weeks 3-4
  "shipped loop" slot.

---

## 2. Proposal-quality ledger: measure lens and ranking quality from real verdicts

- spine: proposal-quality measurement over time
- size: L | impact 8 | effort 5 | risk 3 | confidence high
- impact_why: ties break on Technological Implementation. "Dowser measures its own precision per lens version from
  your team's verdicts" is a claim other entries are unlikely to make. It is also the only way to know whether a
  lens pack change helped (0.3.2 is still unmeasured).

## Summary
Add a `quality` command and a store view that turn verdicts, predictions, bands and outcomes into metrics per slice.
A slice is lens x lens_version x model x period. Metrics: acceptance rate, the mix of reject reasons, ranked versus
reserve acceptance (does scan-score/1 rank well?), predicted-verdict agreement, the outcome right-rate, effort error
(from card 1), and the resurfaced and merged rates. Export the ledger over `dowser_reflect_sync`, show it on the
Learning tab, and require a slice comparison before a pack version bump.

## Description
- Outcomes reach two call sites, and both produce prose for the agent: contextPack (memory.mjs:186-187) and `show`
  (memory.mjs:271). Nothing aggregates them.
- `provenance.lens_version` is validated (model.mjs:473-479) and then only written as a string into `predicted_by`
  (predict.mjs:122). No metric is grouped by pack version.
- The allocator stores `band` (ranked or reserve; docs/data-model.md:129-133). No code checks whether reserve cards
  are accepted as often as ranked ones. That check is the test of whether scan-score/1 earns its place
  (scan-score.mjs:56-72, a fixed formula; docs/contracts/scan-finding-1.md:36).
- Trust replays prediction agreement per slice, but only for the L0/L1 gate (trust.mjs:77, 154). Its output is a
  level, not a quality report.
- The campaign's `docs/evals/campaign/quality.jsonl` (11 rows) measures the code, not the proposals.
  `tools/lens-eval.mjs` measures only a seeded fixture. REPORT.md asks for the four packs to be re-measured and
  notes that the opportunity measurement is n = 1.

## Flow
1. lib/quality.mjs: pure SQL over proposals, transitions, outcomes and deliveries. Each metric carries its n and its
   window, and a metric with n = 0 is omitted.
2. A read-only CLI: `quality [--lens] [--since] [--by lens_version|model|band]`.
3. Calibration rows: the acceptance rate for each score decile; a confusion matrix of predicted_verdict against the
   final verdict; and, for each effort size, the actual days from card 1.
4. Add `quality_json` to `reflect export`, and a "How well Dowser is doing here" panel to the Forge Learning tab.
5. Pack regression gate: `quality --compare <lens>@0.3.1..0.3.2` flags a drop in acceptance rate or right-rate above
   a threshold, when n >= 10.
6. Optional, on the registry side: use the calibration data for a scan-score/2 proposal (the contract says /1 is
   never edited).

## Expected impact
Any team, and the judges, can see measured precision per lens. The lens 5-7 work gets a yardstick. The duplicate
and acceptance numbers from the planned first real run get a permanent home instead of a one-off doc.

## Evaluation
- Claim: proposal quality becomes a measurement that can be queried and compared across versions.
- Before: no code in skill/scripts/lib aggregates outcomes, band or lens_version. The only two readers of outcomes
  produce prose.
- After: one command reports at least 6 metrics per slice, each with its n.
- Method: simulation over the campaign's numbers (65 proposed, 58 accepted, 2 rejected, 3 snoozed, 2 merged;
  outcomes 48 right, 10 partly, 0 wrong).
  (a) The acceptance rate is 89%. The ledger shows it and flags the slice as "above typical, possibly a lenient
  decider", which matches REPORT.md's own caveat.
  (b) Ranked versus reserve: if reserve cards were later accepted at the same rate, scan-score/1 adds nothing. That
  is the evidence a scan-score/2 needs.
  (c) Opportunity 0.3.1 against 0.3.2 with n = 1 in one slice: the gate refuses to decide, which is the honest
  "unmeasured" that the status doc states by hand today.
- Result: better
- Gate: direction (should the Learning tab give space to this?)

- unblocks: acceptance criteria for lenses 5-7; scan-score/2; evidence for or against raising the trust ceiling to
  L2; the plan step 2 duplicate rate as a repeatable metric; the Technological Implementation story for judges
- depends_on: card 1 for effort error only; the rest stands alone
- fits_deadline: yes. About 1 week for the CLI and metrics, and about 0.5 week for the Forge panel.

---

## 3. Forge as the memory of record: hydrate a fresh or CI store from the inbox

- spine: portable team memory
- size: L | impact 9 | effort 6 | risk 5 | confidence medium
- impact_why: memory is per machine today. A teammate's machine, a reinstall, or any CI or scheduled runner (plan
  weeks 3-4) starts blind and re-proposes everything the team already rejected. Fixing this is what makes Dowser a
  team product instead of a single-user tool.

## Summary
Add `dowser_memory_pull` (additive to forge-mcp-2). It returns the decided records of an inbox (fp, lens, kind,
topic, anchors, title, status, reason, note, decided_by and decided_at, issue_ref) and the state of the rules. Add
`hydrate --file`, which inserts those records into a local store as already-decided cards, each with a `forge:`
transition and its evidence keys. From day one, on any machine, suppression, near, precedents, rule offers and trust
then work.

## Description
- A verdict for an fp the local store never saw is reported as `unknown` and not applied (sync.mjs:433-435). On a
  fresh store, every decision a teammate made is dropped, and the run exits 1 (sync.mjs:402-404).
- Suppression and near come only from local `proposals` rows (memory.mjs:149-176). Precedent prediction scans only
  local decided rows (predict.mjs:75-90). Trust replays only local transitions (trust.mjs:47-53).
- The store lives per machine at `~/.dowser/projects/<key>` (paths.mjs:16; docs/data-model.md:10).
- Forge already holds the union. It keeps the full `record_json` per (project_key, fp) (forge/src/core/push.mjs:205,
  330), does its own resurfacing (push.mjs:387-394) and keeps rules per project (forge/src/core/reflect.mjs:92). The
  data exists; only the path back to the skill is missing.

## Flow
1. Contract: `dowser_memory_pull {project_key, cursor?, limit}` returns decided records (not open ones) plus rules,
   paged. Update the mock (tools/mock-forge-mcp.mjs) and the seam test first, as REPORT.md's seam lesson requires.
2. Forge core: a read-only query over proposals, rules and outcomes for the caller's inbox, with the same access
   check as verdicts_pull.
3. Skill: `hydrate --file` inserts each missing fp with a transition (NULL -> status, by `forge:<id>`, note
   `hydrated`) and evidence rows built from record_json. Both tables stay append-only. An fp that already exists is
   skipped, and a rule is inserted only when absent.
4. SKILL.md: on `init` with an empty store and a connection, pull memory before verdicts. Headless runs always do
   this.
5. ingest-verdicts: after a hydrate, an `unknown` fp is a real anomaly. Before one, `unknown` turns into a "run
   hydrate" hint.
6. Trust: hydrated transitions count, because they record real human decisions. A CI runner therefore inherits each
   slice's level.

## Expected impact
Two developers and a scheduled runner share one memory through Jira. Re-proposal of decided work falls to what the
fingerprint alone allows. Every scan adds an MCP round trip that matters, which supports the MCP bonus pitch: "the
agent's memory lives in Jira".

## Evaluation
- Claim: a fresh store reproduces the team's suppression set.
- Before: on a fresh store, 100% of pulled verdicts are `unknown` (sync.mjs:435). In campaign terms, none of the 7
  rejected, merged or snoozed items would be suppressed, although on the single machine all 7 stayed suppressed
  (REPORT.md, "Learning loop").
- After: all 7 suppressed after one `hydrate`, and the trust levels match the original machine.
- Method: simulation, three cases.
  (a) A CI runner with an empty `DOWSER_HOME` re-scans. Without hydrate, DW-33 (rejected, with fresh ticket demand)
  is re-proposed, and Forge's resurfacing check is the only filter. With hydrate, it is suppressed locally, with
  its reason in `near`.
  (b) Teammate B, after a rule offered on A's machine was accepted: the rule arrives as accepted, and B's lens
  prompt carries it.
  (c) A and B propose the same new fp before either pushes: the fp is deterministic, so Forge merges on
  (project_key, fp). Hydrate is not involved, and this keeps working.
- Result: better
- Gate: architecture (a new MCP tool and a contract version note)

- unblocks: the plan's scheduled and CI scans (weeks 3-4). It goes structurally beyond the open card "headless runs
  never push": without memory, a headless push would flood the inbox with re-proposals. Also card 5, and judging
  with a second account.
- depends_on: none
- fits_deadline: yes, but tight. About 1.5 weeks for the mock, the contract, the Forge query and the skill command,
  and it must deploy before the production freeze.

---

## 4. A persistent proposal graph: duplicate-of, follow-up-of, unblocks, conflicts

- spine: proposal relationship graph
- size: L | impact 7 | effort 6 | risk 4 | confidence medium
- impact_why: a backlog is a graph, not a list. A persisted graph lets Dowser put its cards in order ("accept A
  first, it unblocks B and C"), link `partly` outcomes to their follow-ups, and stop recomputing similarity on every
  call.

## Summary
Store v7 gains an append-only `edges` table `{from_fp, to_fp, kind: near|duplicate-of|follow-up-of|unblocks|conflicts|supersedes,
by, at, basis}`. The near tier and the precedent search write what they find as `near` edges; the agent and people
add the typed kinds. The allocator and Forge read the edges: ranked order respects `unblocks`, the inbox shows each
card's lineage, and a follow-up to a `partly` outcome links to its parent.

## Description
- The only relation in the model is `merged_into` (model.mjs:151, 210).
- `similar` computes overlap on each call and keeps nothing (memory.mjs:212). `closestPrecedent` scans every decided
  row of the lens, with a JSON.parse per row, for each propose line (predict.mjs:79-90).
- The campaign's outcome loop produced follow-ups by hand. `partly` ratings made wave 5 "frame follow-ups", and
  DW-61 and DW-63 were "two waves of precise follow-up" (REPORT.md). None of that lineage is recorded.
- Allocation orders by score, confidence, evidence count and fp only (docs/data-model.md:132-133). A prerequisite can
  therefore land in reserve while the card that depends on it is ranked.

## Flow
1. An `edges` table, append-only with triggers like `evidence`, indexed on both ends.
2. `similar` and `closestPrecedent` upsert `near` edges with the overlap as the basis, and later reads come from the
   edges. The table works as a cache and as history.
3. Propose line: an optional `relates[] {fp, kind}`. The store checks that the fp exists and that the lens allows the
   kind.
4. Outcome ingest: a card proposed within N runs that cites a `partly`-rated fp gets a `follow-up-of` edge.
5. budget.mjs: when a ranked card depends on a card in reserve, the reserve card moves up into ranked (one hop at
   most).
6. Wire: an additive `relations` field on the pushed record. The Forge Detail view shows "Follows DW-12, unblocks
   DW-19".

## Expected impact
Cards arrive in an order the team can build in. Follow-ups that come from outcomes can be traced. Each precedent
lookup becomes an indexed read instead of a scan of every decided row.

## Evaluation
- Claim: relationships between cards become first-class data and change the ranking.
- Before: one relation kind (`merged_into`), and no similarity result is persisted.
- After: six kinds, a persisted near tier, and allocation that respects dependencies.
- Method: simulation, three cases.
  (a) DW-61 (retention held only for scans that finish), then DW-63 (the docs overstated the fix): DW-63 gets
  `follow-up-of DW-61`, and the inbox shows the chain.
  (b) DW-19 (monorepo audit) made DW-34 (the XSS advisory) findable. With an `unblocks` edge, a later pair like it
  would rank the audit first.
  (c) Two lenses both anchor `sync.mjs#pushRecords`: one cross-lens `near` edge is stored, and the triage sheet
  shows it without recomputing.
- Result: better
- Gate: direction (does the product want to order cards, or only rank them?)

- unblocks: the open card "Decide by precedent" (it would read edges instead of rescanning); a roadmap view on the
  Opportunity Map; lens 6 "Decision consistency" built as a structurally different mechanism (conflicts-with edges
  against accepted decisions); card 2's merge and duplicate rates
- depends_on: none, but it shares the v7 migration with card 1
- fits_deadline: partly. The store, the persisted near edges and the follow-up edges fit (about 1 week). The Forge
  lineage UI and dependency-aware allocation are stretch goals.

---

## 5. Org-scope taste: carry rules, precedents and trust across repositories

- spine: cross-repo team memory
- size: XL | impact 7 | effort 8 | risk 6 | confidence low
- impact_why: a team owns many repos. Today every new repo starts with no rules, no precedents, and product slices
  at L0. An org-scoped prior would make the first scan of a team's second repo already reflect the team's past
  decisions.

## Summary
Promote accepted rules and decision precedents from project scope to org scope (the Jira site), held in Forge. A new
repo's context pack receives org rules and org precedents, marked as such and weighted below local ones. Trust can
start a slice at the org's measured level instead of the contract start.

## Description
- The store and memory are keyed by the repo's origin (paths.mjs:16; docs/data-model.md:10-13). Rules live in the
  per-project `rules` table (store-core.mjs:188), and Forge keeps rules per `project_key`
  (forge/src/core/reflect.mjs:92).
- Rule text is lens-generic by construction: "Do not propose <lens> items about <token> (rejected Nx as <reason>)"
  (memory.mjs, `offerRules`). The same preference (for example, i18n rejected as not-our-direction) recurs across a
  team's repos.
- Trust starts product slices at L0 and needs at least 20 decisions per slice to move (docs/data-model.md:134-136).
  Every new repo repeats that ramp.

## Flow
1. Forge: a `scope` column on rules (project or org), and an "Apply to all inboxes" action in the Learning tab.
2. `dowser_direction_get` or `reflect_sync` returns the org rules and the org slice levels (additive).
3. contextPack gains an `org_rules` section. `closestPrecedent` falls back to org precedents at a lower weight,
   labelled `org precedent`.
4. trust.mjs: for a slice with an org history of n >= 20, the start level is min(contract start, org level). A
   demotion still applies locally.
5. Privacy guard: an org precedent carries the title, topic and reason only, never evidence quotes from another repo.

## Expected impact
Faster time to value on every repo after the first, and a clear "Dowser for the team, not the repo" pitch for the
Software Teams category.

## Evaluation
- Claim: a new repo's first scan avoids proposals the team rejected in other repos.
- Before: a new project key sees no rules and no precedents (the store is per project, and reflect.mjs:92 filters by
  project_key).
- After: N org rules are visible from the first run.
- Method: simulation, three cases.
  (a) A team rejected "add telemetry dashboards" 3 times as not-our-direction in repo A, and accepted a rule marked
  org. Repo B's opportunity lens skips the idea on its first scan.
  (b) An org precedent conflicts with a local direction: the local direction wins because org precedents rank
  below it. Correct.
  (c) A rule tied to one repo's anchor (`forge/static/...`) is marked org by mistake. The token match is lexical,
  so a false suppression is possible. The risk is real, and each rule's scope needs review.
- Result: better
- Gate: direction

- unblocks: onboarding of further repos and the Marketplace "team" pitch; it compounds card 3
- depends_on: card 3 (the hydrate path) and card 2 (org slice metrics)
- fits_deadline: no. It is XL and depends on two other cards. Pitch it as the post-judging roadmap slide.

---

## Incidental defects (S/M)

1. skill/scripts/lib/sync.mjs:402-404, 435: on a fresh or second-machine store, every pulled verdict is `unknown`
   and counted as bad. `ingest-verdicts` therefore exits 1 on a healthy first connected run, with no hint why.
2. skill/scripts/lib/predict.mjs:79-90: `closestPrecedent` loads and JSON.parses every decided row of the lens for
   each propose line, so a run costs O(lines x history).
3. skill/scripts/lib/memory.mjs:377: for rule offers marked `earlier`, the titles are fetched with one
   `SELECT title` per fp (N+1). This is the same pattern as the filed bylineForPage card, here in the skill.
4. skill/scripts/lib/memory.mjs:181-184: each exemplar runs its own `SELECT DISTINCT type FROM evidence` (N+1; small
   at the cap of 5).
5. docs/data-model.md:4: the "Code:" list names `store` but leaves out store-core, proposals, memory, reflect, sync,
   runs and triage, which is where most of the documented behaviour now lives. The list went stale after the
   wave-6 store split.
