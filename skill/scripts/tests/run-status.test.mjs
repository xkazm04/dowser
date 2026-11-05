// @ts-check
// `run status --run <id>`: where a run stands and the next command, derived from the store (read-only), and the
// open runs `status` and `run start` show. Through main(), one fresh repo (so one fresh store) per test.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../dowser.mjs';
import { candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';

/** @type {string[]} */
const dirs = [];
/** @type {string | undefined} */
let homeBefore;
before(() => {
  homeBefore = process.env.DOWSER_HOME;
  const home = tempDir('run-status-home');
  dirs.push(home);
  process.env.DOWSER_HOME = home;
});
after(() => {
  if (homeBefore === undefined) delete process.env.DOWSER_HOME; else process.env.DOWSER_HOME = homeBefore;
  for (const d of dirs) removeDir(d);
});

const SRC = 'export function login(user) {\n  return check(user.password);\n}\n';
const QUOTE = [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }];

/** A fresh repo and a CLI bound to it. */
function project() {
  const repo = tempDir('run-status-repo');
  const scratch = tempDir('run-status-work');
  dirs.push(repo, scratch);
  gitRepo(repo, { 'src/auth.js': SRC, 'README.md': '# App\n' });
  let n = 0;
  /** @param {string[]} args */
  const cli = async (...args) => {
    const r = await main([...args, '--repo', repo]);
    /** @type {any} */
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = undefined; }
    return { code: r.code, out, stdout: r.stdout, stderr: r.stderr };
  };
  /** @param {unknown} doc */
  const file = (doc) => {
    const p = join(scratch, `f${n++}.json`);
    writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
    return p;
  };
  /** @param {string} run @param {object[]} cands */
  const propose = async (run, cands) => {
    const r = await cli('propose', '--run', run, '--file', file(cands.map((c) => JSON.stringify(c)).join('\n')));
    assert.equal(r.code, 0, r.stdout);
    return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.fp).map((l) => String(l.fp));
  };
  const start = async () => {
    const r = await cli('run', 'start', '--mode', 'full');
    assert.equal(r.code, 0, r.stdout);
    return r;
  };
  const dbFile = async () => (await cli('init')).out.db;
  return { cli, file, propose, start, dbFile };
}

/** An opportunity candidate whose quote verifies. @param {string} topic */
const opp = (topic) => candidate({ lens: 'opportunity', kind: 'missing-capability', topic, title: `Add ${topic}`, evidence: QUOTE });
/** An opportunity candidate whose quote does not verify. @param {string} topic */
const bad = (topic) => candidate({ lens: 'opportunity', kind: 'missing-capability', topic, title: `Add ${topic}`,
  evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'this line is not in the file' }] });

/** Every table's rows, to prove a command wrote nothing. @param {string} path */
function dump(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = /** @type {{name: string}[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all());
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]));
  } finally { db.close(); }
}

test('case 1 + 7: proposed, verify pending -> stages.proposed per lens, verify pending, next verify; the others not reached', async () => {
  const p = project();
  const run = (await p.start()).out.run_id;
  await p.propose(run, [opp('alpha'), opp('beta'), opp('gamma')]);
  const r = await p.cli('run', 'status', '--run', run);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.run_id, run);
  assert.equal(r.out.status, 'running');
  assert.deepEqual(r.out.stages.proposed, { opportunity: 3 });
  assert.equal(r.out.stages.verify, 'pending');
  assert.deepEqual(r.out.stages.not_reached, ['ux-friction', 'doc-drift', 'security-cra'], 'LENSES order');
  assert.deepEqual(r.out.next, [`verify --run ${run}`]);
});

test('case 2: after verify -> verify done with verified and dropped counts, next[0] pretriage', async () => {
  const p = project();
  const run = (await p.start()).out.run_id;
  await p.propose(run, [opp('alpha'), opp('beta'), bad('gamma')]);
  assert.equal((await p.cli('verify', '--run', run)).code, 0);
  const r = await p.cli('run', 'status', '--run', run);
  assert.deepEqual(r.out.stages.verify, { state: 'done', verified: 2, dropped: 1 });
  assert.equal(r.out.next[0], `pretriage --run ${run}`);
  assert.equal(r.out.next.at(-1), `run finish --run ${run} --lenses <json>`);
});

test('case 3: stages.push.pending is exactly the set outbox would send (store-wide); gone once ingest-push marks them pushed', async () => {
  const p = project();
  // an earlier run pushes one card
  const r0 = (await p.start()).out.run_id;
  const [old] = await p.propose(r0, [opp('old card')]);
  await p.cli('verify', '--run', r0);
  const first = await p.cli('outbox', '--run', r0);
  assert.deepEqual(JSON.parse(first.out.proposals_json).map((/** @type {any} */ x) => x.fp), [old]);
  assert.equal((await p.cli('ingest-push', '--file', p.file({ results: [{ fp: old, result: 'created', external_ref: 'DW-1' }] }))).code, 0);
  assert.equal((await p.cli('run', 'finish', '--run', r0, '--lenses', '{"opportunity":{"state":"ran"}}')).code, 0);

  // this run: two new verified cards, and the pushed card's evidence grew
  const run = (await p.start()).out.run_id;
  await p.propose(run, [opp('alpha'), opp('beta')]);
  await p.cli('verify', '--run', run);
  await p.propose(run, [{ ...opp('old card'), evidence: [...QUOTE, { type: 'ticket', ref: 'SEC-77' }] }]);
  const unchecked = await p.cli('run', 'status', '--run', run);
  assert.deepEqual(unchecked.out.stages.push, { pending: 2, pushed: 1 }, 'the grown card waits until verify checks its new evidence');
  assert.equal((await p.cli('ingest-sources', '--run', run, '--type', 'ticket', '--file', p.file({ items: [{ ref: 'SEC-77', title: 'Plaintext' }] }))).code, 0);
  const v = await p.cli('verify', '--run', run);
  assert.deepEqual(v.out.rechecked.map((/** @type {any} */ x) => [x.fp, x.result]), [[old, 'checked']]);
  const before = await p.cli('run', 'status', '--run', run);
  // what outbox returns for the same store (outbox itself writes outbox:last, so it runs after run status)
  const sent = JSON.parse((await p.cli('outbox', '--run', run)).out.proposals_json);
  assert.equal(sent.length, 3);
  assert.deepEqual(before.out.stages.push, { pending: sent.length, pushed: 1 }, 'the re-proposed card was pushed once already');
  assert.ok(before.out.next.includes(`outbox --run ${run}`), JSON.stringify(before.out.next));

  const results = sent.map((/** @type {any} */ x, /** @type {number} */ i) => ({ fp: x.fp, result: x.fp === old ? 'updated' : 'created', external_ref: x.fp === old ? 'DW-1' : `DW-${i + 2}` }));
  assert.equal((await p.cli('ingest-push', '--file', p.file({ results }))).code, 0);
  const afterPush = await p.cli('run', 'status', '--run', run);
  assert.deepEqual(afterPush.out.stages.push, { pushed: 3 }, 'no pending key once outbox has nothing to send');
  assert.equal(afterPush.out.next.includes(`outbox --run ${run}`), false);
});

test('case 4: status lists open runs with their next command; run start names them without closing or refusing them', async () => {
  const p = project();
  const quiet = await p.cli('status');
  assert.equal('open' in quiet.out, false, 'no running run -> no open key');
  const old = (await p.start()).out.run_id;
  const dbFile = await p.dbFile();
  const raw = new DatabaseSync(dbFile);
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  raw.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(twoHoursAgo, old);
  raw.close();

  const s = await p.cli('status');
  assert.deepEqual(s.out.open, [{ run_id: old, started_at: twoHoursAgo, next: ['context --run ' + old + ' --lens opportunity',
    'context --run ' + old + ' --lens ux-friction', 'context --run ' + old + ' --lens doc-drift', 'context --run ' + old + ' --lens security-cra'] }]);

  const again = await p.start();
  assert.deepEqual(again.out.open_runs, [old]);
  assert.equal(again.out.abandoned, undefined, 'a run of 2 h is not closed');
  const st = await p.cli('run', 'status', '--run', old);
  assert.equal(st.out.status, 'running', 'the open run is left alone');
});

test('case 5: a finished run -> status done, next [], the per-lens record; an unknown run id -> exit 2 bad-input', async () => {
  const p = project();
  const run = (await p.start()).out.run_id;
  await p.propose(run, [opp('alpha')]);
  await p.cli('verify', '--run', run);
  assert.equal((await p.cli('run', 'finish', '--run', run, '--lenses', '{"opportunity":{"state":"ran","emitted":1}}')).code, 0);
  const r = await p.cli('run', 'status', '--run', run);
  assert.equal(r.code, 0);
  assert.equal(r.out.status, 'done');
  assert.deepEqual(r.out.next, []);
  assert.equal(r.out.lenses.opportunity.state, 'ran');
  assert.equal(r.out.lenses.opportunity.emitted, 1);

  const none = await p.cli('run', 'status', '--run', 'r-20000101000000-dead');
  assert.equal(none.code, 2);
  assert.equal(none.out.error, 'bad-input');
});

test('case 6: no sources and no direction -> neither key (never 0, never null); ingested ones are counted', async () => {
  const p = project();
  const run = (await p.start()).out.run_id;
  const r = await p.cli('run', 'status', '--run', run);
  assert.equal('sources' in r.out.stages, false);
  assert.equal('direction' in r.out.stages, false);
  assert.doesNotMatch(r.stdout, /null/);

  assert.equal((await p.cli('ingest-sources', '--run', run, '--type', 'ticket', '--file',
    p.file({ items: [{ ref: 'SEC-1', title: 't', body: 'b' }, { ref: 'SEC-2', title: 't2', body: 'b2' }] }))).code, 0);
  const s = await p.cli('run', 'status', '--run', run);
  assert.deepEqual(s.out.stages.sources, { ticket: 2 });
});

test('run status is read-only: the store is byte-for-byte the same table content before and after', async () => {
  const p = project();
  const run = (await p.start()).out.run_id;
  await p.propose(run, [opp('alpha'), bad('beta')]);
  await p.cli('verify', '--run', run);
  const dbFile = await p.dbFile();
  const before = dump(dbFile);
  assert.equal((await p.cli('run', 'status', '--run', run)).code, 0);
  assert.equal((await p.cli('status')).code, 0);
  assert.equal(dump(dbFile), before);
});
