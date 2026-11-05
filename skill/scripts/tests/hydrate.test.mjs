// @ts-check
// Forge as the team's memory (moonshot 2026-11-04, idea 3). Machine A scans, pushes, and people decide in Jira;
// machine B starts with an empty store, pulls the inbox's memory and hydrates. B must then suppress what the team
// rejected, find the team's precedent, take the verdict pull as in-sync, and never use the hydrate run as a base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, lastDoneRun, move, openStore, propose, runStart } from '../lib/store.mjs';
import { ingestPush, ingestVerdicts, outbox } from '../lib/sync.mjs';
import { hydrate } from '../lib/hydrate.mjs';
import { closestPrecedent } from '../lib/predict.mjs';
import { callTool, emptyBackend } from '../../../tools/mock-forge-mcp.mjs';
import { STORE_OWNED, validateCandidate } from '../lib/model.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

const PK = 'github-com-acme-shop';
const cards = {
  rej: candidate({ topic: 'plaintext password check', title: 'Plaintext compare' }),
  acc: candidate({ topic: 'session token in url', anchors: ['src/session.js#start'], title: 'Token in URL' }),
  snz: candidate({ topic: 'weak reset flow', anchors: ['src/reset.js#reset'], title: 'Weak reset' }),
};

/** Machine A: propose, verify, push to the mock, then people decide in the inbox. */
function machineA() {
  const dir = tempDir('hydrate-a');
  const db = openStore(join(dir, 'dowser.db'));
  const b = emptyBackend();
  const run = String(runStart(db, { mode: 'full' }).id);
  /** @type {Record<string, string>} */
  const fp = {};
  for (const [k, c] of Object.entries(cards)) {
    fp[k] = String(propose(db, run, c, { kinds: KINDS }).fp);
    move(db, fp[k], 'verified', { by: 'skill:dowser-verify' });
  }
  const args = outbox(db, { projectKey: PK, runId: run });
  ingestPush(db, callTool(b, 'dowser_proposals_push', /** @type {any} */ (args)));
  callTool(b, 'mock_decide', { fp: fp.rej, status: 'rejected', reason: 'already-known', note: 'fixed upstream in Q1', decided_by: 'forge:jane' });
  callTool(b, 'mock_decide', { fp: fp.acc, status: 'accepted', decided_by: 'forge:bob' });
  callTool(b, 'mock_decide', { fp: fp.snz, status: 'snoozed', decided_by: 'forge:bob' });
  return { b, fp, done: () => { db.close(); removeDir(dir); } };
}

test('a fresh store hydrated from the inbox suppresses what the team rejected and quotes its precedent', () => {
  const a = machineA();
  const dir = tempDir('hydrate-b');
  const db = openStore(join(dir, 'dowser.db'));
  try {
    const page = callTool(a.b, 'dowser_memory_pull', { project_key: PK, after: '0' });
    const h = hydrate(db, page);
    assert.equal(h.code, 0, JSON.stringify(h.out));
    assert.equal(h.out.added, 3);
    const rej = getProposal(db, a.fp.rej);
    assert.equal(rej?.status, 'rejected');
    assert.equal(rej?.reason, 'already-known');
    assert.equal(rej?.decided_by, 'forge:jane');
    assert.equal(getProposal(db, a.fp.acc)?.issue_ref?.startsWith('MOCK-'), true);
    assert.equal(lastDoneRun(db), undefined, 'the hydrate run is never an incremental base');

    const run = String(runStart(db, { mode: 'full' }).id);
    assert.equal(propose(db, run, cards.rej, { kinds: KINDS }).result, 'suppressed', 'the team said no: B does not re-propose it');
    const near = closestPrecedent(db, { fp: 'ffffffffffffffff', lens: 'security-cra', topic: 'password check timing', anchors: ['src/auth.js#login'] });
    assert.equal(near?.note, 'fixed upstream in Q1', 'the reason comes along, not just the title');

    const v = ingestVerdicts(db, callTool(a.b, 'dowser_verdicts_pull', { project_key: PK }));
    assert.equal(v.code, 0);
    assert.deepEqual([...new Set(v.out.verdicts.map((/** @type {any} */ x) => x.outcome))], ['in-sync'], 'every pulled verdict matches the hydrated state');
    assert.equal(hydrate(db, page).out.present, 3, 'a second hydrate adds nothing: local memory wins');
  } finally { db.close(); removeDir(dir); a.done(); }
});

test('a hydrated snoozed card that wakes pushes as a valid record: no marker in its provenance', () => {
  const a = machineA();
  const dir = tempDir('hydrate-wake');
  const db = openStore(join(dir, 'dowser.db'));
  try {
    assert.equal(hydrate(db, callTool(a.b, 'dowser_memory_pull', { project_key: PK, after: '0' })).code, 0);
    assert.equal('hydrated_from' in (getProposal(db, a.fp.snz)?.provenance ?? {}), false);
    const run = String(runStart(db, { mode: 'full' }).id);
    move(db, a.fp.snz, 'verified', { from: 'snoozed', by: 'skill:dowser', runId: run });
    // a card hydrated before the fix carries the marker; the record leaves it out
    db.prepare("UPDATE proposals SET provenance_json = json_set(provenance_json, '$.hydrated_from', 'dowser_memory_pull') WHERE fp = ?").run(a.fp.snz);
    const sent = JSON.parse(String(outbox(db, { projectKey: PK, runId: run }).proposals_json));
    const rec = sent.find((/** @type {any} */ r) => r.fp === a.fp.snz);
    assert.ok(rec, 'the woken card is in the outbox');
    // as Forge checks a pushed record (forge/src/core/push.mjs checkRecord): store-owned and issue fields dropped
    const cand = Object.fromEntries(Object.entries(rec).filter(([k]) => ![...STORE_OWNED, 'issue_ref', 'issue_url'].includes(k)));
    const v = validateCandidate(cand, { wire: true });
    assert.equal(v.ok, true, JSON.stringify(v));
  } finally { db.close(); removeDir(dir); a.done(); }
});

test('hydrate refuses a forged item and keeps the rest; rules arrive decided', () => {
  const dir = tempDir('hydrate-bad');
  const db = openStore(join(dir, 'dowser.db'));
  const a = machineA();
  try {
    const page = callTool(a.b, 'dowser_memory_pull', { project_key: PK, after: '0' });
    page.items[0] = { ...page.items[0], topic: 'something else' };
    page.rules = [{ id: 'r1', lens: 'security-cra', text: 'Do not propose demo code', state: 'accepted', offered_at: '2026-10-27T09:00:00.000Z', decided_by: 'forge:jane' }, { id: 'x' }];
    const h = hydrate(db, page);
    assert.equal(h.code, 1);
    assert.equal(h.out.added, 2);
    assert.match(h.out.invalid[0].why, /fp does not match/);
    assert.equal(h.out.rules_added, 1);
    assert.equal(/** @type {any} */ (db.prepare("SELECT state FROM rules WHERE id = 'r1'").get()).state, 'accepted');
    assert.throws(() => hydrate(db, { nope: true }), (e) => /** @type {any} */ (e).code === 2);
  } finally { db.close(); removeDir(dir); a.done(); }
});
