// @ts-check
// Lens direction: direction.get / direction.set (Settings), dowser_direction_get (tool 8), the caps and errors,
// the shape routing, and the directions table migrating itself on first use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { actionName, isNoTable, runResolver, runTool } from '../src/core/app.mjs';
import { MIGRATIONS } from '../src/sql/migrations.mjs';

const PK = 'github-com-Acme-Shop';

/** @param {any} deps @param {string} key @param {object} p @param {string} [who] */
const res = (deps, key, p, who = ME) => /** @type {Promise<any>} */ (runResolver(deps, key, p, who, 'inbox'));
/** @param {any} deps @param {object} args */
const tool = (deps, args) => /** @type {Promise<any>} */ (runTool(deps, 'dowser_direction_get', args, ME));

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  return d;
}

test('direction: get/set round trip, normalised; a second set overwrites; a clear deletes the row', async () => {
  const d = await seeded();
  assert.deepEqual(await res(d, 'direction.get', { project_key: PK }), { lenses: {} });

  const set = await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: [' checkout ', '', 'checkout', 'exports'], exclude: ['admin pages'], notes: '  Q4 is about retention.  ' });
  assert.deepEqual(set, { lens: 'opportunity', direction: { focus: ['checkout', 'exports'], exclude: ['admin pages'], notes: 'Q4 is about retention.' } });
  await res(d, 'direction.set', { project_key: PK, lens: 'doc-drift', spaces: ['DOCS', 'ENG'], focus: 'setup guide\ninstall' });
  assert.deepEqual(await res(d, 'direction.get', { project_key: PK }), {
    lenses: {
      opportunity: { focus: ['checkout', 'exports'], exclude: ['admin pages'], notes: 'Q4 is about retention.' },
      'doc-drift': { focus: ['setup guide', 'install'], spaces: ['DOCS', 'ENG'] },
    },
  });

  // a second set replaces the lens whole (exclude and notes are gone)
  d.clock.tick();
  const again = await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: ['pricing'] });
  assert.deepEqual(again, { lens: 'opportunity', direction: { focus: ['pricing'] } });
  // the same value again still lands (MySQL reports 0 changed rows; the insert falls back to the update)
  assert.deepEqual(await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: ['pricing'] }), again);
  const row = /** @type {any} */ (d.db.raw.prepare("SELECT * FROM directions WHERE lens = 'opportunity'").get());
  assert.equal(row.updated_by, `forge:${ME}`);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM directions').get()?.n, 2);

  // a clear: everything absent or empty deletes the row, and the answer has no direction
  assert.deepEqual(await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: [], exclude: [' '], notes: '' }), { lens: 'opportunity' });
  assert.equal(d.db.raw.prepare("SELECT COUNT(*) AS n FROM directions WHERE lens = 'opportunity'").get()?.n, 0);
  assert.deepEqual((await res(d, 'direction.get', { project_key: PK })).lenses, { 'doc-drift': { focus: ['setup guide', 'install'], spaces: ['DOCS', 'ENG'] } });
  // clearing a lens that has nothing is fine too
  assert.deepEqual(await res(d, 'direction.set', { project_key: PK, lens: 'security-cra' }), { lens: 'security-cra' });
});

test('direction: caps and errors, and a refused set stores nothing', async () => {
  const d = await seeded();
  assert.equal((await res(d, 'direction.get', { project_key: 'nope' })).error, 'unknown-project');
  assert.equal((await res(d, 'direction.set', { project_key: 'nope', lens: 'opportunity', focus: ['x'] })).error, 'unknown-project');
  assert.equal((await res(d, 'direction.get', {})).error, 'bad-input');
  const long = 'x'.repeat(121);
  for (const bad of [
    { lens: 'nope', focus: ['x'] },
    { focus: ['x'] },
    { lens: 'opportunity', focus: Array.from({ length: 11 }, (_, i) => `f${i}`) },
    { lens: 'opportunity', exclude: [long] },
    { lens: 'opportunity', focus: [1] },
    { lens: 'opportunity', focus: { a: 1 } },
    { lens: 'opportunity', notes: 'n'.repeat(2001) },
    { lens: 'opportunity', spaces: ['DOCS'] },
    { lens: 'doc-drift', spaces: ['not a key'] },
    { lens: 'doc-drift', spaces: Array.from({ length: 11 }, (_, i) => `S${i}`) },
  ]) {
    const out = await res(d, 'direction.set', { project_key: PK, ...bad });
    assert.equal(out.error, 'bad-input', JSON.stringify(bad).slice(0, 80));
  }
  // exactly at the caps is accepted
  const ok = await res(d, 'direction.set', { project_key: PK, lens: 'doc-drift', focus: Array.from({ length: 10 }, (_, i) => `f${i}`), exclude: ['x'.repeat(120)], notes: 'n'.repeat(2000), spaces: ['A_b-1', '~pat'] });
  assert.equal(ok.direction.focus.length, 10);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM directions').get()?.n, 1, 'only the valid set stored');
});

test('dowser_direction_get returns what Settings saved; lens narrows it; routed by shape', async () => {
  const d = await seeded();
  assert.equal((await tool(d, { project_key: 'nope', lens: 'all' })).error, 'unknown-project');
  await res(d, 'direction.set', { project_key: PK, lens: 'ux-friction', focus: ['onboarding'], notes: 'Mobile first.' });
  await res(d, 'direction.set', { project_key: PK, lens: 'doc-drift', spaces: ['DOCS'] });
  const saved = await res(d, 'direction.get', { project_key: PK });
  assert.deepEqual(await tool(d, { project_key: PK, lens: 'all' }), saved);
  assert.deepEqual(await tool(d, { project_key: PK }), saved);
  assert.deepEqual(await tool(d, { project_key: PK, lens: 'doc-drift' }), { lenses: { 'doc-drift': { spaces: ['DOCS'] } } });
  assert.deepEqual(await tool(d, { project_key: PK, lens: 'opportunity' }), { lenses: {} });
  assert.equal((await tool(d, { project_key: PK, lens: 'nope' })).error, 'bad-input');

  // a transport without a tool name: `lens` routes here, a bare project_key stays a pull
  assert.equal(actionName('mcp', [undefined], { project_key: PK, lens: 'all' }), 'dowser_direction_get');
  assert.equal(actionName('mcp', [undefined], { project_key: PK }), 'dowser_verdicts_pull');
  assert.equal(actionName('mcp', ['dowser_direction_get'], { project_key: PK }), 'dowser_direction_get');
});

test('directions table: a missing table is reported as such, and the migration makes the next call work', async () => {
  const d = await seeded();
  d.db.raw.exec('DROP TABLE directions');
  await assert.rejects(() => res(d, 'direction.get', { project_key: PK }), (e) => isNoTable(e), 'escapes answer() so index.js migrates and retries');
  await assert.rejects(() => res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: ['x'] }), (e) => isNoTable(e));
  const m = MIGRATIONS.find((x) => x.name === 'v015_directions');
  assert.ok(m);
  d.db.raw.exec(m.statement);
  assert.deepEqual((await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: ['x'] })).direction, { focus: ['x'] });
  assert.deepEqual(await res(d, 'direction.get', { project_key: PK }), { lenses: { opportunity: { focus: ['x'] } } });
});
