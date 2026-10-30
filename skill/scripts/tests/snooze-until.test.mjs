// @ts-check
// DW-18: snooze until a date. `move --to snoozed --until YYYY-MM-DD` stores proposals.snooze_until (store v5);
// `run start` wakes the items whose date has passed (snoozed -> verified, a transitions row, `woke` in the output).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DowserError } from '../lib/model.mjs';
import {
  DDL, SYSTEM_DECIDER, USER_VERSION, V6_COLUMNS, getProposal, localDate, move, openStore, propose, runStart, transitionsOf, untilProblem,
} from '../lib/store.mjs';
import { KINDS, candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
/** @type {string} */ let dir;
/** @type {string} */ let home;
/** @type {string} */ let repo;

before(() => {
  dir = tempDir('snooze');
  home = tempDir('snooze-home');
  repo = tempDir('snooze-repo');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
});
after(() => { removeDir(dir); removeDir(home); removeDir(repo); });

/** A local date `days` from today. @param {number} days */
const inDays = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return localDate(d); };

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: dir });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

test('a v4 store file upgrades in place to v5 (and on to v6): snooze_until added, absent on old rows', () => {
  assert.equal(USER_VERSION, 6);
  const v6 = new RegExp(`^\\s*(${V6_COLUMNS.join('|')})\\s.*\\n`, 'gm');
  const ddlV4 = DDL.replace(/^\s*snooze_until\s.*\n/m, '').replace(v6, '').split('CREATE TABLE IF NOT EXISTS trust_state')[0]
    .replace(`PRAGMA user_version = ${USER_VERSION};`, 'PRAGMA user_version = 4;');
  assert.ok(!ddlV4.includes('snooze_until') && ddlV4.includes('PRAGMA user_version = 4;'));
  const file = join(dir, 'v4.db');
  const raw = new DatabaseSync(file);
  raw.exec(ddlV4);
  const at = '2026-10-01T00:00:00.000Z';
  raw.prepare("INSERT INTO runs (id, started_at, mode, status) VALUES ('r-1', ?, 'full', 'done')").run(at);
  raw.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence, confidence_why,
    provenance_json, status, first_run_id, last_run_id, created_at, updated_at)
    VALUES ('bbbbbbbbbbbbbbbb', 'security-cra', 'secret', 't', '["a#b"]', 'Title', 'why', 'body', '{"size":"S"}', 'high', 'q',
    '{"lens_version":"1.0.0"}', 'snoozed', 'r-1', 'r-1', ?, ?)`).run(at, at);
  raw.close();

  const up = openStore(file);
  try {
    assert.equal(Number(/** @type {any} */ (up.prepare('PRAGMA user_version').get()).user_version), 6);
    assert.ok((/** @type {any[]} */ (up.prepare('PRAGMA table_info(proposals)').all())).some((c) => c.name === 'snooze_until'));
    const p = getProposal(up, 'bbbbbbbbbbbbbbbb');
    assert.equal(p?.status, 'snoozed');
    assert.equal(p && 'snooze_until' in p, false, 'the new column starts absent, never null');
    assert.deepEqual(runStart(up, { mode: 'full' }).woke, undefined, 'a snooze with no date does not wake');
  } finally { up.close(); }
  openStore(file).close();
});

test('untilProblem: a real calendar date after today', () => {
  assert.equal(untilProblem('2026-11-01', '2026-10-29'), undefined);
  assert.match(String(untilProblem('2026-10-29', '2026-10-29')), /after today/);
  assert.match(String(untilProblem('2026-10-01', '2026-10-29')), /after today/);
  assert.match(String(untilProblem('2026-02-30', '2026-01-01')), /calendar date/);
  assert.match(String(untilProblem('2026-1-5', '2026-01-01')), /calendar date/);
  assert.match(String(untilProblem('next week', '2026-01-01')), /calendar date/);
});

test('store: --until is set on snooze, cleared on leaving; runStart wakes only passed dates', () => {
  const db = openStore(join(dir, 'store.db'));
  try {
    const run = runStart(db, { mode: 'full' }).id;
    /** @param {string} topic @param {string | undefined} until */
    const snoozed = (topic, until) => {
      const fp = /** @type {string} */ (propose(db, run, candidate({ topic }), { kinds: KINDS }).fp);
      move(db, fp, 'verified', { by: 'skill:dowser-verify' });
      move(db, fp, 'snoozed', { by: 'human:jane', until, today: '2026-10-29' });
      return fp;
    };
    const due = snoozed('due soon', '2026-11-05');
    const later = snoozed('due later', '2026-12-01');
    const undated = snoozed('no date', undefined);
    assert.equal(getProposal(db, due)?.snooze_until, '2026-11-05');
    assert.equal(getProposal(db, undated)?.snooze_until, undefined);

    assert.throws(() => move(db, later, 'verified', { by: 'human:jane', until: '2026-12-01' }), (e) => e instanceof DowserError && e.code === 2 && /only with --to snoozed/.test(e.message));
    assert.throws(() => move(db, later, 'snoozed', { by: 'human:jane', until: '2026-10-01', today: '2026-10-29' }), (e) => e instanceof DowserError && e.code === 2);

    assert.equal(runStart(db, { mode: 'full', today: '2026-11-04' }).woke, undefined, 'the day before: nothing wakes');
    const r = runStart(db, { mode: 'full', today: '2026-11-05' });
    assert.deepEqual(r.woke, [due], 'on the day: it wakes');
    const p = getProposal(db, due);
    assert.equal(p?.status, 'verified');
    assert.equal(p?.snooze_until, undefined, 'leaving snoozed clears the date');
    const last = transitionsOf(db, due).at(-1);
    assert.deepEqual([last?.from_status, last?.to_status, last?.by, last?.note, last?.run_id],
      ['snoozed', 'verified', SYSTEM_DECIDER, 'snooze until 2026-11-05 passed', r.id]);
    assert.equal(getProposal(db, later)?.status, 'snoozed', 'a future date stays snoozed');
    assert.equal(getProposal(db, undated)?.status, 'snoozed', 'no date stays snoozed');
    assert.equal(runStart(db, { mode: 'full', today: '2026-11-06' }).woke, undefined, 'a woken item does not wake twice');
  } finally { db.close(); }
});

test('CLI: move --until validation, list shows snooze_until, run start wakes a passed date', () => {
  const init = cli('init');
  assert.equal(init.code, 0, init.stderr);
  const run = cli('run', 'start', '--mode', 'full').out.run_id;
  const file = join(dir, 'cands.jsonl');
  writeFileSync(file, ['a due item', 'a later item', 'an undated item'].map((topic) => JSON.stringify(candidate({ topic }))).join('\n'));
  const prop = cli('propose', '--run', run, '--file', file, '--kinds', 'security-cra=secret,vuln');
  assert.equal(prop.code, 0, prop.stderr);
  const [due, later, undated] = prop.stdout.split('\n').filter(Boolean).slice(0, 3).map((l) => JSON.parse(l).fp);
  assert.equal(cli('verify', '--run', run).out.verified, 3);

  for (const bad of [['--until', inDays(-1)], ['--until', localDate()], ['--until', '2026-02-30'], ['--until']]) {
    const r = cli('move', due, '--to', 'snoozed', '--by', 'human:jane', ...bad);
    assert.equal(r.code, 2, `refused: ${bad.join(' ')}`);
    assert.equal(r.out.error, 'bad-input');
  }
  const offSnooze = cli('move', due, '--to', 'rejected', '--reason', 'not-worth-it', '--by', 'human:jane', '--until', inDays(5));
  assert.equal(offSnooze.code, 2);
  assert.match(offSnooze.stderr, /--until goes only with --to snoozed/);
  assert.equal(getStatus(due), 'verified', 'a refused move changes nothing');

  const s1 = cli('move', due, '--to', 'snoozed', '--by', 'human:jane', '--until', inDays(3));
  assert.equal(s1.code, 0, s1.stderr);
  assert.equal(s1.out.snooze_until, inDays(3));
  assert.equal(cli('move', later, '--to', 'snoozed', '--by', 'human:jane', '--until', inDays(30)).code, 0);
  const s3 = cli('move', undated, '--to', 'snoozed', '--by', 'human:jane');
  assert.equal(s3.code, 0);
  assert.equal('snooze_until' in s3.out, false);

  const list = cli('list', '--status', 'snoozed').out.proposals;
  /** @type {Record<string, any>} */
  const byFp = Object.fromEntries(list.map((/** @type {any} */ r) => [r.fp, r]));
  assert.equal(byFp[due].snooze_until, inDays(3));
  assert.equal(byFp[later].snooze_until, inDays(30));
  assert.equal('snooze_until' in byFp[undated], false);

  const none = cli('run', 'start', '--mode', 'full');
  assert.equal(none.code, 0, none.stderr);
  assert.equal('woke' in none.out, false, 'no date passed: woke is omitted');

  // time passes for the due item: its date is now yesterday (direct SQL stands in for the calendar)
  const raw = new DatabaseSync(init.out.db);
  raw.prepare('UPDATE proposals SET snooze_until = ? WHERE fp = ?').run(inDays(-1), due);
  raw.close();
  const woke = cli('run', 'start', '--mode', 'full');
  assert.equal(woke.code, 0, woke.stderr);
  assert.deepEqual(woke.out.woke, [due]);
  const show = cli('show', due).out;
  assert.equal(show.card.status, 'verified');
  assert.equal(show.card.snooze_until, undefined);
  assert.equal(getStatus(later), 'snoozed');
  assert.equal(getStatus(undated), 'snoozed');
});

/** @param {string} fp */
function getStatus(fp) { return cli('show', fp).out.card.status; }
