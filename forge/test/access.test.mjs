// @ts-check
// Inbox access (core/access.mjs) through the dispatch door: an inbox follows its Jira project's Browse
// permission, its creator until a project is set, and Jira admins always; Jira writes need the caller's own
// permission; each Custom UI module calls only its own keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { answer, isConsent, resolverAllowed, runResolver, runRovo, runTool } from '../src/core/app.mjs';

const OTHER = '557058:other-person';
const PK = 'github-com-Acme-Shop';

/** @param {ReturnType<typeof makeDeps>} d @param {string} key @param {object} payload @param {string} [who] */
const res = async (d, key, payload, who = ME) => /** @type {any} */ (await runResolver(d, key, payload, who, 'inbox'));
/** @param {ReturnType<typeof makeDeps>} d @param {string} name @param {object} args @param {string} [who] */
const tool = async (d, name, args, who = ME) => /** @type {any} */ (await runTool(d, name, args, who));

/** An inbox with two open items, pushed by ME; with `jira`, bound to that Jira project. */
async function seeded(jira = 'SHOP') {
  const d = makeDeps();
  const out = await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'csv export' }), record({ topic: 'pdf export', anchors: ['src/pdf.js#make'] })]));
  assert.equal(out.results.filter((/** @type {any} */ r) => r.result === 'created').length, 2);
  if (jira) assert.equal((await res(d, 'settings.set', { project_key: PK, jira_project_key: jira, issue_type_id: '10001' })).inbox.jira_project_key, jira);
  return d;
}

test('an inbox bound to a Jira project is open to whoever may browse it, and closed to everyone else', async () => {
  const d = await seeded();
  assert.equal((await res(d, 'inbox.list', {}, OTHER)).groups[0].items.length, 2, 'browse permission opens it');

  d.perms.deny.add('BROWSE_PROJECTS:SHOP').add('ADMINISTER');
  const list = await res(d, 'inbox.list', {}, OTHER);
  assert.deepEqual([list.inboxes, list.groups], [[], []], 'the list hides it, summaries included');
  assert.equal((await res(d, 'inbox.list', { project_key: PK }, OTHER)).error, 'forbidden');
  assert.equal((await res(d, 'settings.get', {}, OTHER)).inboxes.length, 0);
  assert.equal((await res(d, 'proposal.get', { ref: 'DW-1' }, OTHER)).error, 'forbidden');
  assert.equal((await res(d, 'map.data', { project_key: PK }, OTHER)).error, 'forbidden');
  assert.equal((await res(d, 'reflect.data', { project_key: PK }, OTHER)).error, 'forbidden');
  assert.equal((await res(d, 'direction.set', { project_key: PK, lens: 'opportunity', focus: ['x'] }, OTHER)).error, 'forbidden');
  const rej = await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'not-worth-it' }, OTHER);
  assert.equal(rej.error, 'forbidden');
  assert.match(rej.message, /Jira project SHOP/, 'the answer says what would open it');
  assert.doesNotMatch(rej.message, /csv/, 'and nothing of the item');
  d.perms.deny.clear(); // the fake answers for everyone: look as someone who may
  assert.equal((await res(d, 'proposal.get', { ref: 'DW-1' })).card.status, 'open', 'nothing was decided');
  d.perms.deny.add('BROWSE_PROJECTS:SHOP').add('ADMINISTER');

  // MCP and Rovo follow the same rule.
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK }, OTHER)).error, 'forbidden');
  assert.equal((await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'fake' })]), OTHER)).error, 'forbidden');
  assert.equal((await tool(d, 'dowser_direction_get', { project_key: PK, lens: 'all' }, OTHER)).error, 'forbidden');
  assert.equal(/** @type {any} */ ((await runRovo(d, 'dowser_inbox_list', {}, OTHER))).items.length, 0);
  assert.equal(/** @type {any} */ ((await runRovo(d, 'dowser_proposal_explain', { ref: 'DW-2' }, OTHER))).error, 'forbidden');
  assert.equal(/** @type {any} */ ((await runRovo(d, 'dowser_verdict_record', { ref: 'DW-2', status: 'snoozed' }, OTHER))).error, 'forbidden');
});

test('without a Jira project an inbox is open to its creator and Jira admins only; a pre-v018 inbox to admins only', async () => {
  const d = await seeded('');
  d.perms.deny.add('ADMINISTER');
  assert.equal((await res(d, 'inbox.list', {})).groups[0].items.length, 2, 'the creator (first pusher) sees it');
  assert.equal((await res(d, 'inbox.list', { project_key: PK }, OTHER)).error, 'forbidden');
  assert.match((await res(d, 'proposal.get', { ref: 'DW-1' }, OTHER)).message, /only the person who first pushed/);
  d.perms.deny.delete('ADMINISTER');
  assert.equal((await res(d, 'inbox.list', { project_key: PK }, OTHER)).groups[0].items.length, 2, 'a Jira admin sees it');

  d.db.raw.exec('UPDATE inboxes SET created_by = NULL');
  d.perms.deny.add('ADMINISTER');
  assert.equal((await res(d, 'inbox.list', { project_key: PK })).error, 'forbidden', 'no creator on file: admins only');
});

test('a push to a new project key creates its inbox for the caller; one to a key someone else owns is refused', async () => {
  const d = makeDeps();
  d.perms.deny.add('ADMINISTER');
  assert.equal((await tool(d, 'dowser_proposals_push', pushArgs([record()], { project_key: 'github-com-Other-Repo' }), OTHER)).results[0].result, 'created');
  assert.equal((await tool(d, 'dowser_areas_push', { project_key: 'github-com-Other-Repo', run_id: 'r-1', areas_json: '[]' }, OTHER)).stored, 0);
  assert.equal((await tool(d, 'dowser_areas_push', { project_key: 'github-com-Other-Repo', run_id: 'r-1', areas_json: '[]' }, ME)).error, 'forbidden');
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: 'github-com-Other-Repo' }, ME)).error, 'forbidden');
  assert.deepEqual((await tool(d, 'dowser_verdicts_pull', { project_key: 'github-com-Other-Repo' }, OTHER)).verdicts, []);
});

test('accept and merge make the app write to Jira only where the caller may write themselves', async () => {
  const d = await seeded();
  d.perms.deny.add('CREATE_ISSUES:BILL');
  const acc = await res(d, 'verdict.accept', { ref: 'DW-1', jira_project_key: 'BILL', issue_type_id: '10001' });
  assert.equal(acc.error, 'forbidden');
  assert.equal(d.jira.created.length, 0, 'no issue was created in a project the caller cannot create in');
  assert.equal((await res(d, 'verdict.accept', { ref: 'DW-1' })).card.status, 'accepted', 'the inbox target still works');

  d.perms.deny.add('ADD_COMMENTS:BILL-7');
  assert.equal((await res(d, 'verdict.merge', { ref: 'DW-2', into: 'BILL-7' })).error, 'forbidden');
  assert.equal(d.jira.comments.length, 0, 'no comment on an issue the caller cannot comment on');
  assert.equal(/** @type {any} */ ((await runRovo(d, 'dowser_verdict_record', { ref: 'DW-2', status: 'merged', merged_into: 'BILL-7' }, ME))).error, 'forbidden');

  d.perms.deny.add('CREATE_ISSUES:SHOP');
  assert.equal(/** @type {any} */ ((await runRovo(d, 'dowser_verdict_record', { ref: 'DW-2', status: 'accepted' }, ME))).error, 'forbidden', 'Rovo accept checks the inbox target');
});

test('a merge stays inside its inbox, and a settings change cannot move an inbox into a project the caller cannot use', async () => {
  const d = await seeded();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'other' })], { project_key: 'github-com-Acme-Other' }));
  const into = await res(d, 'verdict.merge', { ref: 'DW-1', into: 'DW-3' });
  assert.equal(into.error, 'bad-input');
  assert.match(into.message, /another inbox/);

  d.perms.deny.add('BROWSE_PROJECTS:SECRET');
  const set = await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SECRET', issue_type_id: '10001' });
  assert.equal(set.error, 'forbidden');
  d.perms.deny.add('CREATE_ISSUES:RO');
  assert.equal((await res(d, 'settings.set', { project_key: PK, jira_project_key: 'RO', issue_type_id: '10001' })).error, 'forbidden');
  assert.equal((await res(d, 'settings.get', {})).inboxes.find((/** @type {any} */ i) => i.project_key === PK).jira_project_key, 'SHOP', 'unchanged');
});

test('the panel and the byline show an item only to someone who may open its inbox', async () => {
  const d = await seeded();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'doc page', doc_impact: ['12345'] })]));
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  const issue = (await res(d, 'proposal.get', { ref: 'DW-1' })).card.issue_ref;
  assert.equal((await res(d, 'panel.forIssue', { issue_key: issue })).card.ref, 'DW-1');
  assert.equal((await res(d, 'byline.forPage', { page_id: '12345' })).count, 1);

  d.perms.deny.add('BROWSE_PROJECTS:SHOP').add('ADMINISTER');
  assert.deepEqual(await res(d, 'panel.forIssue', { issue_key: issue }, OTHER), { history: [] });
  assert.deepEqual(await res(d, 'byline.forPage', { page_id: '12345' }, OTHER), { count: 0, cards: [] });
});

test('permission answers are asked as the user once per call, and a Jira failure is never read as a grant', async () => {
  const d = await seeded();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'two' })], { project_key: 'github-com-Acme-Two' }));
  await res(d, 'settings.set', { project_key: 'github-com-Acme-Two', jira_project_key: 'SHOP', issue_type_id: '10001' });
  d.perms.calls.length = 0;
  await res(d, 'inbox.list', {});
  assert.equal(d.perms.calls.length, 1, 'two inboxes on one project: one lookup');

  d.perms.fail = true;
  const out = await res(d, 'inbox.list', { project_key: PK });
  assert.equal(out.error, 'unavailable');
  assert.equal(out.groups, undefined);
});

test('each Custom UI module may call only its own keys; a missing user grant escapes answer() for the consent screen', async () => {
  assert.equal(resolverAllowed('dowser-evidence', 'panel.forIssue'), true);
  assert.equal(resolverAllowed('dowser-evidence', 'verdict.accept'), false);
  assert.equal(resolverAllowed('dowser-doc-impact', 'byline.forPage'), true);
  assert.equal(resolverAllowed('dowser-doc-impact', 'inbox.list'), false);
  assert.equal(resolverAllowed('dowser-inbox', 'verdict.accept'), true);
  assert.equal(resolverAllowed('dowser-inbox', 'byline.forPage'), false);
  assert.equal(resolverAllowed(undefined, 'inbox.list'), false);
  assert.equal(resolverAllowed('dowser-other', 'inbox.list'), false);

  const consent = Object.assign(new Error('needs auth'), { name: 'NEEDS_AUTHENTICATION_ERR' });
  assert.equal(isConsent(consent), true);
  await assert.rejects(answer(async () => { throw consent; }), consent);
});
