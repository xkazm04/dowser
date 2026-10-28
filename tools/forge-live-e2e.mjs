#!/usr/bin/env node
// @ts-check
// forge-live-e2e - drives the dowser CLI on a throwaway fixture repo against the LIVE Forge app, calling the
// MCP tools through a headless `claude -p` run from this repository (the `dowser` MCP server is registered
// for this project; a session that started before `claude mcp add` cannot see the tools, a fresh process can).
// Work files and the fixture's memory live in the OS temp folder, never in a scanned repo.
//
//   node tools/forge-live-e2e.mjs prep     fixture repo + init + run start + 2 proposals + verify
//   node tools/forge-live-e2e.mjs push     outbox -> dowser_proposals_push -> ingest-push
//   node tools/forge-live-e2e.mjs areas    areas -> dowser_areas_push
//   node tools/forge-live-e2e.mjs pull     dowser_verdicts_pull -> ingest-verdicts -> show each proposal
//   node tools/forge-live-e2e.mjs tool <name> <args.json>   one raw tool call
//
// Between push and pull, decide the items in the Jira inbox (Accept needs an inbox setting: Jira project +
// issue type). Set DOWSER_E2E_DIR to reuse a work folder; delete it to start over.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'skill/scripts/dowser.mjs');
const { candidate, gitRepo } = await import(new URL('../skill/scripts/tests/_fixture.mjs', import.meta.url).href);
const WORK = process.env.DOWSER_E2E_DIR ?? join(tmpdir(), 'dowser-live-e2e');
const repo = join(WORK, 'repo');
const home = join(WORK, 'home');
const statePath = join(WORK, 'state.json');
mkdirSync(WORK, { recursive: true });
/** @type {{project_key?: string, run_id?: string, fps?: string[], cursor?: string}} */
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

/**
 * Runs the dowser CLI against the fixture; exits on failure. Returns the parsed JSON, or the JSON lines.
 * @param {...string} args
 * @returns {any}
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: WORK });
  if (r.status !== 0) { console.error(`dowser ${args.join(' ')} -> ${r.status}\n${r.stderr}${r.stdout}`); process.exit(1); }
  try { return JSON.parse(r.stdout); } catch { return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
}

/**
 * Calls one live tool through headless Claude Code, passing `args` unedited. Matches the environment suffix a
 * non-production install adds (`dowser_verdicts_pull_development`).
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {any}
 */
function tool(name, args) {
  const argFile = join(WORK, `${name}.args.json`);
  writeFileSync(argFile, JSON.stringify(args));
  const prompt = `Read the JSON object in the file ${argFile.replace(/\\/g, '/')}. Call the MCP tool from the "dowser" server whose name ends with "${name}" or "${name}_development" or "${name}_staging", passing exactly that object's keys and values as the arguments, unedited. Then output ONLY the raw text of the tool result, verbatim, with no commentary and no code fences.`;
  const out = execFileSync(process.env.CLAUDE_BIN ?? 'claude', ['-p', prompt, '--allowedTools', 'mcp__dowser__*', 'Read', '--output-format', 'text'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  writeFileSync(join(WORK, `${name}.result.txt`), out);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) { console.error(`no JSON in the ${name} output:\n${out}`); process.exit(1); }
  return JSON.parse(m[0]);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'prep') {
  if (existsSync(join(repo, '.git'))) { console.error(`${repo} exists; delete ${WORK} to start over`); process.exit(1); }
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitRepo(repo, {
    'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n',
    'src/api/rate.js': 'export const limit = null; // TODO rate limit\n',
    'docs/guide/setup.md': '# Setup\nRun `npm start`.\n',
  });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/xkazm04/dowser-e2e.git']);
  const init = cli('init');
  const start = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'e2e');
  const code = { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' };
  writeFileSync(join(WORK, 'sec.jsonl'), [
    candidate({ evidence: [code] }),
    candidate({ topic: 'Login has no rate limit', title: 'Login can be brute-forced', kind: 'vuln', anchors: ['src/api/rate.js#limit'],
      evidence: [code, { type: 'code', ref: 'src/api/rate.js:1', quote: 'export const limit = null; // TODO rate limit' }] }),
  ].map((c) => JSON.stringify(c)).join('\n') + '\n');
  const lines = cli('propose', '--run', start.run_id, '--file', join(WORK, 'sec.jsonl'), '--kinds', 'security-cra=secret,vuln');
  cli('verify', '--run', start.run_id);
  Object.assign(state, { project_key: init.project_key, run_id: start.run_id, fps: [].concat(lines).map((/** @type {any} */ l) => l.fp).filter(Boolean) });
  save();
  console.log(JSON.stringify(state, null, 2));
} else if (cmd === 'push') {
  const { more, ...args } = cli('outbox', '--run', state.run_id ?? '');
  const pushed = tool('dowser_proposals_push', args);
  console.log('push:', JSON.stringify(pushed, null, 2), more ? '\n(more pending: push again)' : '');
  if (pushed.error) process.exit(1);
  writeFileSync(join(WORK, 'push.json'), JSON.stringify(pushed));
  console.log('ingest-push:', JSON.stringify(cli('ingest-push', '--file', join(WORK, 'push.json')).summary));
} else if (cmd === 'areas') {
  console.log('areas:', JSON.stringify(tool('dowser_areas_push', cli('areas', '--run', state.run_id ?? ''))));
} else if (cmd === 'pull') {
  const res = tool('dowser_verdicts_pull', { project_key: state.project_key, ...(state.cursor ? { cursor: state.cursor } : {}) });
  console.log('pull:', JSON.stringify(res, null, 2));
  if (res.error) process.exit(1);
  writeFileSync(join(WORK, 'verdicts.json'), JSON.stringify(res));
  console.log('ingest-verdicts:', JSON.stringify(cli('ingest-verdicts', '--file', join(WORK, 'verdicts.json')).summary));
  state.cursor = res.cursor;
  save();
  for (const fp of state.fps ?? []) {
    const { card } = cli('show', fp);
    console.log(fp, card.status, card.external_ref ?? '', card.issue_ref ?? '');
  }
} else if (cmd === 'tool') {
  console.log(JSON.stringify(tool(rest[0], JSON.parse(readFileSync(rest[1], 'utf8'))), null, 2));
} else {
  console.error('usage: prep | push | areas | pull | tool <name> <args.json>');
  process.exit(2);
}
