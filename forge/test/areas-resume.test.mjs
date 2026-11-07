// @ts-check
// DW-85: an areas push re-run with the same areas and run id (the sample load's resume path) must succeed on a store
// with MySQL affected-row semantics, as Forge SQL has: an UPDATE that sets the values a row already holds counts 0
// affected rows, so "0 rows updated" does not mean "no row" (core/direction.mjs says the same). docs/forge-app.md
// "Sample inbox": "A load cut short any other way (a timeout) is completed by the next call too."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, record } from './helpers.mjs';
import { pushAreas } from '../src/core/areas.mjs';
import { SAMPLE_KEY, loadSample } from '../src/core/sample.mjs';

const PK = 'github-com-Acme-Shop';

/**
 * Gives `d.db` MySQL affected-row semantics: an UPDATE reports the rows whose values it changed, not the rows it
 * matched (node:sqlite reports matched rows). A duplicate primary key still throws DuplicateKey (helpers.mjs, as the
 * Forge SQL adapter does). `failOn(re, nth)` makes the nth statement matching `re` throw, as a call cut short there.
 * @param {ReturnType<typeof makeDeps>} d
 */
function mysqlSemantics(d) {
  const inner = d.db.exec.bind(d.db);
  /** @type {{re: RegExp, left: number} | undefined} */
  let fail;
  d.db.exec = async (sql, params = []) => {
    if (fail && fail.re.test(sql) && --fail.left === 0) { fail = undefined; throw new Error('function timed out'); }
    const m = /^\s*UPDATE\s+(\w+)\s/i.exec(sql);
    if (!m) return inner(sql, params);
    const snap = () => d.db.raw.prepare(`SELECT * FROM "${m[1]}"`).all().map((r) => JSON.stringify(r));
    const before = snap();
    await inner(sql, params);
    /** @type {Map<string, number>} */
    const left = new Map();
    for (const r of snap()) left.set(r, (left.get(r) ?? 0) + 1);
    let changed = 0;
    for (const r of before) {
      const n = left.get(r) ?? 0;
      if (n > 0) left.set(r, n - 1); else changed++;
    }
    return { affectedRows: changed };
  };
  return {
    /** @param {RegExp} re @param {number} nth */
    failOn(re, nth) { fail = { re, left: nth }; },
  };
}

const AREAS = [
  { path: 'forge/src', files: 40, churn_90d: 5, authors_90d: 1 },
  { path: 'forge/test', files: 30, churn_90d: 2, authors_90d: 1 },
  { path: 'docs', files: 10, churn_90d: 0 },
];

/** @param {ReturnType<typeof makeDeps>} d @param {string} key */
const areaRows = (d, key) => d.db.raw.prepare('SELECT path, files, run_id FROM areas WHERE project_key = ? ORDER BY path').all(key).map((r) => ({ ...r }));

/** A sample file with three areas and a trust step, so the areas step sits between the cards and the trust. */
function sample() {
  return {
    schema: 'dowser-sample/1',
    source: { repo_url: 'https://github.com/xkazm04/dowser', head_sha: 'abc123', scanned_at: '2026-11-01T10:00:00.000Z', run_id: 'r-areas' },
    lens_kinds_json: JSON.stringify({ opportunity: ['missing-capability'] }),
    proposals: [0, 1, 2].map((i) => record({ topic: `areas topic ${i}`, anchors: [`forge/src/a${i}.mjs#f${i}`], evidence: [{ type: 'code', ref: `forge/src/a${i}.mjs:1`, quote: `export const a${i} = ${i};` }] })),
    areas: AREAS,
    trust_json: JSON.stringify({ slices: [{ slice: 'product|opportunity|low|S', level: 0, ceiling: 1, start: 0, n: 0 }], events: [] }),
  };
}

test('the MySQL-semantics double counts an UPDATE that changes nothing as 0 rows, and one that changes a value as 1', async () => {
  const d = makeDeps();
  mysqlSemantics(d);
  assert.deepEqual(await pushAreas(d, { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify(AREAS) }, ME), { stored: 3 });
  const same = await d.db.exec('UPDATE areas SET files = ? WHERE project_key = ? AND path = ?', [40, PK, 'forge/src']);
  assert.equal(same.affectedRows, 0, 'same value: 0 affected rows, as on Forge SQL');
  const changed = await d.db.exec('UPDATE areas SET files = ? WHERE project_key = ? AND path = ?', [41, PK, 'forge/src']);
  assert.equal(changed.affectedRows, 1);
});

test('an areas push re-run with the same areas and run id succeeds and stores each area once (MySQL affected rows)', async () => {
  const d = makeDeps();
  mysqlSemantics(d);
  const args = { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify(AREAS) };
  assert.deepEqual(await pushAreas(d, args, ME), { stored: 3 });
  const first = areaRows(d, PK);
  assert.deepEqual(await pushAreas(d, args, ME), { stored: 3 }, 'the second identical push must not fail on a duplicate key');
  assert.deepEqual(areaRows(d, PK), first, 'each area stored once, unchanged');
});

test('a sample load is completed on a MySQL-semantics store when nothing was cut short (control)', async () => {
  const d = makeDeps();
  mysqlSemantics(d);
  assert.deepEqual(await loadSample(d, ME, sample()), { project_key: SAMPLE_KEY, created: 3 });
  assert.equal(areaRows(d, SAMPLE_KEY).length, AREAS.length);
});

test('a sample load whose areas step was cut short part-way is completed by the next load (MySQL affected rows)', async () => {
  const d = makeDeps();
  const db = mysqlSemantics(d);
  // An earlier cut call already stored the first area with these very values; this one dies on its first area INSERT,
  // however many rows that statement carries (DW-235 writes new areas in multi-row statements).
  const [a] = AREAS;
  d.db.raw.prepare('INSERT INTO areas (project_key, path, files, churn_90d, authors_90d, run_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(SAMPLE_KEY, a.path, a.files, a.churn_90d, a.authors_90d ?? null, sample().source.run_id);
  db.failOn(/^\s*INSERT INTO areas\b/i, 1);
  await assert.rejects(() => loadSample(d, ME, sample()), /function timed out/);
  assert.equal(areaRows(d, SAMPLE_KEY).length, 1, 'setup: the areas step stopped part-way, one area of three stored');

  const out = await loadSample(d, ME, sample());
  assert.deepEqual(out, { project_key: SAMPLE_KEY, created: 0 }, 'the next load completes: no throw, no more');
  assert.deepEqual(areaRows(d, SAMPLE_KEY).map((r) => r.path), AREAS.map((a) => a.path).sort());
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM trust WHERE project_key = ?').get(SAMPLE_KEY)?.n, 1, 'and the trust step after it ran');
  assert.deepEqual(await loadSample(d, ME, sample()), { project_key: SAMPLE_KEY, created: 0, already: true });
});
