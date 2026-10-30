# UX friction and wellbeing - worked example cards

The cards the `ux-friction` pack (`lenses/ux-friction.md`, 0.3.1) points to. They are spread
over several lines here, one field per line, so each line stays readable; in
`<work>/ux-friction.jsonl` every card is **one line** (`JSON.stringify` of the object). Each one
passes `propose`'s validation and is scored by the store.

The first card carries a `flow` (the error branch of a core path: blocked, 8), the second a
`before-after` (predicted `defer` with the judge's reason), the third an H4 `table`, and the
fourth carries no view (predicted `reject`, quoting a rejected precedent). Each card's `risk`
sits in the band of its `blast` (`references/cards.md` "Delivery risk").

```json
{
  "lens": "ux-friction",
  "kind": "unrecoverable-error",
  "topic": "checkout-payment-error-recovery",
  "anchors": ["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"],
  "title": "Let people recover from a failed card payment without starting over",
  "rationale": "When a card is declined, checkout shows a generic error and clears the form. People must re-enter everything and are not told what to try. Four blocked tickets in six months name this step.",
  "body": "## Summary\nOn a declined payment, keep the form filled and tell the person what to try next.\n\n## Description\n`onPaymentError` resets the form state (`src/checkout/PaymentStep.tsx:88`) and shows a single message (`src/checkout/messages.ts:14`) with no next step. Query `decline OR declined OR payment` since 2026-04-28, grouped by component Checkout: 4 tickets, all blocked, among them SUP-310, SUP-322 and SUP-341, each describing re-typing the address after a decline. Done means the form keeps its values, the message names the likely cause (declined, expired, 3-D Secure failed) and offers retry or another method.\n\n## Flow\n- person submits a card that is declined\n- onPaymentError calls resetForm and shows the generic message\n- person sees an empty form and no hint; some abandon\n\n## Expected impact\nBlocks checkout for anyone whose card is declined; after the fix they retry in one step without re-typing. Measure retries after decline per week. Keeping fields filled must never keep the card number itself.\n\n## Evaluation\nClaim: user - a declined payment can be retried in one step\nBefore: 1 generic message for 3 decline causes; form cleared on every decline; 4 blocked tickets in 180 days\nAfter: 3 cause-specific messages; address fields kept, card number cleared\nMethod: count - read the error handler and the message table; counted tickets by component\nFalsified if: the payment provider returns no decline cause to show",
  "evidence": [{"type":"code","ref":"src/checkout/PaymentStep.tsx:88","quote":"resetForm();"},{"type":"code","ref":"src/checkout/messages.ts:14","quote":"paymentFailed: 'Something went wrong. Please try again later.',"},{"type":"ticket","ref":"SUP-310","url":"https://example.atlassian.net/browse/SUP-310"},{"type":"ticket","ref":"SUP-322","url":"https://example.atlassian.net/browse/SUP-322"},{"type":"ticket","ref":"SUP-341","url":"https://example.atlassian.net/browse/SUP-341"}],
  "effort": {"size":"S","days_low":1,"days_high":2,"basis":["src/checkout/PaymentStep.tsx#onPaymentError","src/checkout/messages.ts"]},
  "confidence": "high",
  "confidence_why": "The handler and three tickets describe the same behaviour; a provider log of decline causes would raise it.",
  "delivery_risk": {"blast":"high"},
  "impact": 8,
  "impact_why": "Blocked on the error branch of a core path (4 tickets): a declined card ends checkout and clears the form.",
  "risk": 8,
  "predicted_verdict": "accept",
  "predicted_why": "Closest precedent \"Let people retry a failed address lookup in checkout\" (c2e8a51f7d94b036) accepted: a retry card on this screen was kept.",
  "artifacts": [{"kind":"flow","message":"A decline clears the form and offers no next step","alt":"Flow of four checkout steps: enter address and card, submit, card declined, form cleared with a generic message. The last step is marked as the failure.","refs":["src/checkout/PaymentStep.tsx:88","src/checkout/messages.ts:14"],"data":{"steps":[{"label":"Enter address and card"},{"label":"Submit payment"},{"label":"Card declined"},{"label":"Form cleared, generic message","mark":"failure"}]}}],
  "provenance": {"lens_version":"0.3.1","model":"<model id>","harness":"codex"}
}
```

```json
{
  "lens": "ux-friction",
  "kind": "dark-pattern",
  "topic": "account-cancel-extra-steps",
  "anchors": ["src/account/CancelFlow.tsx","src/account/SignupFlow.tsx"],
  "title": "Make cancelling a subscription as short as signing up",
  "rationale": "Signing up takes one page; cancelling takes four, including a pre-ticked offer to pause. That pressure costs trust and may breach consumer rules on easy cancellation.",
  "body": "## Summary\nCut the cancel flow to one confirmation page with no pre-selected retention offer.\n\n## Description\nSignup is one page (`src/account/SignupFlow.tsx:20`). Cancel walks through four steps (`src/account/CancelFlow.tsx:31`) and the pause offer is pre-ticked (`src/account/CancelFlow.tsx:64`). Done means one page that states what ends and when, with an optional, un-ticked offer.\n\n## Flow\n- person opens Cancel subscription\n- four steps follow: reason survey, discount offer, pause offer pre-ticked, confirm\n- an inattentive person pauses instead of cancelling\n\n## Expected impact\nPressures everyone who leaves; after the fix they leave in one step and involuntary pauses stop. Short-term retention may dip, which is the honest number.\n\n## Evaluation\nClaim: user - leaving is as easy as joining\nBefore: signup 1 step, cancel 4 steps, 1 pre-ticked retention option\nAfter: cancel 1 step, 0 pre-ticked options\nMethod: count - steps counted in both flow components\nFalsified if: steps 2-3 are legally required disclosures in the markets served",
  "evidence": [{"type":"code","ref":"src/account/CancelFlow.tsx:31","quote":"const steps = [ReasonSurvey, DiscountOffer, PauseOffer, Confirm];"},{"type":"code","ref":"src/account/CancelFlow.tsx:64","quote":"<Checkbox name=\"pause\" defaultChecked />"},{"type":"code","ref":"src/account/SignupFlow.tsx:20","quote":"const steps = [Details];"}],
  "effort": {"size":"S","days_low":0.5,"days_high":1.5,"basis":["src/account/CancelFlow.tsx"]},
  "confidence": "medium",
  "confidence_why": "Read from code only (no tickets connected); churn feedback mentioning the flow would raise it.",
  "delivery_risk": {"blast":"medium"},
  "impact": 7,
  "impact_why": "Pressured on a core path: cancelling takes four pages and a pre-ticked pause, signing up one.",
  "risk": 5,
  "predicted_verdict": "defer",
  "predicted_why": "No similar decision in near or outcomes. Shortening the exit trades against retention numbers; the team weighs that, not the evidence.",
  "artifacts": [{"kind":"before-after","message":"Cancelling drops from 4 steps to 1, with no pre-ticked offer","alt":"Before and after of the steps to cancel a subscription. Before: reason survey, discount offer, pause offer pre-ticked, confirm. After: one confirm page with an optional offer. Signup is one step.","refs":["src/account/CancelFlow.tsx:31","src/account/CancelFlow.tsx:64","src/account/SignupFlow.tsx:20"],"data":{"measure":"steps to cancel","before":["Reason survey","Discount offer","Pause offer, pre-ticked","Confirm"],"after":["Confirm, optional un-ticked offer"]}}],
  "provenance": {"lens_version":"0.3.1","model":"<model id>","harness":"codex"}
}
```

```json
{
  "lens": "ux-friction",
  "kind": "accessibility-gap",
  "topic": "checkout-controls-keyboard-labels",
  "anchors": ["src/checkout/AddressForm.tsx","src/checkout/PaymentStep.tsx"],
  "title": "Make the checkout form usable by keyboard and screen reader",
  "rationale": "The postcode input has no label and the pay button is a clickable div, so a screen-reader or keyboard user cannot finish checkout.",
  "body": "## Summary\nLabel the checkout inputs and make the pay control a real button.\n\n## Description\nThe postcode input has only a placeholder (`src/checkout/AddressForm.tsx:42`), failing WCAG 2.2 1.3.1 and 4.1.2. The pay control is a div with a click handler (`src/checkout/PaymentStep.tsx:120`), failing 2.1.1: it is never focusable. Done means every input has a programmatic label and the pay control is a `button` reachable by Tab.\n\n## Flow\n- keyboard user tabs through the address form\n- the postcode field is announced without a name\n- Tab skips the pay control; checkout cannot be finished\n\n## Expected impact\nBlocks checkout for keyboard and screen-reader users; after the fix they can pay. Restyling the pay control must keep its current look.\n\n## Evaluation\nClaim: user - checkout can be completed by keyboard alone\nBefore: 1 unlabelled input, 1 unfocusable pay control on the core path\nAfter: 0 unlabelled inputs; pay reachable by Tab and Enter\nMethod: quote - read both components\nFalsified if: a wrapper adds the label and button role at render time",
  "evidence": [{"type":"code","ref":"src/checkout/AddressForm.tsx:42","quote":"<input name=\"postcode\" placeholder=\"Postcode\" />"},{"type":"code","ref":"src/checkout/PaymentStep.tsx:120","quote":"<div className=\"pay\" onClick={submit}>Pay now</div>"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.5,"basis":["src/checkout/AddressForm.tsx","src/checkout/PaymentStep.tsx#submit"]},
  "confidence": "medium",
  "confidence_why": "Both markup lines show the defect directly; an accessibility checker run or a ticket from an affected user would raise it.",
  "delivery_risk": {"blast":"low"},
  "impact": 9,
  "impact_why": "Blocked on a core path: keyboard and screen-reader users cannot reach the pay control.",
  "risk": 2,
  "predicted_verdict": "accept",
  "predicted_why": "No similar decision in near or outcomes. A control that blocks payment for keyboard users, fixed in markup, is rarely turned down.",
  "artifacts": [{"kind":"table","message":"The pay control cannot be reached by keyboard; the postcode input has no label","alt":"Table of two accessibility failures in checkout. Postcode input without a label fails 1.3.1 and 4.1.2. Pay control as a div with a click handler fails 2.1.1.","refs":["src/checkout/AddressForm.tsx:42","src/checkout/PaymentStep.tsx:120"],"data":{"columns":["Criterion","Site","Fails because"],"rows":[["1.3.1, 4.1.2","AddressForm.tsx:42","placeholder, no label"],["2.1.1","PaymentStep.tsx:120","div with onClick, not focusable"]],"highlight":[1]}}],
  "provenance": {"lens_version":"0.3.1","model":"<model id>","harness":"codex"}
}
```

```json
{
  "lens": "ux-friction",
  "kind": "confusing-copy",
  "topic": "export-button-label-mismatch",
  "anchors": ["src/reports/ExportButton.tsx"],
  "title": "Name the export button for the file it actually produces",
  "rationale": "The button says Export to Excel but the handler writes a CSV, so people expect formatting and formulas they will not get.",
  "body": "## Summary\nRelabel the report export button to say CSV.\n\n## Description\nThe label reads Export to Excel (`src/reports/ExportButton.tsx:12`) while the handler builds a CSV blob (`src/reports/ExportButton.tsx:30`). Done means the label names CSV.\n\n## Flow\n- person clicks Export to Excel\n- the handler downloads a CSV file\n\n## Expected impact\nSlows people who expect a spreadsheet with formatting; after the fix the label matches the file. Nothing else changes.\n\n## Evaluation\nClaim: user - the label matches the file format\nBefore: label says Excel, file is CSV\nAfter: label says CSV\nMethod: quote - read the label and the handler\nFalsified if: a later step converts the CSV to xlsx before download",
  "evidence": [{"type":"code","ref":"src/reports/ExportButton.tsx:12","quote":"<Button>Export to Excel</Button>"},{"type":"code","ref":"src/reports/ExportButton.tsx:30","quote":"const blob = new Blob([csv], { type: 'text/csv' });"}],
  "effort": {"size":"XS","days_low":0.25,"days_high":0.25,"basis":["src/reports/ExportButton.tsx"]},
  "confidence": "medium",
  "confidence_why": "Label and handler are quoted from one file; a ticket about the format would raise it.",
  "delivery_risk": {"blast":"low"},
  "impact": 3,
  "impact_why": "Slowed, off the core path: the label promises Excel, the file is CSV.",
  "risk": 2,
  "predicted_verdict": "reject",
  "predicted_why": "Closest precedent \"Rename the Archive button to match what it does\" (9f4d16e2b07ac853) rejected as not-worth-it: one-label copy fixes were turned down.",
  "provenance": {"lens_version":"0.3.1","model":"<model id>","harness":"codex"}
}
```
