// @ts-check
// tools/quality-snapshot.mjs: the gate fields read from either node --test reporter, and --append honouring the
// path it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSummary } from '../../../tools/quality-snapshot.mjs';

test('quality-snapshot reads the test counts from spec or TAP output, the status from the exit code, and omits what is not there', () => {
  assert.deepEqual(testSummary('✔ a\nℹ tests 225\nℹ suites 0\nℹ pass 225\nℹ fail 0\n', 0), { tests_status: 'pass', tests: 225, tests_fail: 0 });
  assert.deepEqual(testSummary('ok 1 - a\n1..225\n# tests 225\n# pass 224\n# fail 1\n', 1), { tests_status: 'fail', tests: 225, tests_fail: 1 });
  const crashed = testSummary('SyntaxError: boom\n', 1);
  assert.deepEqual(crashed, { tests_status: 'fail' }, 'a crashed suite is fail, its counts omitted (never null)');
  assert.equal(JSON.stringify(crashed).includes('null'), false);
});
