// @ts-check
// DW-193: "Let the first connected scan create its inbox instead of refusing to push". Only a push creates an inbox, and
// the pull before it answers `unknown-project`. The pull rule exempts that answer (no inbox yet: a first scan goes on and
// pushes); every other pull error still disables the push. The CLI flow at the end is coverage: the CLI never gated this.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, removeDir, tempDir } from './_fixture.mjs';
import { callTool, emptyBackend } from '../../../tools/mock-forge-mcp.mjs';

const at = (/** @type {string} */ rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (/** @type {string} */ rel) => readFileSync(at(rel), 'utf8').replace(/\r\n/g, '\n');
const CLI = at('../dowser.mjs');

const FIRST_RUN = /no inbox|first (connected )?(scan|run|push)/i;
const GOES_ON = /(go|goes|carry|carries|continue)s?\b[^.]*\bon\b|\bstill push|\bpush(es)? (as usual|anyway|goes)|not an error|expected/i;
const OTHER_STOPS = /\b(any|every|all) other\b[^]*?(unconnected|must not push|disables? the push|no push)/i;

/** The paragraphs of a document that hold the rule about a failed pull and the push. @param {string} doc */
const pullRule = (doc) => doc.split(/\n\s*\n/).filter((p) => /\b(half-synced|disables? the push)\b/i.test(p)).join('\n\n');

for (const [name, rel] of [['SKILL.md', '../../SKILL.md'], ['the contract', '../../../docs/contracts/forge-mcp-2.md']]) {
  test(`DW-193: ${name}: the pull rule exempts unknown-project, and a first scan goes on and pushes`, () => {
    const rule = pullRule(read(rel));
    assert.ok(rule, 'the rule about a failed pull is still there');
    assert.match(rule, /`?unknown-project`?/, 'the rule names the exempt answer');
    assert.match(rule, FIRST_RUN, 'it says why: no inbox yet, a first scan');
    assert.match(rule, GOES_ON, 'it says the scan goes on');
  });

  test(`DW-193: ${name}: every other pull error still disables the push`, () => {
    assert.match(pullRule(read(rel)), OTHER_STOPS);
  });
}

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;
before(() => {
  home = tempDir('first-home');
  repo = tempDir('first-repo');
  work = tempDir('first-work');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
});
after(() => { removeDir(home); removeDir(repo); removeDir(work); });

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; } // propose prints one line per candidate
  return { code: r.status, out, stderr: r.stderr };
}

// The mock's pull does not model the refusal: it answers an empty page for a project it has not seen, where Forge answers
// unknown-project, so this flow skips the pull as a run does once it holds the answer.
test('DW-193: a first run: with no ingest of a pull the CLI lets the push through, and the inbox exists after', () => {
  const backend = emptyBackend();
  const projectKey = cli('init').out.project_key;
  const runId = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm').out.run_id;
  const code = { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' };
  const file = join(work, 'c.jsonl');
  writeFileSync(file, `${JSON.stringify(candidate({ kind: 'secret-exposure', evidence: [code] }))}\n`);
  assert.equal(cli('propose', '--run', runId, '--file', file).code, 0);
  assert.equal(cli('verify', '--run', runId).code, 0);
  const ob = cli('outbox', '--run', runId);
  assert.equal(ob.code, 0, ob.stderr);
  const pushed = /** @type {any} */ (callTool(backend, 'dowser_proposals_push', ob.out));
  assert.deepEqual(pushed.results.map((/** @type {any} */ r) => r.result), ['created']);
  assert.deepEqual(/** @type {any} */ (callTool(backend, 'dowser_verdicts_pull', { project_key: projectKey })).verdicts, []);
});
