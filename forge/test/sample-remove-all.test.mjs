// @ts-check
// DW-81: sample.remove "deletes every row of the sample in every table" (docs/forge-app.md "Sample inbox"). Every
// table with a project_key column (discovered from the migrated schema, so a later table is covered too) holds no
// sample row after the remove, deliveries, work_reports and page_links included; other inboxes' rows survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { SAMPLE_KEY, loadSample, removeSample } from '../src/core/sample.mjs';
import { reflectSync } from '../src/core/reflect.mjs';

const PK = 'github-com-Acme-Shop';

/** @param {ReturnType<typeof makeDeps>} d @param {string} key @param {object} [payload] */
const res = async (d, key, payload = {}) => /** @type {any} */ (await runResolver(d, key, payload, ME, 'inbox'));

/** The tables of the migrated schema that have a project_key column. @param {ReturnType<typeof makeDeps>} d */
const keyedTables = (d) => d.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  .map((r) => String(r.name))
  .filter((t) => d.db.raw.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'project_key'));

/** Rows per keyed table: of `key`, or (`not`) of every other inbox. @param {ReturnType<typeof makeDeps>} d @param {string} key @param {boolean} [not] */
const rowsOf = (d, key, not = false) => Object.fromEntries(keyedTables(d).map((t) => [t,
  Number(/** @type {any} */ (d.db.raw.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE project_key ${not ? '<>' : '='} ?`).get(key)).n)]));

/** A sample with a trust step, so every keyed table the sample can reach gets a row. */
function sample() {
  return {
    schema: 'dowser-sample/1',
    source: { repo_url: 'https://github.com/xkazm04/dowser', head_sha: 'abc123', scanned_at: '2026-11-01T10:00:00.000Z', run_id: 'r-rm' },
    lens_kinds_json: JSON.stringify({ opportunity: ['missing-capability'] }),
    proposals: [0, 1].map((i) => record({ topic: `remove topic ${i}`, anchors: [`forge/src/r${i}.mjs#f${i}`], evidence: [{ type: 'code', ref: `forge/src/r${i}.mjs:1`, quote: `export const r${i} = ${i};` }] })),
    areas: [{ path: 'forge/src', files: 2, churn_90d: 1, authors_90d: 1 }],
    trust_json: JSON.stringify({ slices: [{ slice: 'product|opportunity|low|S', level: 0, ceiling: 1, start: 0, n: 0 }], events: [] }),
  };
}

/** A delivery, a work report and a page link for proposal `id` of inbox `key`. @param {ReturnType<typeof makeDeps>} d @param {string} key @param {number} id @param {number} n */
function writeDownstream(d, key, id, n) {
  d.db.raw.prepare("INSERT INTO deliveries (proposal_id, project_key, jira_state, jira_status, jira_at) VALUES (?, ?, 'done', 'Done', '2026-11-02T10:00:00.000Z')").run(id, key);
  d.db.raw.prepare("INSERT INTO work_reports (id, proposal_id, project_key, status, by_who, at) VALUES (?, ?, ?, 'started', 'forge:me', '2026-11-02T10:00:00.000Z')").run(n, id, key);
  d.db.raw.prepare('INSERT INTO page_links (page_id, proposal_id, project_key) VALUES (?, ?, ?)').run(`9${n}`, id, key);
}

test('sample.remove leaves no sample row in deliveries, work_reports, page_links or any other project_key table; other inboxes keep theirs', async () => {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  assert.deepEqual(await loadSample(d, ME, sample()), { project_key: SAMPLE_KEY, created: 2 });
  const items = (await res(d, 'inbox.list', { project_key: SAMPLE_KEY })).groups.flatMap((/** @type {any} */ g) => g.items);
  const ids = items.map((/** @type {any} */ c) => Number(c.ref.slice(3)));
  // decisions, an outcome, a direction and a rule: the rows the app's own paths write for the sample
  await res(d, 'verdict.accept', { ref: items[0].ref, jira_project_key: 'SHOP', issue_type_id: '10001' });
  await res(d, 'verdict.reject', { refs: [items[1].ref], reason: 'not-worth-it', note: 'demo' });
  await res(d, 'outcome.record', { ref: items[0].ref, rating: 'right' });
  await res(d, 'direction.set', { project_key: SAMPLE_KEY, lens: 'opportunity', focus: ['exports'] });
  await reflectSync(d, { project_key: SAMPLE_KEY, rules_json: JSON.stringify([{ id: 'rule-1', lens: 'opportunity', text: 'skip demos', offered_at: '2026-10-27T10:00:00.000Z' }]) }, { sample: true });
  // the delivery truth, the agent work queue and the page links, for the sample and for the scan inbox
  const scanId = Number(/** @type {any} */ (d.db.raw.prepare('SELECT id FROM proposals WHERE project_key = ?').get(PK)).id);
  writeDownstream(d, SAMPLE_KEY, ids[0], 1);
  writeDownstream(d, PK, scanId, 2);

  const tables = keyedTables(d);
  for (const t of ['deliveries', 'work_reports', 'page_links']) assert.ok(tables.includes(t), `${t} has a project_key column`);
  const loaded = rowsOf(d, SAMPLE_KEY);
  assert.deepEqual(Object.entries(loaded).filter(([, n]) => n === 0).map(([t]) => t), [],
    `setup: every project_key table holds a sample row before the remove (a new table needs a row here): ${JSON.stringify(loaded)}`);
  const others = rowsOf(d, SAMPLE_KEY, true);

  assert.deepEqual(await removeSample(d, ME), { removed: true, issues_kept: 1 });
  const left = rowsOf(d, SAMPLE_KEY);
  assert.deepEqual(Object.entries(left).filter(([, n]) => n !== 0), [], `no sample row is left in any project_key table: ${JSON.stringify(left)}`);
  assert.deepEqual(rowsOf(d, SAMPLE_KEY, true), others, 'every other inbox keeps all its rows');
  for (const t of ['deliveries', 'work_reports', 'page_links']) assert.equal(others[t], 1, `the scan inbox's ${t} row survives`);
});
