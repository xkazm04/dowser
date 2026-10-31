// @ts-check
// scan-finding/1 in the skill's store (dowser-proposal/2): the judge's fields and the store's defaults, the score at
// propose, the shadow prediction quoting the closest precedent, the budget enforced in code (MVP per lens, score,
// reserve), memory in context (reasons, notes), and per-slice trust: earned L1, the pre-triage gate, a reversal,
// append-only events - with acceptance still a person's (model.mjs DECIDER_GUARDS untouched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { COMPUTED_KEYS, DECIDER_GUARDS, MACHINE_DECIDER, deciderAllowed, sliceKey, validateCandidate } from '../lib/model.mjs';
import { getProposal, move, openStore, propose, runFinish, runStart } from '../lib/store.mjs';
import { allocateRun } from '../lib/budget.mjs';
import { contextPack } from '../lib/memory.mjs';
import { proposalRecord } from '../lib/sync.mjs';
import { CEILING, pretriageRun, syncTrust, trustReport } from '../lib/trust.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** A fresh store and a running run; `done()` closes and removes it. */
function fresh() {
  const dir = tempDir('scan-finding');
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

test('validate: the judge writes impact/why, risk, category, a predicted verdict; store-computed fields are refused on a line', () => {
  const ok = (/** @type {Record<string, unknown>} */ o) => { const r = validateCandidate(candidate(o)); return r.ok ? 'ok' : r.why; };
  assert.equal(ok({ impact: 7, impact_why: 'Every login', risk: 3, category: 'technical', predicted_verdict: 'accept', predicted_why: 'like DW-3', effort: { size: 'S', score: 3 } }), 'ok');
  assert.match(ok({ impact: 7 }), /^impact_why:required with impact/);
  assert.match(ok({ impact: 0, impact_why: 'x' }), /^impact:/);
  assert.match(ok({ risk: 11 }), /^risk:/);
  assert.match(ok({ category: 'ux' }), /^category:/);
  assert.match(ok({ predicted_verdict: 'maybe' }), /^predicted_verdict:/);
  assert.match(ok({ predicted_why: 'alone' }), /^predicted_why:goes with predicted_verdict/);
  assert.match(ok({ effort: { size: 'S', score: 0 } }), /^effort\.score:/);
  assert.match(ok({ impact: 3, impact_why: 'two\nlines' }), /^impact_why:one line/);
  for (const k of COMPUTED_KEYS) assert.match(ok({ [k]: k === 'mvp' ? true : 'x' }), new RegExp(`^store-computed-field:${k}`), k);
  const wire = validateCandidate({ ...candidate(), score: 12.5, score_parts: { impact: 3, confidence_w: 0.95, effort_div: 1.111, risk_factor: 0.75, formula: 'scan-score/1' }, band: 'reserve', mvp: true, pretriaged_by: MACHINE_DECIDER }, { wire: true });
  assert.equal(wire.ok, true, wire.ok ? '' : wire.why);
});

test('propose: effort.score from size, risk from blast, category from lens, and the scan-score/1 number; no impact = unscored', () => {
  const s = fresh();
  try {
    const a = s.prop({ topic: 'scored', anchors: ['src/a.js'], impact: 8, impact_why: 'Every login', effort: { size: 'M' }, confidence: 'medium', delivery_risk: { blast: 'low' } });
    const p = /** @type {any} */ (getProposal(s.db, String(a.fp)));
    assert.deepEqual([p.effort.score, p.risk, p.category, p.score], [4, 2, 'technical', 42.8]);
    assert.deepEqual(p.score_parts, { impact: 8, confidence_w: 0.75, effort_div: 1.333, risk_factor: 0.95, formula: 'scan-score/1' });
    const judged = s.prop({ topic: 'judged', anchors: ['src/j.js'], impact: 8, impact_why: 'x', effort: { size: 'M', score: 4 }, risk: 3, category: 'product', confidence: 'medium' });
    assert.equal(/** @type {any} */ (getProposal(s.db, String(judged.fp))).score, 40.5, "the judge's own risk and category win");
    const u = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'unscored', anchors: ['src/u.js'] }).fp)));
    for (const k of ['score', 'score_parts', 'impact', 'risk', 'band', 'mvp']) assert.equal(k in u, false, `${k} omitted, never 0 or null`);
    assert.equal(u.effort.score, 2, 'effort still defaults from size');
  } finally { s.done(); }
});

test('predict: the closest decided precedent is quoted with its reason and note; the judge verdict is kept, the precedent appended', () => {
  const s = fresh();
  try {
    const old = s.verified({ topic: 'plaintext password check', anchors: ['src/auth.js#login'], title: 'Plaintext compare' });
    move(s.db, old, 'rejected', { by: 'human:ann', reason: 'already-known', note: 'Tracked in SEC-12' });
    const derived = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'password check timing', anchors: ['src/auth.js#login'] }).fp)));
    assert.equal(derived.predicted_verdict, 'reject', 'no judge verdict: the precedent decides');
    assert.equal(derived.predicted_why, `closest precedent "Plaintext compare" (${old}) rejected as already-known: Tracked in SEC-12`);
    assert.equal(derived.predicted_by, 'dowser-security-cra@1.0.0:memory');
    const judged = /** @type {any} */ (getProposal(s.db, String(s.prop({ topic: 'password reset token', anchors: ['src/auth.js#login', 'src/reset.js'], predicted_verdict: 'accept', predicted_why: 'reset is new work' }).fp)));
    assert.equal(judged.predicted_verdict, 'accept');
    assert.match(judged.predicted_why, /^reset is new work \[counter-precedent "Plaintext compare"/, 'a rejected precedent on a predicted accept is labelled the counter-precedent');
    assert.equal(judged.predicted_by, 'dowser-security-cra@1.0.0:m', 'the run model is the predictor');
    const alone = /** @type {any} */ (getProposal(s.db, String(s.prop({ lens: 'doc-drift', kind: 'stale', topic: 'readme port', anchors: ['README.md'] }).fp)));
    assert.deepEqual([alone.predicted_verdict, alone.predicted_why], ['defer', 'no recorded decision on similar work; a person decides']);
  } finally { s.done(); }
});

test('budget in code: each lens its MVP, then by score up to the caps; the rest is reserve, stored and named in run finish', () => {
  const s = fresh();
  try {
    const sec = [9, 3, 7, 5, 8, 6].map((impact, i) => s.verified({ topic: `sec ${i}`, anchors: [`src/s${i}.js`], title: `Sec ${impact}`, impact, impact_why: 'x' }));
    const doc = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'doc one', anchors: ['README.md'], title: 'Doc unscored' });
    const out = allocateRun(s.db, s.run, { perRun: 5 });
    assert.deepEqual(out.per_lens['security-cra'], { ranked: 4, reserve: 2, cap: 4, mvp: { fp: sec[0], title: 'Sec 9', score: 57.7 } });
    assert.deepEqual(out.per_lens['doc-drift'], { ranked: 1, reserve: 0, cap: 4, mvp: { fp: doc, title: 'Doc unscored' } }, 'an unscored lens still gets its MVP slot');
    assert.deepEqual(out.reserve.map((/** @type {any} */ r) => r.title), ['Sec 5', 'Sec 3']);
    const band = (/** @type {string} */ fp) => /** @type {any} */ (getProposal(s.db, fp));
    assert.deepEqual([band(sec[0]).band, band(sec[0]).mvp, band(sec[0]).mvp_rule], ['ranked', true, 'top-score']);
    assert.deepEqual([band(sec[1]).band, 'mvp' in band(sec[1])], ['reserve', false]);
    const narrow = allocateRun(s.db, s.run, { perLens: 2, perRun: 3 });
    assert.deepEqual([narrow.per_lens['security-cra'].ranked, narrow.per_lens['security-cra'].reserve], [2, 4], '--per-lens overrides the pack budget');
    const free = allocateRun(s.db, s.run, { perLens: 2 });
    assert.deepEqual([free.ranked, free.per_lens['security-cra'].ranked, free.per_lens['security-cra'].reserve], [7, 6, 0], 'free run slots go past the per-lens cap');
    allocateRun(s.db, s.run, { perLens: 2, perRun: 3 });
    assert.equal(proposalRecord(s.db, sec[5]).band, 'reserve', 'a re-allocation rewrites the band; the record carries it');
    const fin = /** @type {any} */ (runFinish(s.db, { runId: s.run, lenses: { 'security-cra': { state: 'ran' }, 'doc-drift': { state: 'ran' } } }));
    assert.deepEqual([fin.lenses['security-cra'].ranked, fin.lenses['security-cra'].reserve], [2, 4]);
    assert.deepEqual(fin.lenses['security-cra'].reserve_titles, ['Sec 7', 'Sec 6', 'Sec 5', 'Sec 3']);
    assert.throws(() => allocateRun(s.db, s.run, { perRun: 0 }), /--per-run is a positive integer/);
  } finally { s.done(); }
});

test('context: near carries the person\'s reason and note; titles alone are not memory', () => {
  const s = fresh();
  try {
    const fp = s.verified({ topic: 'debug flag', anchors: ['src/cfg.js'] });
    move(s.db, fp, 'rejected', { by: 'human:ann', reason: 'other', note: `Needed in staging; ${'x'.repeat(400)}` });
    const near = /** @type {any} */ (contextPack(s.db, { runId: s.run, lens: 'security-cra' })).near.find((/** @type {any} */ n) => n.fp === fp);
    assert.equal(near.reason, 'other');
    assert.equal(near.note.length, 300, 'the note is clipped');
    assert.ok(near.note.startsWith('Needed in staging;'));
  } finally { s.done(); }
});

/**
 * `n` cards of one slice pushed and decided by a person in Forge. `verdict` is the person's, `predicted` the judge's.
 * @param {ReturnType<typeof fresh>} s @param {number} n @param {string} predicted @param {'rejected' | 'accepted'} to @param {string} tag
 */
function decide(s, n, predicted, to, tag) {
  for (let i = 0; i < n; i++) {
    const fp = s.verified({ lens: 'opportunity', kind: 'gap', topic: `${tag} item ${i}`, anchors: [`src/${tag}${i}.js`], predicted_verdict: predicted });
    move(s.db, fp, 'pushed', { by: 'skill:dowser-sync' });
    move(s.db, fp, to, { by: 'forge:jane', reason: to === 'rejected' ? 'not-worth-it' : undefined });
  }
}

test('trust: 20 agreeing human verdicts earn L1 (never above the ceiling); 19 do not; every change is an event', () => {
  const s = fresh();
  try {
    const SLICE = 'product|opportunity|-|S';
    decide(s, 19, 'reject', 'rejected', 'a');
    assert.deepEqual(syncTrust(s.db), [], '19 decisions: not enough');
    assert.deepEqual(trustReport(s.db, { slice: SLICE }).slices, [{ slice: SLICE, level: 0, ceiling: 1, start: 0, n: 19, agreement: 1 }]);
    decide(s, 1, 'reject', 'rejected', 'b');
    const ev = syncTrust(s.db);
    assert.deepEqual(ev.map((e) => [e.slice, e.from, e.to, e.n, e.agreement]), [[SLICE, 0, 1, 20, 1]]);
    assert.match(String(ev[0].reason), /^earned: predicted verdicts agreed on 100 % of the last 20 decisions$/);
    assert.deepEqual(syncTrust(s.db), [], 'a replay appends nothing');
    decide(s, 20, 'reject', 'rejected', 'c');
    assert.equal(syncTrust(s.db).length, 0, `the ceiling is L${CEILING}`);
    assert.throws(() => s.db.prepare('DELETE FROM trust_events').run(), /append-only/);
    assert.throws(() => s.db.prepare('UPDATE trust_events SET to_level = 3').run(), /append-only/);
    const other = trustReport(s.db, { slice: 'technical|doc-drift|-|M' }).slices[0];
    assert.deepEqual(other, { slice: 'technical|doc-drift|-|M', level: 1, ceiling: 1, start: 1, n: 0 }, 'a technical slice with no history starts at the contract start capped by the ceiling, agreement absent');
    const prod = trustReport(s.db, { slice: 'product|ux-friction|-|M' }).slices[0];
    assert.equal(prod.level, 0, 'a product slice starts at L0');
  } finally { s.done(); }
});

test('trust: below 90 % agreement there is no promotion', () => {
  const s = fresh();
  try {
    decide(s, 17, 'reject', 'rejected', 'a');
    decide(s, 3, 'reject', 'accepted', 'b');
    assert.deepEqual(syncTrust(s.db), []);
    assert.equal(trustReport(s.db).slices[0].agreement, 0.85);
  } finally { s.done(); }
});

test('pretriage: only an L1 slice\'s ranked cards predicted accept are marked; a person\'s reject of one demotes the slice', () => {
  const s = fresh();
  try {
    const lowFp = s.verified({ lens: 'opportunity', kind: 'gap', topic: 'before trust', anchors: ['src/x.js'], predicted_verdict: 'accept' });
    allocateRun(s.db, s.run);
    assert.deepEqual(pretriageRun(s.db, s.run).pretriaged, [], 'L0: nothing skips the person');
    move(s.db, lowFp, 'rejected', { by: 'human:ann', reason: 'not-worth-it' });
    decide(s, 20, 'reject', 'rejected', 'a');
    syncTrust(s.db);
    const run2 = String(runStart(s.db, { mode: 'full', model: 'm' }).id);
    /** @param {Record<string, unknown>} over */
    const v2 = (over) => { const r = propose(s.db, run2, candidate({ lens: 'opportunity', kind: 'gap', ...over }), { kinds: KINDS }); move(s.db, String(r.fp), 'verified', { by: 'skill:dowser-verify' }); return String(r.fp); };
    const yes = v2({ topic: 'export csv now', anchors: ['src/e.js'], impact: 9, impact_why: 'x', predicted_verdict: 'accept' });
    const no = v2({ topic: 'tour again', anchors: ['src/t.js'], predicted_verdict: 'reject' });
    const big = v2({ topic: 'rewrite billing', anchors: ['src/b.js'], effort: { size: 'XL' }, predicted_verdict: 'accept' });
    allocateRun(s.db, run2);
    const out = pretriageRun(s.db, run2);
    assert.deepEqual(out.pretriaged.map((/** @type {any} */ p) => p.fp), [yes]);
    assert.deepEqual(out.for_person.map((/** @type {any} */ p) => [p.fp, p.level]).sort(), [[big, 0], [no, 1]].sort(), 'another size is another slice');
    const card = /** @type {any} */ (getProposal(s.db, yes));
    assert.deepEqual([card.status, card.pretriaged_by], ['verified', MACHINE_DECIDER], 'no status move: the card goes to the inbox as usual');
    assert.equal(sliceKey(card), 'product|opportunity|-|S');

    // acceptance stays human: the invariant at model.mjs DECIDER_GUARDS is untouched
    assert.deepEqual(DECIDER_GUARDS, { 'verified>accepted': ['human'] });
    assert.equal(deciderAllowed('verified', 'accepted', MACHINE_DECIDER), false);
    assert.throws(() => move(s.db, yes, 'accepted', { by: MACHINE_DECIDER }), /needs a human decider/);

    move(s.db, yes, 'pushed', { by: 'skill:dowser-sync' });
    move(s.db, yes, 'rejected', { by: 'forge:jane', reason: 'false-positive' });
    const ev = syncTrust(s.db);
    assert.deepEqual(ev.map((e) => [e.from, e.to, e.item_id]), [[1, 0, yes]]);
    assert.match(String(ev[0].reason), /^reversal: forge:jane rejected [0-9a-f]{16}, which machine:dowser pre-triaged$/);
    const sl = trustReport(s.db, { slice: 'product|opportunity|-|S' }).slices[0];
    assert.deepEqual([sl.level, sl.n], [0, 0], 'the window resets after a demotion');
    assert.equal(trustReport(s.db).events.length, 2);
  } finally { s.done(); }
});
