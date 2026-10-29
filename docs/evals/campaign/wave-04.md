# Wave 4 - 2026-10-29/30

Scan at 6589096: incremental (`d9a55e5..6589096`, 5 commits, 24 files), 6 new cards (DW-31 to DW-36), 0 dropped,
$4.46. Lens states: opportunity 1, ux-friction 2, doc-drift 3 (one card merged by the scan itself), security-cra 1
(partial: osv-scanner absent; npm audit on the root, `forge` and `forge/static/app`).

## Learning loop

7 verdicts and 8 outcomes were pulled. Opportunity named its non-cards with reasons: picking the Jira project
(2 tickets, below the theme bar of 3) and a higher per-lens limit (which works against the triage-speed goal). Both
are honest judgements. **The security-cra 0.2.3 fix worked on its first scan:** the off-focus prosemirror advisory
took an empty slot and became DW-34, where wave 3 had left it in the summary.

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-31 | Triage guide page lists codes guided mode no longer shows | accepted, built (world) | PAGE-12 now lists the plain questions. |
| DW-32 | Status doc says six Forge tools; there are eight | accepted, built | Real, and the doc's gate counts were stale too (60 and 26 tests). |
| DW-33 | Share one card, or a scan with its quoted lines | **rejected, not-our-direction** | `show <fp>` already prints one card, and quoted source lines stay out of documents that travel beyond the inbox (SECURITY.md). The campaign's first rejection: the next scans test that it does not come back without new evidence. |
| DW-34 | High advisory in a text-editor package in the Jira app's UI | accepted, built | Real: GHSA-c8x8-7fp4-3x9w (paste XSS) in prosemirror-view 1.41.5, transitive through @forge/bridge. Fixed with an npm override; `npm audit` is clean. |
| DW-35 | Say up front when a rebase forces a full scan | accepted, built | Real (DOW-80, a reaction to DW-28). |
| DW-36 | Guided form for the shared markdown | accepted, built | Real: **the third new output surface I shipped without a guided form** (the overview, partial wording, now `share`). |

Outcomes: DW-28, DW-5, DW-24, 25, 26, 27, 29 and 30 right; DW-21 partly (no guided form). In the wave-4 summary I
named the rejected card DW-34 by mistake; the inbox records it correctly as DW-33.

## Built

- 4379133 - prosemirror-view override (DW-34).
- 960decd - XS: DW-35, DW-36, DW-32; PAGE-12 updated in the world (DW-31).
- 965a8a8 - **DW-18 (carried), dated snooze**, by a builder: `move --to snoozed --until YYYY-MM-DD`, store
  version 5 (`proposals.snooze_until`), and `run start` wakes items whose date has passed. Director change: the
  wake's decider is `skill:dowser` (the store's own moves), not `agent:dowser` as my brief said.
- 7581b66 - **DW-9 (carried), quotes=omit**, by a builder that first **stopped with evidence**: Forge's synced
  validator required `quote`, and evidence identity was path plus quote, so a quoteless push would have been
  refused or collapsed. Director decision: a withheld quote travels as `quote_sha` (16 hex of sha256), the
  validator gains a wire mode, and quoteless evidence keys on path plus sha. Director fix after review: the
  builder's `outbox` read `~/.dowser/user.json` itself (impure, so tests read the developer's real prefs, and it
  skipped the scanned-repo check). The CLI now reads the preference and passes it in, with a CLI test.
- Also: prose stewardship f8fe2f1 (lens changelogs out of the packs). quality-snapshot now counts packs only.
- World: PAGE-12; new tickets DOW-83 (triage time praised), DOW-84 (**triage time counts the weekend**, a
  fair critique of DW-5's definition) and DOW-85 (praise for the advisory catch).
- Builder friction: one builder hit the account's weekly usage limit mid-task with no edits made, and was resumed
  later from its saved context. The written brief made the resume lossless.

## Quality (wave-03 -> wave-04)

Gates green: 113 tests (+9), forge 60 (+2), typecheck clean, forge build clean, npm audit clean in
`forge/static/app`. Long functions 11, duplicated windows 48 and import cycles 0: unchanged. **Agent-read words
fell for the first time: 21,087 -> 20,792 (-295)**, because the changelog move (-570 or so) paid for this wave's
SKILL.md and references additions (+271). skill-lib +118 (snooze dates, wire validation, `quote_sha`), tests
+267: test lines grew faster than code lines this wave. **`store.mjs` is now 736 lines**, the largest file in the
repo and growing every wave (669 at the start). It is the next stewardship target.

## Reflection

- **The brief's stop condition earned its keep.** The DW-9 builder found a contract gap (the synced validator and
  the evidence key) that the scan, the card and my brief all missed, and stopped instead of shipping an option
  that would refuse every push. This is a brief-writing lesson: name the synced files and the stop rule.
- **I review builders' work, and it matters.** Both builders' work needed a Director change: a decider convention,
  and an impure function that leaked real user state into tests. Neither was a gate failure; both came from
  reading the diff.
- **My recurring miss is guided mode.** Three new surfaces shipped without a guided form, and Dowser caught each
  one a wave later. The repeated lesson goes into the guardrails: every new runner-facing output names its guided
  form in the same change.
- **Dowser is still 100% precise** (36 of 36 cards real). It found the campaign's first real security fix, and
  turned a lens rule I had written too strictly into a measurable improvement within one wave.
