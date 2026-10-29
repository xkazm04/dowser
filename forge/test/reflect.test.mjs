// @ts-check
// Reflection: dowser_reflect_sync (tool 7), the Learning tab resolvers, notes on accept/snooze, the Users and
// Jira-status ports, the dispatch log, and the decided_by coverage on the Rovo and merge paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { actionName, runResolver, runRovo, runTool } from '../src/core/app.mjs';

const PK = 'github-com-Acme-Shop';
const OTHER = '712020:other-person';

/** @param {any} deps @param {string} name @param {object} args @param {string} [who] */
const tool = (deps, name, args, who = ME) => /** @type {Promise<any>} */ (runTool(deps, name, args, who));
/** @param {any} deps @param {string} key @param {object} p @param {string} [who] */
const res = (deps, key, p, who = ME) => /** @type {Promise<any>} */ (runResolver(deps, key, p, who, 'inbox'));
/** @param {any[]} rules */
const sync = (rules, project_key = PK) => ({ project_key, rules_json: JSON.stringify(rules) });
const AT = '2026-10-27T09:00:00.000Z';
/** @param {string} id @param {object} [o] */
const offer = (id, o = {}) => ({ id, lens: 'opportunity', text: `Do not propose ${id}`, titles: ['Add csv export'], offered_at: AT, ...o });

/** A deps with an inbox for PK, two items pushed in r-1 and the accept target set. */
async function seeded() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'alpha' }), record({ topic: 'beta' }), record({ topic: 'gamma', lens: 'doc-drift', kind: 'stale-doc', anchors: ['docs/a.md'] })], { run_id: 'r-1' }));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('reflect sync: unknown project, input checks, and an empty read before any rule', async () => {
  const d = makeDeps();
  assert.equal((await tool(d, 'dowser_reflect_sync', sync([]))).error, 'unknown-project');
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  assert.deepEqual(await tool(d, 'dowser_reflect_sync', { project_key: PK }), { rules: [], outcomes: [] });
  assert.deepEqual(await tool(d, 'dowser_reflect_sync', sync([])), { rules: [], outcomes: [] });
  for (const bad of [
    [offer('r1', { lens: 'nope' })], [offer('bad id')], [offer('r1', { text: '' })], [offer('r1', { offered_at: 'yesterday' })],
    [offer('r1', { titles: Array(11).fill('t') })], ['x'], Array.from({ length: 51 }, (_, i) => offer(`r${i}`)),
  ]) {
    const out = await tool(d, 'dowser_reflect_sync', sync(bad));
    assert.equal(out.error, 'bad-input', JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await tool(d, 'dowser_reflect_sync', { project_key: PK, rules_json: '{' })).error, 'bad-input');
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM rules').get()?.n, 0, 'a refused call stores nothing');
});

test('reflect sync is idempotent, refreshes an offered rule and never reverts a decided one', async () => {
  const d = await seeded();
  const a = await tool(d, 'dowser_reflect_sync', sync([offer('rule-a'), offer('rule-b')]));
  assert.deepEqual(a, { rules: [], outcomes: [] }, 'offered rules are not echoed back');
  await tool(d, 'dowser_reflect_sync', sync([offer('rule-a'), offer('rule-b')]));
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM rules').get()?.n, 2);

  // an offered rule's text and titles refresh
  await tool(d, 'dowser_reflect_sync', sync([offer('rule-a', { text: 'Reworded', titles: ['x', 'y'] })]));
  const row = /** @type {any} */ (d.db.raw.prepare("SELECT * FROM rules WHERE id = 'rule-a'").get());
  assert.equal(row.text, 'Reworded');
  assert.deepEqual(JSON.parse(row.titles_json), ['x', 'y']);

  // a person decides in Forge; later pushes never revert it nor rewrite its (edited) text
  d.clock.tick();
  const dec = await res(d, 'rule.decide', { project_key: PK, id: 'rule-a', state: 'accepted', text: 'Edited by a person' });
  assert.equal(dec.rule.state, 'accepted');
  assert.equal(dec.rule.text, 'Edited by a person');
  assert.equal(dec.rule.decided_by_name, 'Pat Person');
  await res(d, 'rule.decide', { project_key: PK, id: 'rule-b', state: 'declined' });
  const again = await tool(d, 'dowser_reflect_sync', sync([offer('rule-a', { text: 'Skill redraft' }), offer('rule-b', { text: 'Skill redraft' })]));
  assert.deepEqual(again.rules.map((/** @type {any} */ r) => [r.id, r.state, r.text, r.decided_by]), [
    ['rule-a', 'accepted', 'Edited by a person', `forge:${ME}`],
    ['rule-b', 'declined', 'Do not propose rule-b', `forge:${ME}`],
  ]);
  assert.ok(again.rules.every((/** @type {any} */ r) => r.lens === 'opportunity' && r.decided_at.endsWith('Z')));
  assert.deepEqual(await tool(d, 'dowser_reflect_sync', sync([offer('rule-a'), offer('rule-b')])), again, 'idempotent');
});

test('rule.decide is a compare-and-set: a decided rule is refused with its state; text goes only with accept', async () => {
  const d = await seeded();
  await tool(d, 'dowser_reflect_sync', sync([offer('rule-a'), offer('rule-b')]));
  assert.equal((await res(d, 'rule.decide', { project_key: PK, id: 'rule-zzz', state: 'accepted' })).error, 'bad-input');
  assert.equal((await res(d, 'rule.decide', { project_key: PK, id: 'rule-a', state: 'offered' })).error, 'bad-input');
  assert.equal((await res(d, 'rule.decide', { project_key: PK, id: 'rule-a', state: 'declined', text: 'no' })).error, 'bad-input');
  assert.equal((await res(d, 'rule.decide', { project_key: 'nope', id: 'rule-a', state: 'accepted' })).error, 'unknown-project');
  assert.equal((await res(d, 'rule.decide', { project_key: PK, id: 'rule-a', state: 'declined' }, OTHER)).rule.state, 'declined');
  const second = await res(d, 'rule.decide', { project_key: PK, id: 'rule-a', state: 'accepted' });
  assert.equal(second.error, 'bad-input');
  assert.match(second.message, /declined/);
  assert.equal(/** @type {any} */ (d.db.raw.prepare("SELECT decided_by FROM rules WHERE id = 'rule-a'").get()).decided_by, `forge:${OTHER}`);
});

test('outcome.record: accepted items only, once per ref, and the candidates refresh', async () => {
  const d = await seeded();
  assert.equal((await res(d, 'outcome.record', { ref: 'DW-1', rating: 'right' })).error, 'bad-input', 'open item');
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  await res(d, 'verdict.accept', { ref: 'DW-2' });
  await res(d, 'verdict.reject', { refs: ['DW-3'], reason: 'false-positive' });
  assert.equal((await res(d, 'outcome.record', { ref: 'DW-3', rating: 'right' })).error, 'bad-input', 'rejected item');
  assert.equal((await res(d, 'outcome.record', { ref: 'DW-1', rating: 'great' })).error, 'bad-input');
  assert.equal((await res(d, 'outcome.record', { ref: 'DW-99', rating: 'right' })).error, 'bad-input');

  d.clock.tick();
  const out = await res(d, 'outcome.record', { ref: 'DW-1', rating: 'partly', note: 'shipped without the filter' });
  assert.equal(out.outcome.ref, 'DW-1');
  assert.equal(out.outcome.rating, 'partly');
  assert.equal(out.outcome.note, 'shipped without the filter');
  assert.equal(out.outcome.issue_ref, 'SHOP-41');
  assert.equal(out.outcome.decided_by, `forge:${ME}`);
  assert.equal(out.outcome.decided_by_name, 'Pat Person');
  assert.equal(out.outcome.title, 'Add alpha');
  assert.deepEqual(out.candidates.map((/** @type {any} */ c) => c.ref), ['DW-2'], 'DW-1 left the candidates');

  const dup = await res(d, 'outcome.record', { ref: 'DW-1', rating: 'wrong' });
  assert.equal(dup.error, 'bad-input');
  assert.match(dup.message, /partly/);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM outcomes').get()?.n, 1);
  assert.equal((await res(d, 'outcome.record', { ref: 'DW-2', rating: 'right', note: 'x'.repeat(2001) })).error, 'bad-input');

  // the sync answers the outcome (without a title), newest first
  d.clock.tick();
  await res(d, 'outcome.record', { ref: 'DW-2', rating: 'right' });
  const s = await tool(d, 'dowser_reflect_sync', sync([]));
  assert.deepEqual(s.outcomes.map((/** @type {any} */ o) => [o.ref, o.rating, o.issue_ref]), [['DW-2', 'right', 'SHOP-42'], ['DW-1', 'partly', 'SHOP-41']]);
  assert.ok(!('note' in s.outcomes[0]), 'an absent note is omitted');
  assert.ok(!('title' in s.outcomes[0]));
});

test('candidates: done issues first, Jira status named; an unreadable Jira degrades to unknown, never fails', async () => {
  const d = await seeded();
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  d.clock.tick();
  await res(d, 'verdict.accept', { ref: 'DW-2' });
  d.clock.tick();
  await res(d, 'verdict.accept', { ref: 'DW-3' });
  d.jira.setDone('SHOP-41');
  let data = await res(d, 'reflect.data', { project_key: PK });
  assert.deepEqual(data.candidates.map((/** @type {any} */ c) => [c.ref, c.issue_ref, c.issue_status, c.done]), [
    ['DW-1', 'SHOP-41', 'Done', true], ['DW-3', 'SHOP-43', 'To Do', false], ['DW-2', 'SHOP-42', 'To Do', false],
  ]);
  assert.equal(data.candidates[0].issue_url, 'https://acme.atlassian.net/browse/SHOP-41');

  d.jira.failStatus = true;
  data = await res(d, 'reflect.data', { project_key: PK });
  assert.equal(data.error, undefined);
  assert.deepEqual(data.candidates.map((/** @type {any} */ c) => [c.ref, c.issue_status, c.done]), [['DW-3', 'unknown', false], ['DW-2', 'unknown', false], ['DW-1', 'unknown', false]]);
  assert.ok(d.logs.some((l) => l.includes('"warn"')), 'the degrade is logged');
  // an issue Jira does not return is unknown too
  d.jira.failStatus = false;
  delete d.jira.statuses['SHOP-43'];
  data = await res(d, 'reflect.data', { project_key: PK });
  assert.equal(data.candidates.find((/** @type {any} */ c) => c.ref === 'DW-3').issue_status, 'unknown');
});

test('reflect.data derives totals, rejects, notes, pushes, lens yield and rules from the existing tables', async () => {
  const d = await seeded();
  d.clock.tick();
  await res(d, 'verdict.accept', { ref: 'DW-1', note: 'ship it behind a flag' });
  d.clock.tick();
  await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'not-worth-it', note: 'too small' });
  d.clock.tick();
  await res(d, 'verdict.snooze', { refs: ['DW-3'], note: 'after the migration' }, OTHER);
  // a second push: DW-1 updated (grew), a new item DW-4 created
  d.clock.tick();
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...record({ topic: 'alpha' }), status: 'pushed' }, record({ topic: 'delta' })], { run_id: 'r-2' }));
  await tool(d, 'dowser_reflect_sync', sync([offer('rule-a')]));

  const data = await res(d, 'reflect.data', { project_key: PK });
  assert.deepEqual(data.totals, { open: 1, accepted: 1, rejected: 1, snoozed: 1, merged: 0 });
  assert.deepEqual(data.rejects, [{ lens: 'opportunity', reason: 'not-worth-it', count: 1 }]);
  assert.deepEqual(data.notes.map((/** @type {any} */ n) => [n.ref, n.status, n.note, n.decided_by_name]), [
    ['DW-3', 'snoozed', 'after the migration', undefined], // OTHER has no name: the key is omitted
    ['DW-2', 'rejected', 'too small', 'Pat Person'],
    ['DW-1', 'accepted', 'ship it behind a flag', 'Pat Person'],
  ]);
  assert.ok(!('decided_by_name' in data.notes[0]));
  assert.equal(data.notes[0].title, 'Add gamma');

  // pushes: newest first. An item belongs to the push where it first appeared (first_run_id).
  assert.deepEqual(data.pushes.map((/** @type {any} */ p) => [p.run_id, p.created, p.updated, p.dup_rate, p.open, p.accepted, p.rejected, p.snoozed]), [
    ['r-2', 1, 1, 0.5, 1, 0, 0, 0],
    ['r-1', 3, 0, 0, 0, 1, 1, 1],
  ]);
  assert.equal(data.pushes[0].head_sha, 'abc123');

  assert.deepEqual(data.lens_yield, [
    { lens: 'opportunity', proposed: 3, accepted: 1, rejected: 1, snoozed: 0, open: 1 },
    { lens: 'doc-drift', proposed: 1, accepted: 0, rejected: 0, snoozed: 1, open: 0 },
  ]);
  assert.deepEqual(data.rules, [{ id: 'rule-a', lens: 'opportunity', text: 'Do not propose rule-a', titles: ['Add csv export'], state: 'offered', offered_at: AT }]);
  assert.deepEqual(data.outcomes, []);
  assert.equal((await res(d, 'reflect.data', { project_key: 'nope' })).error, 'unknown-project');
  assert.equal((await res(d, 'reflect.data', {})).error, 'bad-input');
});

test('a push with nothing created or updated has no dup_rate; a run pushed in several calls is one row', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([], { run_id: 'r-empty' }));
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' })], { run_id: 'r-big' }));
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'b' })], { run_id: 'r-big' }));
  const data = await res(d, 'reflect.data', { project_key: PK });
  const empty = data.pushes.find((/** @type {any} */ p) => p.run_id === 'r-empty');
  assert.ok(!('dup_rate' in empty));
  assert.equal(empty.created, 0);
  const big = data.pushes.filter((/** @type {any} */ p) => p.run_id === 'r-big');
  assert.equal(big.length, 1);
  assert.deepEqual([big[0].created, big[0].open], [2, 2]);
});

test('time to triage: minutes from the push to its last decision, only once nothing is open; merged-only has none', async () => {
  const MIN = 60_000;
  const d = await seeded(); // r-1 pushed at T with DW-1..3
  const T = Date.parse(d.now().toISOString());
  d.clock.tick(3 * MIN);
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'not-worth-it' }); // T+3m
  d.clock.tick(2 * MIN);
  await res(d, 'verdict.snooze', { refs: ['DW-3'] }); // T+5m
  d.clock.tick(2 * MIN);
  await res(d, 'verdict.accept', { ref: 'DW-2' }); // T+7m
  d.clock.tick(MIN);
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'delta' })], { run_id: 'r-2' })); // DW-4 stays open
  d.clock.tick(MIN);
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'epsilon' })], { run_id: 'r-3' })); // DW-5
  d.clock.tick(MIN);
  await res(d, 'verdict.merge', { ref: 'DW-5', into: 'DW-2' });

  const data = await res(d, 'reflect.data', { project_key: PK });
  const by = Object.fromEntries(data.pushes.map((/** @type {any} */ p) => [p.run_id, p]));
  assert.equal(by['r-1'].triage_minutes, 7);
  assert.equal(by['r-1'].decided_at, new Date(T + 7 * MIN).toISOString());
  assert.equal(by['r-1'].first_decided_at, new Date(T + 3 * MIN).toISOString());
  assert.equal(by['r-1'].deciding_minutes, 4);
  for (const k of ['r-2', 'r-3']) {
    for (const key of ['decided_at', 'triage_minutes', 'first_decided_at', 'deciding_minutes']) assert.ok(!(key in by[k]), `${k} has no ${key}`);
  }
  assert.equal(by['r-2'].open, 1);
});

test('time to triage rounds up and counts from the run\'s earliest push when the run spans several calls', async () => {
  const d = makeDeps();
  const T = Date.parse(d.now().toISOString());
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' })], { run_id: 'r-big' }));
  d.clock.tick(60_000);
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'b' })], { run_id: 'r-big' }));
  d.clock.tick(60_000);
  await res(d, 'verdict.snooze', { refs: ['DW-1'] }); // T+2m
  d.clock.tick(1000);
  await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'not-worth-it' }); // T+2m1s
  const [p] = (await res(d, 'reflect.data', { project_key: PK })).pushes;
  assert.equal(p.decided_at, new Date(T + 121_000).toISOString());
  assert.equal(p.triage_minutes, 3);
  assert.equal(p.first_decided_at, new Date(T + 120_000).toISOString());
  assert.equal(p.deciding_minutes, 1);
});

test('deciding minutes: first decision to last, not the weekend the inbox waited; one decision is 0; open has neither', async () => {
  const MIN = 60_000;
  const DAYS3 = 3 * 24 * 60 * MIN;
  const d = await seeded(); // r-1 pushed at T with DW-1..3
  const T = Date.parse(d.now().toISOString());
  d.clock.tick(DAYS3);
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'not-worth-it' }); // T+3d
  d.clock.tick(4 * MIN);
  await res(d, 'verdict.snooze', { refs: ['DW-3'] }); // T+3d+4m
  d.clock.tick(5 * MIN);
  await res(d, 'verdict.accept', { ref: 'DW-2' }); // T+3d+9m
  d.clock.tick(MIN);
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'delta' })], { run_id: 'r-2' })); // DW-4, decided once
  d.clock.tick(2 * MIN);
  await res(d, 'verdict.snooze', { refs: ['DW-4'] });
  d.clock.tick(MIN);
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'epsilon' })], { run_id: 'r-3' })); // DW-5 stays open

  const data = await res(d, 'reflect.data', { project_key: PK });
  const by = Object.fromEntries(data.pushes.map((/** @type {any} */ p) => [p.run_id, p]));
  assert.equal(by['r-1'].deciding_minutes, 9);
  assert.equal(by['r-1'].triage_minutes, (DAYS3 + 9 * MIN) / MIN);
  assert.equal(by['r-1'].first_decided_at, new Date(T + DAYS3).toISOString());
  assert.equal(by['r-1'].decided_at, new Date(T + DAYS3 + 9 * MIN).toISOString());
  assert.equal(by['r-2'].deciding_minutes, 0);
  assert.equal(by['r-2'].triage_minutes, 2);
  assert.equal(by['r-2'].first_decided_at, by['r-2'].decided_at);
  for (const key of ['decided_at', 'triage_minutes', 'first_decided_at', 'deciding_minutes']) assert.ok(!(key in by['r-3']), `r-3 has no ${key}`);
});

test('names: a failing or missing Users port only drops the names', async () => {
  const d = await seeded();
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'other', note: 'because' });
  d.users.fail = true;
  const data = await res(d, 'reflect.data', { project_key: PK });
  assert.equal(data.error, undefined);
  assert.ok(!('decided_by_name' in data.notes[0]));
  const { history } = await res(d, 'proposal.get', { ref: 'DW-1' });
  assert.ok(!('decided_by_name' in history[0]));
  d.users.fail = false;
  delete (/** @type {any} */ (d)).users;
  assert.equal((await res(d, 'proposal.get', { ref: 'DW-1' })).history[0].decided_by, `forge:${ME}`);
});

test('decided_by_name rides proposal.get and panel.forIssue history, not the verdict the skill pulls', async () => {
  const d = await seeded();
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  const got = await res(d, 'proposal.get', { ref: 'DW-1' });
  assert.equal(got.history[0].decided_by, `forge:${ME}`);
  assert.equal(got.history[0].decided_by_name, 'Pat Person');
  const panel = await res(d, 'panel.forIssue', { issue_key: 'SHOP-41' });
  assert.equal(panel.history[0].decided_by_name, 'Pat Person');
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.ok(!('decided_by_name' in pull.verdicts[0]));
  assert.deepEqual(d.users.calls.at(0), [ME]);
});

test('notes on accept and snooze ride the verdict to the skill; the cap holds on every decision', async () => {
  const d = await seeded();
  await res(d, 'verdict.accept', { ref: 'DW-1', note: '  smallest first  ' });
  await res(d, 'verdict.snooze', { refs: ['DW-2'], note: 'later' });
  await res(d, 'verdict.snooze', { refs: ['DW-3'] });
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => [v.status, v.note]), [['accepted', 'smallest first'], ['snoozed', 'later'], ['snoozed', undefined]]);
  assert.ok(!('note' in pull.verdicts[2]));

  const long = 'x'.repeat(2001);
  const e = await seeded2();
  assert.equal((await res(e, 'verdict.accept', { ref: 'DW-1', note: long })).error, 'bad-input');
  assert.equal(e.jira.created.length, 0, 'a bad note stops the accept before Jira');
  assert.equal((await res(e, 'verdict.snooze', { refs: ['DW-1'], note: long })).error, 'bad-input');
  assert.equal((await res(e, 'verdict.reject', { refs: ['DW-1'], reason: 'other', note: long })).error, 'bad-input');
  assert.equal(/** @type {any} */ (e.db.raw.prepare('SELECT status FROM proposals WHERE id = 1').get()).status, 'open');
});

/** One open item with an accept target. */
async function seeded2() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('gap 5: a Rovo decision is recorded as the chatting person (via rovo), notes included; a merge into a Jira key names the key', async () => {
  const d = await seeded();
  await runRovo(d, 'dowser_verdict_record', { ref: 'DW-1', status: 'accepted', note: 'agent-asked' }, OTHER);
  await runRovo(d, 'dowser_verdict_record', { ref: 'DW-2', status: 'merged', merged_into: 'SHOP-7' }, ME);
  await runRovo(d, 'dowser_verdict_record', { ref: 'DW-3', status: 'snoozed' }, OTHER);
  const rows = d.db.raw.prepare('SELECT status, decided_by, via, merged_into, note FROM verdicts ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { status: 'accepted', decided_by: `forge:${OTHER}`, via: 'rovo', merged_into: null, note: 'agent-asked' },
    { status: 'merged', decided_by: `forge:${ME}`, via: 'rovo', merged_into: 'SHOP-7', note: null },
    { status: 'snoozed', decided_by: `forge:${OTHER}`, via: 'rovo', merged_into: null, note: null },
  ]);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => [v.status, v.decided_by, v.merged_into]), [
    ['accepted', `forge:${OTHER}`, undefined], ['merged', `forge:${ME}`, 'SHOP-7'], ['snoozed', `forge:${OTHER}`, undefined],
  ]);
  assert.equal(d.jira.comments[0].issueKey, 'SHOP-7');
});

test('the dispatch door logs one structured line per call, and an extra line per failed resolver call, with no payload bodies', async () => {
  const d = await seeded();
  d.logs.length = 0;
  await tool(d, 'dowser_reflect_sync', sync([offer('rule-secret-text', { text: 'SENSITIVE RULE TEXT' })]));
  await tool(d, 'dowser_verdicts_pull', { project_key: 'nope' });
  await res(d, 'proposal.get', { ref: 'DW-1' });
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'other' }); // needs a note: fails
  await runRovo(d, 'dowser_inbox_list', {}, ME);
  await tool(d, 'dowser_reflect_sync', sync([]), '');
  const lines = d.logs.map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.dowser, l.surface ?? '', l.key, l.ok ?? '', l.error ?? '']), [
    ['call', 'tool', 'dowser_reflect_sync', true, ''],
    ['call', 'tool', 'dowser_verdicts_pull', false, 'unknown-project'],
    ['call', 'resolver', 'proposal.get', true, ''],
    ['call', 'resolver', 'verdict.reject', false, 'bad-input'],
    ['resolver-error', '', 'verdict.reject', '', 'bad-input'],
    ['call', 'rovo', 'dowser_inbox_list', true, ''],
    ['call', 'tool', 'dowser_reflect_sync', false, 'unauthorized'],
  ]);
  assert.equal(lines[0].project_key, PK);
  assert.ok(!('project_key' in lines[2]));
  assert.ok(lines.every((l) => l.ms === undefined || Number.isInteger(l.ms)));
  assert.ok(!d.logs.join('\n').includes('SENSITIVE'), 'payload bodies are never logged');
  assert.ok(!d.logs.join('\n').includes(ME), 'account ids are never logged');
});

test('the tool 7 action key: the module key wins; rules_json routes by shape', () => {
  assert.equal(actionName('mcp', ['dowser_reflect_sync'], { project_key: 'x' }), 'dowser_reflect_sync');
  assert.equal(actionName('mcp', [], { project_key: 'x', rules_json: '[]' }), 'dowser_reflect_sync');
  assert.equal(actionName('mcp', [], { project_key: 'x' }), 'dowser_verdicts_pull');
});
