// @ts-check
// Moonshot round 2026-11-04 incidentals: one broken lens pack no longer blocks every lens; the precedent search
// reuses one parsed pass per lens until a decision lands; the memory reads that ran one query per card still
// return the same data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { LENS_DIR, contextPack, packKinds, packStatus } from '../lib/memory.mjs';
import { closestPrecedent } from '../lib/predict.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

test('a broken lens pack drops only its own lens; propose refuses that lens and names why', () => {
  const dir = tempDir('packs');
  try {
    for (const f of readdirSync(LENS_DIR).filter((n) => n.endsWith('.md'))) copyFileSync(join(LENS_DIR, f), join(dir, f));
    writeFileSync(join(dir, 'doc-drift.md'), '---\nid: doc-drift\n---\nno version, no kinds\n');
    const { kinds, broken } = packStatus(dir);
    assert.equal(kinds['doc-drift'], undefined);
    assert.match(broken['doc-drift'], /doc-drift\.md/);
    assert.ok(kinds.opportunity?.length, 'the other lenses still load');
    assert.deepEqual(Object.keys(packKinds(dir)).sort(), Object.keys(kinds).sort(), 'packKinds no longer throws for one pack');
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), 'broken');
    assert.throws(() => packKinds(dir), (e) => /** @type {any} */ (e).code === 2, 'every pack broken still exits 2');

    const home = tempDir('packs-home');
    const db = openStore(join(home, 'dowser.db'));
    try {
      const run = String(runStart(db, { mode: 'full' }).id);
      const { 'doc-drift': _gone, ...rest } = KINDS;
      const r = propose(db, run, candidate({ lens: 'doc-drift', kind: KINDS['doc-drift'][0] }), { kinds: rest });
      assert.match(String(r.result), /^invalid:lens doc-drift has no kinds loaded/);
    } finally { db.close(); removeDir(home); }
  } finally { removeDir(dir); }
});

test('closestPrecedent sees a decision made after its first read in the same process', () => {
  const home = tempDir('precedent-cache');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const run = String(runStart(db, { mode: 'full' }).id);
    const old = String(propose(db, run, candidate({ topic: 'plaintext password check', anchors: ['src/auth.js#login'], title: 'Plaintext compare' }), { kinds: KINDS }).fp);
    const ask = { fp: 'ffffffffffffffff', lens: 'security-cra', topic: 'password check timing', anchors: ['src/auth.js#login'] };
    assert.equal(closestPrecedent(db, ask), undefined, 'nothing decided yet');
    move(db, old, 'verified', { by: 'skill:dowser-verify' });
    move(db, old, 'pushed', { by: 'skill:dowser-sync' });
    move(db, old, 'rejected', { by: 'forge:jane', reason: 'false-positive' });
    assert.equal(closestPrecedent(db, ask)?.fp, old, 'the new decision invalidates the cached pass');
    assert.equal(closestPrecedent(db, { ...ask, fp: old }), undefined, 'a card is never its own precedent');
  } finally { db.close(); removeDir(home); }
});

test('context exemplars keep their evidence types per card after the batched read', () => {
  const home = tempDir('exemplars');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const run = String(runStart(db, { mode: 'full' }).id);
    const a = String(propose(db, run, candidate({ topic: 'alpha thing', evidence: [{ type: 'code', ref: 'src/a.js:1', quote: 'a' }, { type: 'git', ref: 'abc1234' }] }), { kinds: KINDS }).fp);
    const b = String(propose(db, run, candidate({ topic: 'beta thing', evidence: [{ type: 'doc', ref: 'README.md:1', quote: 'b' }] }), { kinds: KINDS }).fp);
    for (const fp of [a, b]) {
      move(db, fp, 'verified', { by: 'skill:dowser-verify' });
      move(db, fp, 'pushed', { by: 'skill:dowser-sync' });
      move(db, fp, 'accepted', { by: 'forge:jane' });
    }
    const lens = String(getProposal(db, a)?.lens);
    const next = String(runStart(db, { mode: 'full' }).id);
    const ex = /** @type {any[]} */ (contextPack(db, { runId: next, lens }).exemplars);
    assert.deepEqual(ex.find((e) => e.fp === a)?.evidence_types, ['code', 'git']);
    assert.deepEqual(ex.find((e) => e.fp === b)?.evidence_types, ['doc']);
  } finally { db.close(); removeDir(home); }
});
