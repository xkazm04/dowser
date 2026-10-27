---
id: ux-friction
version: 0.1.0
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

## Gather

1. **UI surface.** `git ls-files` filtered to `**/*.{tsx,jsx,vue,svelte,html,erb,hbs}`,
   `**/pages/**`, `**/components/**`, `**/views/**`, `**/templates/**`. For a CLI or API product,
   use its command and error-response modules instead.
2. **User-facing errors.** `git grep -n -E "(toast|alert|notify|setError|showError|flash)\(|throw new [A-Za-z]*Error\(['\"]"`,
   and the i18n or strings files (`**/locales/**`, `**/i18n/**`, `**/*strings*`). For each error
   string, read the code around it: is there a retry, a link, or a next step?
3. **Dead ends.** Empty states and terminal screens:
   `git grep -n -i -E "no (results|items|data)|nothing (here|found)|something went wrong|try again later|404|not found"`.
   Check whether each one offers an action.
4. **Dark patterns.** `git grep -n -i -E "defaultChecked|checked=\{?true|preselect|auto.?renew|countdown|only [0-9]+ left|are you sure you want to (leave|cancel)|confirmshaming|unsubscribe"`;
   cancel and delete flows (`git grep -n -i -E "cancel(Subscription|Account)|deleteAccount|unsubscribe"`)
   compared with their signup counterparts (count the steps on each side).
5. **Accessibility.** `git grep -n -E "<img(?![^>]*alt=)|onClick=\{[^}]*\}[^>]*>(?![^<]*<button)|tabIndex=\{?-1|outline: ?none|aria-hidden=\"true\""`
   (use `-P` for lookaheads, or grep plainly and read). Look for inputs without a label,
   icon-only buttons without `aria-label`, color-only status, and fixed font sizes in px on body
   text.
6. **Missing feedback.** Mutating handlers (`onSubmit`, `POST`, `PUT`, `DELETE` calls) with no
   loading, success or failure state nearby.
7. **Tickets (connected).** Call `dowser_sources_tickets` with
   `{query: "error OR stuck OR confusing OR can't find OR accessibility OR screen reader", limit: 50}`,
   plus one query per screen you found friction on. Then `ingest-sources --type ticket`.

Record empty steps ("no cancel flow in this product") and go on.

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

## Evidence rules

- Quote the exact user-facing string or the markup line (`code`), and the handler line that
  shows the missing recovery, feedback or extra step.
- H3 states both step counts (join vs leave) in Evaluation `Before`, from the code you read.
- H4 names the WCAG 2.2 success criterion (for example 1.1.1, 2.1.1, 1.3.1, 1.4.1) in
  Description. If the repo already runs an accessibility checker, cite its output instead of
  restating it.
- With tickets, cite at least 2 that describe the same screen. Do not attach generic
  "app is confusing" tickets.
- Wellbeing framing: describe the effect on the person (lost work, pressure, exclusion), not
  only the conversion metric.

## Topic naming

`<screen-or-flow>-<problem>` in kebab case: `checkout-payment-error-recovery`,
`account-cancel-extra-steps`, `invoice-list-empty-state`, `settings-icon-buttons-labels`.
Name the place and the friction, not the fix.

## Examples

```jsonl
{"lens":"ux-friction","kind":"unrecoverable-error","topic":"checkout-payment-error-recovery","anchors":["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"],"title":"Let people recover from a failed card payment without starting over","rationale":"When a card is declined, checkout shows a generic error and clears the form. People must re-enter everything and are not told what to try. Support tickets show customers giving up at this step.","body":"## Summary\nOn a declined payment, keep the form filled and tell the person what to try next.\n\n## Description\n`onPaymentError` resets the form state (`src/checkout/PaymentStep.tsx:88`) and shows a single message (`src/checkout/messages.ts:14`) with no next step. Tickets SUP-310 and SUP-322 describe re-typing the address after a decline. Done means the form keeps its values, the message names the likely cause (declined, expired, 3-D Secure failed) and offers retry or another method.\n\n## Flow\n- person submits a card that is declined\n- onPaymentError calls resetForm and shows the generic message\n- person sees an empty form and no hint; some abandon\n\n## Expected impact\nFewer abandoned checkouts after a decline and less re-typing; measure retries after decline per week. Keeping card fields filled must never keep the card number itself.\n\n## Evaluation\nClaim: user - a declined payment can be retried in one step\nBefore: 1 generic message for 3 decline causes; form cleared on every decline\nAfter: 3 cause-specific messages; address fields kept, card number cleared\nMethod: quote - read the error handler and the message table\nFalsified if: the payment provider returns no decline cause to show","evidence":[{"type":"code","ref":"src/checkout/PaymentStep.tsx:88","quote":"resetForm();"},{"type":"code","ref":"src/checkout/messages.ts:14","quote":"paymentFailed: 'Something went wrong. Please try again later.',"},{"type":"ticket","ref":"SUP-310","url":"https://example.atlassian.net/browse/SUP-310"},{"type":"ticket","ref":"SUP-322","url":"https://example.atlassian.net/browse/SUP-322"}],"effort":{"size":"S","days_low":1,"days_high":2,"basis":["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"]},"confidence":"high","confidence_why":"The handler and the tickets describe the same behaviour; a provider log of decline causes would raise it.","delivery_risk":{"blast":"medium"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"codex","run_id":"<run_id>"}}
{"lens":"ux-friction","kind":"dark-pattern","topic":"account-cancel-extra-steps","anchors":["src/account/CancelFlow.tsx","src/account/SignupFlow.tsx"],"title":"Make cancelling a subscription as short as signing up","rationale":"Signing up takes one page; cancelling takes four, including a pre-ticked offer to pause. That pressure costs trust and may breach consumer rules on easy cancellation.","body":"## Summary\nCut the cancel flow to one confirmation page with no pre-selected retention offer.\n\n## Description\nSignup is one page (`src/account/SignupFlow.tsx:20`). Cancel walks through four steps (`src/account/CancelFlow.tsx:31`) and the pause offer is pre-ticked (`src/account/CancelFlow.tsx:64`). Done means one page that states what ends and when, with an optional, un-ticked offer.\n\n## Flow\n- person opens Cancel subscription\n- four steps follow: reason survey, discount offer, pause offer pre-ticked, confirm\n- an inattentive person pauses instead of cancelling\n\n## Expected impact\nPeople leave in one step and trust the product more; involuntary pauses stop. Short-term retention may dip, which is the honest number.\n\n## Evaluation\nClaim: user - leaving is as easy as joining\nBefore: signup 1 step, cancel 4 steps, 1 pre-ticked retention option\nAfter: cancel 1 step, 0 pre-ticked options\nMethod: count - steps counted in both flow components\nFalsified if: steps 2-3 are legally required disclosures in the markets served","evidence":[{"type":"code","ref":"src/account/CancelFlow.tsx:31","quote":"const steps = [ReasonSurvey, DiscountOffer, PauseOffer, Confirm];"},{"type":"code","ref":"src/account/CancelFlow.tsx:64","quote":"<Checkbox name=\"pause\" defaultChecked />"},{"type":"code","ref":"src/account/SignupFlow.tsx:20","quote":"const steps = [Details];"}],"effort":{"size":"S","days_low":0.5,"days_high":1.5,"basis":["src/account/CancelFlow.tsx"]},"confidence":"medium","confidence_why":"Read from code only (no tickets connected); churn feedback mentioning the flow would raise it.","delivery_risk":{"blast":"low"},"provenance":{"lens_version":"0.1.0","model":"<model id>","harness":"codex","run_id":"<run_id>"}}
```

## No finding

```
ux-friction: ran|partial (<reason>)|skipped (<reason>) - no proposals.
Checked: H1 <n empty states read in ...>; H2 <n error strings read, all with a next step>;
H3 <cancel flow: n steps vs signup n|no exit flows>; H4 <...>; H5 <...>; H6 <...>.
```

Changelog: 0.1.0 - first pack.
