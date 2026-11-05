# Build brief - scan-sweep ideas-2026-11-05 backlog (operator-approved 2026-11-05)

You build ONE package of operator-accepted findings in your own git worktree of the Dowser repo
(`C:\Users\kazda\kiro\dowser\.claude\worktrees\sweep-<x>`, branch `sweep/2026-11-05-<x>`). Four other
agents build the other packages in parallel worktrees; the lead merges all five branches into master
and cuts the release. Stay inside your package's files where you can.

## Inputs
- Your package: `packages.json` beside this file, key `<x>`: finding numbers `n[]` and any `extra` items.
- Each finding's full card (Summary / Description / Flow / Expected impact / Evaluation, evidence,
  size): `backlog-accepted.jsonl` beside this file, the line whose `n` matches. Read the body; it names
  file:line. Re-read the code before you change it: the card is a claim, not the truth. If a finding
  turns out false or already fixed, do not build it; record it as `false-positive` or `already-fixed`.
- Repo rules: `AGENTS.md` at the worktree root (Gates, Rules: plain ESM .mjs with // @ts-check, zero
  runtime dependencies, absent = omit the key, English only, card copy lives in packs/SKILL.md).

## How to work
1. `cd` into your worktree. Install deps there if the gates need them: `npm ci` at the root, and
   `npm ci --prefix forge` / `npm ci --prefix forge/static/app` when you touch forge.
2. One finding = one small atomic commit (conventional style as in `git log`, e.g.
   `fix(skill): ...`, `test(forge-app): ...`), with a regression test where the finding is testable.
   End every commit message with the line:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
3. Gates before each commit for what you touched, and all of them at the end (AGENTS.md "Gates"):
   `npm run typecheck`, `npm test`; for forge/: `npm run forge:typecheck`, `npm run forge:test`,
   `npm run forge:check-shared`; for forge/static/app/: also `npm run forge:build-ui`. Check the REAL exit
   status (never pipe a gate through tail/head and trust the pipe). A shared module changed in
   `skill/scripts/lib/` that forge copies (`forge/src/shared/`) must be re-synced with
   `node forge/scripts/sync-shared.mjs` in the same commit.
4. Never push, never merge, never tag, never touch master or another worktree, never force anything,
   never bypass hooks. No deploys (`forge deploy`) and no live e2e (`tools/forge-live-e2e.mjs`): e2e
   follows the release, it is not yours.
5. Keep going through the whole package; do not stop to ask. If an item needs a design choice the
   card does not settle, take the smallest change that keeps the documented behaviour, and say so.

## Report (your final message, under 300 words)
Per finding n: `built <sha>` | `false-positive: why` | `already-fixed` | `skipped: why`. Then the
gate results (each command and its exit code), files touched outside your package's area, and anything
the lead must know when merging (shared files, migrations numbers, version or changelog edits).
