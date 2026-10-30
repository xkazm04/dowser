// @ts-check
// The map's cells link to the inbox filtered by area and lens (card 3fc3baf82f785c57): `inbox.list` takes `area`,
// resolved with the same mapping `map.data` counts with, so a cell's open count equals the cards the filter lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

const PK = 'github-com-Acme-Shop';

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));
/** @param {any} out */
const refs = (out) => out.groups.flatMap((/** @type {any} */ g) => g.items.map((/** @type {any} */ c) => c.ref));

/** Three opportunity cards under src/checkout (one by evidence only), one under src, one doc-drift under src/checkout. */
async function seeded() {
  const d = makeDeps();
  const code = (/** @type {string} */ ref) => [{ type: 'code', ref, quote: 'x()' }];
  await tool(d, 'dowser_proposals_push', pushArgs([
    record({ topic: 'pay', anchors: ['src/checkout/pay.js#pay'], evidence: code('src/checkout/pay.js:3') }),
    record({ topic: 'cart', anchors: ['src/checkout/cart.js#cart'], evidence: code('src/checkout/cart.js:9') }),
    record({ topic: 'tax', anchors: ['src/util.js#tax'], evidence: code('src/checkout/tax.js:1') }),
    record({ topic: 'util', anchors: ['src/util.js#u'], evidence: code('src/util.js:2') }),
    record({ topic: 'readme', lens: 'doc-drift', kind: 'stale-doc', anchors: ['src/checkout/pay.js'], evidence: [{ type: 'doc', ref: 'README.md:1', quote: 'x' }] }),
  ]));
  await tool(d, 'dowser_areas_push', { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify([
    { path: 'src', files: 5, churn_90d: 0 }, { path: 'src/checkout', files: 3, churn_90d: 2, authors_90d: 1 },
  ]) });
  return d;
}

test('inbox.list with area + lens lists exactly the cards the map cell counts', async () => {
  const d = await seeded();
  const m = await res(d, 'map.data', { project_key: PK });
  for (const a of m.areas) {
    for (const c of a.proposals) {
      const out = await res(d, 'inbox.list', { project_key: PK, lens: c.lens, area: a.path });
      assert.equal(out.error, undefined, JSON.stringify(out));
      assert.equal(refs(out).length, c.open, `${a.path} x ${c.lens}`);
    }
  }
  const checkout = await res(d, 'inbox.list', { project_key: PK, lens: 'opportunity', area: 'src/checkout' });
  assert.deepEqual(refs(checkout).sort(), ['DW-1', 'DW-2', 'DW-3']);
  const all = await res(d, 'inbox.list', { project_key: PK, area: 'src/checkout' });
  assert.deepEqual(refs(all).sort(), ['DW-1', 'DW-2', 'DW-3', 'DW-5'], 'no lens: every lens in the area');
});

test('an area filter pages like the plain list and needs its inbox', async () => {
  const d = await seeded();
  assert.equal((await res(d, 'inbox.list', { area: 'src' })).error, 'bad-input', 'area without project_key');
  assert.equal((await res(d, 'inbox.list', { project_key: PK, area: '' })).error, 'bad-input', 'empty area');
  const none = await res(d, 'inbox.list', { project_key: PK, area: 'lib' });
  assert.deepEqual(none.groups, [], 'an area the map does not know lists nothing');
  assert.equal(none.next, undefined);
  const plain = await res(d, 'inbox.list', { project_key: PK });
  assert.equal(plain.groups.flatMap((/** @type {any} */ g) => g.items).length, 5, 'no area: unchanged');
});
