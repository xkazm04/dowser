# Hardening campaign - final report (10 waves, 2026-10-29/30)

Dowser scanned its own repository ten times against an invented closed beta (tickets, Confluence pages, goals and
a direction per lens, all checkable against the code). Between scans the agent played the team: it decided every
card in the mock Forge inbox, built what it accepted, rated outcomes, and evolved the world the way a beta does.
Per-wave detail is in `wave-01.md` ... `wave-10.md`; the structural rows are in `quality.jsonl`.

## Dowser as a product

| | Result |
|---|---|
| Cards proposed | 65 (per wave: 14, 9, 7, 6, 10, 3, 8, 5, 2, 1) |
| Real when checked against the code | **65 of 65.** None was a false positive, though one (DW-7) rested on a wrong premise in my seeded tickets that Dowser did not question |
| Team verdicts | 58 accepted, 3 snoozed (release work), 2 merged, 2 rejected |
| Outcome ratings of built items | 48 right, 10 partly, 0 wrong |
| Scan cost | $51.67 for ten scans (incremental from wave 2: $3.54 to $6.91 each) |
| Learning loop | **Every** merged, snoozed and rejected item stayed suppressed across all later scans, including a rejected one with fresh ticket demand (DW-33, DOW-79). Outcome ratings steered behaviour: `partly` ratings made the next scan frame follow-ups (wave 5) and propose fewer, more distinct cards (wave 8). |

**What it found that mattered most:**
1. **DW-37**: supporting views never reached the Jira inbox. `RECORD_KEYS` dropped `artifacts`, and every test on
   each side passed. Found by reading the contract against the writer.
2. **DW-34**: a high XSS advisory (prosemirror-view) bundled in the Jira app's UI. Found only after the wave-2
   monorepo audit (DW-19) and the wave-3 direction fix (security-cra 0.2.3) let it through.
3. **DW-28**: an incremental scan whose base left the history (rebase, force-push) diffed against nothing. My own
   harness bug exposed it.
4. **DW-61 / DW-63**: the retention promise for Jira text held only for scans that finish, and then the docs
   overstated the fix. Two waves of precise follow-up.
5. A steady stream of **its own previous wave's loose ends**: docs not synced, guided mode not given, a definition
   that misreads a weekend, a dialog that promises the wrong moment.

**What it could not see:**
- **A runtime crash** (fd853dd: the accept dialog crashed on open after my wave-8 change). Dowser reads code and
  docs, and does not run the product. A builder's fixture run caught it.
- **Code structure.** No lens proposed splitting the 418-line `Inbox` component or the growing store. Code health
  is outside the four lenses by design. Only the campaign's own snapshot watched it.
- **The quality of my seeded premise** (DW-7): eight tickets said cards were too long, and the rendering spec said
  otherwise. Dowser took demand over code for a claim about current behaviour.

## The repository as it grew

| Measure | wave-00 | wave-10 | Reading |
|---|---|---|---|
| Tests (skill) | 101 | 123 | +22, plus forge 58 -> 69. Test lines grew 17%, code lines 7%. |
| Code lines (skill lib, forge core and UI, tools) | 13,780 | 14,762 | +7% for ~25 features and fixes |
| Longest function | 191 (418 hidden) | 114 | The 418-line `Inbox` was invisible to the detector until wave 7, then split in wave 9 |
| Functions over 60 lines | 14 | 15 | Rose **because** of the Inbox split (one 418 -> several 60-107). A threshold count alone misleads. |
| Largest file | store.mjs 669 (growing to 788) | sync.mjs 563 | store split in wave 6; sync.mjs is the next to watch |
| Import cycles (skill lib) | 0 | 0 | Held through two module splits |
| Duplicated 6-line windows | 48 | 48 | Flat all campaign: never paid down, never grew |
| Words the agent reads per scan | 20,496 | 21,059 | +2.7% over ten waves, with features added; the wave-4 changelog move paid for most |

**Verdict: the code got better, not messier.** Every new module came with tests, the two largest
structural risks (the store and the Inbox component) were split behind unchanged interfaces with verified
behaviour, nothing gained a cycle, and the agent's prompt grew less than 3% while the product gained dated snooze,
quote withholding, monorepo audits, sharing, retention and a deciding-time metric. **The process, though, kept
shipping half-finished work**, and that is where the campaign's real lessons are.

## What degraded, and what was done about it

| Recurring defect | Times | Where the lesson now lives |
|---|---|---|
| A runner-facing output shipped without its guided-mode form | 5 | spark overlay Repo law |
| A behaviour change shipped with a stale doc | 4 | spark overlay Repo law (grep the OLD claim) |
| A seam change missed a test double or the seam test | 2 (artifacts, the mock's reopen) | spark overlay Repo law |
| A UI change shipped untested at runtime | 1 (a crash) | spark overlay Gates (fixture render) and the status doc |
| An outcome note cited the wrong refs | 2 | list refs before writing notes |

These lessons share a shape: the build was right at its center and wrong at its edges (the second mode, the
second doc, the second side, the runtime). Dowser was good at finding these edges, one wave late. The overlay now
carries them, so builders meet them before the scan does.

## The instrument

- The harness hid the seed with a commit in wave 1, which broke incremental scans. Wave 2 fixed it with a sparse
  checkout. A file **name** under `docs/evals/` still shows in `git diff --name-only` (wave 10 listed one); no card
  cited one.
- The quality snapshot had three blind spots, each found and fixed during the campaign: the lens changelog counted
  as prompt, synced shared copies counted twice, and `export default function` never matched. Each fix is
  recorded beside the row it changed.
- My acceptance rate (58 of 65) is above a real team's. Every card was real, but a real team would reject more on
  value, and rejections are Dowser's only negative signal. A future campaign should decide with a budget.

## What next

1. Convergence (2, then 1 card) answers DOW-100: on this repo and this world the lenses have little left. Scan
   another repository, or move this one to a weekly cadence.
2. Watch `sync.mjs` (563 lines, growing every wave the push changed) and `validateCandidate` (88 lines).
3. Give `forge:typecheck` coverage of `static/app`, so the fixture render is the second gate rather than the only one.
4. Re-measure the four packs on the lens fixture (`tools/lens-eval.mjs`, fixture v3): security-cra moved to 0.2.3
   and the opportunity measurement is n = 1.
