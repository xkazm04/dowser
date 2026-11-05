// @ts-check
// `triage sheet --run R` (the numbered decision sheet: for_person rows with their prediction and held-back
// lookalike, then the reserve, then the machine pre-triaged) and `triage apply --run R --by human:<n> --decisions
// '<line>' [--dry-run]` (every line validated before the first move; moves go through store.move, the same CAS).
// Through main(), one fresh repo (so one fresh store) per test.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../dowser.mjs';
import { candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';
import { move, openStore } from '../lib/store.mjs';

/** @type {string[]} */
const dirs = [];
/** @type {string | undefined} */
let homeBefore;
before(() => {
  homeBefore = process.env.DOWSER_HOME;
  const home = tempDir('triage-home');
  dirs.push(home);
  process.env.DOWSER_HOME = home;
});
after(() => {
  if (homeBefore === undefined) delete process.env.DOWSER_HOME; else process.env.DOWSER_HOME = homeBefore;
  for (const d of dirs) removeDir(d);
});

const SRC = 'export function login(user) {\n  return check(user.password);\n}\n';
const QUOTE = [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }];

/** A date `days` after today, local, YYYY-MM-DD. @param {number} days */
const future = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** An opportunity candidate whose quote verifies. @param {string} topic @param {Record<string, unknown>} [over] */
const opp = (topic, over = {}) => candidate({ lens: 'opportunity', kind: 'missing-capability', topic, title: `Add ${topic}`,
  anchors: [`src/${topic.replace(/\W+/g, '-')}.js#main`], evidence: QUOTE, predicted_verdict: 'accept', predicted_why: `like ${topic}`, ...over });

/** A fresh repo and a CLI bound to it. */
function project() {
  const repo = tempDir('triage-repo');
  const scratch = tempDir('triage-work');
  dirs.push(repo, scratch);
  gitRepo(repo, { 'src/auth.js': SRC });
  let n = 0;
  /** @param {string[]} args */
  const cli = async (...args) => {
    const r = await main([...args, '--repo', repo]);
    /** @type {any} */
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = undefined; }
    return { code: r.code, out, stdout: r.stdout, stderr: r.stderr };
  };
  /** @param {string} run @param {object[]} cands */
  const propose = async (run, cands) => {
    const p = join(scratch, `f${n++}.jsonl`);
    writeFileSync(p, cands.map((c) => JSON.stringify(c)).join('\n'));
    const r = await cli('propose', '--run', run, '--file', p);
    assert.equal(r.code, 0, r.stdout);
    return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.fp).map((l) => String(l.fp));
  };
  const start = async () => {
    const r = await cli('run', 'start', '--mode', 'full');
    assert.equal(r.code, 0, r.stdout);
    return String(r.out.run_id);
  };
  const dbFile = async () => String((await cli('init')).out.db);
  /** @param {string} sqlText @param {...string} params */
  const exec = async (sqlText, ...params) => {
    const db = new DatabaseSync(await dbFile());
    try { db.prepare(sqlText).run(...params); } finally { db.close(); }
  };
  const transitions = async () => {
    const db = new DatabaseSync(await dbFile(), { readOnly: true });
    try { return Number(/** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM transitions').get()).n); } finally { db.close(); }
  };
  /** @param {string} fp */
  const card = async (fp) => (await cli('show', fp)).out;
  return { cli, propose, start, dbFile, exec, transitions, card };
}

/** A run with 5 verified ranked cards (scores apart), the first `pretriaged` of them marked machine pre-triaged. */
async function fiveCards(pretriaged = 1, verifyFlags = /** @type {string[]} */ ([])) {
  const p = project();
  const run = await p.start();
  const fps = await p.propose(run, ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((t, i) => opp(t, { impact: 9 - i, impact_why: 'x' })));
  const v = await p.cli('verify', '--run', run, ...verifyFlags);
  assert.equal(v.code, 0, v.stdout);
  const pre = await p.cli('pretriage', '--run', run);
  assert.equal(pre.code, 0, pre.stdout);
  // the machine mark as an L1 slice leaves it, set after pretriage (which re-checks a mark against the slice's
  // level: these product slices are at L0 and would clear it)
  const marked = fps.slice(0, pretriaged);
  for (const fp of marked) await p.exec("UPDATE proposals SET pretriaged_by = 'machine:dowser' WHERE fp = ?", fp);
  const forPerson = pre.out.for_person.filter((/** @type {any} */ r) => !marked.includes(r.fp));
  return { p, run, fps, pre: { ...pre.out, for_person: forPerson } };
}

test('case 1: the sheet numbers the for_person rows 1..4 in for_person order, each row a decision row; stable across calls', async () => {
  const { p, run, fps, pre } = await fiveCards();
  const s = await p.cli('triage', 'sheet', '--run', run);
  assert.equal(s.code, 0, s.stdout);
  assert.deepEqual(s.out.rows.map((/** @type {any} */ r) => r.n), [1, 2, 3, 4]);
  assert.deepEqual(s.out.rows.map((/** @type {any} */ r) => r.fp), pre.for_person.map((/** @type {any} */ r) => r.fp), 'for_person order');
  const row = s.out.rows[0];
  for (const k of ['n', 'fp', 'lens', 'title', 'size', 'confidence', 'predicted_verdict', 'predicted_why']) assert.ok(k in row, `row has ${k}`);
  assert.equal(typeof row.score, 'number');
  assert.equal(row.size, 'S');
  assert.equal(row.predicted_verdict, 'accept');
  assert.ok(!('lookalike' in row), 'no held-back lookalike: the key is omitted');
  assert.deepEqual(s.out.reserve, []);
  assert.deepEqual(s.out.pretriaged.map((/** @type {any} */ r) => [r.n, r.fp]), [[5, fps[0]]], 'the machine pre-triaged card is numbered after the rest');
  assert.deepEqual((await p.cli('triage', 'sheet', '--run', run)).out, s.out, 'numbering identical across two calls');
});

test('case 1b: reserve rows are numbered after the ranked rows', async () => {
  const { p, run } = await fiveCards(0, ['--per-run', '3']);
  const s = await p.cli('triage', 'sheet', '--run', run);
  assert.deepEqual(s.out.rows.map((/** @type {any} */ r) => r.n), [1, 2, 3]);
  assert.deepEqual(s.out.reserve.map((/** @type {any} */ r) => r.n), [4, 5]);
  assert.ok(s.out.rows.some((/** @type {any} */ r) => r.mvp === true), 'the lens MVP is marked');
});

test('case 2: a card whose similar hit is rejected or snoozed carries lookalike {fp, title, status, decided_at, reason?}', async () => {
  const p = project();
  const r0 = await p.start();
  const [old, sleepy] = await p.propose(r0, [opp('csv export'), opp('pdf export')]);
  await p.cli('verify', '--run', r0);
  assert.equal((await p.cli('move', old, '--to', 'rejected', '--by', 'human:ana', '--reason', 'not-worth-it')).code, 0);
  assert.equal((await p.cli('move', sleepy, '--to', 'snoozed', '--by', 'human:ana')).code, 0);
  assert.equal((await p.cli('run', 'finish', '--run', r0, '--lenses', '{"opportunity":{"state":"ran"}}')).code, 0);

  const run = await p.start();
  const [again, pdf, other] = await p.propose(run, [
    opp('csv export again', { anchors: ['src/csv-export.js#main'] }),
    opp('pdf export again', { anchors: ['src/pdf-export.js#main'] }),
    opp('unrelated thing'),
  ]);
  await p.cli('verify', '--run', run);
  const s = await p.cli('triage', 'sheet', '--run', run);
  assert.equal(s.code, 0, s.stdout);
  const by = Object.fromEntries(s.out.rows.map((/** @type {any} */ r) => [r.fp, r]));
  const look = by[again].lookalike;
  assert.deepEqual([look.fp, look.title, look.status, look.reason], [old, 'Add csv export', 'rejected', 'not-worth-it']);
  assert.match(look.decided_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual([by[pdf].lookalike.fp, by[pdf].lookalike.status], [sleepy, 'snoozed']);
  assert.ok(!('reason' in by[pdf].lookalike), 'a snooze has no reason: omitted');
  assert.ok(!('lookalike' in by[other]));
});

test('case 3: apply keeps, rejects, snoozes and merges; exactly one new transition per moved card', async () => {
  const { p, run } = await fiveCards(0);
  const rows = (await p.cli('triage', 'sheet', '--run', run)).out.rows;
  const before = await p.transitions();
  const until = future(30);
  const r = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', `1 keep; 2 reject not-worth-it; 3 snooze ${until}; 4 merge 1`);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(await p.transitions(), before + 3, 'three moves, keep records nothing');
  const [c1, c2, c3, c4] = await Promise.all(rows.slice(0, 4).map((/** @type {any} */ x) => p.card(x.fp)));
  assert.equal(c1.card.status, 'verified');
  assert.equal(c1.transitions.length, 2, 'card 1 unchanged: propose + verify only');
  assert.deepEqual([c2.card.status, c2.card.reason, c2.card.decided_by], ['rejected', 'not-worth-it', 'human:ana']);
  assert.deepEqual([c3.card.status, c3.card.snooze_until], ['snoozed', until]);
  assert.deepEqual([c4.card.status, c4.card.merged_into], ['merged', rows[0].fp]);
  for (const c of [c2, c3, c4]) assert.equal(c.transitions.length, 3, 'one new transition each');
  assert.deepEqual(r.out.applied.map((/** @type {any} */ a) => [a.n, a.to]), [[2, 'rejected'], [3, 'snoozed'], [4, 'merged']]);
  assert.deepEqual(r.out.kept, [1, 5]);
});

test('case 4: one invalid line refuses the whole sheet before any move; the error names the line and the rule', async () => {
  const { p, run } = await fiveCards(0);
  const before = await p.transitions();
  const r = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', '1 reject not-worth-it; 2 reject other');
  assert.equal(r.code, 2, r.stdout);
  assert.equal(await p.transitions(), before, 'NO card moved, not even line 1');
  assert.equal(r.out.error, 'bad-input');
  assert.deepEqual(r.out.problems.map((/** @type {any} */ x) => x.line), [2]);
  assert.match(r.out.message, /line 2/);
  assert.match(r.out.message, /other needs --note/);
  // the same line with a note is fine
  const ok = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', '2 reject other "dup of a ticket"');
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.out.applied[0].note, 'dup of a ticket');
});

test('case 4b: every rule the move path enforces is checked up front: reason code, date, decider, merge target', async () => {
  const { p, run } = await fiveCards(0);
  const before = await p.transitions();
  /** @param {string} line @param {RegExp} why @param {string} [by] */
  const refused = async (line, why, by = 'human:ana') => {
    const r = await p.cli('triage', 'apply', '--run', run, '--by', by, '--decisions', line);
    assert.equal(r.code, 2, `${line}: ${r.stdout}`);
    assert.match(r.out.message, why, line);
  };
  await refused('1 reject meh', /reason must be one of/);
  await refused('1 reject', /a reject needs --reason/);
  await refused('1 snooze 2020-01-01', /must be after today/);
  await refused('1 snooze 2026-02-30', /calendar date/);
  await refused('1 merge 1', /cannot merge into itself/);
  await refused('1 merge 0123456789abcdef', /not a known proposal/);
  await refused('1 merge', /a merge needs/);
  await refused('1 frobnicate', /keep, reject, snooze or merge/);
  await refused('1 keep; 1 reject not-worth-it', /twice/);
  await refused('rest reject not-worth-it', /rest/);
  await refused('1 keep', /human/, 'agent:claude');
  assert.equal(await p.transitions(), before);
});

test('case 5: --dry-run prints the moves it would make; the store is unchanged', async () => {
  const { p, run } = await fiveCards(0);
  const before = await p.transitions();
  const db = await p.dbFile();
  const r = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--dry-run', '--decisions', '2 reject not-worth-it; 4 merge 1');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.dry_run, true);
  assert.deepEqual(r.out.would_apply.map((/** @type {any} */ a) => [a.n, a.to]), [[2, 'rejected'], [4, 'merged']]);
  assert.equal(await p.transitions(), before, 'transition count equal before and after');
  const conn = new DatabaseSync(db, { readOnly: true });
  try { assert.equal(Number(/** @type {any} */ (conn.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status <> 'verified'").get()).n), 0); } finally { conn.close(); }
});

test('case 6: rest keep and omitted numbers record nothing; an unknown number refuses the sheet', async () => {
  const { p, run } = await fiveCards(0);
  const before = await p.transitions();
  const r = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', '3 reject wrong-size; rest keep');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(await p.transitions(), before + 1);
  assert.deepEqual(r.out.kept, [1, 2, 4, 5]);
  const bad = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', '1 reject not-worth-it; 9 keep');
  assert.equal(bad.code, 2, bad.stdout);
  assert.match(bad.out.message, /9/);
  assert.equal(await p.transitions(), before + 1, 'nothing moved');
});

test('case 7: a card moved after the sheet is refused by CAS with its current status; the other lines apply; trust_events once', async () => {
  const { p, run } = await fiveCards(0);
  const rows = (await p.cli('triage', 'sheet', '--run', run)).out.rows;
  // a verdict lands between the sheet and the apply (as ingest-verdicts would move a card)
  assert.equal((await p.cli('move', rows[1].fp, '--to', 'rejected', '--by', 'human:bob', '--reason', 'already-known')).code, 0);
  const r = await p.cli('triage', 'apply', '--run', run, '--by', 'human:ana', '--decisions', '1 reject not-worth-it; 2 snooze; 3 reject wrong-size');
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(r.out.refused.map((/** @type {any} */ x) => [x.n, x.fp, x.current]), [[2, rows[1].fp, 'rejected']]);
  assert.deepEqual(r.out.applied.map((/** @type {any} */ a) => a.n), [1, 3]);
  for (const a of r.out.applied) assert.ok(!('trust_events' in a), 'trust events are not per item');
  assert.equal((r.stdout.match(/"trust_events"/g) ?? []).length <= 1, true, 'printed at most once, for the batch');
  assert.equal((await p.card(rows[1].fp)).card.reason, 'already-known', 'the concurrent decision stands');
  // the numbering does not shift after moves: row 2 is still row 2
  assert.deepEqual((await p.cli('triage', 'sheet', '--run', run)).out.rows.map((/** @type {any} */ x) => x.fp), rows.map((/** @type {any} */ x) => x.fp));
});

test('guard: move keeps its input refusals and messages (the validator it now shares with triage apply)', () => {
  const dir = tempDir('triage-guard');
  dirs.push(dir);
  const db = openStore(join(dir, 'dowser.db'));
  try {
    /** @param {string} to @param {any} o @param {RegExp} why */
    const throws = (to, o, why) => assert.throws(() => move(db, 'f'.repeat(16), to, o), (e) => /** @type {any} */ (e).code === 2 && why.test(/** @type {any} */ (e).message));
    throws('nope', { by: 'human:a' }, /^--to must be one of/);
    throws('rejected', { by: 'human:a', from: 'x' }, /^--from must be one of/);
    throws('rejected', { by: 'bad' }, /^--by names the decider/);
    throws('rejected', { by: 'human:a' }, /^a reject needs --reason$/);
    throws('rejected', { by: 'human:a', reason: 'other' }, /^reason other needs --note$/);
    throws('merged', { by: 'human:a' }, /^a merge needs --into <fp>$/);
    throws('snoozed', { by: 'human:a', into: 'x' }, /^--into goes only with --to merged$/);
    throws('merged', { by: 'human:a', into: 'f'.repeat(16) }, /^a proposal cannot merge into itself$/);
    throws('rejected', { by: 'human:a', reason: 'other', note: 'n', until: '2999-01-01' }, /^--until goes only with --to snoozed$/);
    throws('snoozed', { by: 'human:a', until: '2000-01-01' }, /^--until must be after today/);
    throws('snoozed', { by: 'human:a', until: 'soon' }, /^--until is a calendar date/);
    assert.throws(() => move(db, 'f'.repeat(16), 'rejected', { by: 'human:a', reason: 'not-worth-it' }), (e) => /** @type {any} */ (e).name === 'MoveRefused');
  } finally { db.close(); }
});
