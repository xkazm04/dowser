# Guided mode - plain language for product people

Guided mode runs the same pipeline as dev mode. Only the words change. The runner may never have
used a terminal tool before: give one instruction at a time, say what it is for, and stop
cleanly when something is missing.

## Preflight messages

Show one failure at a time, with its one fix. After the fix, run the preflight again from the
top.

| Check failed | Say |
| --- | --- |
| Not inside a project folder under version control | "Dowser needs to be started from inside your project's folder. Open the folder you downloaded the project into, start the assistant there, and type /dowser again." |
| Project was downloaded as a zip (no version history) | "This copy of the project has no history attached, so Dowser cannot tell what changed. Ask a developer for a 'clone' of the repository, or for access to it, and start from that folder." |
| Node missing | "Dowser needs a free helper program called Node.js (version 22.13 or newer). Install the LTS version from nodejs.org, close and reopen this window, then type /dowser again." |
| Node too old | "Your Node.js is version <v>. Dowser needs 22.13 or newer. Install the LTS version from nodejs.org, reopen this window, and try again." |
| Memory folder not writable | "Dowser keeps its notes in a folder called .dowser in your home folder, and it cannot write there. Check that your user can create folders in <home>, or ask IT, then try again." |
| Git missing (`git --version` fails) | "Dowser needs a free program called Git to read your project's history, and this computer does not have it. Install it from git-scm.com, reopen this window, then type /dowser again." |
| Store busy (exit 3 on a lock) | "Another Dowser scan is running on this project. Wait for it to finish, then try again." |
| Not connected to Jira | Not a failure. Say: "Dowser is not connected to your Jira and Confluence, so it will work from the project files only. Customer requests and goals will not be included, docs in Confluence will not be checked, and proposals will stay on this computer. To connect, ask your Jira admin to install the Dowser app and add its connection to this assistant." Then continue. |
| Jira answers `forbidden` (no access to this project's inbox) | Not a failure of the scan. Say: "Your Jira account cannot open this project's Dowser inbox, so this scan's proposals will stay on this computer. <the message Jira gave, e.g. which Jira project it follows>. Ask your Jira admin to give you access, then scan again." Then continue unconnected. |

Never show a stack trace, an exit code or a raw JSON error. If a step fails for a reason not in
this table, say what Dowser was trying to do, in one sentence, and stop: "Dowser could not
save its results, so it stopped before scanning. Nothing in your project was changed."

## Vocabulary

Guided output never uses the words on the left. Say the right column instead.

| Do not say | Say |
| --- | --- |
| commit, SHA, hash | "version" or "change", or leave it out |
| diff, delta | "what changed" |
| repo, repository | "the project" or "the project folder" |
| branch, HEAD, merge (git) | leave it out |
| fingerprint, fp | leave it out (keep it internally) |
| grep, regex, glob | "searched the code for" |
| stack trace, exit code, JSON | leave it out |
| lint, typecheck, CI | "automatic checks" |
| dependency, package, lockfile | "outside code the project uses" |
| CVE, SARIF | "a known security weakness", "the security report" |
| endpoint, route, handler | "the part of the app that handles <what>" |
| verified / dropped | "checked" / "set aside because the evidence did not hold up" |
| candidate | "draft proposal" |
| score, scan-score, impact 7/10 | "worth: 7 of 10" (impact), or leave the score out |
| unscored | "worth: not judged" |
| MVP | "top pick for <lens>" |
| reserve, band | "also found" |
| predicted verdict, slice, trust level, L1 | "Dowser's guess", "this kind of proposal", "how often Dowser guesses your decisions right" |
| pretriaged_by, machine pre-triaged | "pre-sorted by Dowser" |

"Merge" in triage stays, because it is the runner's own action: "this is the same as another
proposal".

## Progress

Use one short line per lens, in plain words:

```
Looking for opportunities: reading customer requests (42) and the code...
Looking for opportunities: 3 proposals, all checked against the code.
Checking for confusing screens and dead ends: done, 2 proposals.
Checking the docs against the code: partly done (Confluence is not connected), 1 proposal.
Checking security and EU Cyber Resilience Act duties: done, no proposals.
```

## Summary wording

- Lead with the count and what ran: "Dowser read the whole project and wrote 6 proposals. You
  kept 4, set aside 1, and 1 was the same as an existing one."
- When cards went to reserve: "Showing the top 4 of 7 for opportunities. The other 3 are kept
  as 'also found': <their titles>. They go to the inbox too, folded away."
- The top pick of a lens (its MVP): "Top pick for <lens in words>: <title>."
- Machine pre-triage (`pretriage` marked cards): "<n> proposals of a kind you have agreed with
  Dowser about 9 times out of 10 skipped this review and went straight to the inbox, marked as
  pre-sorted by Dowser. You still decide each one there."
- A trust change (`trust_events` from `ingest-verdicts` or `move`): earned - "Dowser has guessed
  your decisions on <lens in words> proposals of this size right 9 times out of 10, so from now
  on it may pre-sort them for you."; lost - "You turned down a proposal Dowser had pre-sorted, so
  it will ask you about that kind again."
- Set aside by the evidence check: "<n> proposals were set aside because the code no longer
  says what they quoted. That is the check working, not an error."
- An earlier scan that was interrupted and has now been closed (`abandoned`): "An earlier scan of this
  project stopped before it finished. Dowser has tidied it up; nothing was lost." Housekeeping, never an error.
- A partial lens is expected, not a failure. Name its cause. Not connected: "<Lens> was partly
  done because <source> is not connected. That is normal without the Jira connection. To
  include <what it adds>, ask your Jira admin to install the Dowser app and connect it here."
  A checker missing on this computer: "<Lens> was partly done because a free checker program,
  <tool>, is not installed here. A developer can install it; nothing else is needed."
- **Never** "all clear", "no issues" or "everything looks good". If there are no proposals: "No
  proposals this time. Dowser checked <what ran>. It could not check <what was skipped>, because
  <reason>."
- On a focused scan: "This scan only looked at <goal/area>, so it says nothing about the rest of
  the project."

## Triage

- The overview table names lenses in words ("Opportunities", "Confusing screens", "Docs",
  "Security"), sizes in words ("a few days"), worth as "7 of 10" ("not judged" when unscored),
  marks each lens's top pick, and shows no file paths or line numbers; a `full` card's
  Description drops its `path:line` refs the same way. The reserve follows as one line: "Also
  found (kept, not shown card by card): <titles>. Ask to see any of them."
- Ask for a reject reason as a question, and store the code behind the answer:

| Ask | Code |
| --- | --- |
| "The evidence does not show this" | `false-positive` |
| "We already track it or decided it" | `already-known` |
| "True, but not where we are going" | `not-our-direction` |
| "True, but not worth the effort" | `not-worth-it` |
| "Right idea, but too big or too small" | `wrong-size` |
| "Something else (tell me why)" | `other`, with their words as the note |

- Snooze: ask "Until when? Give me a date, or say no date and it comes back when there is new evidence."
  Turn "after the release" or "next month" into a date only after the runner confirms it. A refused date
  is said plainly: "That date has already passed; give me a day after today." 

## Ask-why patterns

Answer from `show <fp>` only, in this order, in plain words:

1. **What it is based on:** "This came from 12 customer requests (for example SUP-118, 'export
   my report to Excel') and from the code that already writes CSV files."
2. **Why Dowser thinks so:** the rationale, reworded for the question asked.
3. **What would change its mind:** the `Falsified if` line.
4. **History:** "Proposed on <date>, checked against the code the same day, kept by <name>."

| Runner asks | Answer from |
| --- | --- |
| "Why this one?" | rationale + evidence |
| "Where does it say that?" | evidence quotes, as plain sentences with their location |
| "How big is it?" | effort size, days and basis, in words ("about 2 to 4 days, mostly in the reports area") |
| "Why is this one first?" | its worth (impact and its reason), how sure, the size and the risk, in words: "Worth 7 of 10 because 14 customers asked, sure, a few days, low risk". Never the formula. |
| "What did Dowser expect me to say?" | `predicted_verdict` and `predicted_why`, as "Dowser guessed you would <accept/turn down/put off> it, because <the precedent in words>". |
| "Didn't we reject this?" | transitions: who decided what, and when |
| "Is this still true?" | Say that the stored evidence is from <date>, and offer a new scan. Do not rescan unasked. |

If the stored evidence does not answer the question: "Dowser's notes for this proposal don't
cover that. A new scan could check it. Want me to run one?"
