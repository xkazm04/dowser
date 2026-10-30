// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARTIFACT_KINDS, ARTIFACT_LIMITS, BANDS, BLASTS, CATEGORIES, COMPUTED_KEYS, CONFIDENCES, FIELD_LIMITS, FLOW_MARKS, EVIDENCE_TYPES, LENSES,
  MVP_RULES, REASONS, SCHEMA_ID, SCORE_PART_KEYS, SIZES, STATUSES, TRANSITIONS, VERDICTS,
  canMove, decisionProblem, isHttpsUrl, validateCandidate,
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

test('the JSON Schema twin (-2) carries the scan-finding/1 fields with model.mjs\'s enums; -1 stays readable', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/dowser-proposal-2.schema.json', import.meta.url), 'utf8'));
  const d = schema.$defs;
  assert.equal(schema.title, SCHEMA_ID);
  assert.deepEqual(d.category.enum, [...CATEGORIES]);
  assert.deepEqual(d.verdict.enum, [...VERDICTS]);
  assert.deepEqual(d.band.enum, [...BANDS]);
  assert.deepEqual(schema.properties.mvp_rule.enum, [...MVP_RULES]);
  assert.deepEqual(d.scoreParts.required, [...SCORE_PART_KEYS]);
  assert.equal(d.impactWhy.maxLength, FIELD_LIMITS.impact_why);
  assert.equal(d.predictedWhy.maxLength, FIELD_LIMITS.predicted_why);
  assert.equal(d.mvpWhy.maxLength, FIELD_LIMITS.mvp_why);
  for (const k of COMPUTED_KEYS) {
    assert.ok(schema.properties[k], `record carries ${k}`);
    assert.equal(d.candidate.properties[k], undefined, `a candidate line never carries ${k}`);
  }
  for (const k of ['impact', 'impact_why', 'risk', 'category', 'predicted_verdict', 'predicted_why']) assert.ok(d.candidate.properties[k], `candidate carries ${k}`);
  assert.ok(d.effort.properties.score);
  const v1 = JSON.parse(readFileSync(new URL('../../schema/dowser-proposal-1.schema.json', import.meta.url), 'utf8'));
  assert.equal(v1.title, 'dowser-proposal/1');
  for (const k of Object.keys(v1.properties)) assert.deepEqual(schema.properties[k], v1.properties[k], `-2 keeps the /1 field ${k} unchanged`);
});

test('the JSON Schema twin carries the same enums and caps as model.mjs', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/dowser-proposal-2.schema.json', import.meta.url), 'utf8'));
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
  const F = FIELD_LIMITS;
  assert.equal(d.kind.maxLength, F.kind);
  assert.equal(d.topic.maxLength, F.topic);
  assert.equal(d.anchors.maxItems, F.anchors);
  assert.equal(d.anchors.items.maxLength, F.anchor);
  assert.equal(d.rationale.maxLength, F.rationale);
  assert.equal(d.body.maxLength, F.body);
  assert.equal(d.confidenceWhy.maxLength, F.confidence_why);
  assert.equal(d.evidenceList.maxItems, F.evidence);
  assert.equal(d.evidence.properties.ref.maxLength, F.ref);
  assert.equal(d.evidence.properties.quote.maxLength, F.quote);
  assert.equal(d.evidence.properties.url.maxLength, F.url);
  assert.equal(d.evidence.properties.url.pattern, '^https://');
  assert.equal(d.stringList.maxItems, F.list);
  assert.equal(d.stringList.items.maxLength, F.item);
  assert.equal(d.artifactList.items.properties.refs.maxItems, F.evidence);
  for (const k of ['lens_version', 'model', 'harness', 'run_id', 'focus']) assert.equal(d.provenance.properties[k].maxLength, F.provenance, k);
  for (const at of [schema.properties, d.candidate.properties]) {
    assert.equal(at.rationale.$ref, '#/$defs/rationale');
    assert.equal(at.confidence_why.$ref, '#/$defs/confidenceWhy');
  }
});

test('field caps: a value at the cap passes, one char or item over is refused with the field named', () => {
  const F = FIELD_LIMITS;
  const body = (/** @type {number} */ n) => { const b = candidate().body; return b + 'x'.repeat(n - b.length); };
  const ev = (over = {}) => ({ type: 'ticket', ref: 'PROJ-1', ...over });
  /** @type {[string, (n: number) => Record<string, unknown>, number, RegExp][]} */
  const cases = [
    ['kind', (n) => ({ kind: 'k'.repeat(n) }), F.kind, /^kind:longer than 64 chars$/],
    ['topic', (n) => ({ topic: 't'.repeat(n) }), F.topic, /^topic:longer than 160 chars$/],
    ['anchor', (n) => ({ anchors: ['a'.repeat(n)] }), F.anchor, /^anchors\[0\]:longer than 300 chars$/],
    ['anchors', (n) => ({ anchors: Array.from({ length: n }, (_, i) => `src/a${i}.js`) }), F.anchors, /^anchors:at most 12 items$/],
    ['rationale', (n) => ({ rationale: 'r'.repeat(n) }), F.rationale, /^rationale:longer than 2000 chars$/],
    ['body', (n) => ({ body: body(n) }), F.body, /^body:longer than 12000 chars$/],
    ['confidence_why', (n) => ({ confidence_why: 'c'.repeat(n) }), F.confidence_why, /^confidence_why:longer than 1000 chars$/],
    ['evidence', (n) => ({ evidence: Array.from({ length: n }, (_, i) => ev({ ref: `PROJ-${i}` })) }), F.evidence, /^evidence:at most 100 items$/],
    ['ref', (n) => ({ evidence: [ev({ ref: 'R'.repeat(n) })] }), F.ref, /^evidence\[0\]\.ref:longer than 500 chars$/],
    ['quote', (n) => ({ evidence: [{ type: 'code', ref: 'src/a.js:1', quote: 'q'.repeat(n) }] }), F.quote, /^evidence\[0\]\.quote:longer than 2000 chars$/],
    ['url', (n) => ({ evidence: [ev({ url: `https://x.example/${'u'.repeat(n - 18)}` })] }), F.url, /^evidence\[0\]\.url:longer than 2000 chars$/],
    ['doc_impact', (n) => ({ doc_impact: Array.from({ length: n }, (_, i) => `docs/${i}.md`) }), F.list, /^doc_impact:at most 20 items$/],
    ['doc_impact item', (n) => ({ doc_impact: ['d'.repeat(n)] }), F.item, /^doc_impact\[0\]:longer than 300 chars$/],
    ['basis', (n) => ({ effort: { size: 'S', basis: Array.from({ length: n }, (_, i) => `b${i}`) } }), F.list, /^effort\.basis:at most 20 items$/],
    ['provenance', (n) => ({ provenance: { lens_version: '1.0.0', model: 'm'.repeat(n) } }), F.provenance, /^provenance\.model:longer than 200 chars$/],
  ];
  for (const [name, make, cap, re] of cases) {
    assert.equal(why(candidate(make(cap))), 'ok', `${name} at the cap passes`);
    assert.match(why(candidate(make(cap + 1))), re, `${name} over the cap`);
  }
  const refs = Array.from({ length: F.evidence + 1 }, () => 'PROJ-1');
  const view = { kind: 'flow', message: 'm', alt: 'a', refs, data: { steps: [{ label: 'a' }, { label: 'b' }] } };
  assert.match(why(candidate({ evidence: [ev()], artifacts: [view] })), /^artifacts\[0\]\.refs:at most 100 refs$/);
  assert.equal(validateCandidate(candidate({ body: body(F.body + 1) }), { wire: true }).ok, false, 'the wire check holds the same caps');
});

test('an evidence url must be an absolute https URL', () => {
  const at = (/** @type {string} */ url) => why(candidate({ evidence: [{ type: 'ticket', ref: 'PROJ-1', url }] }));
  assert.equal(at('https://acme.atlassian.net/browse/PROJ-1'), 'ok');
  for (const bad of ['http://acme.atlassian.net/browse/PROJ-1', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '/browse/PROJ-1', 'acme.atlassian.net/x', 'ftp://x.example/a']) {
    assert.match(at(bad), /^evidence\[0\]\.url:must be an https:\/\/ URL$/, bad);
  }
  assert.equal(isHttpsUrl('HTTPS://X.EXAMPLE/a'), true, 'the scheme is case-insensitive');
  assert.equal(isHttpsUrl(42), false);
});
