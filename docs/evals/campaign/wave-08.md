# Wave 8 - 2026-10-30

Scan at 2a22d49: incremental (3 commits), 5 new cards (DW-58 to DW-62), 0 dropped, $6.87.

## Learning loop

The scan read its own outcome record and acted on it: "Opportunity's accepted items have the weakest record so far
(3 right, 6 partly), so that lens proposed few cards and says what makes each one different." Outcome ratings now
steer how much a lens proposes, not only what.

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-58 | Status doc says no lens fills delivery risk | accepted, built | Real: every lens card carries `delivery_risk`. |
| DW-59 | Dated snooze through the Rovo agent | **rejected, not-worth-it** | The inbox covers dated snooze; no ticket asks for it in chat. The campaign's second rejection. |
| DW-60 | Run dependency audits side by side | accepted, built | Real (DOW-94): the cost of wave 2's monorepo audit. |
| DW-61 | Interrupted scans keep Jira and Confluence text | accepted, built | Real: wave 5's retention promise held only for runs that finish. |
| DW-62 | The accept dialog never says its project is the inbox default | accepted, built | Real (DOW-65, DOW-81). |

Outcomes: DW-44 partly (DW-61); DW-50 to DW-57 right (all eight wave-7 follow-ups).

## Built

- e225145 - `run start` closes runs left `running` more than 24 h as `failed` and drops their fetched text; a run
  within the window may be live elsewhere and is left alone (DW-61, with a test). The accept dialog explains the
  project default (DW-62). Status doc (DW-58). SECURITY.md, SKILL.md and data-model synced in the same commit.
- 83418d2 - **DW-60, by a builder**: `deps` audits up to 4 directories at a time (async spawn, results in the same
  order, output byte-identical). Measured on this repo, three runs each: **5.7 s -> 2.4 s**. The builder measured
  the old version before editing, as the brief required. Its honest residue: the real timeout and output-cap
  paths are untested (a 60 s constant), and killing a `.cmd` shim on Windows may leave npm running, as before.
- World: new tickets DOW-96 (the accept dialog answers DOW-65), DOW-97 (the monorepo audit is quick again) and
  DOW-98 (**"how do we know Dowser itself is healthy?"**, the question this campaign's quality rows answer, asked
  from the user's side).

## Quality (wave-07 -> wave-08)

Gates green: 123 tests (+2), forge 69, typecheck clean, build clean. Long functions 12, duplicated windows 48 and
import cycles 0: unchanged. skill-lib +83 (async spawn and the pool in deps.mjs, abandoned-run closing in
runs.mjs). Agent words +22.

## Reflection

- **The loop has turned from features to edges and costs.** Waves 1-3 found missing things; waves 6-8 find the
  cost and the edges of what was built: a retention promise with a gap (DW-61), a speed cost (DW-60), a definition
  flaw (DW-49), a dialog that does not explain itself (DW-62). That is the right order for a maturing product, and
  each such card is cheap to verify against the code.
- **Rejecting is cheap, and it is the only negative signal Dowser gets.** Two rejections in eight waves. Every
  other card was real and in direction, so the team said yes. A beta team would reject more on value; the
  campaign's acceptance rate is above what a real team would produce.
- **Builders are now the default for S-and-larger work.** In waves 4-8, eight builders shipped and none needed
  rework beyond one Director change each (a decider, an impure read, a test double). The briefs carry the lessons:
  stop conditions, test doubles, the guided form and measuring before editing.
