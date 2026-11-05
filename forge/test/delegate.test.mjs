// @ts-check
// Delegated triage (core/delegate.mjs): a person switches it on per inbox in Settings (`settings.set`), and
// `dowser_verdicts_record` then records verdicts as `delegate:temper` through the same decision path the inbox uses,
// refused without a delegation, past its daily caps and for the sample inbox. No MCP tool or Rovo action can set it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { MODULE_KEYS, TOOL_NAMES, ROVO_ACTIONS, actionName, resolverAllowed, runResolver, runRovo, runTool } from '../src/core/app.mjs';
import { DELEGATE_DECIDER, DELEGATE_LABEL, SAMPLE_KEY, SAMPLE_RESERVED } from '../src/core/types.mjs';
import { recordVerdicts } from '../src/core/delegate.mjs';
import { getInbox } from '../src/core/store.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = async (d, key, p) => /** @type {any} */ (await runResolver(d, key, p, ME, 'inbox'));
/** @param {any} d @param {Record<string, unknown>[]} verdicts @param {string} [pk] */
const rec = async (d, verdicts, pk = PK) => /** @type {any} */ (await runTool(d, 'dowser_verdicts_record', { project_key: pk, verdicts_json: JSON.stringify(verdicts) }, ME));
/** @param {any} d */
const logged = (d) => d.db.raw.prepare('SELECT external_ref, status, decided_by, via FROM verdicts ORDER BY seq').all().map((/** @type {any} */ v) => [v.external_ref, v.status, v.decided_by, v.via]);
const DELEGATE = { project_key: PK, delegate_until: '2026-10-31', delegate_accepts_per_day: 1, delegate_rejects_per_day: 2 };

/** An inbox of `n` open cards (DW-1..DW-n) with a Jira target; `delegated` switches the delegation on. */
async function seeded(n = 4, delegated = true) {
  const d = makeDeps();
  const records = Array.from({ length: n }, (_, i) => record({ topic: `topic ${i}`, anchors: [`src/a${i}.js#x`] }));
  await runTool(d, 'dowser_proposals_push', pushArgs(records), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  if (delegated) assert.equal((await res(d, 'settings.set', DELEGATE)).error, undefined);
  return d;
}

test('without a delegation the tool is refused whole, and nothing is decided', async () => {
  const d = await seeded(2, false);
  const out = await rec(d, [{ ref: 'DW-1', verdict: 'accept' }]);
  assert.equal(out.error, 'forbidden');
  assert.match(out.message, /has no delegated triage; a person switches it on in Dowser Settings/);
  assert.deepEqual(logged(d), []);
  assert.equal(d.jira.created.length, 0);
});

test('an expired delegation is refused; the day it ends still counts', async () => {
  const d = await seeded(2);
  d.clock.tick(4 * 86_400_000 - 10 * 3_600_000); // 2026-10-31T00:00Z, the last day
  assert.equal((await rec(d, [{ ref: 'DW-1', verdict: 'snooze' }])).results[0].result, 'recorded');
  d.clock.tick(86_400_000); // 2026-11-01
  const out = await rec(d, [{ ref: 'DW-2', verdict: 'snooze' }]);
  assert.equal(out.error, 'forbidden');
  assert.match(out.message, /ended on 2026-10-31; a person renews it/);
});

test('the sample inbox is refused before any access check, and takes no delegation in Settings', async () => {
  const d = await seeded(1);
  assert.deepEqual(await rec(d, [{ ref: 'DW-1', verdict: 'accept' }], SAMPLE_KEY), { error: 'bad-input', message: SAMPLE_RESERVED });
  assert.equal((await res(d, 'sample.load', {})).project_key, SAMPLE_KEY);
  const set = await res(d, 'settings.set', { ...DELEGATE, project_key: SAMPLE_KEY });
  assert.equal(set.error, 'bad-input');
  assert.match(set.message, /takes no delegated triage/);
});

test('a delegate accept creates the Jira issue labelled dowser-delegate; every verdict is delegate:temper and pulls as such', async () => {
  const d = await seeded(4);
  const out = await rec(d, [
    { ref: 'DW-1', verdict: 'accept', note: 'Clear evidence' },
    { ref: 'DW-2', verdict: 'reject', reason: 'not-worth-it' },
    { ref: 'DW-3', verdict: 'snooze', until: '2026-12-01' },
  ]);
  assert.deepEqual(out, { results: [
    { ref: 'DW-1', result: 'recorded', issue_ref: 'SHOP-41' },
    { ref: 'DW-2', result: 'recorded' },
    { ref: 'DW-3', result: 'recorded' },
  ] });
  assert.deepEqual(d.jira.created.map((c) => c.labels), [[DELEGATE_LABEL]]);
  assert.deepEqual(logged(d), [['DW-1', 'accepted', DELEGATE_DECIDER, 'mcp'], ['DW-2', 'rejected', DELEGATE_DECIDER, 'mcp'], ['DW-3', 'snoozed', DELEGATE_DECIDER, 'mcp']]);
  d.clock.tick(120_000);
  const pull = /** @type {any} */ (await runTool(d, 'dowser_verdicts_pull', { project_key: PK }, ME));
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => [v.external_ref, v.status, v.decided_by]), [
    ['DW-1', 'accepted', DELEGATE_DECIDER], ['DW-2', 'rejected', DELEGATE_DECIDER], ['DW-3', 'snoozed', DELEGATE_DECIDER]]);
  assert.equal(pull.verdicts[0].issue_ref, 'SHOP-41');
  assert.equal(pull.verdicts[0].note, 'Clear evidence');
  assert.equal(pull.verdicts[2].snooze_until, '2026-12-01');
  // a person's accept in the inbox is not labelled
  await res(d, 'verdict.accept', { ref: 'DW-4' });
  assert.equal(d.jira.created[1].labels, undefined);
  // the inbox history and the Learning tab name the delegate, apart from people
  const got = await res(d, 'proposal.get', { ref: 'DW-1' });
  assert.deepEqual([got.history[0].decided_by, got.history[0].decided_by_name], [DELEGATE_DECIDER, 'Temper (delegate)']);
  const rd = await res(d, 'reflect.data', { project_key: PK });
  assert.deepEqual(rd.verdicts_by, { human: { accepted: 1, rejected: 0, merged: 0, snoozed: 0 }, delegate: { accepted: 1, rejected: 1, merged: 0, snoozed: 1 } });
  assert.equal(rd.notes.find((/** @type {any} */ n) => n.ref === 'DW-1').decided_by_name, 'Temper (delegate)');
});

test('past a daily cap a verdict is refused with why; the others still run, and the caps reset at 00:00 UTC', async () => {
  const d = await seeded(6);
  const out = await rec(d, [
    { ref: 'DW-1', verdict: 'accept' },
    { ref: 'DW-2', verdict: 'accept' },
    { ref: 'DW-3', verdict: 'reject', reason: 'false-positive' },
    { ref: 'DW-4', verdict: 'merge', into: 'DW-3' },
    { ref: 'DW-5', verdict: 'snooze' },
  ]);
  assert.deepEqual(out.results.map((/** @type {any} */ r) => [r.ref, r.result]), [['DW-1', 'recorded'], ['DW-2', 'refused'], ['DW-3', 'recorded'], ['DW-4', 'recorded'], ['DW-5', 'refused']]);
  assert.match(out.results[1].why, /^today's delegate accept cap \(1\) is reached; it resets at 00:00 UTC$/);
  assert.match(out.results[4].why, /^today's delegate cap of 2 rejects, snoozes and merges is reached/);
  // a second call the same day counts what the log already holds
  assert.equal((await rec(d, [{ ref: 'DW-2', verdict: 'accept' }])).results[0].result, 'refused');
  // a person's decisions never use the delegate's caps
  assert.equal((await res(d, 'verdict.snooze', { refs: ['DW-6'] })).cards[0].status, 'snoozed');
  d.clock.tick(14 * 3_600_000); // 2026-10-28T00:00Z
  assert.deepEqual((await rec(d, [{ ref: 'DW-2', verdict: 'accept' }, { ref: 'DW-5', verdict: 'snooze' }])).results.map((/** @type {any} */ r) => r.result), ['recorded', 'recorded']);
});

test('the caller\'s own permissions still apply: a closed inbox is forbidden, an accept without Create issues is refused', async () => {
  const d = await seeded(2);
  d.perms.deny.add('CREATE_ISSUES:SHOP');
  const out = await rec(d, [{ ref: 'DW-1', verdict: 'accept' }, { ref: 'DW-2', verdict: 'reject', reason: 'other' }]);
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), ['refused', 'refused']);
  assert.match(out.results[0].why, /You do not have permission to create issues in Jira project SHOP/);
  assert.match(out.results[1].why, /note/, 'reason other needs a note, as in the inbox');
  assert.equal(d.jira.created.length, 0);
  d.perms.deny.add('BROWSE_PROJECTS:SHOP');
  d.perms.deny.add('ADMINISTER');
  assert.equal((await rec(d, [{ ref: 'DW-2', verdict: 'snooze' }])).error, 'forbidden');
});

test('an item of another inbox, a decided item and a malformed verdicts_json', async () => {
  const d = await seeded(1);
  await runTool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'other inbox' })], { project_key: 'github-com-Acme-Other' }), ME);
  const out = await rec(d, [{ ref: 'DW-2', verdict: 'snooze' }, { ref: 'DW-1', verdict: 'snooze' }, { ref: 'DW-1', verdict: 'snooze' }]);
  assert.deepEqual(out.results.map((/** @type {any} */ r) => [r.ref, r.result]), [['DW-2', 'refused'], ['DW-1', 'recorded'], ['DW-1', 'refused']]);
  assert.match(out.results[0].why, /DW-2 is in another inbox, not github-com-Acme-Shop/);
  assert.match(out.results[2].why, /DW-1 is snoozed, not open/);
  for (const [bad, why] of /** @type {[unknown, RegExp][]} */ ([
    ['[]', /non-empty JSON array/], ['{', /not valid JSON/], [JSON.stringify([{ ref: 'DW-1', verdict: 'approve' }]), /accept, reject, snooze or merge/],
    [JSON.stringify([{ ref: 'DW-1', verdict: 'accept', by: 'human:x' }]), /\.by is not a verdict field/],
    [JSON.stringify(Array.from({ length: 51 }, () => ({ ref: 'DW-1', verdict: 'snooze' }))), /at most 50 per call/],
  ])) {
    const r = /** @type {any} */ (await runTool(d, 'dowser_verdicts_record', { project_key: PK, verdicts_json: bad }, ME));
    assert.equal(r.error, 'bad-input');
    assert.match(r.message, why);
  }
});

test('a call starts no new verdict past its time budget and answers more', async () => {
  const d = await seeded(3);
  const inbox = /** @type {any} */ (await getInbox(d.db, PK));
  /** @type {string[]} */
  const seen = [];
  const out = await recordVerdicts(d, inbox, JSON.stringify(['DW-1', 'DW-2', 'DW-3'].map((ref) => ({ ref, verdict: 'snooze' }))), async (v) => {
    seen.push(v.ref);
    d.clock.tick(6000);
    return {};
  }, { budgetMs: 10_000 });
  assert.deepEqual(out, { results: [{ ref: 'DW-1', result: 'recorded' }, { ref: 'DW-2', result: 'recorded' }], more: true });
  assert.deepEqual(seen, ['DW-1', 'DW-2']);
});

test('Settings sets, shows and switches off the delegation; bad values are refused', async () => {
  const d = await seeded(1, false);
  const on = await res(d, 'settings.set', DELEGATE);
  assert.deepEqual([on.inbox.delegate_until, on.inbox.delegate_accepts_per_day, on.inbox.delegate_rejects_per_day], ['2026-10-31', 1, 2]);
  assert.equal(on.inbox.jira_project_key, 'SHOP', 'the accept target is kept');
  const shown = (await res(d, 'settings.get', {})).inboxes[0];
  assert.equal(shown.delegate_until, '2026-10-31');
  for (const [p, why] of /** @type {[Record<string, unknown>, RegExp][]} */ ([
    [{ delegate_until: '2026-02-30', delegate_accepts_per_day: 1, delegate_rejects_per_day: 1 }, /calendar date/],
    [{ delegate_until: '2026-10-25', delegate_accepts_per_day: 1, delegate_rejects_per_day: 1 }, /today or later/],
    [{ delegate_until: '2026-10-31', delegate_accepts_per_day: 1 }, /delegate_rejects_per_day is a whole number from 0 to 200/],
    [{ delegate_until: '2026-10-31', delegate_accepts_per_day: 201, delegate_rejects_per_day: 1 }, /from 0 to 200/],
    [{ delegate_until: '2026-10-31', delegate_accepts_per_day: 1.5, delegate_rejects_per_day: 1 }, /whole number/],
    [{ delegate_until: '', delegate_accepts_per_day: 1 }, /delegate_until "" alone/],
    [{}, /takes jira_project_key and issue_type_id, the delegate_\* fields, or both/],
  ])) {
    const r = await res(d, 'settings.set', { project_key: PK, ...p });
    assert.equal(r.error, 'bad-input', JSON.stringify(p));
    assert.match(r.message, why);
  }
  const zero = await res(d, 'settings.set', { project_key: PK, delegate_until: '2026-10-31', delegate_accepts_per_day: 0, delegate_rejects_per_day: 3 });
  assert.equal(zero.inbox.delegate_accepts_per_day, 0, 'a cap of 0 is a measured value, kept');
  const off = await res(d, 'settings.set', { project_key: PK, delegate_until: '' });
  assert.equal(off.inbox.delegate_until, undefined);
  assert.equal(off.inbox.delegate_accepts_per_day, undefined);
  assert.equal(Object.hasOwn(off.inbox, 'delegate_rejects_per_day'), false, 'absent: omitted, never null');
  assert.equal((await rec(d, [{ ref: 'DW-1', verdict: 'snooze' }])).error, 'forbidden');
});

test('MCP and Rovo have no path to the delegation: only the inbox page\'s settings.set writes it', async () => {
  const d = await seeded(1, false);
  const sneaky = { project_key: PK, delegate_until: '2026-10-31', delegate_accepts_per_day: 50, delegate_rejects_per_day: 50, jira_project_key: 'SHOP', issue_type_id: '10001' };
  for (const name of TOOL_NAMES) await runTool(d, name, sneaky, ME);
  for (const name of [...ROVO_ACTIONS, 'settings.set']) await runRovo(d, name, sneaky, ME);
  assert.deepEqual(/** @type {any} */ (await runTool(d, 'settings.set', sneaky, ME)).error, 'bad-input', 'settings.set is no tool');
  const inbox = /** @type {any} */ (await getInbox(d.db, PK));
  assert.equal(inbox.delegate_until, undefined, 'no tool or action set the delegation');
  // the resolver is the inbox global page's only: the issue panel and the Confluence modules may not call it
  assert.deepEqual(Object.keys(MODULE_KEYS).filter((m) => resolverAllowed(m, 'settings.set')), ['dowser-inbox']);
  // and nothing routes a tool call to it, by name or by shape
  assert.ok(/** @type {readonly string[]} */ (TOOL_NAMES).includes(actionName('mcp', ['settings.set'], sneaky)));
  assert.equal(TOOL_NAMES.some((n) => /settings|delegat/.test(n)), false);
  assert.equal(actionName('mcp', [undefined], { project_key: PK, verdicts_json: '[]' }), 'dowser_verdicts_record');
});
