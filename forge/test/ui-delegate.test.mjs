// @ts-check
// The delegate chip (static/app/src/components/labels.js) says the same name the server gives a delegate
// (core/names.mjs delegateName), so the inbox, the panel and the Learning tab never show a delegate as a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegateName } from '../src/core/names.mjs';
import { DELEGATE_DECIDER } from '../src/core/types.mjs';

/** @type {any} */
const labels = await import(String(new URL('../static/app/src/components/labels.js', import.meta.url)));

test('the delegate chip names the delegate as the server does, and only a delegate decider gets it', () => {
  assert.equal(labels.delegateChip(DELEGATE_DECIDER), 'Decided by Temper (delegate)');
  assert.equal(`${labels.delegateName(DELEGATE_DECIDER)} (delegate)`, delegateName(DELEGATE_DECIDER));
  assert.equal(labels.isDelegate(DELEGATE_DECIDER), true);
  for (const by of ['forge:712020:7d1c', 'human:jane', 'delegate:', undefined]) assert.equal(labels.isDelegate(by), false, String(by));
});
