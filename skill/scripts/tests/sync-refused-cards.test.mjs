// @ts-check
// DW-167: "a push pass ends and sends each card at most once". The card's probe: a scratch store with 60 cards and
// every result refused. A card Forge refused is not sent again in the same run, and goes out on a later run.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runFinish, runStart } from '../lib/store.mjs';
import { getState, ingestPush, outbox } from '../lib/sync.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;
const PK = 'github-com-acme-shop';

beforeEach(() => {
  dir = tempDir('sync-refused');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
afterEach(() => { db.close(); removeDir(dir); });

/** @param {number} n @returns {string[]} */
function cards(n) {
  return Array.from({ length: n }, (_, i) => {
    const fp = /** @type {string} */ (propose(db, run, candidate({ topic: `refused card ${i}` }), { kinds: KINDS }).fp);
    move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' });
    return fp;
  });
}
/** @param {{proposals_json: string}} ob @returns {string[]} */
const sentFps = (ob) => JSON.parse(ob.proposals_json).map((/** @type {any} */ p) => String(p.fp));
/** @param {string[]} fps */
const refuseAll = (fps) => ingestPush(db, { results: fps.map((fp) => ({ fp, result: 'refused', why: 'kind not allowed' })) });

test('the card\'s probe: 60 cards, every result refused: rounds send 50 then 10, each card once, more absent at the end', () => {
  const fps = cards(60);
  const one = outbox(db, { projectKey: PK, runId: run });
  assert.equal(sentFps(one).length, 50);
  assert.equal(one.more, true);
  const r1 = refuseAll(sentFps(one));
  assert.equal(r1.out.summary.refused, 50, 'refused reports stay as they are');
  assert.equal(r1.code, 1);

  const two = outbox(db, { projectKey: PK, runId: run });
  assert.equal(sentFps(two).length, 10, 'the remaining 10, not the same 50 again');
  assert.equal(two.more, undefined, 'the loop ends');
  assert.deepEqual([...sentFps(one), ...sentFps(two)].sort(), [...fps].sort(), 'each card once');
  refuseAll(sentFps(two));

  const three = outbox(db, { projectKey: PK, runId: run });
  assert.deepEqual(sentFps(three), [], 'nothing left for this run');
  assert.equal(three.more, undefined);
  for (const fp of fps) assert.equal(getProposal(db, fp)?.status, 'verified', 'a refused card stays verified');
});

test('a refused card is recorded under the run that sent it, from outbox:last', () => {
  const [fp] = cards(1);
  const ob = outbox(db, { projectKey: PK, runId: run });
  assert.deepEqual(sentFps(ob), [fp]);
  refuseAll([fp]);
  assert.ok(getState(db, `refused:${run}`) !== undefined, 'sync_state refused:<run_id>');
  assert.deepEqual(sentFps(outbox(db, { projectKey: PK, runId: run })), []);
});

test('a later run sends a refused card again', () => {
  const fps = cards(3);
  refuseAll(sentFps(outbox(db, { projectKey: PK, runId: run })));
  assert.deepEqual(sentFps(outbox(db, { projectKey: PK, runId: run })), []);
  runFinish(db, { runId: run, lenses: {} });
  const next = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
  assert.deepEqual(sentFps(outbox(db, { projectKey: PK, runId: next })).sort(), [...fps].sort());
});

test('a pass where only some are refused still sends the others, and a card that was created is not held back', () => {
  const fps = cards(4);
  const sent = sentFps(outbox(db, { projectKey: PK, runId: run, limit: 2 }));
  ingestPush(db, { results: [
    { fp: sent[0], result: 'refused', why: 'no' },
    { fp: sent[1], result: 'created', external_ref: 'DW-1' },
  ] });
  const next = sentFps(outbox(db, { projectKey: PK, runId: run, limit: 2 }));
  assert.deepEqual(next.sort(), fps.filter((fp) => !sent.includes(fp)).sort());
  assert.equal(getProposal(db, sent[1])?.status, 'pushed');
});
