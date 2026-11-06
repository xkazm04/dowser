// @ts-check
// DW-114: "every open proposal stays reachable through Load more". The card's probe: 80 open, reject the 50 on page 1,
// call inbox.list with the issued cursor. "Before: Load more returned 0 items and no next, summary said 30 open.
// After: the same sequence returns the 30"; "A changed cursor must still reject a cursor it did not issue."
// Built reading: `next` is an opaque keyset cursor `k<id>` naming the last row of the page, read as "the rows after
// that row in list order", whatever that row's status is now; a bare number is bad-cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} name @param {object} args */
const tool = (d, name, args) => /** @type {Promise<any>} */ (runTool(d, name, args, ME));
/** @param {any} d @param {string} key @param {object} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));
/** @param {any} page @returns {string[]} */
const refs = (page) => page.groups.flatMap((/** @type {any} */ g) => g.items.map((/** @type {any} */ c) => c.ref));

/**
 * `n` records in pushes of at most 50.
 * @param {any} d @param {number} n @param {(i: number) => Record<string, unknown>} [over]
 */
async function push(d, n, over = () => ({})) {
  const recs = Array.from({ length: n }, (_, i) => record({
    topic: `keyset topic ${i}`, anchors: [`src/k${i}.js#f`], evidence: [{ type: 'code', ref: `src/k${i}.js:1`, quote: `line ${i}` }], ...over(i),
  }));
  for (let k = 0; k * 50 < n; k++) {
    await tool(d, 'dowser_proposals_push', pushArgs(recs.slice(k * 50, (k + 1) * 50), { run_id: `r-${k}` }));
    d.clock.tick(60_000);
  }
}

test('the card\'s probe: 80 open, the 50 on page 1 rejected: the issued cursor returns exactly the other 30 and no next', async () => {
  const d = makeDeps();
  await push(d, 80);
  const first = await res(d, 'inbox.list', {});
  const page1 = refs(first);
  assert.equal(page1.length, 50);
  assert.ok(first.next);
  await res(d, 'verdict.reject', { refs: page1, reason: 'not-worth-it' });

  const second = await res(d, 'inbox.list', { cursor: first.next });
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.equal(second.inboxes[0].open, 30);
  const page2 = refs(second);
  assert.equal(page2.length, 30, 'the same sequence returns the 30');
  assert.equal(second.next, undefined);
  assert.equal(new Set(page2).size, 30);
  assert.ok(page2.every((r) => !page1.includes(r)));
  const fresh = refs(await res(d, 'inbox.list', {}));
  assert.deepEqual([...page2].sort(), [...fresh].sort(), 'what a fresh list shows');
});

test('next is an opaque keyset cursor k<id> naming the last row of the page', async () => {
  const d = makeDeps();
  await push(d, 60);
  const first = await res(d, 'inbox.list', {});
  assert.match(String(first.next), /^k[0-9]+$/);
  const last = refs(first).at(-1);
  const row = d.db.raw.prepare('SELECT id FROM proposals WHERE ref = ?').get(last);
  assert.equal(first.next, `k${row.id}`);
});

test('a walk that decides part of each page reaches every remaining card once and none twice', async () => {
  const d = makeDeps();
  await push(d, 130);
  const all = d.db.raw.prepare("SELECT ref FROM proposals WHERE status = 'open'").all().map((/** @type {any} */ r) => String(r.ref));
  /** @type {string[]} */ const decided = [];
  /** @type {string[]} */ const seen = [];
  let cursor;
  for (let n = 0; n < 10; n++) {
    const page = await res(d, 'inbox.list', cursor ? { cursor } : {});
    assert.equal(page.error, undefined, JSON.stringify(page));
    const here = refs(page);
    seen.push(...here);
    // decide every third row, the page's last row included
    const pick = here.filter((_, i) => i % 3 === 2 || i === here.length - 1);
    if (pick.length) await res(d, 'verdict.reject', { refs: pick, reason: 'not-worth-it' });
    decided.push(...pick);
    cursor = page.next;
    if (!cursor) break;
  }
  assert.equal(cursor, undefined, 'the walk ends');
  assert.equal(new Set(seen).size, seen.length, 'none twice');
  assert.deepEqual([...seen].sort(), [...all].sort(), 'every card once');
  assert.ok(decided.length > 40);
});

test('under a lens filter the cursor walks that lens only, after its page was decided', async () => {
  const d = makeDeps();
  await push(d, 120, (i) => (i % 2 ? { lens: 'doc-drift', kind: 'stale' } : {}));
  const a = await res(d, 'inbox.list', { lens: 'doc-drift' });
  assert.ok(a.next, '60 doc-drift cards');
  assert.equal(refs(a).length, 50);
  await res(d, 'verdict.reject', { refs: refs(a), reason: 'not-worth-it' });
  const b = await res(d, 'inbox.list', { lens: 'doc-drift', cursor: a.next });
  assert.equal(refs(b).length, 10);
  assert.equal(b.next, undefined);
});

test('under an area filter the cursor walks that area, after its page was decided', async () => {
  const d = makeDeps();
  await push(d, 80, (i) => ({ anchors: [`src/${i % 8 === 7 ? 'misc' : 'checkout'}/k${i}.js#f`], evidence: [{ type: 'code', ref: `src/${i % 8 === 7 ? 'misc' : 'checkout'}/k${i}.js:1`, quote: `line ${i}` }] }));
  await tool(d, 'dowser_areas_push', { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify([
    { path: 'src', files: 40, churn_90d: 0 }, { path: 'src/checkout', files: 20, churn_90d: 2, authors_90d: 1 },
  ]) });
  const a = await res(d, 'inbox.list', { project_key: PK, area: 'src/checkout' });
  assert.equal(refs(a).length, 50);
  await res(d, 'verdict.reject', { refs: refs(a), reason: 'not-worth-it' });
  const b = await res(d, 'inbox.list', { project_key: PK, area: 'src/checkout', cursor: a.next });
  assert.equal(b.error, undefined, JSON.stringify(b));
  assert.equal(refs(b).length, 20, '70 in the area, 50 decided');
  assert.equal(b.next, undefined);
});

test('a cursor it did not issue is bad-cursor: a bare number, a stray text, a row that does not exist', async () => {
  const d = makeDeps();
  await push(d, 60);
  for (const cursor of ['50', '0', 'x', 'k', 'k-1', 'k1x', 'k999999']) {
    assert.equal((await res(d, 'inbox.list', { cursor })).error, 'bad-cursor', cursor);
  }
});
