// @ts-check
// DW-233: a push checks inbox access on the key it writes to. The access check looked the key up as sent while the
// handlers trim it (needStr), so a padded key skipped the check as a first push and wrote into the closed inbox.
// A push to a closed inbox is refused for every spelling of its key, and changes no row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

const OTHER = '557058:other-person';
const PK = 'github-com-Acme-Shop';
const SPELLINGS = /** @type {const} */ ([['a leading space', ` ${PK}`], ['a trailing space', `${PK} `]]);
const AREAS = [{ path: 'src', files: 10, churn_90d: 4, authors_90d: 2 }, { path: 'docs', files: 3, churn_90d: 0 }];

/** @param {ReturnType<typeof makeDeps>} d @param {string} name @param {object} args @param {string} who */
const tool = async (d, name, args, who) => /** @type {any} */ (await runTool(d, name, args, who));

/** The intruder's copy of the seeded card: same fp, another title. */
const intruderCard = () => ({ ...record(), title: 'Title of the intruder' });
/** @param {string} key */
const intruderPush = (key) => pushArgs([intruderCard()], { project_key: key, run_id: 'r-intruder', repo_url: 'https://github.com/intruder/fork' });
/** @param {string} key */
const intruderAreas = (key) => ({ project_key: key, run_id: 'r-intruder', areas_json: '[]' });

/** Every row of every table, so "no row changed" covers what the push might touch; tool_calls only counts calls per tool name, a refused one too. @param {ReturnType<typeof makeDeps>} d */
function everyRow(d) {
  const tables = d.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'tool_calls' ORDER BY name").all();
  return /** @type {Record<string, any[]>} */ (Object.fromEntries(tables.map((t) => [t.name, d.db.raw.prepare(`SELECT * FROM "${t.name}"`).all().map((r) => ({ ...r }))])));
}

/** An inbox with one card and two areas, pushed by ME; with `jira`, bound to that Jira project. */
async function seeded(jira = 'SHOP') {
  const d = makeDeps();
  assert.equal((await tool(d, 'dowser_proposals_push', pushArgs([record()]), ME)).results[0].result, 'created');
  assert.equal((await tool(d, 'dowser_areas_push', { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify(AREAS) }, ME)).stored, 2);
  if (jira) {
    const set = /** @type {any} */ (await runResolver(d, 'settings.set', { project_key: PK, jira_project_key: jira, issue_type_id: '10001' }, ME, 'inbox'));
    assert.equal(set.inbox.jira_project_key, jira);
  }
  return d;
}

/** The seeded inbox, as an account denied every inbox. */
async function closed() {
  const d = await seeded();
  d.perms.deny.add('BROWSE_PROJECTS').add('ADMINISTER');
  return d;
}

test('control: a denied account with the plain key answers forbidden on both pushes and changes no row', async () => {
  const d = await closed();
  const before = everyRow(d);
  assert.equal((await tool(d, 'dowser_proposals_push', intruderPush(PK), OTHER)).error, 'forbidden');
  assert.equal((await tool(d, 'dowser_areas_push', intruderAreas(PK), OTHER)).error, 'forbidden');
  assert.deepEqual(everyRow(d), before);
});

for (const [name, key] of SPELLINGS) {
  test(`dowser_proposals_push with ${name}: a denied account answers forbidden and changes no row`, async () => {
    const d = await closed();
    const before = everyRow(d);
    const out = await tool(d, 'dowser_proposals_push', intruderPush(key), OTHER);
    assert.equal(out.error, 'forbidden', `answered ${JSON.stringify(out)}`);
    assert.deepEqual(everyRow(d), before);
  });

  test(`dowser_areas_push with ${name}: a denied account answers forbidden and changes no row`, async () => {
    const d = await closed();
    const before = everyRow(d);
    const out = await tool(d, 'dowser_areas_push', intruderAreas(key), OTHER);
    assert.equal(out.error, 'forbidden', `answered ${JSON.stringify(out)}`);
    assert.deepEqual(everyRow(d), before);
  });

  test(`with ${name}, an inbox with no Jira project stays closed to anyone but its creator`, async () => {
    const d = await seeded('');
    d.perms.deny.add('ADMINISTER');
    const before = everyRow(d);
    const push = await tool(d, 'dowser_proposals_push', intruderPush(key), OTHER);
    assert.equal(push.error, 'forbidden', `answered ${JSON.stringify(push)}`);
    const areas = await tool(d, 'dowser_areas_push', intruderAreas(key), OTHER);
    assert.equal(areas.error, 'forbidden', `answered ${JSON.stringify(areas)}`);
    assert.deepEqual(everyRow(d), before);
  });

  test(`control: an allowed account with ${name} still files into the real inbox`, async () => {
    const d = await seeded();
    const push = await tool(d, 'dowser_proposals_push', pushArgs([{ ...record(), title: 'A better title' }], { project_key: key, run_id: 'r-2' }), ME);
    assert.equal(push.results[0].result, 'updated');
    assert.equal(push.results[0].external_ref, 'DW-1');
    const areas = await tool(d, 'dowser_areas_push', { project_key: key, run_id: 'r-2', areas_json: JSON.stringify(AREAS.slice(0, 1)) }, ME);
    assert.equal(areas.stored, 1);
    const rows = everyRow(d);
    assert.deepEqual(rows.inboxes.map((r) => r.project_key), [PK], 'no second inbox under the padded key');
    assert.deepEqual(rows.areas.map((r) => [r.project_key, r.path]), [[PK, 'src']]);
    assert.deepEqual(rows.proposals.map((r) => r.project_key), [PK]);
  });

  test(`control: a first push with ${name} creates the inbox under the trimmed key`, async () => {
    const d = makeDeps();
    d.perms.deny.add('ADMINISTER');
    assert.equal((await tool(d, 'dowser_proposals_push', pushArgs([record()], { project_key: key }), OTHER)).results[0].result, 'created');
    assert.deepEqual(everyRow(d).inboxes.map((r) => r.project_key), [PK]);
  });
}
