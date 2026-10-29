// @ts-check
// `dowser deps`: auditors run read-only, findings are cached as `dep` source rows, absent or failing auditors are
// reported as skipped with a reason (never as clean), and a re-run of the same run upserts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, runStart } from '../lib/store.mjs';
import { sourcesOf } from '../lib/sync.mjs';
import { SYSTEM, npmFindings, osvFindings, pipFindings, runDeps, severityOf } from '../lib/deps.mjs';
import { listFiles, removeDir, tempDir, writeFiles } from './_fixture.mjs';

/** @type {string} */ let home;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string[]} */ const dirs = [];

before(() => {
  home = tempDir('deps-home');
  db = openStore(join(home, 'dowser.db'));
});
after(() => { db.close(); removeDir(home); for (const d of dirs) removeDir(d); });

/** @param {Record<string, string>} files */
function repoWith(files) {
  const d = tempDir('deps-repo');
  dirs.push(d);
  writeFiles(d, files);
  return d;
}

/** Every file's sha256, so a test can assert the repo is byte-identical after a run. @param {string} root */
const snapshot = (root) => Object.fromEntries(listFiles(root).map((f) => [f, createHash('sha256').update(readFileSync(join(root, f))).digest('hex')]));

const LOCK = JSON.stringify({
  name: 'shop', lockfileVersion: 3,
  packages: { '': { name: 'shop' }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/a/node_modules/minimist': { version: '1.2.5' } },
});

const NPM_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash', severity: 'high', nodes: ['node_modules/lodash'], fixAvailable: { name: 'lodash', version: '4.17.21' },
      via: [
        { source: 1, name: 'lodash', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695', severity: 'critical' },
        { source: 2, name: 'lodash', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9', severity: 'moderate' },
      ],
    },
    minimist: { name: 'minimist', severity: 'moderate', nodes: ['node_modules/a/node_modules/minimist'], fixAvailable: true,
      via: [{ source: 3, url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', severity: 'moderate' }] },
    a: { name: 'a', severity: 'moderate', nodes: ['node_modules/a'], via: ['minimist'] },
  },
};

const OSV_REPORT = (/** @type {string} */ root) => ({
  results: [{
    source: { path: join(root, 'package-lock.json'), type: 'lockfile' },
    packages: [{
      package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
      vulnerabilities: [
        { id: 'GHSA-jf85-cpcp-j695', aliases: ['CVE-2019-10744'], database_specific: { severity: 'CRITICAL' },
          affected: [{ package: { name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.12' }] }] }] },
        { id: 'CVE-2019-10744', aliases: ['GHSA-jf85-cpcp-j695'] },
      ],
      groups: [{ ids: ['GHSA-jf85-cpcp-j695', 'CVE-2019-10744'], max_severity: '9.1' }],
    }],
  }],
});

/**
 * A fake System: `tools` maps a command name to its scripted answer; an unlisted command is not installed.
 * @param {Record<string, (args: string[], cwd: string) => import('../lib/deps.mjs').SpawnResult>} tools
 */
function fakeSys(tools) {
  /** @type {{cmd: string, args: string[], cwd: string}[]} */
  const calls = [];
  /** @type {import('../lib/deps.mjs').System} */
  const sys = {
    which: (cmd) => (tools[cmd] ? `/fake/bin/${cmd}` : undefined),
    spawn: (path, args, cwd) => {
      const cmd = String(path.split('/').pop());
      calls.push({ cmd, args, cwd });
      return tools[cmd](args, cwd);
    },
  };
  return { sys, calls };
}

/** @param {unknown} doc @param {number} [status] */
const answer = (doc, status = 1) => ({ status, stdout: JSON.stringify(doc), stderr: '' });

test('severityOf: words and CVSS scores', () => {
  assert.equal(severityOf('MODERATE'), 'moderate');
  assert.equal(severityOf('medium'), 'moderate');
  assert.equal(severityOf('9.8'), 'critical');
  assert.equal(severityOf('7.5'), 'high');
  assert.equal(severityOf(undefined), 'unknown');
});

test('parsers: npm audit v2 (version from the lockfile, string via skipped), osv groups, pip-audit', () => {
  const npm = npmFindings(NPM_REPORT, JSON.parse(LOCK));
  assert.deepEqual(npm.map((f) => `${f.package}@${f.version} ${f.advisory} ${f.severity} ${f.fixed_in ?? '-'}`), [
    'lodash@4.17.20 GHSA-jf85-cpcp-j695 critical 4.17.21',
    'lodash@4.17.20 GHSA-29mw-wpgm-hmr9 moderate 4.17.21',
    'minimist@1.2.5 GHSA-xvch-5gv4-984h moderate -',
  ]);
  const osv = osvFindings(OSV_REPORT('/r'), '/r');
  assert.equal(osv.length, 1, 'the CVE alias of the GHSA counts once');
  assert.deepEqual(osv[0], { manifest: 'package-lock.json', package: 'lodash', version: '4.17.20', advisory: 'GHSA-jf85-cpcp-j695',
    severity: 'critical', url: 'https://osv.dev/vulnerability/GHSA-jf85-cpcp-j695', fixed_in: '4.17.12', tool: 'osv-scanner' });
  const pip = pipFindings({ dependencies: [{ name: 'flask', version: '0.12', vulns: [{ id: 'PYSEC-2019-179', fix_versions: ['1.0'] }] }, { name: 'ok', version: '1', vulns: [] }] }, 'requirements.txt');
  assert.deepEqual(pip, [{ manifest: 'requirements.txt', package: 'flask', version: '0.12', advisory: 'PYSEC-2019-179', severity: 'unknown',
    url: 'https://osv.dev/vulnerability/PYSEC-2019-179', fixed_in: '1.0', tool: 'pip-audit' }]);
});

test('deps caches dep rows, reports ran/skipped honestly, leaves the repo byte-identical, and re-runs upsert', () => {
  const repo = repoWith({ 'package.json': '{"name":"shop"}', 'package-lock.json': LOCK, 'requirements.txt': 'flask==0.12\n', 'src/a.js': 'x\n' });
  const before = snapshot(repo);
  const run = runStart(db, { mode: 'full' }).id;
  const { sys, calls } = fakeSys({
    npm: () => answer(NPM_REPORT),
    'osv-scanner': (_a, cwd) => answer(OSV_REPORT(cwd)),
    // pip-audit is installed but fails: skipped with the first line of its error, not "clean"
    'pip-audit': () => ({ status: 2, stdout: '', stderr: '\nERROR: could not resolve flask==0.12\nmore detail' }),
  });
  const out = runDeps(db, { root: repo, runId: run }, sys).out;
  assert.deepEqual(out.auditors, [
    { tool: 'npm-audit', state: 'ran', found: 2 },
    { tool: 'osv-scanner', state: 'ran', found: 1 },
    { tool: 'pip-audit', state: 'skipped', reason: 'requirements.txt: ERROR: could not resolve flask==0.12' },
  ]);
  assert.deepEqual(out.refs, [
    { type: 'dep', ref: 'package-lock.json#lodash@4.17.20', title: 'GHSA-jf85-cpcp-j695 critical', url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695', fixed_in: '4.17.21' },
    { type: 'dep', ref: 'package-lock.json#minimist@1.2.5', title: 'GHSA-xvch-5gv4-984h moderate', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h' },
  ]);
  assert.ok(calls.every((c) => c.cwd === repo), 'every auditor runs with cwd = the repo root');
  assert.deepEqual(calls.find((c) => c.cmd === 'npm')?.args, ['audit', '--json', '--package-lock-only']);
  assert.deepEqual(calls.find((c) => c.cmd === 'osv-scanner')?.args, ['--format', 'json', '--lockfile=package-lock.json', '--lockfile=requirements.txt']);

  const rows = sourcesOf(db, run, 'dep');
  assert.equal(rows.length, 2);
  const lodash = rows.find((r) => r.ref === 'package-lock.json#lodash@4.17.20');
  assert.equal(lodash?.url, 'https://github.com/advisories/GHSA-jf85-cpcp-j695');
  assert.deepEqual(JSON.parse(String(lodash?.body)), {
    package: 'lodash', version: '4.17.20', advisory: 'GHSA-jf85-cpcp-j695', severity: 'critical', fixed_in: '4.17.21', tool: 'npm-audit',
    advisories: ['GHSA-jf85-cpcp-j695', 'GHSA-29mw-wpgm-hmr9'],
  });
  const minimist = JSON.parse(String(rows.find((r) => r.ref.endsWith('minimist@1.2.5'))?.body));
  assert.equal('fixed_in' in minimist, false, 'no fixed version known: the key is omitted');

  runDeps(db, { root: repo, runId: run }, sys);
  assert.equal(sourcesOf(db, run, 'dep').length, 2, 'a re-run upserts, no duplicates');
  assert.deepEqual(snapshot(repo), before, 'the repo is byte-identical after deps');
});

test('a repo with no manifests reports every auditor skipped with a reason and caches nothing', () => {
  const repo = repoWith({ 'README.md': '# hi\n' });
  const before = snapshot(repo);
  const run = runStart(db, { mode: 'full' }).id;
  const { sys, calls } = fakeSys({ npm: () => answer({}), 'osv-scanner': () => answer({}), 'pip-audit': () => answer({}) });
  const out = runDeps(db, { root: repo, runId: run }, sys).out;
  assert.deepEqual(out.auditors, [
    { tool: 'npm-audit', state: 'skipped', reason: 'no package.json or package-lock.json' },
    { tool: 'osv-scanner', state: 'skipped', reason: 'no lockfile osv-scanner reads' },
    { tool: 'pip-audit', state: 'skipped', reason: 'no requirements*.txt or pyproject.toml' },
  ]);
  assert.deepEqual(out.refs, []);
  assert.equal(calls.length, 0, 'nothing is spawned without a manifest');
  assert.equal(sourcesOf(db, run, 'dep').length, 0);
  assert.deepEqual(snapshot(repo), before);
});

test('absent tools are "not installed"; an npm error report and a timeout are skipped, never clean', () => {
  const repo = repoWith({ 'package-lock.json': LOCK, 'pyproject.toml': '[project]\nname = "x"\n' });
  const run = runStart(db, { mode: 'full' }).id;
  const none = runDeps(db, { root: repo, runId: run }, fakeSys({}).sys).out;
  assert.deepEqual(none.auditors.map((a) => `${a.tool}:${a.state}:${a.reason}`), [
    'npm-audit:skipped:not installed', 'osv-scanner:skipped:not installed', 'pip-audit:skipped:not installed',
  ]);
  const broken = runDeps(db, { root: repo, runId: run }, fakeSys({
    npm: () => answer({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.\nsecond' } }),
    'osv-scanner': () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync osv-scanner ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
    'pip-audit': (args) => answer({ dependencies: [] }, args.includes('.') ? 0 : 9),
  }).sys).out;
  assert.deepEqual(broken.auditors, [
    { tool: 'npm-audit', state: 'skipped', reason: 'Your configured registry does not support audit requests.' },
    { tool: 'osv-scanner', state: 'skipped', reason: 'timed out after 60 s' },
    { tool: 'pip-audit', state: 'ran', found: 0 },
  ]);
  assert.deepEqual(runDeps(db, { root: repo, runId: run }, fakeSys({ npm: () => answer({}, 0) }).sys).out.auditors[0], { tool: 'npm-audit', state: 'ran', found: 0 },
    'a measured zero is reported as found: 0');
  const lockless = repoWith({ 'package.json': '{}' });
  assert.equal(runDeps(db, { root: lockless, runId: run }, fakeSys({ npm: () => answer({}) }).sys).out.auditors[0].reason,
    'package.json without package-lock.json; npm audit needs a lockfile');
});

test('the real System finds and runs an auditor stub on PATH, in the repo root', () => {
  const bin = tempDir('deps-bin');
  dirs.push(bin);
  const repo = repoWith({ 'Cargo.lock': '# lock\n' });
  const report = { results: [{ source: { path: 'Cargo.lock' }, packages: [{ package: { name: 'time', version: '0.1.43' }, vulnerabilities: [{ id: 'RUSTSEC-2020-0071', database_specific: {} }], groups: [{ ids: ['RUSTSEC-2020-0071'], max_severity: '6.2' }] }] }] };
  writeFiles(bin, {
    'osv.cjs': `const fs = require('fs'); if (!fs.existsSync('Cargo.lock')) { console.error('wrong cwd'); process.exit(2); }\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(1);\n`,
    'osv-scanner.cmd': '@node "%~dp0osv.cjs" %*\r\n',
    'osv-scanner': '#!/bin/sh\nexec node "$(dirname "$0")/osv.cjs" "$@"\n',
  });
  if (process.platform !== 'win32') chmodSync(join(bin, 'osv-scanner'), 0o755);
  const before = snapshot(repo);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${path}`;
  try {
    const run = runStart(db, { mode: 'full' }).id;
    const out = runDeps(db, { root: repo, runId: run }, SYSTEM).out;
    assert.deepEqual(out.auditors.find((a) => a.tool === 'osv-scanner'), { tool: 'osv-scanner', state: 'ran', found: 1 });
    assert.deepEqual(out.refs, [{ type: 'dep', ref: 'Cargo.lock#time@0.1.43', title: 'RUSTSEC-2020-0071 moderate', url: 'https://osv.dev/vulnerability/RUSTSEC-2020-0071' }]);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(snapshot(repo), before);
});

test('deps refuses a run that is not running', () => {
  assert.throws(() => runDeps(db, { root: home, runId: 'nope' }, fakeSys({}).sys), /does not exist/);
});
