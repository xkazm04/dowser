// @ts-check
// A delegate's verdicts (`delegate:temper`, recorded in Jira by `dowser_verdicts_record` under a delegation a person
// switched on in Dowser Settings) arrive through ingest-verdicts like any pulled verdict. They teach the memory (the
// closest precedent quotes them) but never move trust: the ladder stays human-earned. `show` marks them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DECIDER_GUARDS, DELEGATE_KIND, deciderAllowed } from '../lib/model.mjs';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { ingestVerdicts } from '../lib/sync.mjs';
import { syncTrust, trustReport } from '../lib/trust.mjs';
import { closestPrecedent } from '../lib/predict.mjs';
import { show } from '../lib/memory.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

const DELEGATE = 'delegate:temper';
const SLICE = 'product|opportunity|-|S';

/** A fresh store with `n` pushed opportunity cards predicted `reject`; `done()` removes it. @param {number} n @param {string} tag */
function pushedStore(n, tag) {
  const dir = tempDir('delegate');
  const db = openStore(join(dir, 'dowser.db'));
  const run = String(runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id);
  const fps = Array.from({ length: n }, (_, i) => {
    const r = propose(db, run, candidate({ lens: 'opportunity', kind: 'gap', topic: `${tag} item ${i}`, anchors: [`src/${tag}${i}.js`], predicted_verdict: 'reject' }), { kinds: KINDS });
    move(db, String(r.fp), 'verified', { by: 'skill:dowser-verify' });
    move(db, String(r.fp), 'pushed', { by: 'skill:dowser-sync' });
    return String(r.fp);
  });
  return { db, fps, done: () => { db.close(); removeDir(dir); } };
}

/** @param {string} fp @param {number} i @param {string} by @param {Record<string, string | undefined>} [o] */
const verdict = (fp, i, by, o = {}) => ({ fp, status: 'rejected', reason: 'not-worth-it', decided_by: by, decided_at: new Date(Date.UTC(2026, 10, 5, 9, 0, i)).toISOString(), external_ref: `DW-${i + 1}`, ...o });

test('the delegate kind may reject, snooze and accept a pushed card, never a verified one (it arrives only by pull)', () => {
  assert.equal(DELEGATE_KIND, 'delegate');
  for (const to of ['accepted', 'rejected', 'snoozed', 'merged']) assert.ok(deciderAllowed('pushed', to, DELEGATE), `pushed -> ${to}`);
  for (const to of ['accepted', 'rejected', 'snoozed']) assert.equal(deciderAllowed('verified', to, DELEGATE), false, `verified -> ${to}`);
  assert.deepEqual(DECIDER_GUARDS['verified>accepted'], ['human'], 'offline acceptance stays a person\'s');
});

test('ingest-verdicts applies delegate verdicts; trust is unchanged by them, and a person\'s same verdicts would have moved it', () => {
  const s = pushedStore(20, 'd');
  try {
    const before = trustReport(s.db, { slice: SLICE }).slices[0];
    const r = ingestVerdicts(s.db, { verdicts: s.fps.map((fp, i) => verdict(fp, i, DELEGATE)), cursor: '20' });
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.deepEqual(r.out.summary, { applied: 20 });
    assert.equal(r.out.trust_events, undefined, 'no trust event');
    assert.deepEqual(syncTrust(s.db), []);
    assert.deepEqual(trustReport(s.db, { slice: SLICE }).slices[0], before, 'the slice is as it was: level, n and agreement');
    assert.equal(getProposal(s.db, s.fps[0])?.decided_by, DELEGATE);
    // the memory still learns: a new card on the same anchor finds the delegate's decision as its precedent
    const near = closestPrecedent(s.db, { fp: '0000000000000000', lens: 'opportunity', topic: 'd item 0', anchors: ['src/d0.js'] });
    assert.equal(near?.decided_by, DELEGATE);
    // show marks the delegate's move
    const last = /** @type {any} */ (show(s.db, s.fps[0])).transitions.at(-1);
    assert.deepEqual([last.by, last.delegate], [DELEGATE, true]);
    assert.equal(/** @type {any} */ (show(s.db, s.fps[0])).transitions[0].delegate, undefined, 'only a delegate move is marked');
  } finally { s.done(); }

  // the control: the same twenty verdicts by a person in Jira earn the slice L1
  const h = pushedStore(20, 'h');
  try {
    const r = ingestVerdicts(h.db, { verdicts: h.fps.map((fp, i) => verdict(fp, i, 'forge:jane')), cursor: '20' });
    assert.deepEqual((r.out.trust_events ?? []).map((/** @type {any} */ e) => [e.slice, e.from, e.to]), [[SLICE, 0, 1]]);
  } finally { h.done(); }
});

test('a delegate snooze and accept from Jira land with their date and issue', () => {
  const s = pushedStore(2, 's');
  try {
    const r = ingestVerdicts(s.db, { verdicts: [
      verdict(s.fps[0], 0, DELEGATE, { status: 'snoozed', reason: undefined, snooze_until: '2099-01-01' }),
      { fp: s.fps[1], status: 'accepted', decided_by: DELEGATE, decided_at: '2026-11-05T09:01:00.000Z', external_ref: 'DW-2', issue_ref: 'DOW-9', issue_url: 'https://x.atlassian.net/browse/DOW-9' },
    ].map((v) => JSON.parse(JSON.stringify(v))), cursor: '2' });
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(getProposal(s.db, s.fps[0])?.snooze_until, '2099-01-01');
    assert.equal(getProposal(s.db, s.fps[1])?.status, 'accepted');
  } finally { s.done(); }
});
