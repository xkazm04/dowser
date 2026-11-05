// @ts-check
// Confluence doc-drift closure (moonshot 2026-11-04, app#4): a page -> item index replaces the byline's LIKE scan;
// a page edit after an item's decision is recorded and shown; "Draft the fix" leaves a footer comment, as the person,
// quoting what the code says against the stale page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { resolverAllowed, runResolver, runTool } from '../src/core/app.mjs';
import { backfillPageLinks, onPageEvent } from '../src/core/doc-drift.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));
const pageEv = (/** @type {string} */ id) => ({ eventType: 'avi:confluence:updated:page', atlassianId: 'u-1', content: { id, type: 'page', version: { when: '2026-11-06T09:00:00.000Z', number: 4 } } });

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([
    record({ topic: 'stale upload limit', lens: 'doc-drift', kind: 'stale-doc', anchors: ['docs/a.md'], doc_impact: ['164004'],
      evidence: [{ type: 'code', ref: 'src/config/limits.ts:7', quote: 'export const MAX_UPLOAD_MB = 10;' }] }),
    record({ topic: 'other', evidence: [{ type: 'code', ref: 'src/x.js:1', quote: 'x' }] }),
  ], { run_id: 'r-1' }), ME);
  return d;
}

test('the byline reads the page index, not a scan; the index is filled at push and backfilled once', async () => {
  const d = await seeded();
  assert.equal((await res(d, 'byline.forPage', { page_id: '164004' })).count, 1);
  assert.equal(/** @type {any} */ (d.db.raw.prepare('SELECT COUNT(*) AS n FROM page_links').get()).n, 1);
  const src = readFileSync(new URL('../src/core/cards.mjs', import.meta.url), 'utf8');
  const byline = src.slice(src.indexOf('export async function bylineForPage'), src.indexOf('\n}\n', src.indexOf('export async function bylineForPage')));
  assert.doesNotMatch(byline, /LIKE/, 'no scan over every proposal on each page view');

  d.db.raw.exec('DELETE FROM page_links');
  assert.equal((await res(d, 'byline.forPage', { page_id: '164004' })).count, 0, 'the byline trusts the index');
  assert.deepEqual(await backfillPageLinks(d), { linked: 1 });
  assert.equal((await res(d, 'byline.forPage', { page_id: '164004' })).count, 1);
  assert.deepEqual(await backfillPageLinks(d), { linked: 0 }, 'runs once');
});

test('the page-link backfill resumes where a run stopped instead of restarting from id 0', async () => {
  const d = await seeded();
  d.db.raw.exec('DELETE FROM page_links');
  const ids = /** @type {any[]} */ (d.db.raw.prepare('SELECT id FROM proposals ORDER BY id').all()).map((r) => Number(r.id));
  assert.equal(ids.length, 2);
  /** @type {unknown[][]} */
  const reads = [];
  const query = d.db.query;
  d.db.query = async (sql, params = []) => {
    if (/FROM proposals WHERE id > \?/.test(sql)) reads.push(params);
    return query(sql, params);
  };
  // budget spent after the first page of one item: the run stops and stores where it was
  const first = await backfillPageLinks(d, { budgetMs: 0, page: 1 });
  assert.equal(first.more, true);
  assert.deepEqual(reads, [[0]]);
  // the next run starts after that item, not at 0, and finishes
  const second = await backfillPageLinks(d, { budgetMs: 60_000, page: 1 });
  assert.equal(second.more, undefined);
  assert.deepEqual(reads.slice(1), [[ids[0]], [ids[1]]]);
  assert.equal(first.linked + second.linked, 1);
  assert.deepEqual(await backfillPageLinks(d), { linked: 0 }, 'done once finished');
});

test('a page edit after the decision is recorded and flagged; an unlinked page costs one lookup and stores nothing', async () => {
  const d = await seeded();
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.deepEqual(await onPageEvent(d, pageEv('555')), { matched: 0 });
  assert.equal(/** @type {any} */ (d.db.raw.prepare('SELECT COUNT(*) AS n FROM page_edits').get()).n, 0);
  d.clock.tick();
  assert.deepEqual(await onPageEvent(d, pageEv('164004')), { matched: 1 });
  const b = await res(d, 'byline.forPage', { page_id: '164004' });
  assert.equal(b.page_edited_at, '2026-11-06T09:00:00.000Z');
  assert.equal(b.cards[0].page_edited_since_decision, true);
});

test('Draft the fix posts a footer comment as the person, quoting the code; only for an item linked to that page', async () => {
  const d = await seeded();
  const out = await res(d, 'byline.draftFix', { page_id: '164004', ref: 'DW-1' });
  assert.equal(out.comment.page_id, '164004');
  const posted = d.confluence.comments.at(-1);
  assert.equal(posted?.pageId, '164004');
  assert.match(JSON.stringify(posted?.body), /MAX_UPLOAD_MB = 10/);
  assert.match(JSON.stringify(posted?.body), /DW-1/);
  assert.equal((await res(d, 'byline.draftFix', { page_id: '164004', ref: 'DW-2' })).error, 'bad-input', 'DW-2 does not name this page');
  d.confluence.fail = true;
  assert.equal((await res(d, 'byline.draftFix', { page_id: '164004', ref: 'DW-1' })).error, 'unavailable', 'Confluence refused (no permission): nothing claimed');
  assert.equal(resolverAllowed('dowser-doc-impact', 'byline.draftFix'), true);
  assert.equal(resolverAllowed('dowser-doc-banner', 'byline.forPage'), true);
  assert.equal(resolverAllowed('dowser-doc-banner', 'byline.draftFix'), false, 'the banner only reads');
});
