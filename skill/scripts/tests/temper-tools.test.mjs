// @ts-check
// The /temper tools (tools/temper-scan.mjs, temper-cards.mjs, temper-tickets.mjs, temper-verdicts.mjs, live-mcp.mjs): argument
// validation, the ticket dedupe key, ADF building, and the verdicts tool's paging against a stub. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_KEY_RE } from '../../../forge/src/core/push.mjs';
import { SAMPLE_KEY } from '../../../forge/src/core/types.mjs';
import { findDowserServer, toolPrompt, writeMcpConfig } from '../../../tools/live-mcp.mjs';
import { UsageError, checkProjectKey, parseFlags } from '../../../tools/temper-lib.mjs';
import { listCards, scanStore } from '../../../tools/temper-cards.mjs';
import { cardCounts, parseScanArgs, reportFile, scanPrompt, writeReport } from '../../../tools/temper-scan.mjs';
import { adfOf, closeTickets, dedupeJql, fileFindings, planFindings, findingFp, fpLabel, jiraClient, parseFindings, parseTicketArgs, summaryOf } from '../../../tools/temper-tickets.mjs';
import { checkVerdict, parseVerdictArgs, parseVerdicts, recordVerdicts } from '../../../tools/temper-verdicts.mjs';
import { scanArgs } from '../../../tools/scan-workspace.mjs';
import { candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A finding as a UAT persona pass writes it. @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({ title: 'Load more drops the open filter', surface: 'fixture #/inbox', steps: ['Open the inbox', 'Filter by lens', 'Click Load more'],
  expected: 'The filter stays applied', actual: 'All lenses are listed', screenshot: 'e2e/results/inbox-load-more.png', spec: 'inbox.load-more.spec.mjs', ...over });

test('checkProjectKey: the push rule, never the sample key, and stable under the skill\'s remote normalization', () => {
  assert.equal(checkProjectKey('bp-temper'), 'bp-temper');
  assert.equal(checkProjectKey('github-com-xkazm04-bp'.toLowerCase()), 'github-com-xkazm04-bp');
  for (const bad of [undefined, '', '-bp', 'bp_temper', 'bp temper', 'x'.repeat(192), SAMPLE_KEY, 'Bp-Temper', 'bp--temper', 'bp-']) {
    assert.throws(() => checkProjectKey(bad), UsageError, String(bad));
  }
  assert.ok(PROJECT_KEY_RE.test('bp-temper'), 'the rule is forge/src/core/push.mjs\'s own');
  assert.throws(() => checkProjectKey(SAMPLE_KEY), /reserved for the sample inbox/);
});

test('parseFlags: values, booleans, repeats; a valueless or doubled flag is a usage error', () => {
  assert.deepEqual(parseFlags(['--a', '1', '--b', '--h', 'x', '--h', 'y', 'pos'], { values: ['a'], bool: ['b'], multi: ['h'] }),
    { flags: { a: '1', b: true }, multi: { h: ['x', 'y'] }, rest: ['pos'] });
  assert.throws(() => parseFlags(['--a'], { values: ['a'] }), /valueless/);
  assert.throws(() => parseFlags(['--a', '1', '--a', '2'], { values: ['a'] }), /twice/);
  assert.throws(() => parseFlags(['--zzz', '1'], { values: ['a'] }), /unknown/);
});

test('temper-scan: argument validation, focus in the store\'s form, and the connected push prompt', () => {
  const dir = tempDir('temper-scan');
  try {
    const o = parseScanArgs(['--repo', dir, '--project-key', 'bp-temper', '--focus', 'goal:  faster triage', '--budget-usd', '8', '--hide', 'secret', '--hide', 'docs/x']);
    assert.equal(o.projectKey, 'bp-temper');
    assert.equal(o.focus, 'goal:faster triage');
    assert.equal(o.budget, '8');
    assert.deepEqual(o.hide, ['secret', 'docs/x']);
    assert.equal(o.lenses.length, 4);
    assert.equal(o.dryRun, false);
    assert.throws(() => parseScanArgs(['--project-key', 'bp-temper']), /--repo is required/);
    assert.throws(() => parseScanArgs(['--repo', join(dir, 'missing'), '--project-key', 'bp-temper']), /not a folder/);
    assert.throws(() => parseScanArgs(['--repo', dir]), /--project-key/);
    assert.throws(() => parseScanArgs(['--repo', dir, '--project-key', SAMPLE_KEY]), /reserved/);
    assert.throws(() => parseScanArgs(['--repo', dir, '--project-key', 'bp-temper', '--focus', 'module: x']), /--focus/);
    assert.throws(() => parseScanArgs(['--repo', dir, '--project-key', 'bp-temper', '--budget-usd', '0']), /positive/);
    assert.throws(() => parseScanArgs(['--repo', dir, '--project-key', 'bp-temper', '--lenses', 'opportunity,nope']), /unknown lens nope/);
    const p = scanPrompt({ lenses: ['opportunity'], focus: 'area:src/api' });
    assert.match(p, /--focus/);
    assert.match(p, /area:src\/api/);
    assert.match(p, /push the kept cards \(section 8\)/);
    assert.match(p, /never ask a question/);
  } finally { removeDir(dir); }
});

test('temper-scan: a bad command line exits 2 before any clone or call', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/temper-scan.mjs'), '--repo', ROOT, '--project-key', SAMPLE_KEY], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reserved for the sample inbox/);
});

test('temper-scan --dry-run: plans a clone keyed to the inbox and writes nothing into the repo or the Temper home', () => {
  const dir = tempDir('temper-dry');
  try {
    const repo = join(dir, 'src');
    mkdirSync(repo, { recursive: true });
    gitRepo(repo, { 'a.js': 'export const a = 1;\n' });
    const status = () => spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
    const home = join(dir, 'temper');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/temper-scan.mjs'), '--repo', repo, '--project-key', 'bp-temper', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, TEMPER_HOME: home, DOWSER_MCP_URL: 'https://example.invalid/mcp' } });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.project_key, 'bp-temper');
    assert.equal(plan.dowser_home, join(home, 'homes', 'bp-temper'));
    assert.deepEqual(plan.mcp, { type: 'http', url: 'https://example.invalid/mcp' });
    assert.equal(status(), '');
    assert.throws(() => readFileSync(join(home, 'scans.jsonl')), 'a dry run appends no ledger row');
  } finally { removeDir(dir); }
});

test('scanArgs: project and local settings only, the one MCP config, no ScheduleWakeup heartbeat, the budget passed on', () => {
  const a = scanArgs({ prompt: 'p', mcpConfig: 'm.json', addDir: 'T', budget: '8' });
  assert.deepEqual(a.slice(0, 4), ['-p', 'p', '--setting-sources', 'project,local']);
  assert.equal(a[a.indexOf('--mcp-config') + 1], 'm.json');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--disallowedTools') + 1], 'ScheduleWakeup');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '8');
  assert.ok(!scanArgs({ prompt: 'p', mcpConfig: 'm', addDir: 'T' }).includes('--max-budget-usd'));
});

test('cardCounts: created vs moved, pushed by external ref, per status', () => {
  const before = new Map([['b', 'verified']]);
  const cards = [{ card: { fp: 'a', status: 'verified', external_ref: 'DW-1' } }, { card: { fp: 'b', status: 'rejected' } }, { card: { fp: 'c', status: 'verified' } }];
  assert.deepEqual(cardCounts(cards, before), { created: 2, moved: 1, pushed: 1, by_status: { verified: 2, rejected: 1 } });
});

test('live-mcp: the dowser server registered for this checkout or its main checkout; the tool prompt matches the env suffix', () => {
  const server = { type: 'http', url: 'https://mcp.example/forge/x' };
  const config = { projects: { 'C:/work/other': { mcpServers: { dowser: { type: 'http', url: 'nope' } } }, 'C:/work/dowser': { mcpServers: { dowser: server } } } };
  assert.deepEqual(findDowserServer(config, ['C:\\work\\dowser\\.claude\\worktrees\\wp3', 'C:\\Work\\Dowser']), server);
  assert.equal(findDowserServer({ projects: {} }, ['C:/x']), undefined);
  assert.deepEqual(findDowserServer({ mcpServers: { dowser: server } }, ['C:/x']), server);
  const p = toolPrompt('dowser_verdicts_record', 'C:\\t\\a.json');
  assert.match(p, /dowser_verdicts_record_development/);
  assert.match(p, /C:\/t\/a\.json/);
  const dir = tempDir('mcp-config');
  try {
    assert.deepEqual(JSON.parse(readFileSync(writeMcpConfig(join(dir, 'm.json'), server), 'utf8')), { mcpServers: { dowser: server } });
  } finally { removeDir(dir); }
});

test('findingFp: stable under case and whitespace, independent of the actual result, distinct per surface, spec and title', () => {
  const fp = findingFp(finding());
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(findingFp(finding({ title: '  LOAD more   drops the open filter ', actual: 'something else', steps: ['other'] })), fp);
  assert.notEqual(findingFp(finding({ surface: 'local #/inbox' })), fp);
  assert.notEqual(findingFp(finding({ spec: 'other.spec.mjs' })), fp);
  assert.notEqual(findingFp(finding({ title: 'Load more drops the sort' })), fp);
  assert.notEqual(findingFp(finding({ spec: undefined })), fp);
  assert.equal(findingFp(finding({ fp: '0123456789ab' })), '0123456789ab');
  assert.equal(fpLabel(fp), `temper-fp-${fp}`);
  assert.equal(dedupeJql('DOW', fp), `project = "DOW" AND labels = "temper-uat" AND labels = "temper-fp-${fp}" AND statusCategory != Done ORDER BY created ASC`);
});

test('parseFindings: required fields, steps, optional fields typed, fp format', () => {
  assert.equal(parseFindings([finding()]).length, 1);
  assert.equal(parseFindings({ findings: [finding({ screenshot: undefined, spec: undefined })] })[0].spec, undefined);
  assert.throws(() => parseFindings([]), /non-empty/);
  assert.throws(() => parseFindings({}), /non-empty/);
  assert.throws(() => parseFindings([finding({ title: ' ' })]), /title/);
  assert.throws(() => parseFindings([finding({ surface: undefined })]), /surface/);
  assert.throws(() => parseFindings([finding({ steps: [] })]), /steps/);
  assert.throws(() => parseFindings([finding({ steps: ['ok', ''] })]), /steps/);
  assert.throws(() => parseFindings([finding({ spec: 3 })]), /spec/);
  assert.throws(() => parseFindings([finding({ fp: 'XYZ' })]), /fp/);
  assert.throws(() => parseFindings(['x']), /not an object/);
});

test('adfOf: a valid ADF doc with the surface, ordered steps, expected/actual, screenshot and spec as text, and no empty text node', () => {
  const f = parseFindings([finding()])[0];
  const doc = adfOf(f);
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  const json = JSON.stringify(doc);
  for (const s of ['fixture #/inbox', 'Click Load more', 'The filter stays applied', 'All lenses are listed', 'e2e/results/inbox-load-more.png', 'inbox.load-more.spec.mjs', fpLabel(findingFp(f))]) {
    assert.ok(json.includes(s), s);
  }
  const list = /** @type {any} */ (doc.content.find((/** @type {any} */ n) => n.type === 'orderedList'));
  assert.equal(list.content.length, 3);
  assert.deepEqual(doc.content.filter((/** @type {any} */ n) => n.type === 'heading').map((/** @type {any} */ n) => n.content[0].text), ['Steps to reproduce', 'Expected', 'Actual', 'Evidence']);
  /** @param {any} n @returns {any[]} */
  const texts = (n) => (n.type === 'text' ? [n] : (n.content ?? []).flatMap(texts));
  for (const t of texts(doc)) assert.ok(t.text.length > 0);
  const bare = adfOf(parseFindings([finding({ screenshot: undefined, spec: undefined })])[0]);
  assert.ok(!JSON.stringify(bare).includes('Screenshot:'));
  assert.ok(!JSON.stringify(bare).includes('Spec:'));
  assert.ok(summaryOf(parseFindings([finding({ title: 'x'.repeat(400) })])[0]).length <= 255);
  assert.equal(summaryOf(f), 'UAT: Load more drops the open filter');
});

/**
 * A stub Jira: a DOW project with Bug and Task, issues in memory, a search that can lag behind creation.
 * @param {{lag?: boolean}} [o]
 */
function stubJira(o = {}) {
  /** @type {{key: string, fields: any}[]} */
  const issues = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../../../tools/temper-tickets.mjs').Jira} */
  const jira = async (method, path, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    const b = /** @type {any} */ (body);
    if (path.endsWith('/issuetypes')) return { issueTypes: [{ id: '3', name: 'Task' }, { id: '1', name: 'Bug' }, { id: '9', name: 'Sub-task', subtask: true }] };
    if (path === '/rest/api/3/search/jql') {
      const labels = [...b.jql.matchAll(/labels = "([^"]+)"/g)].map((m) => m[1]);
      return { issues: o.lag ? [] : issues.filter((i) => labels.every((l) => i.fields.labels.includes(l)) && i.fields.status.statusCategory.key !== 'done') };
    }
    if (method === 'POST' && path === '/rest/api/3/issue') {
      const key = `DOW-${issues.length + 1}`;
      issues.push({ key, fields: { ...b.fields, status: { name: 'To Do', statusCategory: { key: 'new' } } } });
      return { key };
    }
    const m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)(\/transitions)?/);
    const issue = m && issues.find((i) => i.key === m[1]);
    if (!issue) throw new Error(`Jira ${method} ${path} -> 404`);
    if (m[2] && method === 'GET') return { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] };
    if (m[2]) { issue.fields.status = { name: 'Done', statusCategory: { key: 'done' } }; return {}; }
    return issue;
  };
  return { jira, issues, calls };
}

test('fileFindings: files once with both labels and a Bug, dedupes the second run, files again after the ticket is Done', async () => {
  const { jira, issues } = stubJira();
  const findings = parseFindings([finding()]);
  const first = await fileFindings(findings, { jira, project: 'DOW' });
  assert.equal(first.filed.length, 1);
  assert.equal(first.issue_type, 'Bug');
  assert.deepEqual(issues[0].fields.labels, ['temper-uat', fpLabel(findingFp(findings[0]))]);
  assert.equal(issues[0].fields.issuetype.id, '1');
  assert.equal(issues[0].fields.description.type, 'doc');
  const second = await fileFindings(findings, { jira, project: 'DOW' });
  assert.deepEqual(second.filed, []);
  assert.deepEqual(second.deduped, [{ fp: findingFp(findings[0]), key: 'DOW-1' }]);
  assert.deepEqual((await closeTickets(jira, ['DOW-1'])).closed, [{ key: 'DOW-1', result: 'closed', status: 'Done' }]);
  assert.equal((await closeTickets(jira, ['DOW-1'])).closed[0].result, 'already-done');
  assert.equal((await fileFindings(findings, { jira, project: 'DOW' })).filed[0].key, 'DOW-2');
});

test('fileFindings: the local ledger dedupes while the search index lags; the plan needs no Jira', async () => {
  const { jira } = stubJira({ lag: true });
  const known = new Map();
  const findings = parseFindings([finding()]);
  assert.equal((await fileFindings(findings, { jira, project: 'DOW', known })).filed.length, 1);
  assert.equal(known.get(findingFp(findings[0])), 'DOW-1');
  assert.deepEqual((await fileFindings(findings, { jira, project: 'DOW', known })).deduped.map((d) => d.key), ['DOW-1']);
  assert.deepEqual(planFindings(findings), [{ fp: findingFp(findings[0]), summary: summaryOf(findings[0]), labels: ['temper-uat', fpLabel(findingFp(findings[0]))] }]);
  assert.throws(() => planFindings(parseFindings([finding(), finding({ actual: 'other' })])), /repeats fingerprint/);
  await assert.rejects(fileFindings(parseFindings([finding(), finding({ actual: 'other' })]), { jira, project: 'DOW' }), /repeats fingerprint/);
});

test('fileFindings: a named issue type the project lacks is an error; close refuses an issue that is not a temper-uat ticket', async () => {
  const { jira, issues } = stubJira();
  await assert.rejects(fileFindings(parseFindings([finding()]), { jira, project: 'DOW', issueType: 'Story' }), /no issue type Story/);
  issues.push({ key: 'DOW-50', fields: { labels: ['dowser'], status: { name: 'To Do', statusCategory: { key: 'new' } } } });
  await assert.rejects(closeTickets(jira, ['DOW-50']), /no temper-uat label/);
});

test('jiraClient: basic auth from the FORGE_* pair, errors name the status and Jira messages but never the token', async () => {
  assert.throws(() => jiraClient({ email: 'a@b.c' }), /FORGE_EMAIL and FORGE_API_TOKEN/);
  /** @type {any[]} */
  const seen = [];
  const fakeFetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, init });
    return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['Field labels is bad'], errors: { summary: 'too long' } }) };
  }));
  const jira = jiraClient({ site: 'https://x.atlassian.net/', email: 'a@b.c', token: 'SECRET-TOKEN', fetch: fakeFetch });
  await assert.rejects(jira('POST', '/rest/api/3/issue', { a: 1 }), (/** @type {Error} */ e) => {
    assert.match(e.message, /POST \/rest\/api\/3\/issue -> 400: Field labels is bad; summary: too long/);
    assert.ok(!e.message.includes('SECRET-TOKEN'));
    return true;
  });
  assert.equal(seen[0].url, 'https://x.atlassian.net/rest/api/3/issue');
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from('a@b.c:SECRET-TOKEN').toString('base64')}`);
});

test('parseTicketArgs: file / list / close and their flags', () => {
  assert.deepEqual(parseTicketArgs(['file', '--findings', 'f.json', '--dry-run']), { cmd: 'file', findings: 'f.json', project: 'DOW', dryRun: true });
  assert.deepEqual(parseTicketArgs(['list', '--all']), { cmd: 'list', project: 'DOW', all: true });
  assert.deepEqual(parseTicketArgs(['close', 'DOW-7', 'DOW-8']), { cmd: 'close', project: 'DOW', keys: ['DOW-7', 'DOW-8'] });
  assert.throws(() => parseTicketArgs([]), /command is required/);
  assert.throws(() => parseTicketArgs(['nuke']), /unknown command/);
  assert.throws(() => parseTicketArgs(['file']), /--findings/);
  assert.throws(() => parseTicketArgs(['list', '--findings', 'x']), /does not apply/);
  assert.throws(() => parseTicketArgs(['close']), /at least one/);
  assert.throws(() => parseTicketArgs(['close', 'ABC-1']), /not an issue key in DOW/);
  assert.throws(() => parseTicketArgs(['list', '--project', 'dow']), /not a Jira project key/);
});

test('temper-verdicts: each verdict checked against the dowser_verdicts_record contract', () => {
  assert.deepEqual(checkVerdict({ ref: 'DW-3', verdict: 'accept', note: 'n' }, 0), { ref: 'DW-3', verdict: 'accept', note: 'n' });
  assert.deepEqual(checkVerdict({ ref: 'DW-3', verdict: 'reject', reason: 'false-positive' }, 0), { ref: 'DW-3', verdict: 'reject', reason: 'false-positive' });
  assert.ok(checkVerdict({ ref: 'DW-3', verdict: 'merge', into: 'DW-1' }, 0));
  assert.ok(checkVerdict({ ref: 'DW-3', verdict: 'merge', into: 'DOW-12' }, 0));
  assert.ok(checkVerdict({ ref: 'DW-3', verdict: 'snooze', until: '2026-12-01' }, 0));
  assert.ok(checkVerdict({ ref: 'DW-3', verdict: 'snooze' }, 0));
  for (const [bad, re] of /** @type {[any, RegExp][]} */ ([
    [{ ref: 'DOW-3', verdict: 'accept' }, /ref/], [{ ref: 'DW-3', verdict: 'keep' }, /verdict must be/],
    [{ ref: 'DW-3', verdict: 'reject' }, /reason/], [{ ref: 'DW-3', verdict: 'reject', reason: 'other' }, /note/],
    [{ ref: 'DW-3', verdict: 'reject', reason: 'meh' }, /reason must be/], [{ ref: 'DW-3', verdict: 'accept', reason: 'other' }, /only with a reject/],
    [{ ref: 'DW-3', verdict: 'merge' }, /into/], [{ ref: 'DW-3', verdict: 'accept', into: 'DW-1' }, /into/],
    [{ ref: 'DW-3', verdict: 'accept', until: '2026-12-01' }, /until/], [{ ref: 'DW-3', verdict: 'snooze', until: 'soon' }, /until/],
    [{ ref: 'DW-3', verdict: 'accept', note: null }, /omit an absent value/], [{ ref: 'DW-3', verdict: 'accept', decided_by: 'me' }, /unknown key/],
  ])) assert.throws(() => checkVerdict(bad, 0), re, JSON.stringify(bad));
  assert.throws(() => parseVerdicts([{ ref: 'DW-1', verdict: 'accept' }, { ref: 'DW-1', verdict: 'snooze' }]), /two verdicts/);
  assert.throws(() => parseVerdicts([]), /non-empty/);
  assert.deepEqual(parseVerdictArgs(['--project-key', 'bp-temper', '--verdicts', 'v.json']), { projectKey: 'bp-temper', verdicts: 'v.json', dryRun: false });
  assert.throws(() => parseVerdictArgs(['--project-key', SAMPLE_KEY, '--verdicts', 'v.json']), /reserved/);
  assert.throws(() => parseVerdictArgs(['--project-key', 'bp-temper']), /--verdicts/);
});

test('recordVerdicts: one scalar call, paging on more until every verdict has a result; refusals reported', async () => {
  const verdicts = parseVerdicts([{ ref: 'DW-1', verdict: 'accept' }, { ref: 'DW-2', verdict: 'reject', reason: 'not-worth-it' }, { ref: 'DW-3', verdict: 'snooze' }]);
  /** @type {any[]} */
  const sent = [];
  const stub = (/** @type {string} */ name, /** @type {any} */ args) => {
    assert.equal(name, 'dowser_verdicts_record');
    assert.equal(typeof args.verdicts_json, 'string');
    const batch = JSON.parse(args.verdicts_json);
    sent.push(batch.map((/** @type {any} */ v) => v.ref));
    const [first, ...rest] = batch;
    const r = first.ref === 'DW-1' ? { ref: 'DW-1', result: 'recorded', issue_ref: 'DOW-9' } : first.ref === 'DW-3' ? { ref: 'DW-3', result: 'refused', why: 'cap' } : { ref: first.ref, result: 'recorded' };
    return { results: [r], ...(rest.length ? { more: true } : {}) };
  };
  const out = await recordVerdicts('bp-temper', verdicts, stub);
  assert.deepEqual(sent, [['DW-1', 'DW-2', 'DW-3'], ['DW-2', 'DW-3'], ['DW-3']]);
  assert.equal(out.recorded, 2);
  assert.deepEqual(out.refused, [{ ref: 'DW-3', result: 'refused', why: 'cap' }]);
  assert.equal(out.results[0].issue_ref, 'DOW-9');
  await assert.rejects(recordVerdicts('bp-temper', verdicts, () => ({ error: { code: 'forbidden' } })), /answered forbidden/);
  await assert.rejects(recordVerdicts('bp-temper', verdicts, () => ({ results: [] })), /and no more/);
  await assert.rejects(recordVerdicts('bp-temper', verdicts, () => ({ results: [], more: true })), /recorded nothing new/);
});

test('temper-cards: lists a scan home\'s cards (status, lens, title, evidence refs) by inbox key, read through the store library', () => {
  const work = tempDir('temper-cards');
  try {
    const temperHome = join(work, 'temper'), key = 'bp-temper';
    const repo = join(work, 'clone');
    mkdirSync(repo);
    gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', key]);
    const CLI = join(ROOT, 'skill', 'scripts', 'dowser.mjs');
    const env = { ...process.env, DOWSER_HOME: join(temperHome, 'homes', key) };
    const cli = (/** @type {string[]} */ ...a) => { const r = spawnSync(process.execPath, [CLI, ...a, '--repo', repo], { encoding: 'utf8', env, cwd: work }); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
    const run = JSON.parse(cli('run', 'start', '--mode', 'full')).run_id;
    const file = join(work, 'c.jsonl');
    writeFileSync(file, `${JSON.stringify(candidate({ kind: 'secret-exposure', topic: 'plaintext password' }))}\n`);
    const fp = JSON.parse(cli('propose', '--run', run, '--file', file, '--kinds', 'security-cra=secret-exposure').split('\n')[0]).fp;
    // the real checkout's origin differs, which is why `dowser.mjs list --repo <real path>` answers nothing
    const out = listCards({ home: temperHome, key });
    assert.equal(out.db, scanStore(temperHome, key));
    assert.deepEqual(out.cards.map((c) => [c.fp, c.lens, c.title]), [[fp, 'security-cra', 'Password compared in plaintext']]);
    assert.deepEqual(out.cards[0].evidence, [{ type: 'code', ref: 'src/auth.js:2', path: 'src/auth.js', line: 2 }], 'quotes only with --quotes');
    assert.equal(listCards({ home: temperHome, key, quotes: true }).cards[0].evidence[0].quote, 'return check(user.password);');
    assert.deepEqual(listCards({ home: temperHome, key, status: 'rejected' }).cards, []);
    const tool = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [join(ROOT, 'tools', 'temper-cards.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, TEMPER_HOME: temperHome } });
    const ok = tool('--project-key', key);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).cards[0].fp, fp);
    assert.equal(tool('--project-key', 'personas-temper').status, 1, 'no scan wrote that home');
    assert.equal(tool('--project-key', key, '--lens', 'nope').status, 2);
    assert.equal(tool().status, 2);
    // temper-scan's report names the cards it created, so triage needs neither the clone nor a store query
    const report = reportFile(temperHome, key);
    assert.ok(report.startsWith(join(temperHome, 'scans')) && report.endsWith(`-${key}.json`));
    const shown = JSON.parse(cli('show', fp));
    writeReport(report, { ts: 't', project_key: key, report }, 'done', [shown], new Map());
    const r = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(r.report, report);
    assert.equal(r.summary, 'done');
    assert.deepEqual([r.cards[0].fp, r.cards[0].created, r.cards[0].lens], [fp, true, 'security-cra']);
  } finally { removeDir(work); }
});
