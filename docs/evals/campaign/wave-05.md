# Wave 5 - 2026-10-30

Scan at ed69451: incremental (6 commits, 35 files), 10 new cards (DW-37 to DW-46), 0 dropped, $6.91. Lens states:
opportunity 2, ux-friction 2, doc-drift 4, security-cra 2 (partial: osv-scanner absent; npm audit on three
directories, 0 findings after the wave-4 override).

## Learning loop

**The first rejection held.** DW-33 (share quoted lines, rejected `not-our-direction`) stayed suppressed although a
ticket (DOW-79) asks for exactly that. The scan said so in its summary. The 9 outcomes it pulled shaped it too:
opportunity saw three `partly` ratings, each "shipped without its follow-up", and framed both of its cards as named
follow-ups (DW-41 for DW-5, DW-42 for DW-18). That is the outcome signal changing behaviour, which the reflect loop was
built for.

## Decisions

| Ref | Card | Verdict | Why |
|---|---|---|---|
| DW-37 | Supporting views never reach the Jira inbox, though the contract sends them | accepted, built | **Real, and the most important find so far.** `RECORD_KEYS` in sync.mjs never listed `artifacts`, so every view since the lens-quality-plan spark stayed in the terminal. Forge stores and renders them; only the writer dropped them. |
| DW-38 | Docs miss the keep-quotes-local option | accepted, built | Real: my DW-9 doc sync covered SECURITY.md only. |
| DW-39 | Getting-started page never mentions a snooze date | accepted, built (world) | Real. |
| DW-40 | Status doc lists four fixed live-test gaps as open | accepted, built | Checked against the code: gaps 1, 2, 4 and 6 are fixed; 3 and 5 stay open. |
| DW-41 | Time to triage counts the weekend after a push | accepted, built | Real (DOW-84): G-1 is about deciding, not waiting. |
| DW-42 | Snooze until a date in the Jira inbox too | accepted, carried | Real, M, Forge. |
| DW-43 | Withheld quotes can reappear in card text | accepted, built (scope stated) | Real. SECURITY.md now says what `quotes=omit` covers (evidence) and what it does not (card text). A guard that flags quotes in card text is carried. |
| DW-44 | How much Jira and Confluence text a scan keeps on disk | accepted, built | Real: every run's ticket, page and goal bodies stayed in the store forever. |
| DW-45 | Guided snooze date question | accepted, built | Real: **the fourth new surface without a guided form** (my DW-18 brief named none). |
| DW-46 | Announce snoozed items that woke | accepted, built | Real: the builder documented it in triage.md, and SKILL.md never told the agent. |

10 of 10 real. Outcomes: DW-34 right; DW-9 partly, DW-18 partly; DW-31, 32, 35, 36 right. Correction: the DW-9
outcome note cites DW-40 and DW-44, which should read DW-43 and DW-38. Again I wrote a note before listing the refs.
From now on I list the refs first.

## Built

- 4aed7c8 - **artifacts in the push (DW-37)**, with a unit test and an assertion in the seam test that drives the
  skill CLI against the real Forge core. **I confirmed that assertion fails with the old `RECORD_KEYS` and passes
  with the fix.**
- 9fe0ee7 - deciding time leads the Learning tab's triage figure (DW-41), by a builder. Its caveat, recorded:
  `decided_at` keeps only an item's latest decision, so a snooze followed by an accept understates deciding time;
  the exact figure would come from the `verdicts` table.
- 8cb2d2a - `run finish` drops cached ticket, page and goal text from every finished run; refs, titles and links
  stay (DW-44, with a test). XS: DW-38, 40, 43, 45, 46.
- World: PAGE-11 and PAGE-13; new tickets DOW-86 (the inbox now shows the tables), DOW-87 (dated snooze in Jira,
  more demand for DW-42) and DOW-88 (the store keeps growing: a new theme).
- Carried: DW-42 (Forge dated snooze, M) and the card-text quote guard (from DW-43).

## Quality (wave-04 -> wave-05)

Gates green: 115 tests (+2), forge 61 (+1), typecheck clean, build clean. Long functions 11, duplicated windows 48
and import cycles 0: unchanged. Code growth small (skill-lib +5, forge +26). Agent words 20,792 -> 20,891 (+99,
+0.5%). `store.mjs` 736 -> 741 lines: stewardship target for wave 6.

## Reflection

- **The best finding came from reading the contract against the writer.** DW-37 was invisible to every test: the
  skill's tests checked what outbox sends, and Forge's checked what it does with views it receives. Nothing
  crossed the seam with a view in it. The lens found it by comparing the contract text to `RECORD_KEYS`. The fix
  added the missing seam assertion, and I proved it can fail.
- **Outcome ratings work as a signal.** Rating DW-9 and DW-18 `partly` led the next scan to frame its cards as
  follow-ups to them. Honest `partly` ratings pay off.
- **My guided-mode miss is now structural.** Four surfaces in five waves, the last one under a brief I wrote after
  adding the guardrail. The guardrail binds my builds but my briefs did not carry it. Builder briefs now name
  the guided form of every runner-facing output.
- **Precision 46 of 46.** The surface is getting cleaner, and the cards are increasingly follow-ups to the
  previous wave rather than new ground. Wave 6 is the second stewardship pass.
