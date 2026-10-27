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

export const CARDS = [
  // Group 1 (latest push): new, evidence grew, reopened
  card({
    ref: 'DW-14', fp: 'a1b2c3d4e5f60718', title: 'Let users recover from a declined card payment',
    rationale: 'A declined card leaves a blank error and no retry. Support sees it weekly, and it is the top checkout ticket theme.',
    confidence: 'high', confidence_why: 'Code quote shows the swallowed error and 41 tickets agree; a funnel metric would raise it.',
    delivery_risk: { blast: 'medium', bus_factor: 1 }, doc_impact: ['docs/checkout.md', 'confluence:page/48213'],
    evidence: [
      code('src/checkout/payment.ts', 88, "catch (e) { setError(''); }"),
      { type: 'ticket', ref: 'SUP-118', quote: 'blank red box after card declined', url: 'https://acme.atlassian.net/browse/SUP-118' },
      { type: 'ticket', ref: 'SUP-131', url: 'https://acme.atlassian.net/browse/SUP-131' },
      { type: 'goal', ref: 'goal/checkout-conversion', quote: 'Raise checkout conversion to 64%', url: 'https://home.atlassian.com/o/acme/goal/12' },
    ],
  }),
  card({
    ref: 'DW-9', fp: 'b2c3d4e5f6071829', lens: 'doc-drift', kind: 'stale-instruction', title: 'Fix the install guide that still names the removed --legacy flag',
    rationale: 'The guide tells admins to pass a flag the CLI no longer accepts, so first installs fail at step 3.',
    effort: { size: 'XS', days_low: 0.25, days_high: 0.5, basis: ['docs/install.md'] },
    delivery_risk: { blast: 'low' }, doc_impact: ['docs/install.md'], first_seen: PUSHES[1].at,
    evidence: [
      { type: 'doc', ref: 'docs/install.md:42', quote: 'shopctl init --legacy', link: `${REPO}/blob/${SHA1}/docs/install.md#L42` },
      { type: 'git', ref: '7e1a2b9', quote: 'remove --legacy from shopctl init' },
      { type: 'page', ref: 'confluence:page/90211', quote: 'Run shopctl init --legacy on a fresh host.', url: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/90211' },
    ],
  }),
  card({
    ref: 'DW-6', fp: 'c3d4e5f607182930', lens: 'security-cra', kind: 'vulnerable-dependency', reopened: true,
    title: 'Upgrade the image library with a known decoder overflow',
    rationale: 'The pinned version has a published overflow in its PNG decoder, and product images are user uploads.',
    effort: { size: 'S', days_low: 0.5, days_high: 1.5, basis: ['package.json#sharp'] }, confidence: 'high',
    confidence_why: 'Lockfile pins the affected version and SARIF flags it; a reachability probe would raise it.',
    delivery_risk: { blast: 'high', bus_factor: 2 }, first_seen: PUSHES[2].at,
    evidence: [
      { type: 'dep', ref: 'package-lock.json#sharp@0.32.1' },
      code('package-lock.json', 2210, '"version": "0.32.1",'),
      { type: 'sarif', ref: 'audit.sarif#GHSA-54xq-cgqr-rpm3@package-lock.json', quote: 'Heap overflow in PNG decoder' },
    ],
  }),
  // Group 2
  card({
    ref: 'DW-11', fp: 'd4e5f60718293041', lens: 'ux-friction', kind: 'dead-end', title: 'Keep the cart when a session times out',
    rationale: 'A timed-out session empties the cart without warning; mobile users lose carts while paying in another app.',
    first_seen: PUSHES[1].at, last_push_at: PUSHES[1].at,
    provenance: { lens_version: '1.0.3', model: 'claude-opus-5-5', harness: 'codex', run_id: PUSHES[1].run_id },
    effort: { size: 'L', days_low: 5, days_high: 9 },
    evidence: [
      code('src/session/expire.ts', 17, 'store.clear(CART_KEY);'),
      { type: 'ticket', ref: 'SUP-140', quote: 'cart gone after paying in banking app', url: 'https://acme.atlassian.net/browse/SUP-140' },
    ],
  }),
  card({
    ref: 'DW-10', fp: 'e5f6071829304152', title: 'Export order reports as CSV from the report screen',
    rationale: 'A CSV writer already exists for invoices; finance asks for order exports every month-end.',
    confidence: 'low', confidence_why: 'Inferred from two tickets; no usage count. A count of export requests would raise it.',
    effort: { size: 'S', days_low: 1, days_high: 2, basis: ['src/reports/csv.ts#writeCsv'] },
    delivery_risk: { blast: 'low' }, first_seen: PUSHES[1].at, last_push_at: PUSHES[1].at,
    provenance: { lens_version: '1.2.0', run_id: PUSHES[1].run_id },
    evidence: [code('src/reports/csv.ts', 12, 'export function writeCsv(rows, columns) {'), { type: 'ticket', ref: 'FIN-77', url: 'https://acme.atlassian.net/browse/FIN-77' }],
  }),
  // Group 3
  card({
    ref: 'DW-3', fp: 'f60718293041526a', lens: 'ux-friction', kind: 'missing-feedback', title: 'Show progress while a large catalogue import runs',
    rationale: 'Imports over 5k rows show nothing for minutes, and admins re-submit, creating duplicates.',
    first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at, delivery_risk: { blast: 'medium' },
    provenance: { lens_version: '1.0.3', run_id: PUSHES[2].run_id },
    evidence: [code('src/admin/import.ts', 230, 'await importAll(rows); // no progress'), { type: 'page', ref: 'confluence:page/7781', url: 'https://acme.atlassian.net/wiki/spaces/SUP/pages/7781' }],
  }),
  card({
    ref: 'DW-2', fp: '0718293041526a7b', title: 'Let shops schedule price changes',
    rationale: 'Price changes go live on save; shops edit at midnight to launch sales.', first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at,
    provenance: { lens_version: '1.2.0', run_id: PUSHES[2].run_id }, effort: { size: 'M' },
    evidence: [code('src/catalog/price.ts', 54, 'product.price = input.price; await save(product);'), { type: 'goal', ref: 'goal/merchant-nps', url: 'https://home.atlassian.com/o/acme/goal/7' }],
  }),
  // Other inbox
  card({
    ref: 'DW-20', fp: '18293041526a7b8c', project_key: 'github.com/acme/billing', title: 'Retry failed webhook deliveries with backoff',
    rationale: 'Failed webhooks are dropped after one try.', first_seen: '2026-10-25T11:00:00.000Z', last_push_at: '2026-10-25T11:00:00.000Z',
    provenance: { lens_version: '1.2.0', run_id: '2026-10-25T10-58-00Z-b2' },
    evidence: [code('src/hooks/send.ts', 31, 'if (!res.ok) log.warn(res.status);')],
  }),
  // Accepted (merge target, evidence panel)
  card({
    ref: 'DW-1', fp: '293041526a7b8c9d', status: 'accepted', issue_ref: 'SHOP-101', issue_url: 'https://acme.atlassian.net/browse/SHOP-101',
    title: 'Explain shipping costs before the payment step', rationale: 'Shipping appears only on the last step; tickets call it a surprise.',
    first_seen: PUSHES[2].at, last_push_at: PUSHES[2].at, delivery_risk: { blast: 'low', bus_factor: 3 }, doc_impact: ['docs/checkout.md'],
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
  { project_key: 'github.com/acme/shop', repo_url: REPO, jira_project_key: 'SHOP', issue_type_id: '10001' },
  { project_key: 'github.com/acme/billing', repo_url: 'https://bitbucket.org/acme/billing' },
];

export const PROJECTS = [
  { key: 'SHOP', name: 'Shop', issue_types: [{ id: '10001', name: 'Story' }, { id: '10002', name: 'Bug' }, { id: '10003', name: 'Task' }] },
  { key: 'BILL', name: 'Billing', issue_types: [{ id: '10101', name: 'Task' }, { id: '10102', name: 'Bug' }] },
];
