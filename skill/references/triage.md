# Triage - statuses, moves, reasons, memory

`dowser.mjs` holds the status of every proposal. Every move is compare-and-set: it names the
status it expects to move from. A move that is illegal, or that comes from a stale status, exits
2 and prints the current status. Read that status, tell the runner, and never force the move.

## Statuses and moves

| From | To | Who | How |
| --- | --- | --- | --- |
| (new) | `candidate` | script | `propose` |
| `candidate` | `verified` | script | `verify`: every code and doc quote was found |
| `candidate` | `dropped` | script | `verify`: a quote was missing; note `verify-failed:<ref>` |
| `verified` | `rejected` | human | `move --to rejected --reason <code>` (pre-triage) |
| `verified` | `snoozed` | human | `move --to snoozed [--until YYYY-MM-DD]` |
| `verified` | `merged` | human, or agent for a same-work duplicate | `move --to merged --into <fp>` |
| `verified` | `pushed` | script | `ingest-push`, after `dowser_proposals_push` |
| `verified` | `accepted` | human only (`--by human:<name>`) | `move --to accepted` (offline acceptance, see below) |
| `pushed` | `accepted` / `rejected` / `merged` / `snoozed` | human in Jira (`forge:<jira-user>`) | `ingest-verdicts`, after `dowser_verdicts_pull` |
| `snoozed` | `candidate` | script | `propose` with any new evidence key (resurfacing) |
| `snoozed` | `verified` | human | `move --to verified` (the runner un-snoozes it) |
| `snoozed` | `verified` | store (`skill:dowser`) | `run start`, once the `--until` date has passed |
| `rejected` | `candidate` | script | `propose` that passes the rejected-resurfacing test |
| `dropped` | `candidate` | script | `propose` with a new evidence key (a retry after a failed verify) |

A resurfaced item goes back through `verify` like a new one. `decided_by` is always
`kind:name`: `human:<name>` for the runner, `agent:<harness>` for the scanning agent,
`forge:<jira-user>` for a verdict pulled from Jira, and `skill:dowser` / `skill:dowser-verify`
for the store's own moves.

An **evidence key** is what makes evidence "new". For `code` and `doc` it is the path plus the
quote with whitespace collapsed. The line number is only a hint, so the same quote at a shifted
line is not new evidence. For every other type, the key is the `ref`.

**`accepted` is a human act.** It normally arrives from Jira: a person accepts the item in the
Dowser inbox, which creates the Jira issue, and the pulled verdict records that issue on the card
(`issue_ref`, `issue_url`). Offline, the runner may say
explicitly "accept this one". Only then record `move <fp> --to accepted --by human:<name>`.
If that move exits 2, the transition table does not allow it from the current status. Say so;
the item stays kept and is pushed on the next connected run.

## Reason codes (closed)

| Code | Use when | Example |
| --- | --- | --- |
| `false-positive` | The evidence does not show what the card claims. | "The 'missing retry' is handled by the queue wrapper in jobs/runner.ts." |
| `already-known` | The team already tracks it or already decided it. | "That is PAY-311, planned for next sprint." |
| `not-our-direction` | True, but not where the product is going. | "We are dropping the desktop export, not extending it." |
| `not-worth-it` | True and in direction, but the gain does not pay for the cost. | "Four users a year hit this screen." |
| `wrong-size` | The idea is right but it is scoped too big or too small to act on. | "Split this: the API part is S, the UI part is L." |
| `other` | None of the above. **A note is required.** | `other` + note "legal is reviewing this flow; ask again in Q2" |

Ask for the code first, then offer an optional note. For `other`, keep asking for the note
until the runner gives one or picks another code. The move is refused without it.

## Snooze

"Not now, but tell me if it gets stronger." The item is held back from later scans until its
evidence grows: **any new evidence key** at the same fingerprint resurfaces it as `candidate`.
Snoozing is not a soft reject, and it teaches no rule.

A date is optional: "not until after the release" is
`move <fp> --to snoozed --by human:<name> --until YYYY-MM-DD`. The date must be a real calendar
day after today, and `--until` is refused on any move that is not to `snoozed` (exit 2). On the
first `run start` on or after that day (the runner's local date), the item wakes: it moves
`snoozed -> verified` by `skill:dowser` with the note `snooze until <date> passed`, and
`run start` lists it under `woke`. Tell the runner which items woke; a woken item is kept and is
pushed on the next connected run like any other. New evidence still resurfaces a dated item
early. Leaving `snoozed` by any route clears the date. Without a date, only new evidence brings
the item back. `list --status snoozed` shows each item's `snooze_until` when it has one.

A dated snooze can also come from Jira: a person who snoozes in the inbox may pick an **Until** day,
and the pulled verdict carries it as `snooze_until`. `ingest-verdicts` records it as the card's date.
If that day has already passed by the time the skill pulls it, the snooze is still recorded with its
date, and the next `run start` wakes it as above. Only a sync can record a past date; a person's
`move --until` keeps refusing one.

## Merge

"This is the same work as that one." Merging moves the item to `merged`, records `merged_into`,
and holds its fingerprint back from later scans. Merge only same-work items: the same
capability or defect in the same place. Two cards about one screen that propose different
changes are distinct.

- The **agent** may merge a verified item into an open or accepted item it judged to be the same
  work (SKILL.md section 6). It tells the runner in the next triage batch.
- The agent **never** merges into a `rejected` or `snoozed` item. That would hide a decision.
  The runner decides.
- In Jira, a merge into an existing issue arrives as a `merged` verdict.

## Resurfacing (who comes back, and when)

- `snoozed`: comes back on any new evidence key, or (as `verified`) once its `--until` date passes.
- `rejected`: comes back only if **both** of these hold:
  - a new evidence **type** appears that the item did not have when it was rejected (for
    example a `ticket` where there was only `code`);
  - the number of distinct evidence keys is at least **double** the count at rejection time.
- Otherwise `propose` answers `suppressed`. Report suppressed counts per lens in dev mode, and
  never as findings.
- `dropped`: comes back as `candidate` when `propose` adds a new evidence key, such as a
  corrected quote. `verify` then checks only the evidence on that newest line. Re-proposing the
  same quote, even at another line, leaves it `dropped`.
- `merged` does not resurface.

## Rule offers

When three or more items of one lens were rejected with the same reason code and share a topic
token, `rules offer` drafts a rule, for example:

> Do not propose ux-friction items about onboarding (rejected 3x as not-our-direction)

- Present each new offer **once**, with its draft text and the titles it came from.
- The runner accepts (`rules accept <id> --by human:<name>`, optionally with
  `--text "<edited wording>"`) or declines (`rules decline <id> --by human:<name>`).
- When Dowser for Jira is connected, an offered rule is also sent to Forge (`reflect export`,
  `dowser_reflect_sync`, `reflect ingest`). A person can accept (with edited wording) or decline it
  there. Whoever decides first wins; a rule that is no longer `offered` locally is never
  overwritten. A Forge decision is recorded as decided by `forge:<account>`.
- Only accepted rules reach a lens's `context` pack. There they bind like the pack's own
  rules. A declined cluster is never offered again.
- Rules change **what** a lens proposes and **how**, never how many. The budget stays 4 per lens.

## Exemplars

The last 5 `accepted` items per lens, local or pulled from Jira, arrive in `context` as
`exemplars`. Use them as the bar: match their evidence depth, their sizing honesty and their
title style. Do not copy their topics, and do not propose variants of them. An accepted item is
already decided.

## What the runner sees per card

Keep / Reject (then the reason) / Snooze / Merge, plus "keep the rest" once per batch. Keep
records nothing. It leaves the item `verified` for the push.
