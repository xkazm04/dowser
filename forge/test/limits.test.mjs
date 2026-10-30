// @ts-check
// Push input limits (field caps from the shared validator, https-only evidence links, the project_key shape,
// the repo_url scheme), the render-time link guard, and log hygiene (hashed project, no error message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { PROJECT_KEY_RE, checkRecord, webRepoUrl } from '../src/core/push.mjs';
import { projectTag } from '../src/core/observe.mjs';
import { FIELD_LIMITS } from '../src/shared/model.mjs';
import { safeHref } from '../static/app/src/safeHref.js';

const PK = 'github-com-Acme-Shop';

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));

test('push refuses a record over a field cap, naming the field, and files the others', async () => {
  const d = makeDeps();
  const ok = record({ topic: 'csv export' });
  const big = { ...record({ topic: 'pdf export' }), body: `${ok.body}\n${'x'.repeat(FIELD_LIMITS.body)}` };
  const many = record({ topic: 'xlsx export', evidence: Array.from({ length: FIELD_LIMITS.evidence + 1 }, (_, i) => ({ type: 'ticket', ref: `SUP-${i}` })) });
  const out = await tool(d, 'dowser_proposals_push', pushArgs([ok, big, many]));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), ['created', 'refused', 'refused']);
  assert.match(out.results[1].why, /^invalid record: body:longer than 12000 chars$/);
  assert.match(out.results[2].why, /^invalid record: evidence:at most 100 items$/);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.n, 1, 'nothing over a cap is stored');
});

test('push refuses an evidence url that is not https', () => {
  for (const url of ['javascript:alert(document.domain)', 'data:text/html,<b>x</b>', 'http://acme.atlassian.net/browse/SUP-1', '//evil.example/x']) {
    const c = checkRecord(record({ evidence: [{ type: 'ticket', ref: 'SUP-1', url }] }));
    assert.equal(c.ok, false, url);
    assert.match(/** @type {any} */ (c).why, /evidence\[0\]\.url:must be an https:\/\/ URL/, url);
  }
  assert.equal(checkRecord(record({ evidence: [{ type: 'ticket', ref: 'SUP-1', url: 'https://acme.atlassian.net/browse/SUP-1' }] })).ok, true);
});

test('push: project_key must be the skill-derived slug shape', async () => {
  for (const k of [PK, 'github-com-acme-shop', 'local-0123456789ab', 'DOW', 'x', 'a'.repeat(191)]) assert.ok(PROJECT_KEY_RE.test(k), k);
  const d = makeDeps();
  for (const k of ['-leading', 'has space', 'a/b', 'a.b', 'ünïcode', 'a'.repeat(192), '<script>']) {
    const out = await tool(d, 'dowser_proposals_push', pushArgs([record()], { project_key: k }));
    assert.equal(out.error, 'bad-input', k);
    assert.match(out.message, /project_key must be/);
  }
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM inboxes').get()?.n, 0, 'a refused key makes no inbox');
});

test('push: repo_url must be an http(s) URL without credentials', async () => {
  assert.equal(webRepoUrl('https://github.com/Acme/Shop'), true);
  assert.equal(webRepoUrl('http://git.local:8080/team/repo'), true, 'an http:// git remote keeps its scheme (git.mjs webUrl)');
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'ftp://h/r', 'github.com/Acme/Shop', `https://h/${'r'.repeat(2000)}`]) {
    assert.equal(webRepoUrl(u), false, u);
    const out = await tool(makeDeps(), 'dowser_proposals_push', pushArgs([record()], { repo_url: u }));
    assert.equal(out.error, 'bad-input', u);
    assert.match(out.message, /^repo_url must be/);
  }
});

test('safeHref passes only absolute http(s) URLs', () => {
  assert.equal(safeHref('https://acme.atlassian.net/browse/SHOP-1'), 'https://acme.atlassian.net/browse/SHOP-1');
  assert.equal(safeHref('http://127.0.0.1:4710/browse/DOW-1'), 'http://127.0.0.1:4710/browse/DOW-1', 'the local Forge serves issues over http');
  for (const u of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', '', undefined, 42]) {
    assert.equal(safeHref(u), undefined, String(u));
  }
});

test('log lines name a project by a 12-hex hash, never the key, and a resolver error carries no message', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  d.logs.length = 0;
  await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'not a key', issue_type_id: '' });
  const lines = d.logs.map((l) => JSON.parse(l));
  const tag = createHash('sha256').update(PK, 'utf8').digest('hex').slice(0, 12);
  assert.equal(projectTag(PK), tag);
  assert.ok(lines.length >= 3, d.logs.join('\n'));
  for (const l of lines) {
    assert.ok(!('project_key' in l), JSON.stringify(l));
    assert.equal(l.project, tag, JSON.stringify(l));
  }
  const err = lines.find((l) => l.dowser === 'resolver-error');
  assert.ok(err, 'the failed resolver call adds a resolver-error line');
  assert.deepEqual(Object.keys(err).sort(), ['dowser', 'error', 'key', 'project']);
  assert.ok(!d.logs.join('\n').includes(PK), 'the project key never reaches a log line');
});
