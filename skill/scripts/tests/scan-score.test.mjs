// @ts-check
// scan-score/1 (lib/scan-score.mjs, a copy of ai-registry scan-sweep's score.mjs): the four contract reference values
// every implementation pins (docs/contracts/scan-finding-1.md), unscored is null (never 0), scale bugs throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMULA, blastToRisk, scanScore, sizeToEffort } from '../lib/scan-score.mjs';

test('the four scan-finding/1 reference values', () => {
  const at = (/** @type {number} */ impact, /** @type {any} */ confidence, /** @type {number} */ effort, /** @type {number} */ risk) => scanScore({ impact, confidence, effort, risk })?.score;
  assert.equal(at(10, 'high', 1, 1), 95.0);
  assert.equal(at(8, 'medium', 4, 3), 40.5);
  assert.equal(at(3, 'high', 1, 1), 28.5);
  assert.equal(at(5, 'low', 10, 10), 6.9);
});

test('the breakdown ships with the number', () => {
  assert.deepEqual(scanScore({ impact: 8, confidence: 'medium', effort: 4, risk: 3 }),
    { score: 40.5, score_parts: { impact: 8, confidence_w: 0.75, effort_div: 1.333, risk_factor: 0.9, formula: FORMULA } });
  assert.equal(FORMULA, 'scan-score/1');
});

test('absent confidence counts low, absent risk the midpoint; no impact or effort is unscored (null, never 0)', () => {
  assert.equal(scanScore({ impact: 10, effort: 1 })?.score, 37.5);
  assert.equal(scanScore({ effort: 2 }), null);
  assert.equal(scanScore({ impact: 5 }), null);
  assert.equal(scanScore(), null);
});

test('a scale bug throws at the producer', () => {
  assert.throws(() => scanScore({ impact: 0, effort: 1 }), RangeError);
  assert.throws(() => scanScore({ impact: 11, effort: 1 }), RangeError);
  assert.throws(() => scanScore({ impact: 5, effort: 2.5 }), RangeError);
  assert.throws(() => scanScore({ impact: 5, effort: 2, risk: 0 }), RangeError);
  assert.throws(() => scanScore({ impact: 5, effort: 2, confidence: /** @type {any} */ ('sure') }), RangeError);
});

test('size and blast map onto the 1-10 scales; unknown is undefined', () => {
  assert.deepEqual(['XS', 'S', 'M', 'L', 'XL'].map(sizeToEffort), [1, 2, 4, 7, 10]);
  assert.deepEqual(['low', 'medium', 'high'].map(blastToRisk), [2, 5, 8]);
  assert.equal(sizeToEffort('XXL'), undefined);
  assert.equal(sizeToEffort(undefined), undefined);
  assert.equal(blastToRisk('none'), undefined);
});
