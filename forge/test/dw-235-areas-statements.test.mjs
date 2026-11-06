// @ts-check
// DW-235: a full map update fits one call with room to spare. Every statement is one Forge SQL request (30-60 ms,
// core/store.mjs) and a tool call has about 25 s, so 200 new areas take under 20 statements, not 407, with the same
// outcome: the stored set equals the pushed set, with the pushed numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, countingDb, makeDeps, pushArgs, record } from './helpers.mjs';
import { runTool } from '../src/core/app.mjs';
import { AREAS_MAX } from '../src/core/types.mjs';

const PK = 'github-com-Acme-Shop';

/** @typedef {{path: string, files: number, churn_90d: number, authors_90d?: number, last_change?: string}} Area */

/** Deps whose Db counts statements. */
function counted() {
  const d = makeDeps();
  const db = countingDb(d.db);
  return Object.assign(d, { db });
}

/**
 * `n` areas from index `from`. Every third is unmeasured, so the absent columns are written too.
 * @param {number} n @param {{from?: number, files?: number}} [o]  `files`: a base that makes the numbers differ
 * @returns {Area[]}
 */
function areas(n, o = {}) {
  const from = o.from ?? 0;
  const files = o.files ?? 1;
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const path = `src/m${String(i).padStart(3, '0')}`;
    return i % 3 === 0
      ? { path, files: files + i, churn_90d: 0 }
      : { path, files: files + i, churn_90d: files + i * 2, authors_90d: files + i % 5, last_change: '2026-10-01T00:00:00.000Z' };
  });
}

/** @param {any} d @param {Area[]} list @param {string} [run] */
const push = async (d, list, run = 'r-1') => /** @type {any} */ (await runTool(d, 'dowser_areas_push', { project_key: PK, run_id: run, areas_json: JSON.stringify(list) }, ME));

/** The stored areas of PK, by path. @param {any} d */
const stored = (d) => d.db.raw.prepare('SELECT path, files, churn_90d, authors_90d, last_change, run_id FROM areas WHERE project_key = ? ORDER BY path').all(PK).map((/** @type {any} */ r) => ({ ...r }));

/** The rows `list` should store, by path. @param {Area[]} list @param {string} run */
const want = (list, run) => [...list].sort((a, b) => (a.path < b.path ? -1 : 1)).map((a) => ({
  path: a.path, files: a.files, churn_90d: a.churn_90d, authors_90d: a.authors_90d ?? null, last_change: a.last_change ?? null, run_id: run,
}));

test('the contract cap the counts below use is 200', () => {
  assert.equal(AREAS_MAX, 200);
});

test('200 new areas on a project with no inbox yet: under 20 statements, every row stored', async () => {
  const d = counted();
  const list = areas(AREAS_MAX);
  assert.deepEqual(await push(d, list), { stored: AREAS_MAX });
  assert.ok(d.db.count() < 20, `${d.db.count()} statements`);
  assert.deepEqual(stored(d), want(list, 'r-1'));
});

test('200 new areas into an existing inbox: under 20 statements, every row stored', async () => {
  const d = counted();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  d.db.reset();
  const list = areas(AREAS_MAX);
  assert.deepEqual(await push(d, list), { stored: AREAS_MAX });
  assert.ok(d.db.count() < 20, `${d.db.count()} statements`);
  assert.deepEqual(stored(d), want(list, 'r-1'));
});

test('a second push of the same 200 paths with changed numbers stores the new numbers and removes nothing', async () => {
  const d = counted();
  await push(d, areas(AREAS_MAX));
  const next = areas(AREAS_MAX, { files: 50 }).map((a, i) => (i % 2 ? a : { path: a.path, files: a.files, churn_90d: 0 }));
  assert.deepEqual(await push(d, next, 'r-2'), { stored: AREAS_MAX });
  assert.deepEqual(stored(d), want(next, 'r-2'), 'the last_change and authors a later push omits are cleared too');
});

test('a push that drops paths deletes them; an empty push deletes all', async () => {
  const d = counted();
  await push(d, areas(AREAS_MAX));
  const kept = areas(50);
  assert.deepEqual(await push(d, kept, 'r-2'), { stored: 50 });
  assert.deepEqual(stored(d), want(kept, 'r-2'));
  assert.deepEqual(await push(d, [], 'r-3'), { stored: 0 });
  assert.deepEqual(stored(d), []);
});

test('a mixed push, some paths new and some existing, stores all with the pushed numbers', async () => {
  const d = counted();
  await push(d, areas(100));
  const next = areas(AREAS_MAX, { files: 7 });
  assert.deepEqual(await push(d, next, 'r-2'), { stored: AREAS_MAX });
  assert.deepEqual(stored(d), want(next, 'r-2'));
});

test('a row a concurrent push inserts between the read and the write fails nothing and ends with the pushed numbers', async () => {
  const d = counted();
  const list = areas(AREAS_MAX);
  const raced = list[5].path;
  let fired = false;
  d.db.before = async (s) => {
    if (fired || !/^\s*INSERT INTO areas\b/i.test(s.sql)) return;
    fired = true;
    await d.db.inner.exec('INSERT INTO areas (project_key, path, files, churn_90d, run_id) VALUES (?, ?, ?, ?, ?)', [PK, raced, 9999, 9999, 'r-concurrent']);
  };
  const out = await push(d, list);
  assert.ok(fired, 'setup: the concurrent insert ran');
  assert.deepEqual(out, { stored: AREAS_MAX });
  assert.deepEqual(stored(d), want(list, 'r-1'));
});
