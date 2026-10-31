---
id: ux-friction
version: 0.3.2
name: UX friction and wellbeing
kinds: [dead-end, unrecoverable-error, dark-pattern, accessibility-gap, missing-feedback, confusing-copy]
sources: [code, docs, git, tickets]
optional_sources: []
requires_connection: false
budget: 4
---
# UX friction and wellbeing

## What it finds

Places where the product works against the person using it: dead ends with no way forward,
error messages that offer no recovery, dark patterns that push people against their interest,
accessibility gaps, actions that give no feedback, and copy that confuses. Example from the
plan: "Checkout error gives no recovery path; 12 tickets mention it".

Unconnected, the lens runs `partial`: it judges from code and UI strings alone, and cannot say
how often users hit the problem.

`skipped: no user interface or user-facing messages` when the repo has neither UI code nor
user-facing CLI or API error text.

## Direction

`context --lens ux-friction` returns `direction` when the team set one. Without it, run every
step below as written.

- **`focus`** (screens, flows or friction types: `checkout`, `onboarding`, `accessibility`):
  run Gather steps 1-6 first on files whose path, component or strings match a focus term, and
  add each term to the step 7 ticket query. A friction type (`accessibility` -> H4, `cancel` ->
  H3) puts that hypothesis first. Then run the rest: focus orders the work and the ranking, it
  never hides a blocking defect elsewhere.
- **`exclude`**: before writing `<work>/ux-friction.jsonl`, remove every candidate whose topic,
  screen or kind matches an excluded term. Never re-word one to slip past it. List each removed
  title in the lens summary as `excluded by direction: <term> - <title>`; it is never written
  (so never in `reserve`) and never dropped silently.
- **`notes`**: the team's intent, binding like this pack's own guidance. Apply it at ranking: a
  note such as "mobile first" or "we know about the legacy admin" moves matching candidates up
  or down within a tier. A note never lifts a candidate whose evidence would not pass on its own.

## Gather

1. **UI surface.** `git ls-files` filtered to `**/*.{tsx,jsx,vue,svelte,html,erb,hbs}`,
   `**/pages/**`, `**/components/**`, `**/views/**`, `**/templates/**`. For a CLI or API product,
   use its command and error-response modules instead. Note which screens sit on a core path
   (signup, sign-in, checkout or payment, the product's main task, cancel or delete): routes,
   nav links and the README name them.
2. **User-facing errors.** `git grep -n -E "(toast|alert|notify|setError|showError|flash)\(|throw new [A-Za-z]*Error\(['\"]"`,
   and the i18n or strings files (`**/locales/**`, `**/i18n/**`, `**/*strings*`). For each error
   string, read the code around it **and its caller**: is there a retry, a link, a next step, or
   a parent (error boundary, wrapper, `catch` one level up) that recovers? An error that recovers
   one level up is not a finding.
3. **Dead ends.** Empty states and terminal screens:
   `git grep -n -i -E "no (results|items|data)|nothing (here|found)|something went wrong|try again later|404|not found"`.
   Check whether each one offers an action, in the component or the layout around it.
4. **Dark patterns.** `git grep -n -i -E "defaultChecked|checked=\{?true|preselect|auto.?renew|countdown|only [0-9]+ left|are you sure you want to (leave|cancel)|confirmshaming|unsubscribe"`;
   cancel and delete flows (`git grep -n -i -E "cancel(Subscription|Account)|deleteAccount|unsubscribe"`)
   compared with their signup counterparts. Count the steps on each side from the step list or
   the routes, and keep both numbers.
5. **Accessibility.** `git grep -n -E "<img(?![^>]*alt=)|onClick=\{[^}]*\}[^>]*>(?![^<]*<button)|tabIndex=\{?-1|outline: ?none|aria-hidden=\"true\""`
   (use `-P` for lookaheads, or grep plainly and read). Look for inputs without a label,
   icon-only buttons without `aria-label`, color-only status, and fixed font sizes in px on body
   text. Group sites by screen and by WCAG 2.2 criterion as you go.
6. **Missing feedback.** Mutating handlers (`onSubmit`, `POST`, `PUT`, `DELETE` calls) with no
   loading, success or failure state nearby, in the handler or the component that renders it.
7. **Tickets (connected).** Call `dowser_sources_tickets` with
   `{query: "error OR stuck OR confusing OR \"can't\" OR lost OR accessibility OR \"screen reader\"", since: <today minus 180 days, ISO>, limit: 50}`,
   plus one query per screen you found friction on (its name and its component name). Save each
   response verbatim under `<work>/` (the OS temp folder, never the repo) and run `ingest-sources --run <run_id> --type ticket --file <saved-response>`.
   Cite only the refs it returns; `verify` drops any other ticket ref.
   - **Group demand by screen.** Use `components` first, then `labels`, then the screen named in
     the title. Keep per screen: the ticket count, the refs, and the window (`created_at` of the
     oldest and newest, or the `since` you sent). A count is always stated with its window.
   - **Tag each ticket blocked or annoyed** from its own words: `blocked` when the person could
     not finish ("can't", "stuck", "lost my", "gave up", "locked out", "charged twice", a screen
     reader or keyboard that cannot reach it); `annoyed` when they finished with effort
     ("confusing", "slow", "had to retry", "took ages"). Untaggable tickets count only as reach.

Record empty steps ("no cancel flow in this product") and go on. Unconnected, skip step 7 and
record `partial: tickets not connected (demand per screen unmeasured)`.

## Hypotheses

- **H1 No way forward:** an empty state, error page or terminal screen offers no action back
  to the task. Kind: `dead-end`.
- **H2 Error without recovery:** a user-facing error says something failed but not what to do;
  or it shows a raw code or stack; or it drops what the user typed. Kind:
  `unrecoverable-error`.
- **H3 Asymmetric exits:** leaving (cancel, unsubscribe, delete, opt out) takes more steps, more
  pages or more pressure than joining; or consent is pre-ticked; or urgency is fake. Kind:
  `dark-pattern`.
- **H4 Excluded users:** images without alt text, controls unreachable by keyboard, inputs
  without labels, or status shown by color only. Kind: `accessibility-gap`.
- **H5 Silent action:** a save, send or delete gives no visible result or progress. Kind:
  `missing-feedback`.
- **H6 Copy that misleads:** a label or message says something the code does not do, or uses
  internal jargon. Kind: `confusing-copy`.

## Choosing under the budget

Rank every candidate and write each that survives step 5: the store ranks by score (top card =
MVP), the rest go to `reserve`. Your ranking reaches it through `impact` (below). Filler is
still not a card: a weak candidate is dropped, not reserved.

1. **Tier by effect on the person, shown in the evidence.**
   - **Blocked**: the person cannot finish or loses something: a dead end or unrecoverable error
     on a core path, typed input dropped, a control a keyboard or screen reader cannot reach on
     a core path, or tickets tagged `blocked` for that screen.
   - **Pressured**: the product pushes against their interest: pre-ticked consent, fake urgency,
     an exit longer than the entry.
   - **Slowed**: they finish with effort: missing feedback, confusing copy, a gap off the core
     path, or only `annoyed` tickets.
2. **Within a tier, order by reach**: the screen's ticket count in the window, `blocked` tickets
   before `annoyed`; unconnected, a core-path screen before a peripheral one. A team `focus`
   match goes first within its tier; `notes` reorder as the team wrote.
3. **Then by evidence strength**: code plus tickets on the same screen, then code with a count
   (`Method: count`), then a single quote.
4. **One card per screen and friction.** Several sites of the same defect on one screen are one
   card with the sites in evidence, not several cards.
5. **Drop before ranking**: anything that recovers one level up (Gather step 2), an empty state
   that offers an action, a confirm step the law or the domain needs (say so in the summary),
   test, story or fixture-only code, and tickets that do not name the screen.

## Impact, risk and the predicted verdict

Set `impact` (1-10) from the tier and the reach, with `impact_why` naming both in one line
("blocked on checkout: 12 tickets tagged blocked in 90 days"):

| Where | Blocked | Pressured | Slowed |
| --- | --- | --- | --- |
| Core path (its main line), or 10+ tickets | 9 | 7 | 4 |
| Error branch of a core path (a decline, a timeout, a failed save), under 10 tickets | 8 | 6 | 4 |
| Elsewhere | 7 | 5 | 3 |

`risk` is the risk of making the change (copy or a message 2, a new step or state 5, a change to
payment or consent flows 8); omit it and the store reads `delivery_risk.blast`. `category` is
`product`, this lens's default, and stays so: the store clamps a `technical` label back to `product` (`clamped` on the propose line), so no UX card skips the person's gate. Every card carries your `predicted_verdict` (`accept`,
`reject` or `defer`) and a `predicted_why`, after reading `context`'s `near` (reasons, notes) and
`outcomes` (notes). With a precedent, quote it ("a retry card on this screen was accepted");
without one, give your own reason (`references/cards.md`).

## Evidence rules

- Quote the exact user-facing string or the markup line (`code`), and the handler line that
  shows the missing recovery, feedback or extra step.
- H3 states both step counts (join vs leave) in Evaluation `Before`, from the code you read.
- H4 names the WCAG 2.2 success criterion (for example 1.1.1, 2.1.1, 1.3.1, 1.4.1) in
  Description. If the repo already runs an accessibility checker, cite its output instead of
  restating it.
- With tickets, cite at least 2 that describe the same screen. A count claim cites at least 3,
  and Description states the query, the grouping field (component, label or title) and the
  window. Do not attach generic "app is confusing" tickets.
- State the tier in Expected impact ("blocks checkout for ...", "slows ..."), and the effect on
  the person (lost work, pressure, exclusion), not only the conversion metric.

## Artifacts

A view shows what the body cannot at a glance: labels of two to six words, numbers that match
the body, `refs` already in the card's `evidence`.

- **`flow`: attach to every flow defect.** When a `dead-end`, `unrecoverable-error`,
  `dark-pattern` or `missing-feedback` card's Flow section walks three or more user steps, add a
  `flow` of the same steps, 3-8 of them, with the
  step where it goes wrong marked `failure` (the error or dead end), `friction` (an extra or
  pressuring step) or `missing` (the feedback or exit that is not there). `message` names the
  marked step. A Flow of two lines, or one that is a build order, gets no view.
- **`before-after`: attach when the fix changes a count the person feels.** H3 always (steps to
  leave vs to join); H2 or H5 when the fix removes re-entry, retries or clicks. `measure` names
  the unit (`steps to cancel`); `before` and `after` list the steps, and their counts equal the
  Evaluation `Before` and `After` lines. A card may carry both a `flow` and a `before-after`.
- **`table`: attach to H4 when two or more sites or criteria are involved.** Columns
  `Criterion`, `Site`, `Fails because`; one row per site, highlight the rows that block the
  task (a control that cannot be reached or operated) and say so in `message`. One
  site with one criterion gets no view: Description says it.
- **No view** for H6 confusing copy, a single-string fix, or anything whose view would repeat
  one sentence of the body.

## Topic naming

`<screen-or-flow>-<problem>` in kebab case: `checkout-payment-error-recovery`,
`account-cancel-extra-steps`, `invoice-list-empty-state`, `settings-icon-buttons-labels`.
Name the place and the friction, not the fix.

## Examples

Read `<skill-dir>/references/examples/ux-friction.md` before the first card (a `flow`, a
`before-after`, an H4 `table`, a card with no view). In the jsonl each card is one line.

## No finding

```
ux-friction: ran|partial (<reason>)|skipped (<reason>) - no proposals.
Checked: H1 <n empty states read in ...>; H2 <n error strings read, all with a next step>;
H3 <cancel flow: n steps vs signup n|no exit flows>; H4 <...>; H5 <...>; H6 <...>.
Tickets: <n ingested, window <from>..<to>, by component|not connected>. Excluded by direction: <titles|none set>.
```
