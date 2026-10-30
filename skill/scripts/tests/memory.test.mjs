// @ts-check
// WP2 memory: context pack, near tier (similar), ask-why (show), list, rule offers, lens pack frontmatter.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  EXEMPLAR_CAP, contextPack, decideRule, list, listRules, loadLensPack, offerRules, parseFrontmatter, show, similar, topicTokens,
} from '../lib/memory.mjs';
import { move, openStore, propose, runFinish, runStart } from '../lib/store.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;

before(() => {
  dir = tempDir('memory');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
after(() => { db.close(); removeDir(dir); });

/**
 * A proposal moved to `verified`.
 * @param {Record<string, unknown>} over
 * @returns {string} fp
 */
function verified(over) {
  const r = propose(db, run, candidate(over), { kinds: KINDS });
  assert.ok(r.fp, r.result);
  move(db, r.fp, 'verified', { by: 'skill:dowser-verify' });
  return r.fp;
}

/** @param {string} fp @param {string} reason */
const reject = (fp, reason) => move(db, fp, 'rejected', { by: 'human:ann', reason, note: reason === 'other' ? 'n' : undefined });

test('lens pack frontmatter: the four packs parse; unknown keys are kept; an unknown lens exits 2', () => {
  for (const lens of ['opportunity', 'ux-friction', 'doc-drift', 'security-cra']) {
    const p = loadLensPack(lens);
    assert.equal(p.id, lens);
    assert.ok(p.kinds.length > 0);
    assert.equal(p.budget, 4);
  }
  assert.deepEqual(loadLensPack('security-cra').optional_sources, ['sarif']);
  const fm = parseFrontmatter('---\nid: x\nlist: [a, "b c", d]\nempty: []\nflag: true\nn: 7\nnew_key: "quoted"\n---\nbody');
  assert.deepEqual(fm, { id: 'x', list: ['a', 'b c', 'd'], empty: [], flag: true, n: 7, new_key: 'quoted' });
  assert.throws(() => loadLensPack('nope'), (e) => /** @type {any} */ (e).code === 2);
});

test('context: version, kinds and budget from the pack; a rejection is suppressed at once', () => {
  const fp = verified({ topic: 'ctx plaintext', anchors: ['src/ctx.js#a'] });
  let c = contextPack(db, { runId: run, lens: 'security-cra' });
  assert.equal(c.lens_version, loadLensPack('security-cra').version);
  assert.deepEqual(c.kinds, loadLensPack('security-cra').kinds);
  assert.equal(c.budget, 4);
  assert.ok(!c.suppressed.includes(fp));
  assert.ok(c.near.some((/** @type {any} */ n) => n.fp === fp && n.status === 'verified' && n.topic === 'ctx-plaintext'));
  assert.equal(c.since_sha, undefined, 'full run: since_sha omitted');
  assert.equal(c.focus, undefined);

  reject(fp, 'false-positive');
  c = contextPack(db, { runId: run, lens: 'security-cra' });
  assert.ok(c.suppressed.includes(fp), 'rejected fp suppressed immediately');
  assert.ok(c.near.some((/** @type {any} */ n) => n.fp === fp && n.status === 'rejected'));
  assert.throws(() => contextPack(db, { runId: 'r-nope', lens: 'security-cra' }), (e) => /** @type {any} */ (e).code === 2);
  assert.throws(() => contextPack(db, { runId: run, lens: 'bogus' }), (e) => /** @type {any} */ (e).code === 2);
});

test('context: since_sha on an incremental run, focus from the run', () => {
  const d = tempDir('memory-inc');
  const db2 = openStore(join(d, 'dowser.db'));
  try {
    const r1 = runStart(db2, { mode: 'full', headSha: 'a'.repeat(40) });
    runFinish(db2, { runId: r1.id, lenses: {} });
    const r2 = runStart(db2, { mode: 'incremental', headSha: 'b'.repeat(40) });
    assert.equal(contextPack(db2, { runId: r2.id, lens: 'doc-drift' }).since_sha, 'a'.repeat(40));
    const r3 = runStart(db2, { mode: 'focused', focus: 'area:src/pay' });
    const c3 = contextPack(db2, { runId: r3.id, lens: 'doc-drift' });
    assert.equal(c3.focus, 'area:src/pay');
    assert.equal(c3.since_sha, undefined);
    assert.deepEqual([c3.suppressed, c3.near, c3.rules, c3.exemplars], [[], [], [], []]);
  } finally { db2.close(); removeDir(d); }
});

test('exemplars: the 5 newest accepted of the lens, with effort and evidence types', () => {
  /** @type {string[]} */
  const fps = [];
  for (let i = 0; i < 7; i++) {
    const fp = verified({ lens: 'doc-drift', kind: 'stale', topic: `exemplar ${i}`, anchors: [`docs/e${i}.md`], title: `Exemplar ${i}`,
      evidence: [{ type: 'doc', ref: `docs/e${i}.md:1`, quote: `line ${i}` }, { type: 'ticket', ref: `DOC-${i}` }] });
    move(db, fp, 'accepted', { by: 'human:ann' });
    fps.push(fp);
  }
  const c = contextPack(db, { runId: run, lens: 'doc-drift' });
  assert.equal(c.exemplars.length, EXEMPLAR_CAP);
  assert.deepEqual(c.exemplars.map((/** @type {any} */ e) => e.title), ['Exemplar 6', 'Exemplar 5', 'Exemplar 4', 'Exemplar 3', 'Exemplar 2']);
  assert.deepEqual(c.exemplars[0].evidence_types, ['doc', 'ticket']);
  assert.equal(c.exemplars[0].effort.size, 'S');
  assert.ok(!c.near.some((/** @type {any} */ n) => fps.includes(n.fp)), 'accepted items are exemplars, not near');
});

test('similar: an anchor overlap with different wording, or 2+ topic tokens; dropped excluded; another lens only on a shared anchor', () => {
  const a = verified({ lens: 'ux-friction', kind: 'dead-end', topic: 'checkout error no retry', anchors: ['src/checkout.js#pay:12'] });
  const b = verified({ lens: 'ux-friction', kind: 'overload', topic: 'payment failure leaves user stuck', anchors: ['./src/checkout.js#pay'], title: 'Stuck after a failed payment' });
  const c = verified({ lens: 'ux-friction', kind: 'dead-end', topic: 'checkout error copy', anchors: ['src/copy.js'] });
  const d = verified({ lens: 'ux-friction', kind: 'dead-end', topic: 'checkout banner', anchors: ['src/banner.js'] });
  const dropped = propose(db, run, candidate({ lens: 'ux-friction', kind: 'dead-end', topic: 'checkout error again', anchors: ['src/checkout.js#pay'] }), { kinds: KINDS }).fp;
  move(db, /** @type {string} */ (dropped), 'dropped', { by: 'skill:dowser-verify', note: 'verify-failed:x' });
  const sec = verified({ lens: 'security-cra', topic: 'checkout error secret', anchors: ['src/checkout.js#pay'] });
  verified({ lens: 'security-cra', topic: 'checkout error token', anchors: ['src/token.js'] });

  const s = similar(db, a);
  const byFp = Object.fromEntries(s.similar.map((/** @type {any} */ h) => [h.fp, h]));
  assert.deepEqual(byFp[b].overlap, { anchors: ['src/checkout.js#pay'] }, 'same anchor, different wording');
  assert.equal(byFp[b].cross_lens, undefined, 'a same-lens hit carries no cross_lens');
  assert.deepEqual(byFp[c].overlap, { topic_tokens: ['checkout', 'error'] });
  assert.equal(byFp[d], undefined, 'one shared token is not enough');
  assert.equal(byFp[/** @type {string} */ (dropped)], undefined, 'dropped excluded');
  assert.equal(byFp[sec].cross_lens, true, 'another lens on the same anchor is a hit, flagged');
  assert.equal(byFp[sec].lens, 'security-cra');
  assert.equal(s.similar.length, 3, 'another lens sharing only topic tokens is not a hit');
  assert.equal(s.similar[0].fp, b, 'anchor overlap ranks first');
  assert.throws(() => similar(db, 'f'.repeat(16)), (e) => /** @type {any} */ (e).code === 2);
});

test('show: card, evidence rows and transitions in order', () => {
  const fp = verified({ topic: 'show me', anchors: ['src/show.js'] });
  propose(db, run, candidate({ topic: 'show me', anchors: ['src/show.js'], evidence: [{ type: 'ticket', ref: 'SEC-9', url: 'https://x/SEC-9' }] }), { kinds: KINDS });
  move(db, fp, 'snoozed', { by: 'human:ann' });
  move(db, fp, 'verified', { by: 'human:ann' });
  reject(fp, 'not-worth-it');
  const s = show(db, fp);
  assert.equal(s.card.fp, fp);
  assert.equal(s.card.status, 'rejected');
  assert.equal(s.card.evidence, undefined);
  assert.deepEqual(s.evidence.map((/** @type {any} */ e) => e.type), ['code', 'ticket']);
  assert.equal(s.evidence[0].quote, 'return check(user.password);');
  assert.equal(s.evidence[1].url, 'https://x/SEC-9');
  assert.deepEqual(s.transitions.map((/** @type {any} */ t) => `${t.from_status ?? '-'}>${t.to_status}`),
    ['->candidate', 'candidate>verified', 'verified>snoozed', 'snoozed>verified', 'verified>rejected']);
  assert.equal(s.transitions[4].reason, 'not-worth-it');
  assert.ok(!('from_status' in s.transitions[0]), 'absent values omitted');
});

test('list: compact rows filtered by lens, status and title', () => {
  const rows = list(db, { lens: 'doc-drift', status: 'accepted', title: 'EXEMPLAR 3' }).proposals;
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['decided_at', 'fp', 'lens', 'status', 'title']);
  assert.ok(list(db).proposals.length > 10);
  assert.throws(() => list(db, { status: 'nope' }), (e) => /** @type {any} */ (e).code === 2);
});

test('topic tokens drop short and stop words', () => {
  assert.deepEqual(topicTokens('add-sso-for-the-onboarding-flow'), ['add', 'sso', 'onboarding', 'flow']);
});

test('rules: a 3-member cluster is offered once and only once; accepted text reaches context, declined does not', () => {
  const lens = 'opportunity';
  const mk = (/** @type {string} */ topic, /** @type {string} */ reason) => {
    const fp = verified({ lens, kind: 'gap', topic, anchors: [`src/${topic.replace(/ /g, '-')}.js`], title: `T ${topic}` });
    reject(fp, reason);
    return fp;
  };
  const before = offerRules(db).offers.filter((o) => o.lens === lens);
  assert.equal(before.length, 0);
  mk('onboarding tour', 'not-our-direction');
  mk('onboarding checklist', 'not-our-direction');
  assert.equal(offerRules(db).offers.filter((o) => o.lens === lens).length, 0, 'two are not a cluster');
  mk('onboarding email', 'not-worth-it');
  assert.equal(offerRules(db).offers.filter((o) => o.lens === lens).length, 0, 'different reason, not a cluster');
  mk('skip onboarding', 'not-our-direction');
  const offers = offerRules(db).offers.filter((o) => o.lens === lens);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].text, 'Do not propose opportunity items about onboarding (rejected 3x as not-our-direction)');
  assert.equal(offers[0].cluster.fps.length, 3);
  assert.equal(offers[0].titles.length, 3);
  assert.equal(offerRules(db).offers.length, 0, 'never re-offered while offered');
  // card b3b6b8b8446b3a41: an offer the runner left unanswered comes back on the next run, marked earlier
  const again = offerRules(db);
  assert.deepEqual(again.earlier?.map((o) => [o.id, o.earlier, o.titles?.length]), [[offers[0].id, true, 3]], 'an unanswered offer is presented again');

  // decline: never again, even when the cluster grows; never in context
  decideRule(db, offers[0].id, 'declined', { by: 'human:ann' });
  mk('onboarding video', 'not-our-direction');
  assert.equal(offerRules(db).offers.length, 0, 'declined cluster never re-offered');
  assert.equal(offerRules(db).earlier?.some((o) => o.id === offers[0].id) ?? false, false, 'a declined offer never comes back as earlier');
  assert.equal(contextPack(db, { runId: run, lens }).rules.length, 0);
  assert.throws(() => decideRule(db, offers[0].id, 'accepted', { by: 'human:ann' }), (e) => /** @type {any} */ (e).detail?.current === 'declined');

  // accept with edited text: in context
  mk('pricing page', 'wrong-size');
  mk('pricing calculator', 'wrong-size');
  mk('pricing tiers', 'wrong-size');
  const [p] = offerRules(db).offers;
  assert.equal(p.cluster.token, 'pricing');
  assert.throws(() => decideRule(db, p.id, 'accepted', { by: 'agent:claude' }), (e) => /** @type {any} */ (e).code === 2, 'humans only');
  const acc = decideRule(db, p.id, 'accepted', { by: 'human:ann', text: 'Keep pricing items small and split.' });
  assert.equal(acc.state, 'accepted');
  assert.equal(acc.cluster.decided_by, 'human:ann');
  assert.equal(acc.cluster.draft_text, p.text);
  assert.deepEqual(contextPack(db, { runId: run, lens }).rules, [{ id: p.id, text: 'Keep pricing items small and split.' }]);
  assert.equal(offerRules(db).offers.length, 0, 'accepted cluster never re-offered');
  assert.deepEqual(listRules(db, { lens }).rules.map((r) => r.state).sort(), ['accepted', 'declined']);
});

test('rules: clusters covering the same items are one offer', () => {
  for (const t of ['legacy export wizard a', 'legacy export wizard b', 'legacy export wizard c']) {
    reject(verified({ lens: 'doc-drift', kind: 'missing', topic: t, anchors: [`docs/${t.replace(/ /g, '-')}.md`] }), 'already-known');
  }
  const offers = offerRules(db).offers.filter((o) => o.lens === 'doc-drift');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].cluster.token, 'export');
  assert.deepEqual(offers[0].cluster.also_tokens, ['legacy', 'wizard']);
  assert.equal(offerRules(db).offers.length, 0);
});
