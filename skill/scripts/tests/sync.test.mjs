// @ts-check
// The Forge seam, local side: outbox, ingest-push, ingest-verdicts, ingest-sources against a temp store.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart, transitionsOf } from '../lib/store.mjs';
import {
  RECORD_KEYS, getState, ingestPush, ingestSources, ingestVerdicts, outbox, readResponse, verdictsCursor,
} from '../lib/sync.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;
const PK = 'github-com-acme-shop';

before(() => {
  dir = tempDir('sync');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
after(() => { db.close(); removeDir(dir); });

/**
 * A verified proposal with the given topic; returns its fp.
 * @param {string} topic
 * @param {Record<string, unknown>} [over]
 */
function verified(topic, over = {}) {
  const r = propose(db, run, candidate({ topic, ...over }), { kinds: KINDS });
  assert.equal(r.result, 'created');
  const fp = /** @type {string} */ (r.fp);
  move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' });
  return fp;
}
/** @param {string} fp */
const statusOf = (fp) => getProposal(db, fp)?.status;
/** @param {string} fp */
const inOutbox = (fp) => outbox(db, { projectKey: PK, runId: run }).proposals.some((p) => p.fp === fp);

test('outbox: full dowser-proposal/1 records of verified items, nothing store-internal', () => {
  const fp = verified('outbox shape', { evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }, { type: 'ticket', ref: 'SEC-9', url: 'https://j/SEC-9' }] });
  const cand = propose(db, run, candidate({ topic: 'still a candidate' }), { kinds: KINDS }).fp;
  const ob = outbox(db, { projectKey: PK, runId: run });
  assert.equal(ob.project_key, PK);
  assert.equal(ob.run_id, run);
  const rec = ob.proposals.find((p) => p.fp === fp);
  assert.ok(rec);
  assert.ok(Object.keys(rec).every((k) => /** @type {readonly string[]} */ (RECORD_KEYS).includes(k)), Object.keys(rec).join(','));
  assert.equal(rec.status, 'verified');
  assert.deepEqual(rec.evidence.map((/** @type {any} */ e) => e.type), ['code', 'ticket']);
  assert.equal(rec.evidence[1].url, 'https://j/SEC-9');
  assert.ok(!JSON.stringify(rec).includes('null'));
  assert.ok(!ob.proposals.some((p) => p.fp === cand), 'a candidate is not pushed');
  assert.throws(() => outbox(db, { projectKey: PK, runId: 'r-nope' }), /does not exist/);
});

test('ingest-push: created -> pushed with external_ref; re-push updated; evidence growth re-enters the outbox', () => {
  const fp = verified('push lifecycle');
  assert.ok(inOutbox(fp));
  const r = ingestPush(db, { results: [{ fp, result: 'created', external_ref: 'DOW-1', external_url: 'https://j/DOW-1' }] });
  assert.equal(r.code, 0);
  assert.equal(r.out.results[0].outcome, 'pushed');
  const p = getProposal(db, fp);
  assert.equal(p?.status, 'pushed');
  assert.equal(p?.external_ref, 'DOW-1');
  assert.equal(p?.decided_by, 'skill:dowser-sync');
  assert.ok(!inOutbox(fp), 'a pushed item with no new evidence is not re-sent');

  // same response again: still pushed, no new transition
  const n = transitionsOf(db, fp).length;
  assert.equal(ingestPush(db, { results: [{ fp, result: 'created', external_ref: 'DOW-1' }] }).out.results[0].outcome, 'updated');
  assert.equal(transitionsOf(db, fp).length, n);

  // new evidence on a pushed item -> back in the outbox, and an `updated` result keeps it pushed
  assert.equal(propose(db, run, candidate({ topic: 'push lifecycle', evidence: [{ type: 'ticket', ref: 'SEC-77' }] }), { kinds: KINDS }).result, 'evidence-grew');
  assert.ok(inOutbox(fp));
  assert.equal(ingestPush(db, { results: [{ fp, result: 'updated', external_ref: 'DOW-1' }] }).out.results[0].outcome, 'updated');
  assert.equal(statusOf(fp), 'pushed');
  assert.ok(!inOutbox(fp));
});

test('ingest-push: refused, unknown, invalid and conflicts are reported (exit 1), nothing forced', () => {
  const a = verified('push refused');
  const b = verified('push conflict');
  const c = verified('push ref clash');
  move(db, b, 'rejected', { by: 'human:jane', reason: 'not-worth-it' });
  ingestPush(db, { results: [{ fp: a, result: 'refused', why: 'quota' }] });
  const r = ingestPush(db, {
    results: [
      { fp: a, result: 'refused', why: 'quota' },
      { fp: '0000000000000000', result: 'created', external_ref: 'DOW-404' },
      { fp: a, result: 'created' },
      { fp: a, result: 'bogus' },
      { fp: b, result: 'created', external_ref: 'DOW-2' },
      { fp: c, result: 'created', external_ref: 'DOW-1' },
    ],
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.results.map((/** @type {any} */ x) => x.outcome), ['refused', 'unknown', 'invalid', 'invalid', 'conflict', 'conflict']);
  assert.equal(r.out.results[0].why, 'quota');
  assert.match(r.out.results[5].why, /already belongs to/);
  assert.equal(statusOf(a), 'verified');
  assert.equal(statusOf(b), 'rejected');
  assert.equal(statusOf(c), 'verified');
  assert.equal(getProposal(db, b)?.external_ref, undefined);
});

test('ingest-push: merged-existing merges into the local owner of the Jira key, else links to it', () => {
  const owner = verified('merge owner');
  ingestPush(db, { results: [{ fp: owner, result: 'created', external_ref: 'DOW-50' }] });
  const dup = verified('merge dup');
  const lone = verified('merge lone');
  const r = ingestPush(db, { results: [
    { fp: dup, result: 'merged-existing', external_ref: 'DOW-50' },
    { fp: lone, result: 'merged-existing', external_ref: 'OLD-7', external_url: 'https://j/OLD-7' },
  ] });
  assert.equal(r.code, 0);
  assert.equal(r.out.results[0].outcome, 'merged');
  assert.equal(getProposal(db, dup)?.status, 'merged');
  assert.equal(getProposal(db, dup)?.merged_into, owner);
  assert.equal(r.out.results[1].outcome, 'linked');
  assert.equal(getProposal(db, lone)?.status, 'pushed');
  assert.equal(getProposal(db, lone)?.external_ref, 'OLD-7');
});

test('ingest-verdicts: applied through CAS with the forge decider, idempotent per (fp, decided_at), cursor kept', () => {
  const rej = verified('verdict reject');
  const acc = verified('verdict accept');
  const mrg = verified('verdict merge');
  ingestPush(db, { results: [
    { fp: rej, result: 'created', external_ref: 'DOW-60' },
    { fp: acc, result: 'created', external_ref: 'DOW-61' },
    { fp: mrg, result: 'created', external_ref: 'DOW-62' },
  ] });
  assert.equal(verdictsCursor(db), undefined);
  const page = {
    verdicts: [
      { fp: rej, status: 'rejected', reason: 'already-known', note: 'dup of PROJ-1', decided_by: 'forge:jane', decided_at: '2026-10-27T10:00:00.000Z', external_ref: 'DOW-60' },
      { fp: acc, status: 'accepted', decided_by: 'forge:bob', decided_at: '2026-10-27T10:01:00.000Z', external_ref: 'DOW-61' },
      { fp: mrg, status: 'merged', merged_into: 'DOW-61', decided_by: 'forge:bob', decided_at: '2026-10-27T10:02:00.000Z', external_ref: 'DOW-62' },
      { fp: 'ffffffffffffffff', status: 'rejected', reason: 'other', note: 'x', decided_by: 'forge:bob', decided_at: '2026-10-27T10:03:00.000Z', external_ref: 'DOW-99' },
    ],
    cursor: '17',
  };
  const r = ingestVerdicts(db, page);
  assert.equal(r.code, 1, 'the unknown fp makes it partial');
  assert.deepEqual(r.out.verdicts.map((/** @type {any} */ v) => v.outcome), ['applied', 'applied', 'applied', 'unknown']);
  const p = getProposal(db, rej);
  assert.equal(p?.status, 'rejected');
  assert.equal(p?.reason, 'already-known');
  assert.equal(p?.decided_by, 'forge:jane');
  assert.equal(p?.decided_at, '2026-10-27T10:00:00.000Z');
  assert.equal(transitionsOf(db, rej).at(-1)?.by, 'forge:jane');
  assert.equal(statusOf(acc), 'accepted');
  assert.equal(getProposal(db, mrg)?.merged_into, acc, 'merged_into resolved from the Jira key');
  assert.equal(verdictsCursor(db), '17');

  const n = transitionsOf(db, rej).length;
  const again = ingestVerdicts(db, page);
  assert.deepEqual(again.out.verdicts.map((/** @type {any} */ v) => v.outcome), ['already-applied', 'already-applied', 'already-applied', 'unknown']);
  assert.equal(transitionsOf(db, rej).length, n, 're-ingesting the same file is a no-op');
});

test('ingest-verdicts: an illegal transition is a conflict, never forced; a matching status is in-sync', () => {
  const fp = verified('verdict conflict');
  move(db, fp, 'merged', { by: 'human:jane', into: verified('verdict conflict target') });
  const fp2 = verified('verdict in sync');
  move(db, fp2, 'snoozed', { by: 'human:jane' });
  const fp3 = verified('verdict forge accept on verified');
  const r = ingestVerdicts(db, { verdicts: [
    { fp, status: 'rejected', reason: 'not-worth-it', decided_by: 'forge:jane', decided_at: '2026-10-27T11:00:00.000Z', external_ref: 'DOW-70' },
    { fp: fp2, status: 'snoozed', decided_by: 'forge:jane', decided_at: '2026-10-27T11:01:00.000Z', external_ref: 'DOW-71' },
    { fp: fp3, status: 'accepted', decided_by: 'forge:jane', decided_at: '2026-10-27T11:02:00.000Z', external_ref: 'DOW-72' },
    { fp: fp3, status: 'rejected', reason: 'nope', decided_by: 'forge:jane', decided_at: '2026-10-27T11:03:00.000Z', external_ref: 'DOW-72' },
  ], cursor: '20' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.verdicts.map((/** @type {any} */ v) => v.outcome), ['conflict', 'in-sync', 'conflict', 'invalid']);
  assert.equal(r.out.verdicts[0].current, 'merged');
  assert.equal(statusOf(fp), 'merged');
  assert.equal(statusOf(fp3), 'verified', 'verified -> accepted needs a human decider');
  assert.throws(() => ingestVerdicts(db, { nope: [] }), /expected \{"verdicts"/);
});

test('ingest-sources: caches the items for the run and returns citable refs', () => {
  const r = ingestSources(db, { runId: run, type: 'ticket', doc: { items: [
    { ref: 'SUP-1', title: 'Export to CSV please', url: 'https://j/SUP-1', body: 'b', created_at: '2026-10-01T00:00:00Z', labels: ['ask'] },
    { ref: 'SUP-2', title: 'Slow login', url: 'https://j/SUP-2', body: 'b2', created_at: '2026-10-02T00:00:00Z' },
    { title: 'no ref' },
  ] } });
  assert.equal(r.code, 1);
  assert.equal(r.out.cached, 2);
  assert.deepEqual(r.out.refs[0], { type: 'ticket', ref: 'SUP-1', url: 'https://j/SUP-1', title: 'Export to CSV please' });
  assert.equal(r.out.skipped.length, 1);
  assert.equal(ingestSources(db, { runId: run, type: 'ticket', doc: { items: [{ ref: 'SUP-1', title: 'Export (edited)', url: 'https://j/SUP-1', body: 'b' }] } }).code, 0);
  const n = Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM sources_cache WHERE run_id = ? AND type = 'ticket'").get(run)).n);
  assert.equal(n, 2, 'a re-fetch refreshes, never duplicates');
  assert.throws(() => ingestSources(db, { runId: run, type: 'jira', doc: { items: [] } }), /--type/);
  assert.throws(() => ingestSources(db, { runId: 'r-nope', type: 'page', doc: { items: [] } }), /does not exist/);
});

test('readResponse unwraps an MCP tool result envelope and refuses a tool error', () => {
  const raw = join(dir, 'raw.json');
  const env = join(dir, 'env.json');
  const err = join(dir, 'err.json');
  writeFileSync(raw, JSON.stringify({ items: [] }));
  writeFileSync(env, JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items: [{ ref: 'X' }] }) }] }));
  writeFileSync(err, JSON.stringify({ content: [{ type: 'text', text: '{}' }], isError: true }));
  assert.deepEqual(readResponse(raw), { items: [] });
  assert.deepEqual(readResponse(env), { items: [{ ref: 'X' }] });
  assert.throws(() => readResponse(err), /tool error/);
  assert.throws(() => readResponse(join(dir, 'missing.json')), /not readable/);
  assert.equal(getState(db, 'nope'), undefined);
});
