// @ts-check
// Supporting views (artifacts[]) in the issue an accept creates: each kind as ADF, the alt-text fallback, the order
// (after the body, before Evidence), a card without artifacts unchanged, and the stored record through push + accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { factsTable, issueDescription, markdownToAdf } from '../src/core/adf.mjs';

const PK = 'github-com-Acme-Shop';
const EVIDENCE = [
  { type: 'code', ref: 'src/session/expire.ts:17', quote: 'store.clear(CART_KEY);' },
  { type: 'ticket', ref: 'SUP-140', link: 'https://acme.atlassian.net/browse/SUP-140' },
];
const BODY = '## Summary\nKeep the cart.\n\n## Description\nIt is cleared.';

/** @param {object} [o] @returns {any} */
const card = (o = {}) => ({ ref: 'DW-4', title: 'Keep the cart', rationale: 'Carts vanish.', body: BODY, evidence: EVIDENCE, ...o });

const TABLE = {
  kind: 'table', message: 'Step 3 names a removed flag', alt: 'Table of install steps.', refs: ['SUP-140'],
  data: { columns: ['Step', 'Count'], rows: [['Init', '3'], ['Start', '']], highlight: [0] },
};
const FLOW = {
  kind: 'flow', message: 'The cart is lost', alt: 'Flow of three steps.', refs: ['src/session/expire.ts:17', 'SUP-140'],
  data: { steps: [{ label: 'Add items' }, { label: 'Session expires', mark: 'friction' }, { label: 'Cart empty', mark: 'failure' }] },
};
const BA = {
  kind: 'before-after', message: 'Five steps become two', alt: 'Before and after.', refs: ['SUP-140'],
  data: { measure: 'Steps to pay', before: ['Log in', 'Re-add', 'Pay'], after: ['Pay'] },
};
const MATRIX = {
  kind: 'matrix', message: 'One gap', alt: 'Matrix of obligations.', refs: ['SUP-140'],
  data: { rows: ['Updates', 'SBOM'], columns: ['Web', 'Worker'], cells: [[{ v: 'Met', level: 0 }, { v: 'Gap', level: 3 }], [{ v: 'Partial' }, { v: 'Met' }]] },
};

/** @param {any} n @returns {string} the text of one ADF node */
const txt = (n) => (n.type === 'text' ? n.text : (n.content ?? []).map(txt).join(''));
/** @param {any} table @returns {string[][]} rows of cell texts */
const grid = (table) => table.content.map((/** @type {any} */ r) => r.content.map(txt));
/** @param {any} table @returns {string[][]} rows of cell node types */
const types = (table) => table.content.map((/** @type {any} */ r) => r.content.map((/** @type {any} */ c) => c.type));
/** @param {any[]} content @param {string} h */
const headingAt = (content, h) => content.findIndex((n) => n.type === 'heading' && txt(n) === h);
/** The blocks under "Supporting views", up to the Evidence heading. @param {any} doc @returns {any[]} */
const views = (doc) => doc.content.slice(headingAt(doc.content, 'Supporting views') + 1, headingAt(doc.content, 'Evidence'));

test('a card without artifacts produces exactly the ADF it did before artifacts existed, after the facts table', () => {
  const inbox = 'https://acme.atlassian.net/inbox?ref=DW-4';
  const expected = {
    type: 'doc', version: 1, content: [
      factsTable(card()),
      { type: 'paragraph', content: [{ type: 'text', text: 'Carts vanish.' }] },
      ...markdownToAdf(BODY.replace('## Description', '## Details')),
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Evidence' }] },
      {
        type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'code: ' }, { type: 'text', text: 'src/session/expire.ts:17', marks: [{ type: 'code' }] }, { type: 'text', text: ' - "store.clear(CART_KEY);"' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ticket: ' }, { type: 'text', text: 'SUP-140', marks: [{ type: 'link', attrs: { href: 'https://acme.atlassian.net/browse/SUP-140' } }] }] }] },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Proposed by Dowser (' }, { type: 'text', text: 'DW-4', marks: [{ type: 'link', attrs: { href: inbox } }] }, { type: 'text', text: ')' }] },
    ],
  };
  assert.deepEqual(issueDescription(card(), inbox), expected);
  assert.equal(JSON.stringify(issueDescription(card(), inbox)).includes('Supporting views'), false);
});

test('views sit after the body and before Evidence, each as message, view, then "From <refs>"', () => {
  const doc = issueDescription(card({ artifacts: [TABLE, FLOW] }));
  const c = doc.content;
  const sv = headingAt(c, 'Supporting views');
  assert.ok(sv > headingAt(c, 'Details'), 'after the body');
  assert.ok(sv < headingAt(c, 'Evidence'), 'before Evidence');
  const v = views(doc);
  assert.deepEqual(v.map((n) => n.type), ['paragraph', 'table', 'paragraph', 'paragraph', 'orderedList', 'paragraph']);
  assert.deepEqual(v[0].content, [{ type: 'text', text: 'Step 3 names a removed flag', marks: [{ type: 'strong' }] }]);
  assert.deepEqual(v[2].content, [{ type: 'text', text: 'From SUP-140', marks: [{ type: 'em' }] }]);
  assert.equal(txt(v[5]), 'From src/session/expire.ts:17, SUP-140');
});

test('table: a header row of tableHeader cells, highlighted rows bold, an empty cell an empty paragraph', () => {
  const [, t] = views(issueDescription(card({ artifacts: [TABLE] })));
  assert.equal(t.type, 'table');
  assert.deepEqual(grid(t), [['Step', 'Count'], ['Init', '3'], ['Start', '']]);
  assert.deepEqual(types(t), [['tableHeader', 'tableHeader'], ['tableCell', 'tableCell'], ['tableCell', 'tableCell']]);
  assert.deepEqual(t.content[1].content[0].content[0].content[0].marks, [{ type: 'strong' }], 'highlighted row is bold');
  assert.equal(t.content[2].content[0].content[0].content[0].marks, undefined, 'other rows are plain');
  assert.deepEqual(t.content[2].content[1].content, [{ type: 'paragraph', content: [] }], 'no empty text node');
});

test('matrix: a table with a column header row and a row header per row, cells print v', () => {
  const [, t] = views(issueDescription(card({ artifacts: [MATRIX] })));
  assert.deepEqual(grid(t), [['', 'Web', 'Worker'], ['Updates', 'Met', 'Gap'], ['SBOM', 'Partial', 'Met']]);
  assert.deepEqual(types(t), [['tableHeader', 'tableHeader', 'tableHeader'], ['tableHeader', 'tableCell', 'tableCell'], ['tableHeader', 'tableCell', 'tableCell']]);
});

test('flow: an ordered list whose marked steps end with " (<mark>)"', () => {
  const [, l] = views(issueDescription(card({ artifacts: [FLOW] })));
  assert.equal(l.type, 'orderedList');
  assert.deepEqual(l.content.map(txt), ['Add items', 'Session expires (friction)', 'Cart empty (failure)']);
});

test('before-after: the measure across both columns, then Today / After, lines aligned row by row', () => {
  const [, t] = views(issueDescription(card({ artifacts: [BA] })));
  assert.deepEqual(grid(t), [['Steps to pay'], ['Today', 'After'], ['Log in', 'Pay'], ['Re-add', ''], ['Pay', '']]);
  assert.deepEqual(t.content[0].content[0].attrs, { colspan: 2 });
  assert.deepEqual(types(t).slice(0, 2), [['tableHeader'], ['tableHeader', 'tableHeader']]);
});

test('an unknown kind or malformed data shows the alt text as a paragraph, and the next view still renders', () => {
  const broken = { ...MATRIX, data: { ...MATRIX.data, cells: [MATRIX.data.cells[0]] } };
  const unknown = { ...TABLE, kind: 'chart' };
  const stray = { ...FLOW, refs: ['SUP-999'] };
  const v = views(issueDescription(card({ artifacts: [broken, unknown, stray, BA] })));
  assert.deepEqual(v.map((n) => n.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'table', 'paragraph']);
  assert.equal(txt(v[1]), 'Matrix of obligations.');
  assert.equal(txt(v[4]), 'Table of install steps.');
  assert.equal(txt(v[7]), 'Flow of three steps.');
  assert.equal(JSON.stringify(v).includes('"type":"table"'), true, 'the valid view after them is drawn');
});

test('push + accept: the stored artifacts reach the created Jira issue', async () => {
  const d = makeDeps();
  const rec = { ...record({ evidence: EVIDENCE.map(({ link, ...e }) => e) }), artifacts: [FLOW, MATRIX] };
  const pushed = /** @type {any} */ (await runTool(d, 'dowser_proposals_push', pushArgs([rec]), 'me'));
  assert.equal(pushed.error, undefined, JSON.stringify(pushed));
  await runResolver(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' }, 'me', 'inbox');
  const got = /** @type {any} */ (await runResolver(d, 'proposal.get', { ref: 'DW-1' }, 'me', 'inbox'));
  assert.deepEqual(got.card.artifacts, [FLOW, MATRIX], 'toCard returns them as pushed');
  await runResolver(d, 'verdict.accept', { ref: 'DW-1' }, 'me', 'inbox');
  const desc = d.jira.created[0].description;
  const v = views(desc);
  assert.deepEqual(v.filter((n) => n.type !== 'paragraph').map((n) => n.type), ['orderedList', 'table']);
});
