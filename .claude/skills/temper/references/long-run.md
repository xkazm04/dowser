# A long run

## Context

- You orchestrate only. Every scan, triage read, QA spec, build and UAT pass runs in a subagent. Each subagent writes
  its result to a file and answers with that file's path and one line.
- At the start of every cycle, re-read state from disk: `T clock`, `T modules bar`, `.temper/day.json` through
  `T day resume` when unsure, and the last cycle row. Do not carry conclusions across cycles in your head.
- Keep each subagent's brief self-contained (the card, the files, the gate commands). Never paste file dumps back into
  your own context.

## The clock

- The day ends at the charter's `until` (local time), else at start + `limits.wall_min` (8 h).
- `T clock` reports `drain: true` when less than 60 minutes remain, or while rate-limited. Draining means: finish the
  open cycle, start none, and go to the day end. `stop: true` means the end time has passed. Do only the day end.

## The usage window

- A rate-limit error from a subagent or a tool (a usage limit, HTTP 429, "rate limit") means the window is closing.
  Drain: let running subagents finish or stop, record what landed, and run
  `T clock --rate-limited --until <reset time from the error, else now + 1 h>`.
- Then call the **ScheduleWakeup** tool yourself with `wake_in_s`. Use the tool's maximum delay when `wake_in_s` is
  longer, and wake again until the window resets. temper.mjs cannot wake you.
- On wake, run `T clock`. When it is not draining, continue with the next cycle. When the end time passed while you
  slept, do the day end.
- A scan never calls ScheduleWakeup (temper-scan denies it).

## Resume a killed day

`T day resume` checks out the day branch, notes the resume, and prints every open cycle (`open_cycles`, one per repo)
and the clock. A `.temper/cycle.json` left by the first version is read as the open cycle of the repo it names
(Dowser), so a day begun before per-repo cycles continues; end it with `T cycle end --file <f> --repo dowser`. When a
cycle was open, re-read its files: the cycle row is missing, and the subagents' result files are in the temp folder.
Re-run the step that has no result file. If you cannot tell, end the cycle red with a `parked` note and start a new
one. Worktrees of other repos survive in `~/.temper/worktrees/`, and `day.json` keeps them under `repos`.
