// Realistic fixture data for the dev server (VITE_DOWSER_FIXTURE=1). Shapes follow forge/src/core/types.mjs:
// Card = dowser-proposal/1 record + inbox state. Absent values are omitted keys, as on the wire.

const REPO = 'https://github.com/acme/shop';
const SHA1 = '9f2c4e1a7b3d5e6f8091a2b3c4d5e6f708192a3b';
const SHA2 = '3b1d0c9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c';
const SHA3 = 'c0ffee1234567890abcdef1234567890abcdef12';

export const PUSHES = [
  { run_id: '2026-10-27T09-12-04Z-a1', at: '2026-10-27T09:14:10.000Z', head_sha: SHA1, project_key: 'github.com/acme/shop' },
  { run_id: '2026-10-20T16-40-51Z-c7', at: '2026-10-20T16:43:02.000Z', head_sha: SHA2, project_key: 'github.com/acme/shop' },
  { run_id: '2026-10-13T08-02-17Z-f3', at: '2026-10-13T08:05:44.000Z', head_sha: SHA3, project_key: 'github.com/acme/shop' },
];

const body = (summary) => `## Summary
${summary}

## Description
What the product does today, why that is a gap, and what done looks like. Cites \`src/checkout/payment.ts:88\`.

## Flow
- user submits a card payment -> the provider declines -> the page shows a blank error

## Expected impact
Fewer abandoned checkouts after a decline; measured as the retry rate. A retry could double-charge if idempotency keys are missing.

## Evaluation
Claim: user - declined payments become recoverable
Before: 41 support tickets in 90 days mention a blank payment error
After: under 10 tickets per 90 days, read from the same query
Method: count - Jira text search "payment error blank"
Falsified if: the provider already returns a retryable code the page shows`;

function card(over) {
  return {
    fp: over.fp, lens: 'opportunity', kind: 'gap', topic: over.topic ?? 'topic', anchors: ['src/checkout/payment.ts#submitPayment'],
    title: 'Title', rationale: 'Rationale.', body: body(over.summary ?? 'Do the thing.'),
    effort: { size: 'M', days_low: 2, days_high: 4, basis: ['src/checkout/payment.ts#submitPayment', 'src/checkout/ui/Error.tsx#PaymentError'] },
    confidence: 'medium', confidence_why: 'One code quote and three tickets agree; a usage count would raise it.',
    provenance: { lens_version: '1.2.0', model: 'claude-opus-5-5', harness: 'claude-code', run_id: PUSHES[0].run_id },
    status: 'open', project_key: 'github.com/acme/shop', first_seen: PUSHES[0].at, last_push_at: PUSHES[0].at,
    ...over,
  };
}

const code = (path, line, quote) => ({ type: 'code', ref: `${path}:${line}`, quote, link: `${REPO}/blob/${SHA1}/${path}#L${line}` });

// Supporting views (artifacts[]): every kind across lenses, and on DW-10 one whose data is malformed, so the UI
// shows its alt-text fallback. `refs` name evidence refs of the same card, as validateCandidate requires.
const ART = {
  demand: {
    kind: 'table', message: 'A blank error after a decline is 62% of checkout payment tickets',
    alt: 'Table of checkout payment ticket themes over 90 days with ticket counts and share. Blank error after a declined card: 41 tickets, 62%.',
    refs: ['SUP-118', 'SUP-131'],
    data: {
      columns: ['Ticket theme', 'Tickets (90 d)', 'Share'],
      rows: [['Blank error after decline', '41', '62%'], ['Card declined twice', '14', '21%'], ['No retry button', '11', '17%']],
      highlight: [0],
    },
  },
  installDrift: {
    kind: 'table', message: 'Step 3 of the install guide passes a flag the CLI removed',
    alt: 'Table comparing the four install guide steps with the CLI. Steps 1, 2 and 4 match; step 3 passes --legacy, which commit 7e1a2b9 removed.',
    refs: ['docs/install.md:42', '7e1a2b9', '90211'],
    data: {
      columns: ['Step', 'Doc says', 'Code does'],
      rows: [['1 Download', 'curl the installer', 'Unchanged'], ['2 Unpack', 'tar -xzf shop.tgz', 'Unchanged'],
        ['3 Init', 'shopctl init --legacy', 'Flag removed in 7e1a2b9'], ['4 Start', 'shopctl start', 'Unchanged']],
      highlight: [2],
    },
  },
  advisory: {
    kind: 'table', message: 'The pinned sharp is two patch releases behind the fix',
    alt: 'Table of one dependency: sharp installed at 0.32.1, advisory GHSA-54xq-cgqr-rpm3, fixed in 0.32.6.',
    refs: ['package-lock.json#sharp@0.32.1', 'package-lock.json:2210'],
    data: { columns: ['Package', 'Installed', 'Advisory', 'Fixed in'], rows: [['sharp', '0.32.1', 'GHSA-54xq-cgqr-rpm3', '0.32.6']] },
  },
  craMatrix: {
    kind: 'matrix', message: 'Vulnerability handling has a gap only where uploads are decoded',
    alt: 'Matrix of three CRA obligations against three components. The image worker has a gap in vulnerability handling; the rest are met or partial.',
    refs: ['audit.sarif#GHSA-54xq-cgqr-rpm3@package-lock.json', 'package-lock.json#sharp@0.32.1'],
    data: {
      rows: ['Vulnerability handling', 'Security updates', 'SBOM available'],
      columns: ['Shop web', 'Admin', 'Image worker'],
      cells: [
        [{ v: 'Met', level: 0 }, { v: 'Met', level: 0 }, { v: 'Gap', level: 3 }],
        [{ v: 'Met', level: 0 }, { v: 'Partial', level: 1 }, { v: 'Partial', level: 2 }],
        [{ v: 'Partial', level: 1 }, { v: 'Partial', level: 1 }, { v: 'Unknown' }],
      ],
    },
  },
  timeoutFlow: {
    kind: 'flow', message: 'The cart is lost with no warning while the user pays in another app',
    alt: 'Flow of five steps: add items, switch to the banking app (friction), session times out, no warning before expiry (missing), cart is empty on return (failure).',
    refs: ['src/session/expire.ts:17', 'SUP-140'],
    data: {
      steps: [{ label: 'Add items to the cart' }, { label: 'Switch to the banking app', mark: 'friction' }, { label: 'Session times out after 15 min' },
        { label: 'Warning before expiry', mark: 'missing' }, { label: 'Return: the cart is empty', mark: 'failure' }],
    },
  },
  timeoutSteps: {
    kind: 'before-after', message: 'Finishing a payment after a timeout drops from five steps to two',
    alt: 'Before and after of the steps to finish paying after a session timeout: five steps today, two after.',
    refs: ['src/session/expire.ts:17', 'SUP-140'],
    data: {
      measure: 'Steps to pay after a timeout',
      before: ['Log in again', 'Search for each product', 'Re-add every item', 'Re-enter the address', 'Pay'],
      after: ['Log in again', 'Pay'],
    },
  },
  shippingFlow: {
    kind: 'flow', message: 'A shipping estimate on the cart moves the cost to the first step',
    alt: 'Flow of five checkout steps: cart, a new shipping estimate on the cart, address, payment, shipping confirmed.',
    refs: ['src/checkout/steps.ts:9'],
    data: { steps: [{ label: 'Cart' }, { label: 'Shipping estimate on the cart', mark: 'new' }, { label: 'Address' }, { label: 'Payment' }, { label: 'Shipping confirmed' }] },
  },
  shippingSteps: {
    kind: 'table', message: 'Only the last of four steps shows the shipping cost today',
    alt: 'Table of the four checkout steps and whether each shows the shipping cost. Today only step 4 does; after, every step does.',
    refs: ['src/checkout/steps.ts:9', 'SUP-99'],
    data: {
      columns: ['Step', 'Position', 'Shows shipping today', 'After'],
      rows: [['Cart', '1', 'No', 'Yes'], ['Address', '2', 'No', 'Yes'], ['Payment', '3', 'No', 'Yes'], ['Shipping', '4', 'Yes', 'Yes']],
      highlight: [3],
    },
  },
  malformed: {
    kind: 'matrix', message: 'Finance asks for order exports at every month-end',
    alt: 'Matrix of export requests by month and team; finance asked in each of the last three months.',
    refs: ['FIN-77'],
    data: { rows: ['Finance', 'Ops'], columns: ['Aug', 'Sep', 'Oct'], cells: [[{ v: '1' }, { v: '1' }, { v: '2' }]] },
  },
};

export const CARDS = [
  // Group 1 (latest push): new, evidence grew, reopened
  card({
    ref: 'DW-14', fp: 'a1b2c3d4e5f60718', change: 'new', title: 'Let users recover from a declined card payment',
    rationale: 'A declined card leaves a blank error and no retry. Support sees it weekly, and it is the top checkout ticket theme.',
    confidence: 'high', confidence_why: 'Code quote shows the swallowed error and 41 tickets agree; a funnel metric would raise it.',
    delivery_risk: { blast: 'medium', bus_factor: 1 }, doc_impact: ['docs/checkout.md', '48213'],
    artifacts: [ART.demand],
    evidence: [
      code('src/checkout/payment.ts', 88, "catch (e) { setError(''); }"),
      { type: 'ticket', ref: 'SUP-118', quote: 'blank red box after card declined', url: 'https://acme.atlassian.net/browse/SUP-118' },
      { type: 'ticket', ref: 'SUP-131', url: 'https://acme.atlassian.net/browse/SUP-131' },
      { type: 'goal', ref: 'goal/checkout-conversion', quote: 'Raise checkout conversion to 64%', url: 'https://home.atlassian.com/o/acme/goal/12' },
    ],
  }),
  card({
    ref: 'DW-9', fp: 'b2c3d4e5f6071829', change: 'grew', lens: 'doc-drift', kind: 'stale-instruction', title: 'Fix the install guide that still names the removed --legacy flag',
    rationale: 'The guide tells admins to pass a flag the CLI no longer accepts, so first installs fail at step 3.',
    effort: { size: 'XS', days_low: 0.25, days_high: 0.5, basis: ['docs/install.md'] },
    delivery_risk: { blast: 'low' }, doc_impact: ['docs/install.md'], first_seen: PUSHES[1].at,
    artifacts: [ART.installDrift],
    evidence: [
      { type: 'doc', ref: 'docs/install.md:42', quote: 'shopctl init --legacy', link: `${REPO}/blob/${SHA1}/docs/install.md#L42` },
      { type: 'git', ref: '7e1a2b9', quote: 'remove --legacy from shopctl init' },
      { type: 'page', ref: '90211', quote: 'Run shopctl init --legacy on a fresh host.', url: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/90211' },
    ],
  }),
  card({
    ref: 'DW-6', fp: 'c3d4e5f607182930', lens: 'security-cra', kind: 'vulnerable-dependency', reopened: true, change: 'reopened',
    title: 'Upgrade the image library with a known decoder overflow',
    rationale: 'The pinned version has a published overflow in its PNG decoder, and product images are user uploads.',
    effort: { size: 'S', days_low: 0.5, days_high: 1.5, basis: ['package.json#sharp'] }, confidence: 'high',
    confidence_why: 'Lockfile pins the affected version and SARIF flags it; a reachability probe would raise it.',
    delivery_risk: { blast: 'high', bus_factor: 2 }, first_seen: PUSHES[2].at,
    artifacts: [ART.craMatrix, ART.advisory],
    evidence: [
      { type: 'dep', ref: 'package-lock.json#sharp@0.32.1' },
      code('package-lock.json', 2210, '"version": "0.32.1",'),
      { type: 'sarif', ref: 'audit.sarif#GHSA-54xq-cgqr-rpm3@package-lock.json', quote: 'Heap overflow in PNG decoder' },
    ],
  }),
  // Group 2
  card({
    ref: 'DW-11', fp: 'd4e5f60718293041', change: 'new', lens: 'ux-friction', kind: 'dead-end', title: 'Keep the cart when a session times out',
    rationale: 'A timed-out session empties the cart without warning; mobile users lose carts while paying in another app.',
    first_seen: PUSHES[1].at, last_push_at: PUSHES[1].at,
    provenance: { lens_version: '1.0.3', model: 'claude-opus-5-5', harness: 'codex', run_id: PUSHES[1].run_id },
    effort: { size: 'L', days_low: 5, days_high: 9 },
    artifacts: [ART.timeoutFlow, ART.timeoutSteps],
    evidence: [
      code('src/session/expire.ts', 17, 'store.clear(CART_KEY);'),
      { type: 'ticket', ref: 'SUP-140', quote: 'cart gone after paying in banking app', url: 'https://acme.atlassian.net/browse/SUP-140' },
    ],
  }),
  card({
    ref: 'DW-10', fp: 'e5f6071829304152', change: 'new', title: 'Export order reports as CSV from the report screen',
    rationale: 'A CSV writer already exists for invoices; finance asks for order exports every month-end.',
    confidence: 'low', confidence_why: 'Inferred from two tickets; no usage count. A count of export requests would raise it.',
    effort: { size: 'S', days_low: 1, days_high: 2, basis: ['src/reports/csv.ts#writeCsv'] },
    delivery_risk: { blast: 'low' }, first_seen: PUSHES[1].at, last_push_at: PUSHES[1].at,
    artifacts: [ART.malformed],
    provenance: { lens_version: '1.2.0', run_id: PUSHES[1].run_id },
    evidence: [code('src/reports/csv.ts', 12, 'export function writeCsv(rows, columns) {'), { type: 'ticket', ref: 'FIN-77', url: 'https://acme.atlassian.net/browse/FIN-77' }],
  }),
  // Group 3
  card({
    ref: 'DW-3', fp: 'f60718293041526a', change: 'new', lens: 'ux-friction', kind: 'missing-feedback', title: 'Show progress while a large catalogue import runs',
    rationale: 'Imports over 5k rows show nothing for minutes, and admins re-submit, creating duplicates.',
    first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at, delivery_risk: { blast: 'medium' },
    provenance: { lens_version: '1.0.3', run_id: PUSHES[2].run_id },
    evidence: [code('src/admin/import.ts', 230, 'await importAll(rows); // no progress'), { type: 'page', ref: '7781', url: 'https://acme.atlassian.net/wiki/spaces/SUP/pages/7781' }],
  }),
  card({
    ref: 'DW-2', fp: '0718293041526a7b', change: 'new', title: 'Let shops schedule price changes',
    rationale: 'Price changes go live on save; shops edit at midnight to launch sales.', first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at,
    provenance: { lens_version: '1.2.0', run_id: PUSHES[2].run_id }, effort: { size: 'M' },
    evidence: [code('src/catalog/price.ts', 54, 'product.price = input.price; await save(product);'), { type: 'goal', ref: 'goal/merchant-nps', url: 'https://home.atlassian.com/o/acme/goal/7' }],
  }),
  // Other inbox
  card({
    ref: 'DW-20', fp: '18293041526a7b8c', change: 'new', project_key: 'github.com/acme/billing', title: 'Retry failed webhook deliveries with backoff',
    rationale: 'Failed webhooks are dropped after one try.', first_seen: '2026-10-25T11:00:00.000Z', last_push_at: '2026-10-25T11:00:00.000Z',
    provenance: { lens_version: '1.2.0', run_id: '2026-10-25T10-58-00Z-b2' },
    evidence: [code('src/hooks/send.ts', 31, 'if (!res.ok) log.warn(res.status);')],
  }),
  // Accepted (merge target, evidence panel)
  card({
    ref: 'DW-1', fp: '293041526a7b8c9d', status: 'accepted', issue_ref: 'SHOP-101', issue_url: 'https://acme.atlassian.net/browse/SHOP-101',
    title: 'Explain shipping costs before the payment step', rationale: 'Shipping appears only on the last step; tickets call it a surprise.',
    first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at, delivery_risk: { blast: 'low', bus_factor: 3 }, doc_impact: ['docs/checkout.md', '90211'],
    artifacts: [ART.shippingSteps, ART.shippingFlow],
    provenance: { lens_version: '1.2.0', run_id: PUSHES[2].run_id },
    evidence: [code('src/checkout/steps.ts', 9, "const STEPS = ['cart', 'address', 'payment', 'shipping'];"), { type: 'ticket', ref: 'SUP-99', url: 'https://acme.atlassian.net/browse/SUP-99' }],
  }),
];

export const GROUP_OF = Object.fromEntries(CARDS.map((c) => [c.ref, c.provenance.run_id ?? PUSHES[0].run_id]));
GROUP_OF['DW-20'] = '2026-10-25T10-58-00Z-b2';
PUSHES.push({ run_id: '2026-10-25T10-58-00Z-b2', at: '2026-10-25T11:00:00.000Z', project_key: 'github.com/acme/billing' });

export const HISTORY = {
  'DW-1': [{ fp: '293041526a7b8c9d', status: 'accepted', decided_by: 'forge:712020:7d1c', decided_at: '2026-10-14T10:05:00.000Z', external_ref: 'DW-1', issue_ref: 'SHOP-101', issue_url: 'https://acme.atlassian.net/browse/SHOP-101' }],
  'DW-6': [{ fp: 'c3d4e5f607182930', status: 'snoozed', decided_by: 'forge:712020:7d1c', decided_at: '2026-10-15T08:00:00.000Z', external_ref: 'DW-6' }],
};

export const INBOXES = [
  {
    project_key: 'github.com/acme/shop', repo_url: REPO, jira_project_key: 'SHOP', issue_type_id: '10001',
    last_push: { run_id: PUSHES[0].run_id, at: PUSHES[0].at, head_sha: SHA1, created: 1, updated: 2 },
  },
  {
    project_key: 'github.com/acme/billing', repo_url: 'https://bitbucket.org/acme/billing',
    last_push: { run_id: '2026-10-25T10-58-00Z-b2', at: '2026-10-25T11:00:00.000Z', created: 1, updated: 0 },
  },
];

export const PROJECTS = [
  { key: 'SHOP', name: 'Shop', issue_types: [{ id: '10001', name: 'Story' }, { id: '10002', name: 'Bug' }, { id: '10003', name: 'Task' }] },
  { key: 'BILL', name: 'Billing', issue_types: [{ id: '10101', name: 'Task' }, { id: '10102', name: 'Bug' }] },
];

// Area stats per inbox, as `map.data` serves them: the pushed areas (dowser_areas_push) joined with proposal
// counts per lens. churn_90d counts commits; `authors_90d` is omitted when churn_90d is 0 (not measured), as
// forge-mcp-2 says, never sent as 0.
const lensCounts = (counts) => Object.entries(counts).map(([lens, [open, accepted]]) => ({ lens, open, accepted }));
export const AREAS = {
  'github.com/acme/shop': [
    { path: 'src/checkout', files: 24, churn_90d: 184, authors_90d: 1, last_change: '2026-10-26T15:02:00.000Z',
      proposals: lensCounts({ opportunity: [3, 1], 'ux-friction': [2, 0], 'security-cra': [1, 0] }) },
    { path: 'src/catalog', files: 18, churn_90d: 66, authors_90d: 4, last_change: '2026-10-24T09:40:00.000Z',
      proposals: lensCounts({ opportunity: [2, 0], 'doc-drift': [0, 1] }) },
    { path: 'docs', files: 31, churn_90d: 12, authors_90d: 5, last_change: '2026-10-21T12:00:00.000Z',
      proposals: lensCounts({ 'doc-drift': [4, 2] }) },
    { path: 'src/admin', files: 14, churn_90d: 0, last_change: '2026-10-19T08:15:00.000Z',
      proposals: lensCounts({ 'ux-friction': [1, 0], 'security-cra': [1, 0] }) },
    { path: 'src/session', files: 6, churn_90d: 21, authors_90d: 3, last_change: '2026-10-11T17:30:00.000Z',
      proposals: lensCounts({ 'ux-friction': [1, 0], 'security-cra': [0, 1] }) },
    { path: '.', files: 12, churn_90d: 30, authors_90d: 2, last_change: '2026-10-22T10:00:00.000Z',
      proposals: lensCounts({ 'security-cra': [1, 0] }) },
    { path: 'src/reports', files: 9, churn_90d: 9, authors_90d: 2, last_change: '2026-09-30T14:00:00.000Z',
      proposals: lensCounts({ opportunity: [1, 0] }) },
    { path: 'src/payments-legacy', files: 7, churn_90d: 3, authors_90d: 1, last_change: '2026-03-02T09:00:00.000Z', proposals: [] },
  ],
  'github.com/acme/billing': [
    { path: 'src/hooks', files: 5, churn_90d: 14, authors_90d: 1, proposals: lensCounts({ opportunity: [1, 0] }) },
    { path: 'src/invoices', files: 11, churn_90d: 3, authors_90d: 2, proposals: [] },
  ],
};

// The Learning tab (`reflect.data`) per inbox. Shapes follow ReflectData in forge/src/core/types.mjs; pushes and
// notes are newest first, candidates put the ones Jira calls done first. `dup_rate` is omitted for a push that
// had neither created nor updated items.
export const REFLECT = {
  'github.com/acme/shop': {
    totals: { open: 7, accepted: 6, rejected: 9, snoozed: 3, merged: 1 },
    pushes: [
      { run_id: PUSHES[0].run_id, at: PUSHES[0].at, head_sha: SHA1, created: 1, updated: 2, dup_rate: 2 / 3, open: 3, accepted: 0, rejected: 0, snoozed: 0 },
      { run_id: PUSHES[1].run_id, at: PUSHES[1].at, head_sha: SHA2, created: 5, updated: 2, dup_rate: 2 / 7, open: 2, accepted: 2, rejected: 2, snoozed: 1 },
      { run_id: PUSHES[2].run_id, at: PUSHES[2].at, head_sha: SHA3, created: 9, updated: 0, dup_rate: 0, open: 2, accepted: 3, rejected: 3, snoozed: 1 },
      { run_id: '2026-10-06T07-55-00Z-e4', at: '2026-10-06T07:58:12.000Z', created: 0, updated: 0, open: 0, accepted: 0, rejected: 0, snoozed: 0 },
      { run_id: '2026-09-29T15-01-09Z-d2', at: '2026-09-29T15:03:40.000Z', created: 6, updated: 1, dup_rate: 1 / 7, open: 0, accepted: 1, rejected: 4, snoozed: 1, first_decided_at: '2026-09-29T15:06:12.000Z', decided_at: '2026-09-29T15:10:31.000Z', deciding_minutes: 5, triage_minutes: 7 },
    ],
    lens_yield: [
      { lens: 'opportunity', proposed: 11, accepted: 4, rejected: 4, snoozed: 1, open: 2 },
      { lens: 'ux-friction', proposed: 6, accepted: 1, rejected: 2, snoozed: 1, open: 2 },
      { lens: 'doc-drift', proposed: 5, accepted: 1, rejected: 1, snoozed: 1, open: 2 },
      { lens: 'security-cra', proposed: 4, accepted: 0, rejected: 2, snoozed: 0, open: 1 },
    ],
    rejects: [
      { lens: 'opportunity', reason: 'not-our-direction', count: 3 },
      { lens: 'opportunity', reason: 'wrong-size', count: 1 },
      { lens: 'ux-friction', reason: 'already-known', count: 2 },
      { lens: 'doc-drift', reason: 'false-positive', count: 1 },
      { lens: 'security-cra', reason: 'false-positive', count: 1 },
      { lens: 'security-cra', reason: 'other', count: 1 },
    ],
    notes: [
      { ref: 'DW-5', title: 'Add a loyalty points ledger', status: 'rejected', note: 'Loyalty is owned by the CRM vendor; we integrate, we do not build it.', decided_by_name: 'Priya Natarajan', decided_at: '2026-10-21T10:02:00.000Z' },
      { ref: 'DW-6', title: 'Upgrade the image library with a known decoder overflow', status: 'snoozed', note: 'Revisit after the Node 22 upgrade lands; the new sharp needs it.', decided_by_name: 'Tom Berger', decided_at: '2026-10-15T08:00:00.000Z' },
      { ref: 'DW-1', title: 'Explain shipping costs before the payment step', status: 'accepted', note: 'Shipping surprise is the top reason in the exit survey.', decided_by_name: 'Priya Natarajan', decided_at: '2026-10-14T10:05:00.000Z' },
    ],
    rules: [
      { id: 'r-opp-loyalty', lens: 'opportunity', text: 'Do not propose features that the CRM vendor owns (loyalty, referrals, customer segments).', titles: ['Add a loyalty points ledger', 'Referral codes at checkout', 'Segment customers by spend'], state: 'offered', offered_at: '2026-10-27T09:14:10.000Z' },
      { id: 'r-ux-known', lens: 'ux-friction', text: 'Skip friction already tracked under the SHOP-UX epic; link to it instead.', titles: ['Remember the last used address', 'Bigger tap targets on the cart'], state: 'offered', offered_at: '2026-10-20T16:43:02.000Z' },
      { id: 'r-sec-dev', lens: 'security-cra', text: 'Ignore findings in devDependencies that never ship in the bundle.', state: 'accepted', offered_at: '2026-10-06T07:58:12.000Z', decided_by_name: 'Tom Berger', decided_at: '2026-10-08T12:30:00.000Z' },
      { id: 'r-doc-size', lens: 'doc-drift', text: 'Bundle typo-level doc fixes into one proposal per page.', state: 'declined', offered_at: '2026-10-06T07:58:12.000Z', decided_by_name: 'Priya Natarajan', decided_at: '2026-10-09T09:00:00.000Z' },
    ],
    candidates: [
      { ref: 'DW-1', title: 'Explain shipping costs before the payment step', issue_ref: 'SHOP-101', issue_url: 'https://acme.atlassian.net/browse/SHOP-101', issue_status: 'Done', done: true },
      { ref: 'DW-4', title: 'Show stock levels on the product page', issue_ref: 'SHOP-97', issue_url: 'https://acme.atlassian.net/browse/SHOP-97', issue_status: 'In Progress', done: false },
    ],
    outcomes: [
      { ref: 'DW-8', fp: '41526a7b8c9d0e1f', rating: 'right', note: 'Checkout errors fell from 41 to 6 tickets in the next 90 days.', issue_ref: 'SHOP-88', decided_by: 'forge:712020:7d1c', decided_by_name: 'Priya Natarajan', recorded_at: '2026-10-18T14:00:00.000Z', title: 'Retry declined card payments once' },
      { ref: 'DW-7', fp: '526a7b8c9d0e1f20', rating: 'partly', issue_ref: 'SHOP-90', decided_by: 'forge:712020:9a2b', decided_by_name: 'Tom Berger', recorded_at: '2026-10-12T09:30:00.000Z', title: 'Filter the order list by status' },
    ],
  },
};
