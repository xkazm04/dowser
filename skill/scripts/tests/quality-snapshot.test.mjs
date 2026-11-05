// @ts-check
// tools/quality-snapshot.mjs: the gate fields read from either node --test reporter, and --append honouring the
// path it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPath, testSummary } from '../../../tools/quality-snapshot.mjs';
import { removeDir, tempDir } from './_fixture.mjs';

const TOOL = fileURLToPath(new URL('../../../tools/quality-snapshot.mjs', import.meta.url));

test('quality-snapshot reads the test counts from spec or TAP output, the status from the exit code, and omits what is not there', () => {
  assert.deepEqual(testSummary('✔ a\nℹ tests 225\nℹ suites 0\nℹ pass 225\nℹ fail 0\n', 0), { tests_status: 'pass', tests: 225, tests_fail: 0 });
  assert.deepEqual(testSummary('ok 1 - a\n1..225\n# tests 225\n# pass 224\n# fail 1\n', 1), { tests_status: 'fail', tests: 225, tests_fail: 1 });
  const crashed = testSummary('SyntaxError: boom\n', 1);
  assert.deepEqual(crashed, { tests_status: 'fail' }, 'a crashed suite is fail, its counts omitted (never null)');
  assert.equal(JSON.stringify(crashed).includes('null'), false);
});

test('quality-snapshot --append writes to an absolute path as given, not under the repo root', () => {
  const dir = tempDir('qsnap');
  try {
    const file = join(dir, 'campaign', '..', 'q.jsonl');
    assert.equal(appendPath(file), resolve(file));
    assert.equal(appendPath('rel/q.jsonl'), resolve(process.cwd(), 'rel/q.jsonl'), 'a relative path resolves from the working directory');
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [TOOL, '--no-gates', '--label', `w${i}`, '--append', file], { encoding: 'utf8', cwd: dir });
      assert.equal(r.status, 0, r.stderr);
    }
    const rows = readFileSync(resolve(file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.label), ['w0', 'w1']);
    assert.equal(existsSync(join(fileURLToPath(new URL('../../../', import.meta.url)), dir.replace(/^[A-Za-z]:/, ''))), false, 'nothing glued under the repo');
  } finally { removeDir(dir); }
});
