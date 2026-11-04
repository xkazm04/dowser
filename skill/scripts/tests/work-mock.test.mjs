// @ts-check
// The build mode's seam (SKILL.md section 12) against the mock: an item a person accepted is listed as work, its
// brief carries done_when lines from the card's quotes, and a report shows up as the item's work status. An open
// item is not work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { move, openStore, propose, runStart } from '../lib/store.mjs';
import { ingestPush, outbox } from '../lib/sync.mjs';
import { callTool, emptyBackend } from '../../../tools/mock-forge-mcp.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

test('accepted work round trip: list, brief with done_when, report; an open item is refused', () => {
  const home = tempDir('work-mock');
  const db = openStore(join(home, 'dowser.db'));
  const b = emptyBackend();
  try {
    const run = String(runStart(db, { mode: 'full' }).id);
    const fps = ['alpha thing', 'beta thing'].map((topic, i) => {
      const fp = String(propose(db, run, candidate({ topic, anchors: [`src/${i}.js`] }), { kinds: KINDS }).fp);
      move(db, fp, 'verified', { by: 'skill:dowser-verify' });
      return fp;
    });
    ingestPush(db, callTool(b, 'dowser_proposals_push', /** @type {any} */ (outbox(db, { projectKey: 'pk', runId: run }))));
    callTool(b, 'mock_decide', { fp: fps[0], status: 'accepted' });
    const list = callTool(b, 'dowser_work_list', { project_key: 'pk', queue: 'open' });
    assert.deepEqual(list.items.map((/** @type {any} */ i) => i.fp), [fps[0]]);
    const ref = list.items[0].ref;
    const brief = callTool(b, 'dowser_work_get', { ref });
    assert.deepEqual(brief.done_when, ['src/auth.js:2 no longer contains: return check(user.password);']);
    callTool(b, 'dowser_work_report', { ref, status: 'pr_open', url: 'https://github.com/acme/shop/pull/7' });
    assert.equal(callTool(b, 'dowser_work_list', { project_key: 'pk', queue: 'open' }).items[0].work_status, 'pr_open');
    const open = callTool(b, 'dowser_work_list', { project_key: 'pk', queue: 'all' }).items.length;
    assert.equal(open, 1, 'the open item is not work');
    assert.throws(() => callTool(b, 'dowser_work_report', { ref, status: 'done', url: 'http://plain' }), /https/);
  } finally { db.close(); removeDir(home); }
});
