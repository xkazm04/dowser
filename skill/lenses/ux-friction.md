---
id: ux-friction
version: 0.3.0
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

Unconnected, the lens runs `partial`: it judges from code and UI strings, but cannot say how
often users hit the problem. Its confidence then rests on the code alone.

`skipped: no user interface or user-facing messages` when the repo has neither UI code nor
user-facing CLI or API error text.

## Direction

`context --lens ux-friction` returns `direction` when the team set one. Without it, run every
step below as written.

- **`focus`** (screens, flows or friction types, for example `checkout`, `onboarding`,
  `accessibility`): run Gather steps 1-6 on the files whose path, component name or strings
  match a focus term first, and add each term to the ticket query in step 7. Walk the
  hypotheses that fit the focus first. Then run the rest of Gather as usual: a focus orders the
  work and the ranking (see Choosing under the budget), it does not hide a blocking defect
  elsewhere. A friction type in `focus` (`accessibility` -> H4, `cancel` -> H3) puts that
  hypothesis first.
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

There are usually more findings than the 4 slots. Rank every candidate and write each one that
survives step 5: the store keeps the 4 ranked slots by score (the lens's top card is its MVP)
and files the rest in `reserve`, named in the summary. Your ranking reaches the store through
`impact` (below). Filler is still not a card: a weak candidate is dropped, not reserved.

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

| Tier | Core path, or 10+ tickets | Elsewhere |
| --- | --- | --- |
| Blocked | 9 | 7 |
| Pressured | 7 | 5 |
| Slowed | 4 | 3 |

`risk` is the risk of making the change (copy or a message 2, a new step or state 5, a change to
payment or consent flows 8); omit it and the store reads `delivery_risk.blast`. `category` is
`product` (the default for this lens). Before writing a card, read `context`'s `near` (with each
reason and note) and `outcomes` (with notes): set `predicted_verdict` and a `predicted_why` that
names the closest precedent ("a retry card on this screen was accepted"). With no precedent,
omit both; the store records `defer`.

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

A view goes on a card only when it shows what the body cannot at a glance. Its labels are two
to six words, its numbers match the body, and its `refs` are refs already in the card's
`evidence`.

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

The first card carries a `flow`, the second a `before-after`, the third an H4 `table`, and the
fourth carries no view.

```jsonl
{"lens":"ux-friction","kind":"unrecoverable-error","topic":"checkout-payment-error-recovery","anchors":["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"],"title":"Let people recover from a failed card payment without starting over","rationale":"When a card is declined, checkout shows a generic error and clears the form. People must re-enter everything and are not told what to try. Four blocked tickets in six months name this step.","body":"## Summary\nOn a declined payment, keep the form filled and tell the person what to try next.\n\n## Description\n`onPaymentError` resets the form state (`src/checkout/PaymentStep.tsx:88`) and shows a single message (`src/checkout/messages.ts:14`) with no next step. Query `decline OR declined OR payment` since 2026-04-28, grouped by component Checkout: 4 tickets, all blocked, among them SUP-310, SUP-322 and SUP-341, each describing re-typing the address after a decline. Done means the form keeps its values, the message names the likely cause (declined, expired, 3-D Secure failed) and offers retry or another method.\n\n## Flow\n- person submits a card that is declined\n- onPaymentError calls resetForm and shows the generic message\n- person sees an empty form and no hint; some abandon\n\n## Expected impact\nBlocks checkout for anyone whose card is declined; after the fix they retry in one step without re-typing. Measure retries after decline per week. Keeping fields filled must never keep the card number itself.\n\n## Evaluation\nClaim: user - a declined payment can be retried in one step\nBefore: 1 generic message for 3 decline causes; form cleared on every decline; 4 blocked tickets in 180 days\nAfter: 3 cause-specific messages; address fields kept, card number cleared\nMethod: count - read the error handler and the message table; counted tickets by component\nFalsified if: the payment provider returns no decline cause to show","evidence":[{"type":"code","ref":"src/checkout/PaymentStep.tsx:88","quote":"resetForm();"},{"type":"code","ref":"src/checkout/messages.ts:14","quote":"paymentFailed: 'Something went wrong. Please try again later.',"},{"type":"ticket","ref":"SUP-310","url":"https://example.atlassian.net/browse/SUP-310"},{"type":"ticket","ref":"SUP-322","url":"https://example.atlassian.net/browse/SUP-322"},{"type":"ticket","ref":"SUP-341","url":"https://example.atlassian.net/browse/SUP-341"}],"artifacts":[{"kind":"flow","message":"A decline clears the form and offers no next step","alt":"Flow of four checkout steps: enter address and card, submit, card declined, form cleared with a generic message. The last step is marked as the failure.","refs":["src/checkout/PaymentStep.tsx:88","src/checkout/messages.ts:14"],"data":{"steps":[{"label":"Enter address and card"},{"label":"Submit payment"},{"label":"Card declined"},{"label":"Form cleared, generic message","mark":"failure"}]}}],"effort":{"size":"S","days_low":1,"days_high":2,"basis":["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"]},"confidence":"high","confidence_why":"The handler and three tickets describe the same behaviour; a provider log of decline causes would raise it.","delivery_risk":{"blast":"high"},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"codex"}}
{"lens":"ux-friction","kind":"dark-pattern","topic":"account-cancel-extra-steps","anchors":["src/account/CancelFlow.tsx","src/account/SignupFlow.tsx"],"title":"Make cancelling a subscription as short as signing up","rationale":"Signing up takes one page; cancelling takes four, including a pre-ticked offer to pause. That pressure costs trust and may breach consumer rules on easy cancellation.","body":"## Summary\nCut the cancel flow to one confirmation page with no pre-selected retention offer.\n\n## Description\nSignup is one page (`src/account/SignupFlow.tsx:20`). Cancel walks through four steps (`src/account/CancelFlow.tsx:31`) and the pause offer is pre-ticked (`src/account/CancelFlow.tsx:64`). Done means one page that states what ends and when, with an optional, un-ticked offer.\n\n## Flow\n- person opens Cancel subscription\n- four steps follow: reason survey, discount offer, pause offer pre-ticked, confirm\n- an inattentive person pauses instead of cancelling\n\n## Expected impact\nPressures everyone who leaves; after the fix they leave in one step and involuntary pauses stop. Short-term retention may dip, which is the honest number.\n\n## Evaluation\nClaim: user - leaving is as easy as joining\nBefore: signup 1 step, cancel 4 steps, 1 pre-ticked retention option\nAfter: cancel 1 step, 0 pre-ticked options\nMethod: count - steps counted in both flow components\nFalsified if: steps 2-3 are legally required disclosures in the markets served","evidence":[{"type":"code","ref":"src/account/CancelFlow.tsx:31","quote":"const steps = [ReasonSurvey, DiscountOffer, PauseOffer, Confirm];"},{"type":"code","ref":"src/account/CancelFlow.tsx:64","quote":"<Checkbox name=\"pause\" defaultChecked />"},{"type":"code","ref":"src/account/SignupFlow.tsx:20","quote":"const steps = [Details];"}],"artifacts":[{"kind":"before-after","message":"Cancelling drops from 4 steps to 1, with no pre-ticked offer","alt":"Before and after of the steps to cancel a subscription. Before: reason survey, discount offer, pause offer pre-ticked, confirm. After: one confirm page with an optional offer. Signup is one step.","refs":["src/account/CancelFlow.tsx:31","src/account/CancelFlow.tsx:64","src/account/SignupFlow.tsx:20"],"data":{"measure":"steps to cancel","before":["Reason survey","Discount offer","Pause offer, pre-ticked","Confirm"],"after":["Confirm, optional un-ticked offer"]}}],"effort":{"size":"S","days_low":0.5,"days_high":1.5,"basis":["src/account/CancelFlow.tsx"]},"confidence":"medium","confidence_why":"Read from code only (no tickets connected); churn feedback mentioning the flow would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"codex"}}
{"lens":"ux-friction","kind":"accessibility-gap","topic":"checkout-controls-keyboard-labels","anchors":["src/checkout/AddressForm.tsx","src/checkout/PaymentStep.tsx"],"title":"Make the checkout form usable by keyboard and screen reader","rationale":"The postcode input has no label and the pay button is a clickable div, so a screen-reader or keyboard user cannot finish checkout.","body":"## Summary\nLabel the checkout inputs and make the pay control a real button.\n\n## Description\nThe postcode input has only a placeholder (`src/checkout/AddressForm.tsx:42`), failing WCAG 2.2 1.3.1 and 4.1.2. The pay control is a div with a click handler (`src/checkout/PaymentStep.tsx:120`), failing 2.1.1: it is never focusable. Done means every input has a programmatic label and the pay control is a `button` reachable by Tab.\n\n## Flow\n- keyboard user tabs through the address form\n- the postcode field is announced without a name\n- Tab skips the pay control; checkout cannot be finished\n\n## Expected impact\nBlocks checkout for keyboard and screen-reader users; after the fix they can pay. Restyling the pay control must keep its current look.\n\n## Evaluation\nClaim: user - checkout can be completed by keyboard alone\nBefore: 1 unlabelled input, 1 unfocusable pay control on the core path\nAfter: 0 unlabelled inputs; pay reachable by Tab and Enter\nMethod: quote - read both components\nFalsified if: a wrapper adds the label and button role at render time","evidence":[{"type":"code","ref":"src/checkout/AddressForm.tsx:42","quote":"<input name=\"postcode\" placeholder=\"Postcode\" />"},{"type":"code","ref":"src/checkout/PaymentStep.tsx:120","quote":"<div className=\"pay\" onClick={submit}>Pay now</div>"}],"artifacts":[{"kind":"table","message":"The pay control cannot be reached by keyboard; the postcode input has no label","alt":"Table of two accessibility failures in checkout. Postcode input without a label fails 1.3.1 and 4.1.2. Pay control as a div with a click handler fails 2.1.1.","refs":["src/checkout/AddressForm.tsx:42","src/checkout/PaymentStep.tsx:120"],"data":{"columns":["Criterion","Site","Fails because"],"rows":[["1.3.1, 4.1.2","AddressForm.tsx:42","placeholder, no label"],["2.1.1","PaymentStep.tsx:120","div with onClick, not focusable"]],"highlight":[1]}}],"effort":{"size":"XS","days_low":0.25,"days_high":0.5,"basis":["src/checkout/AddressForm.tsx","src/checkout/PaymentStep.tsx#submit"]},"confidence":"medium","confidence_why":"Both markup lines show the defect directly; an accessibility checker run or a ticket from an affected user would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"codex"}}
{"lens":"ux-friction","kind":"confusing-copy","topic":"export-button-label-mismatch","anchors":["src/reports/ExportButton.tsx"],"title":"Name the export button for the file it actually produces","rationale":"The button says Export to Excel but the handler writes a CSV, so people expect formatting and formulas they will not get.","body":"## Summary\nRelabel the report export button to say CSV.\n\n## Description\nThe label reads Export to Excel (`src/reports/ExportButton.tsx:12`) while the handler builds a CSV blob (`src/reports/ExportButton.tsx:30`). Done means the label names CSV.\n\n## Flow\n- person clicks Export to Excel\n- the handler downloads a CSV file\n\n## Expected impact\nSlows people who expect a spreadsheet with formatting; after the fix the label matches the file. Nothing else changes.\n\n## Evaluation\nClaim: user - the label matches the file format\nBefore: label says Excel, file is CSV\nAfter: label says CSV\nMethod: quote - read the label and the handler\nFalsified if: a later step converts the CSV to xlsx before download","evidence":[{"type":"code","ref":"src/reports/ExportButton.tsx:12","quote":"<Button>Export to Excel</Button>"},{"type":"code","ref":"src/reports/ExportButton.tsx:30","quote":"const blob = new Blob([csv], { type: 'text/csv' });"}],"effort":{"size":"XS","days_low":0.25,"days_high":0.25,"basis":["src/reports/ExportButton.tsx"]},"confidence":"medium","confidence_why":"Label and handler are quoted from one file; a ticket about the format would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.2.0","model":"<model id>","harness":"codex"}}
```

## No finding

```
ux-friction: ran|partial (<reason>)|skipped (<reason>) - no proposals.
Checked: H1 <n empty states read in ...>; H2 <n error strings read, all with a next step>;
H3 <cancel flow: n steps vs signup n|no exit flows>; H4 <...>; H5 <...>; H6 <...>.
Tickets: <n ingested, window <from>..<to>, by component|not connected>. Excluded by direction: <titles|none set>.
```
