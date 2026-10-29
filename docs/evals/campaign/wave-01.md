# Wave 1 - 2026-10-29

Scan at d4de342: 14 cards, 0 dropped by verify, all pushed (DW-1 to DW-14), $6.22, 15 turns.
Lens states: opportunity 3, ux-friction 3, doc-drift 4 (top 4 of 5), security-cra 4 (partial: forge lockfiles
not audited, osv-scanner absent).

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-1 | Triage guide offers a reject reason the store refuses | accepted | Real; PAGE-12 corrected. |
| DW-2 | Getting-started page: card count and snooze | accepted | Real; PAGE-11 corrected. |
| DW-3 | Security review draft says no code leaves the machine | accepted | Real; PAGE-13 corrected. The pre-campaign scan had cut this as covered by a security card. |
| DW-4 | Getting-started page: Node version | merged into DW-2 | Same page, one edit. |
| DW-5 | Time to triage per scan (G-1's own measure) | accepted, carried | Real: verdict and push times exist, and nothing computes the measure. Size M, in Forge. |
| DW-6 | No work toward the CRA-ready release (G-3) | merged into DW-8 | The umbrella over the security cards, as in the pre-campaign scan. |
| DW-7 | Short cards using the stored `verbosity` | accepted, built (partly) | `cards.md` already renders cards without the body, so "a full page per card" (the seeded tickets) was wrong, and Dowser did not check it. What is real is an unread `verbosity` and no overview: built those. |
| DW-8 | SECURITY.md with a disclosure contact | accepted, carried | Real absence; cheap; next wave. |
| DW-9 | Option to push evidence without quoted lines | accepted, carried | Real (the push carries quotes); in the security focus. Size M. |
| DW-10 | SBOM with each release | snoozed | Waits on the release plan. |
| DW-11 | Versioned releases | snoozed | Waits on the release plan. |
| DW-12 | Partial scan explained as expected | accepted, built | Built with DW-13. |
| DW-13 | No internal terms in guided progress and summary | accepted, built | The vocabulary existed; SKILL.md's count lines never pointed guided mode to it. |
| DW-14 | Plain fix when setup fails, including missing git | accepted, built | No git-missing row; built as one preflight line and one guided message. |

No rejections this wave. Every card was real. The learning loop gets its first test next wave: DW-4 and DW-6
(merged) and DW-10 and DW-11 (snoozed) must not come back as new cards.

## Built

- fba548a - triage opens with an overview table; `verbosity` is read (`short` default, `full` adds Summary
  and Description); guided count, set-aside and partial wording; git-missing preflight. Prose only, no code.
- World: PAGE-11, 12 and 13 corrected as the team would. New tickets DOW-72 (overview praised), DOW-73
  (time-to-triage ask, more demand for DW-5) and DOW-74 (forge lockfiles never audited).

## Quality (wave-00 -> wave-01)

Gates green, 101 tests, typecheck clean. The agent reads +214 words (SKILL.md +77, references +137) = +2.3%,
inside the 3% budget. Long functions 14, duplicated windows 48, import cycles 0: all unchanged. Tools +235 lines
for the campaign's own tooling (dogfood campaign mode, dogfood-decide, quality-snapshot).

## Reflection

- **Dowser:** 14 of 14 real, but the set differs a lot from the pre-campaign scan of nearly the same tree.
  Monorepo dependency audits, timed snooze, Node 22.13 and the Forge UI install step all vanished, and
  time-to-triage and keep-quotes-local appeared. **Run-to-run variance is large**: a single scan is a sample
  of the findings, not the findings. The campaign will show whether the dropped ones return.
- **Dowser trusted tickets over code** on DW-7: eight tickets said cards were long, and the rendering spec
  says otherwise. A demand claim about current behaviour should be checked against the behaviour.
  Candidate rule: when tickets describe what the product does today, quote the code that does it.
- **Repo:** prose grew, code did not. The first three builds were wording in the agent's procedure, which is
  cheap to add and expensive to read every scan. Prose budget is the metric to watch.
