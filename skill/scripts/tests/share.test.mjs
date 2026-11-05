// @ts-check
// `dowser share`: a run's kept proposals as markdown - kept means proposed or grown in that run and still
// verified, pushed or accepted; evidence appears by ref only, never as a quoted line.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openStore, propose, runFinish, runStart } from '../lib/store.mjs';
import { shareRun } from '../lib/share.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;

before(() => { dir = tempDir('share'); db = openStore(join(dir, 'dowser.db')); });
after(() => { db.close(); removeDir(dir); });

test('share lists the run\'s kept cards with their summary and evidence refs, and leaves out rejected ones and quotes', () => {
  const run = runStart(db, { mode: 'full', headSha: 'abcdef1234' }).id;
  const kept = propose(db, run, candidate({ topic: 'csv-export', title: 'Export orders as CSV' }), { kinds: KINDS });
  const gone = propose(db, run, candidate({ topic: 'dark-mode', title: 'Dark mode', anchors: ['src/theme.ts'] }), { kinds: KINDS });
  db.prepare("UPDATE proposals SET status = 'verified' WHERE fp = ?").run(String(kept.fp));
  db.prepare("UPDATE proposals SET status = 'rejected' WHERE fp = ?").run(String(gone.fp));
  runFinish(db, { runId: run, lenses: { opportunity: { state: 'ran', emitted: 2 } } });

  const out = shareRun(db, run);
  assert.equal(out.cards, 1);
  assert.match(out.markdown, /^# Dowser scan \d{4}-\d{2}-\d{2}\n\nfull scan · at abcdef1 · lenses: opportunity ran · 1 kept proposals\n/);
  assert.match(out.markdown, /## Export orders as CSV\n\nsecurity-cra · size [A-Z]+ · confidence \w+ · verified\n/);
  assert.match(out.markdown, /\*\*Proposed:\*\* s\n/, 'the Summary section of the body');
  assert.match(out.markdown, /Evidence: code /);
  assert.doesNotMatch(out.markdown, /Dark mode/, 'a rejected card is not shared');
  for (const e of /** @type {{quote?: string}[]} */ (candidate().evidence)) if (e.quote) assert.ok(!out.markdown.includes(e.quote), 'no quoted line');
  assert.throws(() => shareRun(db, 'r-nope'), /does not exist/);
});

test('share keeps the Proposed line of a body written with CRLF line endings', () => {
  const run = runStart(db, { mode: 'full' }).id;
  const crlf = ['## Summary', 'Export orders as a CSV file.', '## Description', 'd', '## Flow', 'f', '## Expected impact', 'e', '## Evaluation', 'v'].join('\r\n');
  const kept = propose(db, run, candidate({ topic: 'crlf-export', title: 'CRLF card', body: crlf }), { kinds: KINDS });
  assert.ok(kept.fp, String(kept.result));
  db.prepare("UPDATE proposals SET status = 'verified' WHERE fp = ?").run(String(kept.fp));
  const out = shareRun(db, run);
  assert.match(out.markdown, /\*\*Proposed:\*\* Export orders as a CSV file\.\n/);
  assert.doesNotMatch(out.markdown, /\r/, 'no carriage return leaks into the markdown');
});

test('share --run keeps a run\'s cards after a later run re-sees them; the later run lists only what it created or grew', () => {
  const r1 = runStart(db, { mode: 'full' }).id;
  const a = String(propose(db, r1, candidate({ topic: 'reseen-card', title: 'Reseen card' }), { kinds: KINDS }).fp);
  db.prepare("UPDATE proposals SET status = 'verified' WHERE fp = ?").run(a);
  runFinish(db, { runId: r1, lenses: {} });

  const r2 = runStart(db, { mode: 'full' }).id;
  assert.equal(propose(db, r2, candidate({ topic: 'reseen-card', title: 'Reseen card' }), { kinds: KINDS }).result, 'duplicate');
  const b = String(propose(db, r2, candidate({ topic: 'grown-card', title: 'Grown card', anchors: ['src/grown.js'] }), { kinds: KINDS }).fp);
  db.prepare("UPDATE proposals SET status = 'verified' WHERE fp = ?").run(b);
  runFinish(db, { runId: r2, lenses: {} });

  assert.match(shareRun(db, r1).markdown, /## Reseen card/, 'r1 keeps its card');
  const two = shareRun(db, r2);
  assert.doesNotMatch(two.markdown, /## Reseen card/, 'a duplicate line neither created nor grew it in r2');
  assert.match(two.markdown, /## Grown card/);

  const r3 = runStart(db, { mode: 'full' }).id;
  const grew = propose(db, r3, candidate({ topic: 'reseen-card', title: 'Reseen card',
    evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }, { type: 'git', ref: 'abc1234' }] }), { kinds: KINDS });
  assert.equal(grew.result, 'evidence-grew');
  assert.match(shareRun(db, r3).markdown, /## Reseen card/, 'new evidence in r3: grown in r3');
});
