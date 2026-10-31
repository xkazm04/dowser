// @ts-check
// Guards on what the lens judge may set (cycle-2 self-scan defects 1-3): accepted items reach `context`'s `near`
// with fp, topic and anchors; a card's category is its lens's default and may only move technical -> product
// (the trust gate cannot be skipped by relabelling); the store appends a precedent to `predicted_why` only when the
// judge named none, and a precedent that contradicts the predicted verdict is labelled as the counter-precedent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { allocateRun } from '../lib/budget.mjs';
import { ACCEPTED_NEAR_CAP, NEAR_CAP, contextPack } from '../lib/memory.mjs';
import { pretriageRun } from '../lib/trust.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** A fresh store and a running run; `done()` closes and removes it. */
function fresh() {
  const dir = tempDir('judge-guards');
  const db = openStore(join(dir, 'dowser.db'));
  const run = String(runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id);
  /** @param {Record<string, unknown>} over */
  const prop = (over) => propose(db, run, candidate(over), { kinds: KINDS });
  /** @param {Record<string, unknown>} over @returns {string} */
  const verified = (over) => {
    const r = prop(over);
    assert.ok(r.fp, r.result);
    move(db, r.fp, 'verified', { by: 'skill:dowser-verify' });
    return r.fp;
  };
  return { db, run, prop, verified, done: () => { db.close(); removeDir(dir); } };
}

/** @param {ReturnType<typeof fresh>} s @param {string} fp */
const accept = (s, fp) => { move(s.db, fp, 'pushed', { by: 'skill:dowser-sync' }); move(s.db, fp, 'accepted', { by: 'forge:jane' }); };

test('context: accepted items reach near with fp, topic, anchors and status, capped; open items keep their own cap', () => {
  const s = fresh();
  try {
    const n = 9;
    /** @type {string[]} */
    const acc = [];
    for (let i = 0; i < n; i++) {
      const fp = s.verified({ lens: 'doc-drift', kind: 'stale', topic: `accepted doc ${i}`, anchors: [`docs/a${i}.md`], title: `Accepted ${i}` });
      accept(s, fp);
      acc.push(fp);
    }
    const open = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'open doc', anchors: ['docs/open.md'] });
    const c = /** @type {any} */ (contextPack(s.db, { runId: s.run, lens: 'doc-drift' }));
    const nearAccepted = c.near.filter((/** @type {any} */ r) => r.status === 'accepted');
    assert.equal(nearAccepted.length, n, `all ${n} accepted items are in near (the self-scan saw 0 of 9)`);
    const one = nearAccepted.find((/** @type {any} */ r) => r.fp === acc[3]);
    assert.deepEqual([one.topic, one.anchors, one.title], ['accepted-doc-3', ['docs/a3.md'], 'Accepted 3']);
    assert.ok(c.near.some((/** @type {any} */ r) => r.fp === open && r.status === 'verified'), 'open items still listed');
    assert.equal(c.exemplars.length, 5, 'exemplars unchanged: the 5 newest accepted');
    assert.ok(c.exemplars.every((/** @type {any} */ e) => acc.includes(e.fp)), 'an exemplar carries its fp so it can be quoted');
    assert.ok(ACCEPTED_NEAR_CAP > 0 && ACCEPTED_NEAR_CAP <= NEAR_CAP);
  } finally { s.done(); }
});

test('context: accepted near rows are capped at ACCEPTED_NEAR_CAP, newest decision first', () => {
  const s = fresh();
  try {
    for (let i = 0; i < ACCEPTED_NEAR_CAP + 3; i++) accept(s, s.verified({ topic: `acc sec ${i}`, anchors: [`src/s${i}.js`] }));
    const c = /** @type {any} */ (contextPack(s.db, { runId: s.run, lens: 'security-cra' }));
    assert.equal(c.near.filter((/** @type {any} */ r) => r.status === 'accepted').length, ACCEPTED_NEAR_CAP);
  } finally { s.done(); }
});

test('category: a product lens card labelled technical is clamped to product with a warning; technical -> product is allowed', () => {
  const s = fresh();
  try {
    const r = s.prop({ lens: 'opportunity', kind: 'gap', topic: 'relabelled gap', anchors: ['src/g.js'], category: 'technical' });
    assert.deepEqual(r.clamped, { category: { asked: 'technical', stored: 'product' } });
    assert.equal(/** @type {any} */ (getProposal(s.db, String(r.fp))).category, 'product');
    const ok = s.prop({ lens: 'doc-drift', kind: 'stale', topic: 'product doc', anchors: ['README.md'], category: 'product' });
    assert.equal('clamped' in ok, false);
    assert.equal(/** @type {any} */ (getProposal(s.db, String(ok.fp))).category, 'product', 'a judge may move technical -> product');
    const plain = s.prop({ lens: 'ux-friction', kind: 'dead-end', topic: 'ux plain', anchors: ['src/u.js'], category: 'product' });
    assert.equal('clamped' in plain, false);
  } finally { s.done(); }
});

test('category: the opportunity fork\'s technical-labelled cards no longer land in an L1 slice and skip the person', () => {
  const s = fresh();
  try {
    // the cycle-2 case: two opportunity cards marked technical, ranked, predicted accept
    const fps = ['lens eval ranked band', 'jira inbox kind check'].map((topic, i) => s.verified({
      lens: 'opportunity', kind: 'gap', topic, anchors: [`tools/o${i}.mjs`], category: 'technical',
      impact: 3, impact_why: 'x', predicted_verdict: 'accept', predicted_why: 'No similar decision in near or outcomes.',
    }));
    allocateRun(s.db, s.run, {});
    const out = /** @type {any} */ (pretriageRun(s.db, s.run));
    assert.deepEqual(out.pretriaged, [], 'nothing skips the person');
    assert.deepEqual(out.for_person.map((/** @type {any} */ x) => [x.fp, x.slice, x.level]).sort(),
      fps.map((fp) => [fp, 'product|opportunity|-|S', 0]).sort());
  } finally { s.done(); }
});

test('precedent: the judge named a precedent, so none is appended', () => {
  const s = fresh();
  try {
    const old = s.verified({ topic: 'plaintext password check', anchors: ['src/auth.js#login'], title: 'Plaintext compare' });
    accept(s, old);
    const why = 'Closest precedent "Something else" (0123456789abcdef) accepted: same shape.';
    const p = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'password check timing', anchors: ['src/auth.js#login'], predicted_verdict: 'accept', predicted_why: why }).fp)));
    assert.equal(p.predicted_why, why, 'the judge quoted a precedent by fp: the text is kept as written');
  } finally { s.done(); }
});

test('precedent: a contradicting precedent is appended only as the counter-precedent; an agreeing one as the closest', () => {
  const s = fresh();
  try {
    const snoozed = s.verified({ topic: 'plaintext password check', anchors: ['src/auth.js#login'], title: 'Plaintext compare' });
    move(s.db, snoozed, 'pushed', { by: 'skill:dowser-sync' });
    move(s.db, snoozed, 'snoozed', { by: 'forge:jane', note: 'deferred at calibration' });
    const c = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'password check timing', anchors: ['src/auth.js#login'], predicted_verdict: 'accept', predicted_why: 'reset is new work' }).fp)));
    assert.equal(c.predicted_verdict, 'accept');
    assert.match(c.predicted_why, new RegExp(`^reset is new work \\[counter-precedent "Plaintext compare" \\(${snoozed}\\) snoozed`));
    assert.doesNotMatch(c.predicted_why, /closest precedent/);
    const agree = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'password check hashing', anchors: ['src/auth.js#login'], predicted_verdict: 'defer', predicted_why: 'needs a person' }).fp)));
    assert.match(agree.predicted_why, new RegExp(`^needs a person \\[closest precedent "Plaintext compare" \\(${snoozed}\\) snoozed`));
  } finally { s.done(); }
});
