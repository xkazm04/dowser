// @ts-check
// Kind-in-lens at push (card b8f0af8d0926bb5d): a push that carries `lens_kinds_json` (the runner's lens packs'
// closed kind lists) has every record's kind checked against its lens's list; a record whose kind the lens does
// not have, or whose lens the push declares no kinds for, is refused with the lens and kind named. A push without
// `lens_kinds_json` (an older skill) is filed as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runTool } from '../src/core/app.mjs';
import { checkRecord, parseLensKinds } from '../src/core/push.mjs';

const KINDS = { opportunity: ['missing-capability', 'extend-capability'], 'doc-drift': ['stale-example'] };

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));

test('push with lens_kinds_json refuses a kind its lens does not have, names lens and kind, files the rest', async () => {
  const d = makeDeps();
  const ok = record({ topic: 'csv export' });
  const madeUp = record({ topic: 'pdf export', kind: 'made-up' });
  const noLens = record({ topic: 'tour', lens: 'ux-friction', kind: 'dead-end' });
  const out = await tool(d, 'dowser_proposals_push', { ...pushArgs([ok, madeUp, noLens]), lens_kinds_json: JSON.stringify(KINDS) });
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), ['created', 'refused', 'refused']);
  assert.equal(out.results[1].fp, madeUp.fp);
  assert.equal(out.results[1].why, 'kind "made-up" is not one of opportunity\'s kinds (missing-capability,extend-capability)');
  assert.equal(out.results[2].why, 'the push declares no kinds for lens ux-friction (lens_kinds_json)');
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.n, 1, 'nothing of an unknown kind is stored');
});

test('push without lens_kinds_json files any kind, as before (an older skill)', async () => {
  const d = makeDeps();
  const out = await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'pdf export', kind: 'made-up' })]));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), ['created']);
});

test('a malformed lens_kinds_json is a bad-input error for the whole call, and nothing is filed', async () => {
  const d = makeDeps();
  for (const bad of ['[]', '{', '{"opportunity": []}', '{"opportunity": "missing-capability"}', '{"opportunity": [""]}', '{"opportunity": [1]}', '""']) {
    const out = await tool(d, 'dowser_proposals_push', { ...pushArgs([record()]), lens_kinds_json: bad });
    assert.equal(out.error, 'bad-input', bad);
    assert.match(out.message, /lens_kinds_json/, bad);
  }
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.n, 0);
});

test('parseLensKinds and checkRecord: absent -> no membership check; present -> the lens list is the fingerprint list', () => {
  assert.equal(parseLensKinds({}), undefined);
  assert.deepEqual(parseLensKinds({ lens_kinds_json: JSON.stringify(KINDS) }), KINDS);
  assert.equal(checkRecord(record({ kind: 'made-up' })).ok, true);
  assert.equal(checkRecord(record({ kind: 'made-up' }), KINDS).ok, false);
  assert.equal(checkRecord(record({ kind: 'extend-capability' }), KINDS).ok, true);
});
