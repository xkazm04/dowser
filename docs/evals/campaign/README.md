# Hardening campaign - 10 waves of scan, decide, build, rescan

Started 2026-10-29. Dowser scans its own repository ten times. Between scans, the agent plays the team: it
decides every card in the (mock) Forge inbox, builds what it accepted, rates the outcome, and updates the
invented beta world the way a team would. The point is long-run behaviour on both sides:

- **Dowser as a product**: does it learn from verdicts (no re-proposals of rejected items, rules offered and
  followed), do its cards stay real as the obvious findings run out, does it find what the last wave broke?
- **The repository as it grows**: does each wave leave the code better, or does it pile up long functions,
  duplication, prompt bloat and coupling?

## Mechanics

| Piece | What it does |
|---|---|
| `node tools/dogfood.mjs --campaign ~/.dowser/campaign-2026-10 --budget-usd 20` | Clones HEAD into the temp folder, hides `tools/dogfood/` and `docs/evals/` (the world and these judgments), and scans with all four lenses. The Dowser home and the mock Forge state persist in the campaign folder, and the scan pushes its cards to the inbox. |
| `node tools/dogfood-decide.mjs --campaign <dir> inbox / decide / outcome / rules / rule` | The team's side: verdicts, outcome ratings and rule decisions, written where the next scan pulls them. |
| `node tools/quality-snapshot.mjs --label wave-NN --append docs/evals/campaign/quality.jsonl` | One row of structural measurements per wave, plus the delta since the last row. |
| `tools/dogfood/dowser-world.json` | The world: tickets, pages, goals and direction. It is refreshed into the inbox state before each scan. |

## The team's decision policy

The same rules every wave, so later waves are comparable:

1. **Accept** a card that is real (checked against the code, not the card), inside the direction, and serves a
   goal or a named user pain. **Build at most 3 S-or-larger items per wave**, the highest-value first (XS doc
   and wording fixes are not capped); an accepted card not built this wave goes on the carry-over list.
2. **Reject** with the honest reason code: `false-positive` (the evidence does not show it), `already-known`
   (built, or already accepted), `not-our-direction`, `not-worth-it`, `wrong-size`, or `other` with a note.
3. **Snooze** real work that waits on something named (for example G-3 release work until the release is planned).
4. **Merge** a card into an earlier item it repeats.
5. **Outcome:** after building an accepted card, rate it `right` / `partly` / `wrong` once the next scan has shown
   whether the gap closed.
6. **Rules** Dowser offers are accepted when they would have prevented a wrong card, and declined otherwise.

## The world evolves like a beta

After each build, the world changes as a real team's would: a fixed Confluence page is corrected, beta teams file
2-4 new tickets (reactions to what shipped, new asks, and honest regressions if a change broke something), and the
direction moves only when the team would move it. Every claim stays checkable against the code at that commit.

## Quality guardrails (checked every wave against the previous row)

- Gates green: `npm run typecheck`, `npm test`, and the forge gates when `forge/` changes.
- `lib_cycles` stays empty.
- `long_functions` and `dup_windows` do not grow without a stated reason; a wave that adds one pays it back.
- `agent_words` (SKILL.md, references, lens packs) grows at most 3% per wave unless something is removed for it.
  Every word is read by the agent on every scan.
- Tests grow with behaviour: no new branch in `skill/scripts/lib` without a test.
- Waves 3, 6 and 9 include a stewardship pass: the team pays down the worst item of the quality row, whether or
  not Dowser proposed it. Whether Dowser ever proposes such work is itself a finding.

## Files

- `wave-NN.md` - one per wave: the scan (cards, cost), every decision with its reason, what was built (commits),
  the quality delta and the reflection.
- `quality.jsonl` - the snapshot rows (`wave-00` is the baseline before the first scan).
- `../dogfood-2026-10-29.md` - the single scan that preceded the campaign.
