// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARTIFACT_KINDS, ARTIFACT_LIMITS, BLASTS, CONFIDENCES, FLOW_MARKS, EVIDENCE_TYPES, LENSES, REASONS, SIZES, STATUSES, TRANSITIONS,
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

test('artifacts: the four kinds validate, drawn from the card\'s own evidence', () => {
  const ref = 'src/auth.js:2';
  const base = { message: 'One message', alt: 'A short text alternative.', refs: [ref] };
  const ok = [
    { kind: 'table', ...base, data: { columns: ['Doc says', 'Code does'], rows: [['--legacy', '--force, --seed']], highlight: [0] } },
    { kind: 'flow', ...base, data: { steps: [{ label: 'Pay' }, { label: 'Declined', mark: 'failure' }] } },
    { kind: 'before-after', ...base, data: { measure: 'Steps to pay', before: ['5 steps'], after: ['3 steps'] } },
    { kind: 'matrix', ...base, data: { rows: ['SBOM'], columns: ['Status'], cells: [[{ v: 'missing', level: 3 }]] } },
  ];
  for (const a of ok) assert.equal(why(candidate({ artifacts: [a] })), 'ok', a.kind);
  assert.equal(why(candidate({ artifacts: ok.slice(0, 3) })), 'ok', 'three per card');
});

test('artifacts: refusals name the field', () => {
  const ref = 'src/auth.js:2';
  const t = (over = {}, data = {}) => ({ kind: 'table', message: 'm', alt: 'a', refs: [ref], data: { columns: ['A'], rows: [['1']], ...data }, ...over });
  assert.match(why(candidate({ artifacts: [] })), /^artifacts:must be a non-empty array/);
  assert.match(why(candidate({ artifacts: [t(), t(), t(), t()] })), /at most 3/);
  assert.match(why(candidate({ artifacts: [t({ kind: 'chart' })] })), /\.kind:/);
  assert.match(why(candidate({ artifacts: [t({ refs: ['OTHER-1'] })] })), /OTHER-1 is not in this card's evidence/);
  assert.match(why(candidate({ artifacts: [t({ message: 'two\nlines' })] })), /\.message:/);
  assert.match(why(candidate({ artifacts: [t({ alt: '' })] })), /\.alt:/);
  assert.match(why(candidate({ artifacts: [t({}, { rows: [['1', '2']] })] })), /rows\[0\]:must have 1/);
  assert.match(why(candidate({ artifacts: [t({}, { highlight: [5] })] })), /highlight/);
  assert.match(why(candidate({ artifacts: [{ kind: 'flow', message: 'm', alt: 'a', refs: [ref], data: { steps: [{ label: 'only one' }] } }] })), /steps:2-8/);
  assert.match(why(candidate({ artifacts: [{ kind: 'matrix', message: 'm', alt: 'a', refs: [ref], data: { rows: ['r'], columns: ['c'], cells: [[{ v: 'x', level: 4 }]] } }] })), /level:0-3/);
  assert.match(why(candidate({ artifacts: [t({}, { highlight: null })] })), /^null-at:artifacts\[0\]\.data\.highlight/, 'never null');
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
  assert.deepEqual(d.artifactList.items.properties.kind.enum, [...ARTIFACT_KINDS]);
  assert.equal(d.artifactList.maxItems, ARTIFACT_LIMITS.perCard);
  assert.deepEqual(d.flowData.properties.steps.items.properties.mark.enum, [...FLOW_MARKS]);
  assert.ok(schema.properties.artifacts && d.candidate.properties.artifacts, 'record and candidate both carry artifacts');
});
