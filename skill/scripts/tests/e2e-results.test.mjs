// @ts-check
// e2e/lib/reporter.mjs foldRuns: the three-state row of one spec over its retries and --repeat-each copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldRuns } from '../../../e2e/lib/reporter.mjs';

const run = (/** @type {string} */ outcome, attempts = 1, unverifiable = false) => ({ outcome, attempts, unverifiable });

test('pass, fail and unverifiable are three states, never folded into each other', () => {
  assert.deepEqual(foldRuns('s', [run('expected'), run('expected')]), { spec: 's', state: 'pass', attempts: 2, flaky: false });
  assert.deepEqual(foldRuns('s', [run('unexpected', 2)]), { spec: 's', state: 'fail', attempts: 2, flaky: false });
  // a signed-out live spec skips with the unverifiable annotation: not a pass, not a fail
  assert.deepEqual(foldRuns('s', [run('skipped', 1, true)]), { spec: 's', state: 'unverifiable', attempts: 1, flaky: false });
  // a real failure outweighs an unverifiable copy
  assert.equal(foldRuns('s', [run('skipped', 1, true), run('unexpected')])?.state, 'fail');
});

test('flaky: passed on a retry, or passed and failed across repeats', () => {
  assert.deepEqual(foldRuns('s', [run('flaky', 2)]), { spec: 's', state: 'pass', attempts: 2, flaky: true });
  assert.deepEqual(foldRuns('s', [run('expected'), run('unexpected', 2), run('expected')]), { spec: 's', state: 'fail', attempts: 4, flaky: true });
});

test('a plain skip is not a result', () => {
  assert.equal(foldRuns('s', [run('skipped')]), undefined);
});
