# Moonshot scout - scan-skill + riders (2026-11-04)

Lens: moonshot-architect. Read-only. Five L/XL ideas, ranked by leverage. All paths are repo-relative.

---

## 1. Jira asks, the coding agent answers: scan requests over MCP

- **spine:** bidirectional MCP work queue
- **size:** XL | **impact:** 9 | **effort:** 7 | **risk:** 5 | **confidence:** medium
- **impact_why:** Today the MCP seam goes one way: every one of the 8 tools is called by the agent, and Jira can never start anything. A queue in which a PM in Jira asks a question and a coding agent answers it with verified cards is the clearest "Best app with Atlassian MCP" story there is. It also gives scheduled scans (direction #4) something to do besides re-sweeping.

### Summary
Add a Forge-side request queue: an "Ask Dowser to look at..." action in the inbox, on a Jira issue and through the Rovo agent. It files a `goal:` or `area:` request. Two new rovo:mcp tools carry it: `dowser_requests_pull` and `dowser_request_answer`. The skill drains the queue at the start of a run, interactive or headless, runs each request as a `focused` run, pushes the cards, and answers the request with the run's refs. Jira then shows "answered: 5 cards, 2 ranked".

### Description
- All 8 rovo:mcp tools are agent-initiated (`forge/manifest.yml:21-32`). Direction is the only steer Jira has, and it is static per-lens configuration that only a person sets in Settings (`docs/contracts/forge-mcp-2.md:149-180`). Jira has no way to say "look at checkout now".
- The skill already has the execution half. `run start --focus goal:..|area:..` exists (`skill/scripts/dowser.mjs:197`), a focused run is a first-class mode (`skill/scripts/lib/model.mjs` RUN_MODES, `SKILL.md:43-53`), and `run status` can resume (`skill/scripts/lib/runs.mjs:286-293`).
- The first-run panel's only "scan your own repository" path tells the user to clone and type `/dowser` (`forge/static/app/src/routes/inbox/FirstRun.jsx:80-83`). Nothing in Jira links back to a run.
- Headless runs stop before push (`skill/SKILL.md:464`). That gap is filed as a card; this idea builds on top of that fix and is structurally beyond it, because it adds the inbound direction.

### Flow
1. Forge SQL migration: a `scan_requests` table (id, project_key, focus kind and text, asked_by, asked_at, state open|claimed|answered|expired, claimed_run, answer_json), with CAS state moves.
2. Two contract tools, additive to forge-mcp-2. `dowser_requests_pull {project_key}` returns open requests and claims them with a lease. `dowser_request_answer {project_key, request_id, run_id, refs_json, state}` answers one. Mirror both in `tools/mock-forge-mcp.mjs` and `tools/local-forge.mjs`.
3. Skill CLI: `requests ingest --file` caches the claimed requests, and `run start --request <id>` derives `--focus` from the request and records the link. The `answer` payload comes from the run's pushed fps, the same way `outbox` derives the push arguments.
4. A new step in SKILL.md section 3: pull requests after verdicts and offer them, or take the oldest when headless. Section 9 answers each request.
5. Forge UI: an "Ask Dowser" button on the inbox toolbar and the issue panel, a request list showing its states, and a Rovo action `dowser_request_scan`.
6. Tests: a mock round trip (pull, focused run, push, answer) and a lease expiry that returns a request to `open`.

### Expected impact
A judge, or a PM with no terminal, asks "why do users abandon checkout?" in Jira. The next agent session or scheduled run answers with evidence-backed cards linked to the request. The MCP server stops being a mailbox and becomes a work queue for coding agents.

### Evaluation
- **Claim:** Jira can start a scan and see its answer without anyone opening a terminal.
- **Before:** 0 of 8 rovo:mcp tools carry intent from Jira to the agent (`forge/manifest.yml:24-32`). Lens direction is static and set only in Settings.
- **After:** 2 new tools. Every request reaches a terminal state (answered or expired) and links to its run and cards.
- **Method:** simulation, three cases walked.
  1. A PM asks "area: src/checkout" in the inbox. The developer's next interactive `/dowser` pulls it, offers it, runs it focused, pushes 4 cards and answers. The request shows DW-31..DW-34.
  2. A nightly headless run with a request open claims it, runs it focused and pushes (needs the filed headless-push fix). Without that fix it answers `state: verified-not-pushed` and names the local card count.
  3. A request is claimed, and the run crashes. The lease lapses after 24 h, the request returns to `open`, and the next run claims it. No double answer, because the answer is a CAS move from `claimed` by the same run.
- **Result:** better
- **Gate:** direction (operator: is an inbound request worth a contract amendment this late?)

- **unblocks:** scheduled scans (#4) get demand-driven work; Rovo agent "ask Dowser" (#7); a demo arc that starts in Jira; a judge path once a coding agent is connected.
- **depends_on:** the filed "headless runs never push" card (for the headless half only); the production deploy.
- **fits_deadline:** yes, if scoped to `goal:`/`area:` requests and the interactive path first. That is about 2 weeks, and the contract change is additive.

---

## 2. Code-verified outcomes: re-check accepted cards' evidence on every run

- **spine:** shipped-outcome ground truth
- **size:** L | **impact:** 8 | **effort:** 5 | **risk:** 3 | **confidence:** high
- **impact_why:** It closes the plan's arc "it ships, the docs update" from the code itself rather than from a Jira status. It turns the learning loop's sparsest signal (human outcome ratings) into a free, automatic one. It is unique: no competitor can say "the defect we quoted is gone from the code".

### Summary
Each run, re-read the quoted `code`/`doc` evidence of every `accepted` card at `head_sha`. Classify each card as `resolved` (all quotes gone or changed), `partly` (some gone), `present` (all still there) or `moved`. Store the result as an append-only `evidence_checks` row. Send it to Forge through `dowser_reflect_sync` as an optional `evidence_json`. Forge then shows "Jira says Done, but the quoted problem is still in the code" (or the reverse) on the Learning tab and in the outcome candidates, and pre-fills the outcome rating suggestion.

### Description
- `verify` re-reads quotes only for cards in `candidate` state (`skill/scripts/lib/verify.mjs:2`, loop over `candidatesOfRun` at `:176`). An accepted card's quotes are never read again.
- Outcomes are human ratings only (`forge/src/core/reflect.mjs:439-446`). The candidate list knows only the Jira status category (`forge/src/core/reflect.mjs:295-327`). The skill reads the result back as `{right, partly, wrong}` counts per lens (`skill/scripts/lib/memory.mjs:186-190`, `skill/SKILL.md:203-207`).
- The machinery already exists. `findQuote` handles near-line and in-file matches and drift (`skill/scripts/lib/verify.mjs:2-7`). Pushed evidence carries `quote_sha` (`skill/scripts/lib/model.mjs:26`). Accepted cards keep `anchors_json` locally (`skill/scripts/lib/predict.mjs:81`).
- Trust earns and loses on triage agreement only (`skill/scripts/lib/trust.mjs:9-12`). A signal from the code would let a slice's track record include "accepted and actually fixed".
- Builds on the planned direction #6 ("close the shipped loop") and goes structurally beyond it: the ground truth is the repository, not the Jira workflow.

### Flow
1. `skill/scripts/lib/outcomes.mjs` holds `checkAccepted(db, root, headSha)`. For each accepted card it runs `findQuote` per quoted evidence and classifies the card, appending to an append-only `evidence_checks` table (store v7). It reads only, never writes the repo.
2. Call it from `verify` (or a `recheck --run` command) and report `accepted_checks: {resolved, partly, present}`.
3. `reflect export` adds optional `evidence_json` (fp, state, at_sha, checked_at). Forge stores it (SQL migration), and `candidatesOf` sorts "done + resolved" first and flags "done + present" as a mismatch.
4. Learning tab and issue panel: a "Code check" row ("quoted line gone since a1b2c3d").
5. `context --lens` adds `shipped: {resolved, present}` beside `outcomes`. Optionally, a `resolved` card counts as agreement evidence in `trust.mjs`, behind a flag.
6. Tests with fixture commits that remove one quote, rewrite another and leave a third.

### Expected impact
Every accepted card gets a code-truth status at no human cost. The demo can show a card that went DW-3 → DOW-7 → Done → "quoted line gone at a1b2c3d", the whole loop with no manual rating.

### Evaluation
- **Claim:** Accepted cards get an objective shipped signal on every run.
- **Before:** 0 accepted cards re-checked (`verify.mjs:176` iterates candidates only). Outcomes exist only where a person rated them.
- **After:** 100 % of accepted cards with code/doc evidence get a state per run.
- **Method:** simulation, three cases walked.
  1. A card quoting `if (!user) return;` in `src/auth.js` is accepted, the issue is Done, and the line is deleted. Result: `resolved`, Forge suggests "right".
  2. The issue is Done but the quote is still in the file. Result: `present`, and Forge flags the mismatch on the Learning tab. That is exactly the false "shipped" the rating loop misses.
  3. The file was renamed and the quote moved. `findQuote` searches the anchor path only, so the result is `resolved` (a false positive). Mitigation: search `git log --follow` for the renamed path before classifying, or label the result `moved?`. Walking this case shows the rename rule must be in v1.
- **Result:** better
- **Gate:** none (additive, store-local plus an optional field)

- **unblocks:** #6 shipped loop (a free signal); trust ladder calibration; idea 3 (verifying an agent's build); demo arc.
- **depends_on:** none.
- **fits_deadline:** yes, about 1 week: skill side 3 days, Forge field and UI 2 days.

---

## 3. Build handoff: accepted cards as an MCP work queue for coding agents

- **spine:** accept-to-implement agent loop
- **size:** L | **impact:** 9 | **effort:** 6 | **risk:** 4 | **confidence:** medium
- **impact_why:** Accept in Jira today ends at "issue created". Letting any MCP-connected coding agent (Claude Code, Codex, Rovo Dev) pull the next accepted card with its verified evidence pack, implement it and report the PR back makes Dowser the bridge from "what to build" to "built". With idea 2 verifying the result, that is the full Atlassian MCP loop a judge can watch.

### Summary
Expose three rovo:mcp tools.
- `dowser_work_list {project_key}`: accepted, not yet started cards with issue keys.
- `dowser_work_brief {ref}`: the card, the evidence with quotes and `head_sha` permalinks, the acceptance criteria from its Evaluation section, and the trust slice.
- `dowser_work_report {ref, state: started|pr-open|done, pr_url?, commit?}`: posts to the Jira issue (comment and transition hint) and records it.

A skill step "/dowser build DW-12" (or any agent) uses them. The next scan's code check (idea 2) confirms or contradicts "done".

### Description
- List and explain exist, but only as Rovo actions with `function: rovo` (`forge/manifest.yml:103-119`). They are not in the rovo:mcp tool list (`forge/manifest.yml:24-32`), so an external coding agent cannot read an accepted card's evidence trail.
- The card body already has a build-ready shape: five sections including Flow and Evaluation (`skill/scripts/lib/model.mjs` BODY_SECTIONS), and verified quotes with found lines (`skill/scripts/lib/verify.mjs:2-7`).
- An accepted verdict brings back `issue_ref`/`issue_url` (`docs/contracts/forge-mcp-2.md:285-335`, `skill/SKILL.md:110-112`). Nothing flows after that.
- The Ask-why section can answer only from the local store (`skill/SKILL.md:442-449`). An agent on a different machine has no copy.

### Flow
1. Forge: `work.list`, `work.brief` and `work.report` core functions, reusing `cards.mjs` explain. A `work_reports` append-only table. A report posts an ADF comment on the issue, through the same path merge already uses.
2. Manifest: add the three tools to rovo:mcp, plus contract text (additive, forge-mcp-2), mock and local-forge mirrors.
3. Skill: a `references/build.md` procedure. Pull the brief, re-verify its quotes locally first (refuse when the code moved: "brief is stale, rescan"), implement in the developer's session (this is the one Dowser flow that edits code, so it is a separate, explicit command that never runs during a scan), and report `pr-open` with the URL.
4. Issue panel: a "Build status" row with the agent, PR link and the code check from idea 2.
5. Live e2e: extend `tools/forge-live-e2e.mjs` with list → brief → report.

### Expected impact
Judges see one artifact travel scan → inbox → Accept → coding agent → PR → "quoted problem gone". Real teams get a reason to keep the MCP server connected after triage.

### Evaluation
- **Claim:** An external coding agent can take an accepted card to a reported PR through MCP alone.
- **Before:** 0 rovo:mcp tools read a single card. The 3 read and decide actions are Rovo-only (`forge/manifest.yml:103-119`).
- **After:** 3 tools. The brief includes verified quotes and permalinks at `head_sha`.
- **Method:** simulation, three cases walked.
  1. A developer in Claude Code types "/dowser build DW-3". The skill fetches the brief, all quotes are found, it implements the change, opens a PR and reports `pr-open`. The issue gets a comment.
  2. The brief's quote is no longer in the file (someone else fixed it). The local re-verify fails, and the skill reports nothing and says "already changed; idea 2's next check will classify it". No duplicate work.
  3. A Codex agent with no Dowser skill calls the tools raw. The brief is self-contained (quotes, lines, acceptance), so it still works, which proves the MCP surface is agent-agnostic.
- **Result:** better
- **Gate:** direction (the skill gains a code-editing mode, a stated invariant boundary: `skill/SKILL.md:479-480` "never edit the scanned repo" must be scoped to scans)

- **unblocks:** an MCP-bonus demo climax; idea 2 gets PR and commit anchors; Rovo agent "who is building DW-12?".
- **depends_on:** idea 2 for verification (optional); the production deploy.
- **fits_deadline:** yes, about 1.5 weeks. The invariant wording needs an operator decision first.

---

## 4. Open lens registry: lenses as validated, served packs, not a hardcoded enum

- **spine:** pluggable lens registry
- **size:** XL | **impact:** 7 | **effort:** 7 | **risk:** 6 | **confidence:** medium
- **impact_why:** Lenses 5-7 and every team-specific lens (accessibility, GDPR, performance) are today a code change in two halves. A registry makes a new lens a pack drop, which is a structurally different mechanism from "write lenses 5-7". It turns Dowser into a platform teams extend, and Technological Implementation judges reward that.

### Summary
Replace the closed `LENSES` enum with a registry. Built-in packs plus team packs come from `~/.dowser/lenses/` or are served by Forge through a new `dowser_lenses_get` tool, where a team edits them in Settings, version-stamped. Each pack declares `id`, `category`, `kinds`, `budget` and a `label`. The store, budget, trust slices and Forge validation all read the registry. Forge stores the pack descriptor received with each push (`lens_kinds_json` already proves the pattern) and labels lenses from it.

### Description
- `LENSES` is a const of 4 ids (`skill/scripts/lib/model.mjs:19`), and the category map is fixed (`skill/scripts/lib/model.mjs:41`). The loader refuses any other id (`skill/scripts/lib/memory.mjs:94`). `packKinds` iterates the enum (`skill/scripts/lib/memory.mjs:114-116`).
- Forge refuses unknown lenses in 4 cores (`forge/src/core/app.mjs:339`, `forge/src/core/cards.mjs:215`, `forge/src/core/direction.mjs:72`, `forge/src/core/reflect.mjs:53`). 25 non-test files reference `LENSES`/`LENS_CATEGORY`, among them UI labels and the heat grid.
- The docs name the gap: "A fork under its own id ... needs the id registered with the store, the CLI and the Forge app. That is a planned addition" (`skill/references/lens-authoring.md:103-105`). Today teams can fork only "in place" (`skill/references/lens-authoring.md:87-90`).
- The push already ships lens metadata (`lens_kinds_json`, `forge/manifest.yml:68`). Extending it to a `lens_packs_json` descriptor is the same pattern.

### Flow
1. `skill/scripts/lib/lenses.mjs`: a registry that loads built-ins plus `~/.dowser/lenses/*.md`, validates the frontmatter (adding `category` and `label`), and refuses id collisions and ids that shadow a built-in.
2. Replace the `LENSES` checks with `registry.has(id)` across the 9 skill modules. Category comes from the pack (`predict.mjs:43-48` keeps its clamp rule).
3. Contract: an optional `lens_packs_json` on push (id, version, category, label, kinds). Forge upserts a `lenses` table per inbox, and Forge validation reads that table plus the built-ins. UI labels and the heat grid read the descriptors.
4. Optional, phase 2: `dowser_lenses_get`, a team-authored pack from Settings, served to the skill and cached per run like direction.
5. `lens-eval` accepts `--lens <any registered id>` and a fixture path. Ship a Tech-debt pack as the first registry lens, to prove the mechanism.

### Expected impact
A new lens costs one markdown file instead of about 25 file edits and a `forge:check-shared` round. Lenses 5-7 become pack drops, and teams can carry their own concerns into Jira.

### Evaluation
- **Claim:** Adding a lens needs no code change in either half.
- **Before:** 25 non-test files hardcode the lens set. 4 Forge cores refuse a non-built-in id. The docs call registered forks "planned".
- **After:** 1 file per new lens. 0 code edits.
- **Method:** simulation, three cases walked.
  1. A team drops `~/.dowser/lenses/a11y.md` (category product, kinds [missing-label, contrast]). `context --lens a11y` works and `propose` checks its kinds. The push carries its descriptor, the inbox labels it "Accessibility", and its trust slice `product|a11y|-|S` starts at L0.
  2. A pack declares `id: opportunity` from the user folder. The registry refuses the shadowing with exit 2, so built-in fingerprints are never hijacked.
  3. An inbox receives a card for lens `a11y` from a skill that did not send `lens_packs_json` (an older skill). Forge refuses it with `bad-input unknown lens` as today, so the change is safe for old skills.
- **Result:** better
- **Gate:** architecture (it touches shared modules on both halves and the `forge:check-shared` copies)

- **unblocks:** lenses 5-7 (#7 in the plan) as pack drops; team-specific lenses; a lens pack marketplace story; registry-sourced lenses.
- **depends_on:** none, but best landed before lenses 5-7 are written.
- **fits_deadline:** partly. The skill-local registry plus push descriptors fit (about 2 weeks). Team packs served from Forge Settings should wait until after Dec 22.

---

## 5. Procedure engine: the CLI drives the run, the agent only gathers and judges

- **spine:** deterministic run orchestrator
- **size:** XL | **impact:** 7 | **effort:** 8 | **risk:** 6 | **confidence:** medium
- **impact_why:** About 1,300 lines of procedure prose (SKILL.md 508 plus references 794) carry the sequencing that ingest, push, reflect, direction, pretriage and finish depend on. Every harness (Codex, Rovo Dev, CI) has to follow it perfectly. A `dowser next` state machine that emits the exact next action, including the MCP tool call and its arguments, makes headless/CI, Codex parity and resume deterministic. Ideas 1-3 then each add a step in code instead of in prose.

### Summary
Generalize `run status`'s `next` into `dowser next --run <id> [--done <step-result-file>]`. It returns one typed action: `{kind: cli|mcp|agent, ...}`. Examples: `mcp: dowser_verdicts_pull {project_key, cursor}` then save to `<path>`; `agent: gather+judge lens ux-friction with context <file>, write <jsonl>`; `cli: verify`. The engine records each step's result on the run, so resume, headless stop points and connected/unconnected branching live in code. SKILL.md shrinks to a loop ("call next, do the action, report the result") plus the judging guidance.

### Description
- `run status` already computes `next` as literal CLI lines, but only for verify, context, pretriage, outbox and finish (`skill/scripts/lib/runs.mjs:286-293`). The pull, reflect, direction, sources, push, ingest and areas steps exist only as prose (17 lines of `skill/SKILL.md` name an MCP tool call).
- Headless behaviour is prose rules ("Skip section 8", `skill/SKILL.md:464`), and the drift between procedure and CLI needed its own test (`skill/scripts/tests/procedure-sync.test.mjs`; commit 79f7be7 "procedure-sync catches a renamed command").
- The installer supports `claude|codex` (`skill/install.mjs:93`), but parity rests on each model reading the same 1,300 lines the same way. I have not measured how many past defects were procedure misreads (an open question, not a premise).
- `tools/lens-eval.mjs` and `tools/dogfood.mjs` drive headless `claude -p` runs and could assert the action trace instead of only the outcomes.

### Flow
1. `skill/scripts/lib/engine.mjs`: a step graph (preflight → pull → reflect → start → direction → per-lens [context → sources → agent judge → propose] → verify → similar → pretriage → triage → push loop → areas → reflect → finish), with guards for connected, headless and focused runs.
2. `dowser next` and `dowser step-done --file` persist step results in a `run_steps` table (append-only). `run status` becomes a view of it.
3. MCP actions carry the exact tool-name suffix rule and argument object. The agent's only freedom is the `agent` kind (gather and judge).
4. Rewrite SKILL.md sections 2-9 as the loop plus the judging rules. Keep `references/` for card and triage judgment.
5. Port lens-eval and dogfood to assert the step trace. Run a Codex headless pass on the fixture as the parity check.

### Expected impact
The "headless never pushes" and "run status re-implements outbox" class of defects collapses into engine rules. Codex, Rovo Dev and CI runs follow identical sequences. Ideas 1-3 add an engine step plus a test, not a prose section.

### Evaluation
- **Claim:** Run sequencing moves from prose to code, and the harnesses follow identical traces.
- **Before:** `next` covers 5 step kinds (`runs.mjs:286-293`). 17 SKILL.md lines naming MCP calls and every headless branch live in 508 + 794 lines of prose.
- **After:** every step kind is emitted by `next`. The prose covers judgment only (an estimated 40 % of today's lines).
- **Method:** simulation, three cases walked.
  1. A connected interactive run: `next` emits pull → ingest → reflect export → MCP sync → ingest → start, and so on. The agent never decides the order.
  2. A headless CI run with requests (idea 1): the engine skips the triage dialog, pushes if a policy flag allows, and answers requests. One code branch, testable without a model.
  3. A crash after verify: `next` returns `similar` for the first unchecked fp. Resume needs no prose.
- **Result:** better
- **Gate:** architecture (a large SKILL.md rewrite late in the schedule; it needs lens-eval re-baselined)

- **unblocks:** #4 scheduled CI scans; MCP bonus (#3, Codex parity); ideas 1-3 as engine steps; the filed "headless never pushes" and "run status re-implements outbox pending" cards.
- **depends_on:** none. Best done before the SKILL.md grows further.
- **fits_deadline:** partly. The engine plus `next` for the connected path fits in about 2.5 weeks. The full SKILL.md rewrite and re-baseline is risky before the freeze and could ship as v0.3 with the prose kept as a fallback.

---

## Incidental S/M defects

1. A card whose evidence is only `git` or `sarif` verifies with nothing checked. Only quoted and ingested types can set a drop note (`skill/scripts/lib/verify.mjs:186-188`), and validation requires just one evidence item of any type (`skill/scripts/lib/model.mjs:414`).
2. `verify` reads the current working tree, not `head_sha` (`skill/scripts/lib/verify.mjs:3`). Uncommitted edits can verify quotes that the pushed `head_sha` permalinks (`outbox` `head_sha`) do not contain.
3. `closestPrecedent` loads and parses every decided row of the lens on each `propose` line (`skill/scripts/lib/predict.mjs:80-89`). This is O(decided x candidates) with no anchor index, which will slow down as memory grows.
4. The share `summaryOf` regex requires `\n` after `## Summary` (`skill/scripts/lib/share.mjs:13`). A CRLF body loses its "Proposed:" line silently.
5. `packKinds` loads every lens pack, and one broken pack exits 2 for all of them (`skill/scripts/lib/memory.mjs:114-116`). A single bad pack edit blocks `propose` and `outbox` for every lens.
