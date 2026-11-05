// @ts-check
// The Custom UI hand-keeps the closed vocabularies it renders (static/app/src/components/labels.js); this ties each
// one to the server's list, so a new reason, status, evidence type or lens fails here instead of shipping a raw
// code the UI cannot label or reach by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_TYPES, LENSES, REASONS } from '../src/shared/model.mjs';
import { INBOX_STATUSES } from '../src/core/types.mjs';

/** @type {any} */
const labels = await import(String(new URL('../static/app/src/components/labels.js', import.meta.url)));

test('labels.js mirrors the server vocabularies: reasons (in order, all labelled), inbox statuses, evidence types, lenses', () => {
  assert.deepEqual(labels.REASONS.map((/** @type {any} */ r) => r.code), [...REASONS], 'the reject dialog offers every reason, in key order 1..n');
  assert.ok(labels.REASONS.length <= 9, 'reasons are picked by one digit key');
  for (const r of REASONS) assert.ok(labels.REASON_LABELS[r], `${r} has a label`);
  assert.deepEqual([...labels.STATUSES].sort(), [...INBOX_STATUSES].sort());
  for (const s of INBOX_STATUSES) assert.ok(labels.STATUS_LABELS[s] && labels.STATUS_APPEARANCE[s], `${s} is labelled`);
  assert.deepEqual(Object.keys(labels.EVIDENCE_LABELS).sort(), [...EVIDENCE_TYPES].sort());
  assert.deepEqual(labels.LENSES, [...LENSES]);
  for (const l of LENSES) assert.ok(labels.LENS_LABELS[l], `${l} is labelled`);
});
