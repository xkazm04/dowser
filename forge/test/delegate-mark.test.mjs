// @ts-check
// DW-61: an issue the delegate accepted stays marked even when Jira refuses its label (the adapter drops labels on a
// 400): its description opens with a line naming Temper (delegate), while the label is still sent. A person's accept
// has no such line. The docs say so beside the label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { DELEGATE_LABEL } from '../src/core/types.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = async (d, key, p) => /** @type {any} */ (await runResolver(d, key, p, ME, 'inbox'));
/** @param {any} d @param {Record<string, unknown>[]} verdicts */
const rec = async (d, verdicts) => /** @type {any} */ (await runTool(d, 'dowser_verdicts_record', { project_key: PK, verdicts_json: JSON.stringify(verdicts) }, ME));
const DELEGATE = { project_key: PK, delegate_until: '2026-10-31', delegate_accepts_per_day: 2, delegate_rejects_per_day: 2 };

async function seeded() {
  const d = makeDeps();
  const records = Array.from({ length: 2 }, (_, i) => record({ topic: `topic ${i}`, anchors: [`src/a${i}.js#x`] }));
  await runTool(d, 'dowser_proposals_push', pushArgs(records), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  assert.equal((await res(d, 'settings.set', DELEGATE)).error, undefined);
  return d;
}

/** The plain text of an ADF node. @param {any} n @returns {string} */
const textOf = (n) => (n?.type === 'text' ? String(n.text) : (n?.content ?? []).map(textOf).join(''));

test('a delegate accept opens its issue description with a line naming the delegate; the label is still sent', async () => {
  const d = await seeded();
  const out = await rec(d, [{ ref: 'DW-1', verdict: 'accept' }]);
  assert.equal(out.results[0].result, 'recorded');
  const made = d.jira.created[0];
  assert.deepEqual(made.labels, [DELEGATE_LABEL]);
  const first = made.description.content[0];
  assert.equal(first.type, 'paragraph');
  assert.match(textOf(first), /Temper \(delegate\)/);
  assert.match(textOf(first), /not by a person/);
});

test('a person\'s accept has no delegate line (guard)', async () => {
  const d = await seeded();
  await res(d, 'verdict.accept', { ref: 'DW-2' });
  const made = d.jira.created[0];
  assert.equal(made.labels, undefined);
  const first = made.description.content.find((/** @type {any} */ n) => n.type === 'paragraph');
  assert.doesNotMatch(textOf(first), /\(delegate\)/);
});

/**
 * The paragraph (or list item) of `doc` that holds the label, with the label itself taken out.
 * @param {string} doc
 */
function labelParagraph(doc) {
  const at = doc.indexOf('dowser-delegate');
  assert.ok(at >= 0, 'the doc names the label');
  const before = doc.slice(0, at);
  const starts = [...before.matchAll(/\n\s*\n|\n- /g)];
  const start = starts.length ? /** @type {number} */ (starts[starts.length - 1].index) : 0;
  const after = doc.slice(at);
  const end = after.search(/\n\s*\n|\n- /);
  return doc.slice(start, end < 0 ? doc.length : at + end).replaceAll('dowser-delegate', '');
}

for (const file of ['docs/forge-app.md', 'docs/contracts/forge-mcp-2.md']) {
  test(`${file} says, beside the label, that the description opens with a line naming the delegate`, () => {
    const doc = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const para = labelParagraph(doc);
    const sentences = para.split(/\.\s/);
    assert.ok(sentences.some((s) => /description/i.test(s) && /delegate/i.test(s)),
      `one sentence of the label's paragraph names the description and the delegate:\n${para}`);
  });
}
