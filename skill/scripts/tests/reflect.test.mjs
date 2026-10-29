// @ts-check
// The reflection round trip (dowser_reflect_sync): `reflect export` / `reflect ingest` through the CLI as a child
// process, against hand-written responses and against the mock Forge MCP server spawned over stdio and spoken to
// in JSON-RPC (the test plays the agent, as in sync-mcp.test.mjs).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';
import { openStore } from '../lib/store.mjs';
import { exportOffers } from '../lib/reflect.mjs';
import { callTool, emptyBackend, TOOLS } from '../../../tools/mock-forge-mcp.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../tools/mock-forge-mcp.mjs', import.meta.url));
const CODE = { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' };

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;
/** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ let server;
/** @type {Map<number, (msg: any) => void>} */
const pending = new Map();
let nextId = 1;

before(() => {
  home = tempDir('refl-home');
  repo = tempDir('refl-repo');
  work = tempDir('refl-work');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
  server = spawn(process.execPath, [MOCK], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});
after(() => { server.kill(); removeDir(home); removeDir(repo); removeDir(work); });

/** @param {string} method @param {unknown} [params] @returns {Promise<any>} */
function rpc(method, params) {
  const id = nextId++;
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`${method}: no reply`)), 10000);
    pending.set(id, (msg) => { clearTimeout(t); done(msg); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** @param {string} name @param {Record<string, unknown>} args @returns {Promise<any>} */
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.ok(r.result, JSON.stringify(r));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(r.result.structuredContent, out);
  return out;
}

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, lines: out !== undefined ? [out] : r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stdout: r.stdout, stderr: r.stderr };
}

/** @param {string} name @param {unknown} doc */
const save = (name, doc) => { const f = join(work, name); writeFileSync(f, JSON.stringify(doc, null, 2)); return f; };

/** Raw read of the store, for assertions only. @param {string} sql @returns {any[]} */
function rows(sql) {
  const db = new DatabaseSync(cli('init').out.db, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

/** @type {string} */ let projectKey;
/** @type {string} */ let runId;
/** @type {string[]} */ let rejected = [];
/** @type {string} */ let accepted;
/** @type {any} */ let offer;

test('setup: three same-reason rejections offer a rule; `reflect export` is read-only and shapes the tool arguments', () => {
  const init = cli('init');
  assert.equal(init.code, 0, init.stderr);
  assert.equal(init.out.user_version, 5);
  projectKey = init.out.project_key;
  runId = cli('run', 'start', '--mode', 'full').out.run_id;
  const lines = [
    ...['onboarding tour', 'onboarding checklist', 'skip onboarding'].map((topic, i) => candidate({
      lens: 'opportunity', kind: 'gap', topic, anchors: [`src/onb-${i}.js`], title: `Onboarding idea ${i}`, evidence: [CODE],
    })),
    candidate({ lens: 'security-cra', kind: 'secret', topic: 'plaintext password', title: 'Password compared in plaintext', evidence: [CODE] }),
  ];
  writeFileSync(join(work, 'c.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const p = cli('propose', '--run', runId, '--file', join(work, 'c.jsonl'), '--kinds', 'opportunity=gap', '--kinds', 'security-cra=secret');
  assert.equal(p.code, 0, p.stdout);
  const fps = p.lines.filter((/** @type {any} */ l) => l.fp).map((/** @type {any} */ l) => l.fp);
  assert.equal(cli('verify', '--run', runId).code, 0);
  rejected = fps.slice(0, 3);
  accepted = fps[3];
  for (const fp of rejected) assert.equal(cli('move', fp, '--to', 'rejected', '--by', 'human:ann', '--reason', 'not-our-direction').code, 0);

  // before any offer: nothing to send, but the call is still worth making (decisions and outcomes come back)
  assert.deepEqual(cli('reflect', 'export').out, { project_key: projectKey }, 'rules_json omitted when nothing is offered');

  const offers = cli('rules', 'offer').out.offers;
  assert.equal(offers.length, 1);
  offer = offers[0];
  const before = rows('SELECT * FROM rules');
  const ex = cli('reflect', 'export');
  assert.equal(ex.code, 0, ex.stderr);
  assert.deepEqual(Object.keys(ex.out).sort(), ['project_key', 'rules_json']);
  assert.equal(ex.out.project_key, projectKey);
  const sent = JSON.parse(ex.out.rules_json);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'lens', 'offered_at', 'text', 'titles']);
  assert.equal(sent[0].id, offer.id);
  assert.equal(sent[0].lens, 'opportunity');
  assert.equal(sent[0].text, offer.text);
  assert.deepEqual(sent[0].titles.slice().sort(), ['Onboarding idea 0', 'Onboarding idea 1', 'Onboarding idea 2']);
  assert.deepEqual(cli('reflect', 'export').out, ex.out, 'export is repeatable');
  assert.deepEqual(rows('SELECT * FROM rules'), before, 'export writes nothing');
  assert.equal(cli('reflect').code, 2);
  assert.equal(cli('reflect', 'ingest').code, 2, '--file is required');
});

test('export caps at 50 rules and 10 titles each, oldest first, and says `more`', () => {
  const dir = tempDir('refl-cap');
  const s = openStore(join(dir, 's.db'));
  try {
    for (let i = 0; i < 51; i++) {
      const cluster = JSON.stringify({ fps: Array.from({ length: 12 }, (_, k) => `nope-${k}`) });
      s.prepare("INSERT INTO rules (id, lens, text, cluster_json, state, offered_at) VALUES (?, 'opportunity', ?, ?, 'offered', ?)")
        .run(`rule-${String(i).padStart(3, '0')}`, `text ${i}`, cluster, `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    }
    const out = exportOffers(s, 'k');
    const sent = JSON.parse(out.rules_json);
    assert.equal(sent.length, 50);
    assert.equal(sent[0].id, 'rule-000');
    assert.equal(sent[49].id, 'rule-049');
    assert.equal(sent[0].titles, undefined, 'unknown fingerprints give no titles; the key is omitted');
    assert.equal(out.more, true);
    const fp = 'f'.repeat(16);
    s.prepare("INSERT INTO runs (id, started_at, mode) VALUES ('r', 't', 'full')").run();
    for (let k = 0; k < 12; k++) {
      s.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence, confidence_why,
        provenance_json, status, first_run_id, last_run_id, created_at, updated_at) VALUES (?, 'opportunity', 'gap', 't', '[]', ?, 'r', 'b', '{}', 'high', 'q', '{}', 'rejected', 'r', 'r', 't', 't')`).run(`${fp.slice(0, 14)}${String(k).padStart(2, '0')}`, `T${k}`);
    }
    s.prepare("UPDATE rules SET cluster_json = ? WHERE id = 'rule-000'").run(JSON.stringify({ fps: Array.from({ length: 12 }, (_, k) => `${fp.slice(0, 14)}${String(k).padStart(2, '0')}`) }));
    assert.equal(JSON.parse(exportOffers(s, 'k').rules_json)[0].titles.length, 10, 'titles are capped at 10');
  } finally { s.close(); removeDir(dir); }
});

test('ingest: a decision is a CAS offered -> accepted|declined by the Forge decider; replays and non-offered rules are skipped', () => {
  const decision = { id: offer.id, lens: 'opportunity', state: 'accepted', text: 'Skip onboarding ideas unless they cut time-to-value', decided_by: 'forge:acct-1', decided_at: '2026-10-02T09:00:00.000Z' };
  const f = save('r1.json', { rules: [decision, { ...decision, id: 'rule-unknown' }], outcomes: [] });
  const r = cli('reflect', 'ingest', '--file', f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out, { rules_applied: 1, rules_skipped: 1, outcomes_added: 0, outcomes_seen: 0 });
  const rule = cli('rules', 'list').out.rules[0];
  assert.equal(rule.state, 'accepted');
  assert.equal(rule.text, decision.text);
  assert.equal(rule.decided_at, decision.decided_at);
  assert.equal(rule.cluster.decided_by, 'forge:acct-1');
  assert.equal(rule.cluster.draft_text, offer.text, 'the draft survives next to the edited wording');
  assert.equal(cli('context', '--run', runId, '--lens', 'opportunity').out.rules[0].text, decision.text, 'an accepted rule reaches context');

  // a replay, and a contradicting decision, never touch a rule that is no longer offered
  assert.deepEqual(cli('reflect', 'ingest', '--file', f).out, { rules_applied: 0, rules_skipped: 2, outcomes_added: 0, outcomes_seen: 0 });
  const flip = save('r2.json', { rules: [{ ...decision, state: 'declined', text: undefined }], outcomes: [] });
  assert.deepEqual(cli('reflect', 'ingest', '--file', flip).out.rules_applied, 0);
  assert.equal(cli('rules', 'list').out.rules[0].state, 'accepted');
  // and nothing exported once nothing is offered
  assert.equal(cli('reflect', 'export').out.rules_json, undefined);
});

test('ingest: a bare Forge account id becomes forge:<id>; a malformed entry is reported (exit 1), the rest applied', () => {
  const f = save('r3.json', { rules: [{ id: 5 }, { id: 'x', state: 'maybe', decided_by: 'forge:a' }, { id: 'x', state: 'declined' }], outcomes: [
    { ref: 'DW-9', fp: 'a'.repeat(16), rating: 'right', issue_ref: 'MOCK-9', decided_by: '712020:abc-def', recorded_at: '2026-10-03T00:00:00.000Z' },
    { ref: 'DW-9', fp: 'a'.repeat(16), rating: 'great', issue_ref: 'MOCK-9', decided_by: 'forge:a', recorded_at: '2026-10-03T00:00:01.000Z' },
  ] });
  const r = cli('reflect', 'ingest', '--file', f);
  assert.equal(r.code, 1);
  assert.equal(r.out.outcomes_added, 1);
  assert.equal(r.out.outcomes_seen, 2);
  assert.deepEqual(r.out.invalid.map((/** @type {any} */ i) => i.kind), ['rule', 'rule', 'rule', 'outcome']);
  assert.equal(rows("SELECT decided_by FROM outcomes WHERE ref = 'DW-9'")[0].decided_by, 'forge:712020:abc-def');
  assert.equal(cli('reflect', 'ingest', '--file', save('bad.json', { rules: [] })).code, 2, 'not a reflect response');
  assert.equal(cli('reflect', 'ingest', '--file', save('err.json', { isError: true, content: [] })).code, 2);
});

test('verdict notes on accepted and snoozed verdicts are kept on the transition and the card', () => {
  const at = '2026-10-04T00:00:00.000Z';
  const refs = { [accepted]: 'DW-77' };
  // the item went through the inbox first: verified -> pushed, then a person accepts it there
  assert.equal(cli('outbox', '--run', runId).code, 0);
  const pushedDoc = save('push.json', { results: [{ fp: accepted, result: 'created', external_ref: 'DW-77', external_url: 'https://mock-forge.example/inbox/DW-77' }] });
  assert.equal(cli('ingest-push', '--file', pushedDoc).code, 0);
  const f = save('v.json', { verdicts: [{ fp: accepted, status: 'accepted', note: 'Ship it this sprint', decided_by: 'forge:jane', decided_at: at, external_ref: refs[accepted], issue_ref: 'SHOP-7', issue_url: 'https://j/SHOP-7' }], cursor: '1' });
  const iv = cli('ingest-verdicts', '--file', f);
  assert.equal(iv.code, 0, iv.stdout + iv.stderr);
  const shown = cli('show', accepted);
  assert.equal(shown.out.card.note, 'Ship it this sprint');
  assert.equal(shown.out.transitions.at(-1).note, 'Ship it this sprint');
  assert.equal(shown.out.outcomes, undefined, 'no outcome yet: the key is omitted');
  // snoozed: a verified item from another run
  // a snoozed verdict needs the item pushed too
  const snz = cli('propose', '--run', runId, '--file', (() => {
    writeFileSync(join(work, 'z.jsonl'), `${JSON.stringify(candidate({ lens: 'doc-drift', kind: 'stale', topic: 'stale setup guide', anchors: ['docs/setup.md'], evidence: [CODE] }))}\n`);
    return join(work, 'z.jsonl');
  })(), '--kinds', 'doc-drift=stale');
  const zfp = snz.lines[0].fp;
  assert.equal(cli('verify', '--run', runId).code, 0);
  assert.equal(cli('outbox', '--run', runId).code, 0);
  assert.equal(cli('ingest-push', '--file', save('push2.json', { results: [{ fp: zfp, result: 'created', external_ref: 'DW-78', external_url: 'https://mock-forge.example/inbox/DW-78' }] })).code, 0);
  const g = save('v2.json', { verdicts: [{ fp: zfp, status: 'snoozed', note: 'After the redesign', decided_by: 'forge:jane', decided_at: at, external_ref: 'DW-78' }], cursor: '2' });
  assert.equal(cli('ingest-verdicts', '--file', g).code, 0);
  assert.equal(cli('show', zfp).out.transitions.at(-1).note, 'After the redesign');
});

test('mock round trip over stdio: offer, person decides in Forge, person rates the result, ingest, context and show', async () => {
  const names = (await rpc('tools/list')).result.tools.map((/** @type {any} */ t) => t.name);
  for (const n of ['dowser_reflect_sync', 'mock_decide_rule', 'mock_outcome']) assert.ok(names.includes(n), n);
  for (const t of TOOLS) for (const [k, v] of Object.entries(t.inputSchema.properties)) assert.ok(['string', 'integer'].includes(/** @type {any} */ (v).type), `${t.name}.${k} is scalar`);

  // a second cluster so there is a fresh offer to carry
  const fps = [];
  for (const topic of ['pricing banner', 'pricing popup', 'pricing modal']) {
    writeFileSync(join(work, 'p.jsonl'), `${JSON.stringify(candidate({ lens: 'ux-friction', kind: 'dead-end', topic, anchors: [`src/${topic.replace(' ', '-')}.js`], title: `Pricing ${topic}`, evidence: [CODE] }))}\n`);
    const p = cli('propose', '--run', runId, '--file', join(work, 'p.jsonl'), '--kinds', 'ux-friction=dead-end');
    assert.equal(p.code, 0, p.stdout);
    fps.push(p.lines[0].fp);
  }
  assert.equal(cli('verify', '--run', runId).code, 0);
  for (const fp of fps) assert.equal(cli('move', fp, '--to', 'rejected', '--by', 'human:ann', '--reason', 'false-positive').code, 0);
  const offer2 = cli('rules', 'offer').out.offers[0];
  assert.equal(offer2.lens, 'ux-friction');

  // the accepted item reached the mock inbox (the agent pushed it)
  const ob = cli('outbox', '--run', runId); // the security item is already `accepted`; push nothing it must not
  assert.equal(ob.code, 0, ob.stderr);
  await tool('dowser_proposals_push', { project_key: projectKey, run_id: runId, proposals_json: JSON.stringify([{ fp: accepted, title: 'Password compared in plaintext', status: 'verified', evidence: [CODE] }]) });
  await tool('mock_decide', { project_key: projectKey, fp: accepted, status: 'accepted', decided_by: 'forge:jane' });
  const ref = (await tool('mock_inbox', { fp: accepted })).item.external_ref;

  // 1. export -> tool: the offer is stored `offered`; nothing decided yet
  const ex = cli('reflect', 'export');
  assert.equal(JSON.parse(ex.out.rules_json).length, 1, 'only the still-offered rule goes out');
  assert.deepEqual(await tool('dowser_reflect_sync', ex.out), { rules: [], outcomes: [] });
  assert.deepEqual(await tool('dowser_reflect_sync', ex.out), { rules: [], outcomes: [] }, 'idempotent');

  // 2. people act in Forge
  await tool('mock_decide_rule', { project_key: projectKey, id: offer2.id, state: 'declined', decided_by: 'forge:jane' });
  const r1 = await tool('mock_outcome', { ref, rating: 'wrong', note: 'Broke the SSO login', decided_by: 'forge:jane' });
  assert.equal(r1.outcome.fp, accepted);
  assert.equal(r1.outcome.issue_ref.startsWith('MOCK-'), true);
  await assert.rejects(tool('mock_outcome', { ref: 'DW-999', rating: 'right' }));

  // a decided rule is never reverted by a later offer
  const back = await tool('dowser_reflect_sync', ex.out);
  assert.deepEqual(back.rules.map((/** @type {any} */ r) => [r.id, r.state, r.decided_by]), [[offer2.id, 'declined', 'forge:jane']]);
  assert.equal(back.outcomes.length, 1);

  // 3. ingest: rule declined locally, outcome appended; a replay changes nothing
  const f = save('sync1.json', back);
  const ing = cli('reflect', 'ingest', '--file', f);
  assert.equal(ing.code, 0, ing.stderr);
  assert.deepEqual(ing.out, { rules_applied: 1, rules_skipped: 0, outcomes_added: 1, outcomes_seen: 1 });
  assert.deepEqual(cli('reflect', 'ingest', '--file', f).out, { rules_applied: 0, rules_skipped: 1, outcomes_added: 0, outcomes_seen: 1 });
  assert.equal(cli('rules', 'list', '--lens', 'ux-friction').out.rules[0].state, 'declined');
  assert.equal(cli('rules', 'offer').out.offers.length, 0, 'a declined cluster is not offered again');
  assert.equal(cli('reflect', 'export').out.rules_json, undefined);

  // 4. context weighs accepted-but-wrong patterns; show lists the rows; status is unchanged
  const ctx = cli('context', '--run', runId, '--lens', 'security-cra');
  assert.deepEqual(ctx.out.outcomes, { right: 0, partly: 0, wrong: 1 });
  assert.equal(cli('context', '--run', runId, '--lens', 'opportunity').out.outcomes, undefined, 'omitted when the lens has none');
  const shown = cli('show', accepted).out.outcomes;
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], { ref, rating: 'wrong', note: 'Broke the SSO login', issue_ref: r1.outcome.issue_ref, decided_by: 'forge:jane', recorded_at: r1.outcome.recorded_at });

  // a later rating of the same item is a new row; context counts the latest per item
  await tool('mock_outcome', { ref, rating: 'right' });
  const sync2 = await tool('dowser_reflect_sync', { project_key: projectKey });
  assert.equal(sync2.outcomes.length, 2);
  assert.deepEqual(cli('reflect', 'ingest', '--file', save('sync2.json', sync2)).out, { rules_applied: 0, rules_skipped: 1, outcomes_added: 1, outcomes_seen: 2 });
  assert.deepEqual(cli('context', '--run', runId, '--lens', 'security-cra').out.outcomes, { right: 1, partly: 0, wrong: 0 });
  assert.equal(cli('show', accepted).out.outcomes.length, 2);
  assert.equal(cli('status').code, 0);
});

test('outcomes are append-only at the database level, and unique per (fp, recorded_at)', () => {
  const db = new DatabaseSync(cli('init').out.db);
  try {
    assert.throws(() => db.exec('UPDATE outcomes SET note = note'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM outcomes'), /append-only/);
    assert.throws(() => db.exec("INSERT INTO outcomes (fp, ref, rating, issue_ref, decided_by, recorded_at) VALUES ('f', 'r', 'meh', 'i', 'forge:x', 't')"), /CHECK/);
  } finally { db.close(); }
});

test('mock backend: reflect_sync validates its input', () => {
  const b = emptyBackend();
  assert.throws(() => callTool(b, 'dowser_reflect_sync', {}), /project_key/);
  assert.throws(() => callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: '{}' }), /JSON array/);
  assert.throws(() => callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify([{ id: 'a', lens: 'opportunity', text: 't' }]) }), /offered_at/);
  const over = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, lens: 'opportunity', text: 't', offered_at: 'x' }));
  assert.throws(() => callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify(over) }), /at most 50/);
  const titles = [{ id: 'a', lens: 'opportunity', text: 't', offered_at: 'x', titles: Array.from({ length: 11 }, () => 'y') }];
  assert.throws(() => callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify(titles) }), /titles/);
  // an offered rule takes new wording; a decided one keeps its decision
  callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify([{ id: 'a', lens: 'opportunity', text: 'one', offered_at: 'x' }]) });
  callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify([{ id: 'a', lens: 'opportunity', text: 'two', offered_at: 'x' }]) });
  callTool(b, 'mock_decide_rule', { project_key: 'k', id: 'a', state: 'accepted', text: ' edited ' });
  const out = callTool(b, 'dowser_reflect_sync', { project_key: 'k', rules_json: JSON.stringify([{ id: 'a', lens: 'opportunity', text: 'three', offered_at: 'x' }]) });
  assert.deepEqual(out.rules.map((/** @type {any} */ r) => [r.state, r.text]), [['accepted', 'edited']]);
  assert.throws(() => callTool(b, 'mock_decide_rule', { project_key: 'k', id: 'a', state: 'declined' }), /already accepted/);
});
