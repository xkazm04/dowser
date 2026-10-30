## Finding contract

This skill is one of three backlog scanners (`scan-sweep` -> Personas, `lens-scan` -> bp, Dowser ->
Jira) that share ONE finding contract, `scan-finding/1`. Each store keeps its own column names and
casing; the meaning, the scales, the score formula and the absent-value rule are this text, and a
consumer never recomputes what the producer stored. Standards: codebase-scanning (ranked, disclosed
truncation), scoring-rubrics (a stored score with its breakdown; unmeasured is never zero),
hitl-approval (a gate on anything visible outside the system; severity ladder).

**Fields every finding carries** (canonical snake_case keys; a store maps them 1:1):

| Key | Type | Meaning |
|---|---|---|
| `lens` | string | the dimension that found it (lens id). Never collapsed into a source/origin. |
| `category` | `technical` \| `product` | technical = the codebase's own quality (bugs, perf, reliability, security, debt, docs drift, a11y); product = what users get (features, UX direction, copy, pricing). Decides the autonomy start level. |
| `impact` | int 1-10 | defects: how bad if left (10 = data loss, breach, outage on a main path); opportunities: value if done. |
| `impact_why` | string <=200 | the one-line reason for the number. |
| `confidence` | `low` \| `medium` \| `high` | high = quoted evidence re-read in the current tree AND reproduced or measured; medium = quoted evidence re-read; low = inference. |
| `effort` | int 1-10 | build effort. When only a size is known: XS=1, S=2, M=4, L=7, XL=10. |
| `risk` | int 1-10 | risk of MAKING THE CHANGE (blast radius x irreversibility), never the severity. A low/medium/high blast maps to 2/5/8. |
| `score` | number, 1 decimal | `scan-score/1` below. Stored by the producer; consumers sort by it. |
| `score_parts` | object | `{impact, confidence_w, effort_div, risk_factor, formula:"scan-score/1"}` - the breakdown ships with the number. |
| `band` | `ranked` \| `reserve` | `reserve` = found, verified, scored, but over the run's cap. Filed, not discarded. |
| `mvp` | bool | true on exactly one finding per lens per run: that lens's top finding. |
| `mvp_rule` | `top-score` \| `override` | `override` only with `mvp_why`. |
| `mvp_why` | string <=200 | required when `mvp_rule = override`. |
| `predicted_verdict` | `accept` \| `reject` \| `defer` | the model's verdict, recorded BEFORE any human sees the item (shadow mode). |
| `predicted_why` | string <=300 | names the precedent it leaned on when one exists. |
| `predicted_by` | string | `<skill>@<version>:<model>`. |
| `proof` | object | when a change was built: `{metric, method, unit, before, after, verdict: better|not-better|inconclusive, control: red|absent, base_sha, head_sha}`. |

**Absent-value rule.** Unknown is never `0` and never `""`. JSON wire: omit the key. SQL: `NULL`.
A finding missing `impact` or `effort` has no `score`, ranks after every scored finding, and shows
"unscored" - never a zero.

**`scan-score/1`** (one formula in all three systems; a change is `scan-score/2`, never an edit):

```
confidence_w = {low: 0.5, medium: 0.75, high: 0.95}[confidence]   (absent -> 0.5)
effort_div   = 1 + (effort - 1) / 9                                (1.0 .. 2.0)
risk_factor  = 1 - (risk - 1) / 20                                 (absent -> 0.75)
score        = round1( 10 * impact * confidence_w / effort_div * risk_factor )
```

Range about 1.4-95. Impact leads: effort at most halves a score, so a trivial impact-3 fix (28.5)
never outranks an impact-8 medium-confidence M (40.5); a high-risk change keeps at least 55 % of
its value. Reference values for every implementation's test: `(10,high,1,1) = 95.0`,
`(8,medium,4,3) = 40.5`, `(3,high,1,1) = 28.5`, `(5,low,10,10) = 6.9` (half-up rounding: `Math.round(x * 10) / 10`).

**Coverage: every lens, nothing paid-for discarded.** A sweep reads each unit once and judges it
through EVERY enabled lens. Slot allocation for a run cap N: (1) each lens with >=1 verified finding
gets one ranked slot, its MVP; (2) the remaining slots go by `score` across lenses; (3) everything
else verified is `band: reserve`. The run report prints, per lens: ranked/reserve counts, the MVP's
title and score, and tokens when the harness shows them (omitted otherwise). A lens that could not
run is reported skipped, never as zero findings.

**Autonomy ladder** (per project x slice, slice key = `<category>|<lens>|<risk_class>|<size>` as one
string, an absent part written `-`; `risk_class` is lens-scan's vocabulary
`secret|authz|money|data|llm|perf|reliability|ux|debt`). **The gate lives in the store, not in the
prompt:** the system that records decisions computes each slice's level from its own decision
history and refuses a machine decision above it; a scanner's claim of a level is never trusted.

| Level | The machine may | Proof |
|---|---|---|
| L0 propose | file; the human decides | - |
| L1 auto-triage | record its predicted verdict as the decision, `decided_by: machine:<skill>`, with a 24 h veto window shown on the item | precedent quoted |
| L2 auto-build | build in a branch/pack/worktree and land ONLY a `proof.verdict = better` with `control = red` | before/after, same method, red control |
| L3 auto-merge | merge an L2 `better` to the base without a human | as L2 + gates green |

- **Start:** `category: technical` starts at L2, `product` at L0. A project overlay may lower either.
- **Earn:** a slice moves up one level when its predicted verdicts agree with the human verdicts on
  >= 90 % of its last 20 human-decided items (min 20; a reversed machine decision counts as a disagreement).
- **Lose:** a slice drops one level, and its window resets, on any human reversal of a machine decision
  inside or after the veto window, or any landed change whose proof is later re-measured `not-better`.
- **Ceilings:** `secret|authz|money` never above L1; anything that leaves the system (a Jira issue, a
  message, a publish) is never machine-decided - the human click stays. A scanner that may not write
  into the scanned repo (Dowser) has no L2/L3: its ceiling is L1.
- **Every transition is an append-only event** `{slice, from, to, reason, agreement, n, at}`, shown
  to the human beside the slice's current level.
- **Memory feeds the verdict:** before predicting, the scanner reads the project's recorded decisions
  for the same context and lens - verdict, reason, note - and quotes the closest one in `predicted_why`.
  Titles alone are not memory.
<!-- contract: scan-finding/1 - copied byte-for-byte into dowser/docs/contracts/scan-finding-1.md -->
