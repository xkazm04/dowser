// @ts-check
// The issue an accept creates and the accept preview open with what doing it buys ("Expected benefit") and where
// to look ("Where it is and how to reproduce"), from the card's own metadata; the UI mirror equals the shared one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueOutline } from '../src/shared/model.mjs';
import { adfToText, issueDescription } from '../src/core/adf.mjs';

const labels = await import(String(new URL('../static/app/src/components/labels.js', import.meta.url)));

const BODY = '## Summary\nRegister the key.\n## Description\nThe button calls an undefined resolver.\n## Flow\n1. Open a Confluence page\n2. Press Draft the fix\n3. See the error\n## Expected impact\nThe documented button works for every page.\n## Evaluation\nBefore: fails. After: posts.';
const card = {
  ref: 'DW-9', title: 'Make Draft the fix work', lens: 'doc-drift', kind: 'stale-claim', rationale: 'A shipped button fails.', body: BODY,
  impact: 8, impact_why: 'every judge who opens a page sees it', anchors: ['forge/src/index.js#KEYS', 'forge/src/core/app.mjs#RESOLVERS'],
  evidence: [
    { type: 'code', ref: 'forge/src/index.js:90', link: 'https://github.com/x/y/blob/abc/forge/src/index.js#L90', quote: 'const KEYS' },
    { type: 'doc', ref: 'docs/forge-app.md:12' },
    { type: 'ticket', ref: 'SUP-3' },
  ],
};

test('the outline: benefit, places (linked, anchors not covered by evidence), steps, and the rest of the body', () => {
  const o = issueOutline(card);
  assert.deepEqual(o.benefit, { impact: '8/10 - every judge who opens a page sees it', text: 'The documented button works for every page.' });
  assert.deepEqual(o.where, [
    { ref: 'forge/src/index.js:90', link: 'https://github.com/x/y/blob/abc/forge/src/index.js#L90' },
    { ref: 'docs/forge-app.md:12' },
    { ref: 'forge/src/core/app.mjs#RESOLVERS' },
  ]);
  assert.match(o.steps ?? '', /Press Draft the fix/);
  assert.match(o.rest, /## Details\nThe button calls/);
  assert.doesNotMatch(o.rest, /## Flow|## Expected impact/);
});

test('a card without the sections or metadata omits those parts', () => {
  const o = issueOutline({ title: 't', body: 'plain text' });
  assert.deepEqual(o, { rest: 'plain text' });
});

test('the UI mirror gives the same outline as the shared module', () => {
  for (const c of [card, { title: 't', body: 'plain' }, { ...card, impact: undefined, evidence: [] }]) assert.deepEqual(labels.issueOutline(c), issueOutline(c));
  const p = labels.issuePreview(card);
  assert.ok(p.benefit && p.where && p.steps, 'the preview carries the outline');
});

test('the Jira issue reads benefit, then where and how, then the rest, in that order', () => {
  const t = adfToText(issueDescription(/** @type {any} */ (card), 'https://site/inbox?ref=DW-9'));
  const at = (/** @type {string} */ s) => { const i = t.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('Expected benefit') < at('Where it is and how to reproduce'));
  assert.ok(at('Where it is and how to reproduce') < at('Press Draft the fix'));
  assert.ok(at('Press Draft the fix') < at('Details'));
  assert.ok(at('Details') < at('Evidence'));
  assert.equal(t.split('The documented button works').length, 2, 'the benefit text appears once');
});
