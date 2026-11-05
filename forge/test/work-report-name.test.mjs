// @ts-check
// DW-66: a coding agent's progress comment on the Jira issue names the person it works for, never their raw account
// id: their display name when the Users port knows it, else an ADF mention Jira renders as the name. The tool's own
// answer keeps `by` as the decider (`forge:<account>`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} name @param {Record<string, unknown>} a */
const tool = (d, name, a) => /** @type {Promise<any>} */ (runTool(d, name, a, ME));
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

/** @param {(d: ReturnType<typeof makeDeps>) => void} [tweak] */
async function seeded(tweak) {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  assert.ok((await res(d, 'verdict.accept', { ref: 'DW-1' })).card.issue_ref);
  tweak?.(d);
  return d;
}

/** Every ADF node under `n`, depth first. @param {any} n @returns {any[]} */
const nodes = (n) => [n, ...(n?.content ?? []).flatMap(nodes)];
/** @param {any} body */
const texts = (body) => nodes(body).filter((n) => n.type === 'text').map((n) => String(n.text));

/** @param {any} body */
function noRawId(body) {
  for (const t of texts(body)) assert.ok(!t.includes(ME), `no text node carries the account id: ${t}`);
}

test('with a named account the comment says "a coding agent for <name>"; report.by stays the decider', async () => {
  const d = await seeded((x) => { x.users.directory[ME] = 'Ada Lovelace'; });
  const r = await tool(d, 'dowser_work_report', { ref: 'DW-1', status: 'started' });
  assert.equal(r.error, undefined, r.message);
  assert.equal(r.report.by, `forge:${ME}`);
  const body = d.jira.comments.at(-1)?.body;
  assert.match(texts(body).join(''), /a coding agent for Ada Lovelace/);
  noRawId(body);
});

test('with no Users port the comment mentions the account instead of printing its id', async () => {
  const d = await seeded((x) => { delete (/** @type {any} */ (x)).users; });
  const r = await tool(d, 'dowser_work_report', { ref: 'DW-1', status: 'started' });
  assert.equal(r.error, undefined, r.message);
  assert.equal(r.report.by, `forge:${ME}`);
  const body = d.jira.comments.at(-1)?.body;
  assert.ok(nodes(body).some((n) => n.type === 'mention' && n.attrs?.id === ME), 'an ADF mention of the account');
  noRawId(body);
});

test('a Users port that does not name the account falls back to the mention too', async () => {
  const d = await seeded((x) => { x.users.directory = {}; });
  const r = await tool(d, 'dowser_work_report', { ref: 'DW-1', status: 'pr_open', url: 'https://github.com/acme/shop/pull/7' });
  assert.equal(r.report.by, `forge:${ME}`);
  const body = d.jira.comments.at(-1)?.body;
  assert.ok(nodes(body).some((n) => n.type === 'mention' && n.attrs?.id === ME), 'an ADF mention of the account');
  noRawId(body);
});
