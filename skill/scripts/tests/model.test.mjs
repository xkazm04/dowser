// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BLASTS, CONFIDENCES, EVIDENCE_TYPES, LENSES, REASONS, SIZES, STATUSES, TRANSITIONS,
  canMove, decisionProblem, validateCandidate,
} from '../lib/model.mjs';
import { candidate } from './_fixture.mjs';

/** @param {unknown} c */
const why = (c) => { const r = validateCandidate(c); return r.ok ? 'ok' : r.why; };

test('a well-formed candidate validates', () => {
  assert.equal(why(candidate()), 'ok');
  assert.equal(why(candidate({ evidence: [{ type: 'ticket', ref: 'PROJ-1' }] })), 'ok', 'ticket evidence needs no quote');
});

test('validateCandidate refuses what the record forbids', () => {
  assert.match(why(candidate({ title: 'x'.repeat(81) })), /^title:/);
  assert.match(why(candidate({ body: '## Summary\ns\n## Description\nd' })), /^body:missing section\(s\) ## Flow, ## Expected impact, ## Evaluation/);
  assert.match(why(candidate({ evidence: [{ type: 'code', ref: 'src/a.js:1' }] })), /quote:required for code/);
  assert.match(why(candidate({ evidence: [{ type: 'doc', ref: 'README.md' }] })), /quote:required for doc/);
  assert.match(why(candidate({ evidence: [] })), /^evidence:/);
  assert.match(why(candidate({ lens: 'tech-debt' })), /^lens:/);
  assert.match(why(candidate({ confidence: 'sure' })), /^confidence:/);
  assert.match(why(candidate({ status: 'verified' })), /^store-owned-field:status/);
  assert.match(why(candidate({ extra: 1 })), /^unknown-field:extra/);
  assert.match(why(candidate({ effort: { size: 'S', days_low: 0 } })), /days_low/, 'never 0 for unmeasured');
  assert.match(why(candidate({ delivery_risk: { blast: 'low', bus_factor: null } })), /^null-at:delivery_risk.bus_factor/, 'never null');
  assert.match(why(candidate({ delivery_risk: { blast: 'low', bus_factor: 0 } })), /bus_factor/);
  assert.match(why(candidate({ provenance: {} })), /lens_version/);
  assert.equal(why('nope'), 'not-an-object');
});

test('reason codes: a reject needs a reason, `other` needs a note', () => {
  assert.deepEqual([...REASONS], ['false-positive', 'already-known', 'not-our-direction', 'not-worth-it', 'wrong-size', 'other']);
  assert.match(String(decisionProblem({ to: 'rejected' })), /needs --reason/);
  assert.match(String(decisionProblem({ to: 'rejected', reason: 'other' })), /needs --note/);
  assert.equal(decisionProblem({ to: 'rejected', reason: 'other', note: 'why' }), undefined);
  assert.match(String(decisionProblem({ to: 'rejected', reason: 'meh' })), /must be one of/);
});

test('the transition table is D4', () => {
  assert.ok(canMove('candidate', 'verified') && canMove('candidate', 'dropped'));
  assert.ok(['rejected', 'snoozed', 'merged', 'pushed'].every((t) => canMove('verified', t)));
  assert.ok(['accepted', 'rejected', 'merged', 'snoozed'].every((t) => canMove('pushed', t)));
  assert.ok(canMove('snoozed', 'verified') && canMove('snoozed', 'candidate') && canMove('rejected', 'candidate'));
  assert.ok(!canMove('candidate', 'pushed') && !canMove('dropped', 'verified') && !canMove('accepted', 'rejected'));
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATUSES].sort(), 'every status has a row');
});

test('the JSON Schema twin carries the same enums as model.mjs', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/dowser-proposal-1.schema.json', import.meta.url), 'utf8'));
  const d = schema.$defs;
  assert.deepEqual(d.lens.enum, [...LENSES]);
  assert.deepEqual(schema.properties.status.enum, [...STATUSES]);
  assert.deepEqual(schema.properties.reason.enum, [...REASONS]);
  assert.deepEqual(d.evidence.properties.type.enum, [...EVIDENCE_TYPES]);
  assert.deepEqual(d.effort.properties.size.enum, [...SIZES]);
  assert.deepEqual(d.confidence.enum, [...CONFIDENCES]);
  assert.deepEqual(d.deliveryRisk.properties.blast.enum, [...BLASTS]);
  assert.equal(d.title.maxLength, 80);
});
