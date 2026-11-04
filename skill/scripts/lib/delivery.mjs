// @ts-check
// Delivery truth from the code. Jira says when an issue is Done; only the code says whether the problem the card
// quoted is gone. Each run re-checks every accepted card's quoted `code`/`doc` evidence at the scanned commit
// (verify.mjs findQuote, read at the run's head): every quote still found -> `present`, some -> `partly`, none ->
// `resolved`. It also lists the commits since the decision whose message names the card's Jira issue or inbox
// item. A row is appended to `deliveries` only when the state or the commits changed, so the table is the card's
// delivery history. A card without quoted evidence has nothing to check and is left out (never `present` by
// default). Read-only towards the repo.
import { commitsNaming, hasCommit } from './git.mjs';
import { findQuote } from './verify.mjs';
import { clean, now, requireRunning, sql } from './store.mjs';

/** @typedef {import('./store.mjs').Db} Db */
/** @typedef {Record<string, any>} Row */
/** @typedef {{fp: string, title: string, issue_ref?: string, external_ref?: string, from?: string, to: string, found: number, total: number, commits?: {sha: string, at: string}[]}} Change */

/**
 * @param {Db} db
 * @param {string} root
 * @param {string} runId a running run
 * @returns {{run: string, checked: number, states: Record<string, number>, changes: Change[], note?: string}}
 */
export function checkDeliveries(db, root, runId) {
  const run = requireRunning(db, runId);
  const head = typeof run.head_sha === 'string' && hasCommit(root, run.head_sha) ? run.head_sha : undefined;
  const cards = /** @type {Row[]} */ (db.prepare(
    "SELECT fp, title, issue_ref, external_ref, decided_at FROM proposals WHERE status = 'accepted' ORDER BY decided_at, fp",
  ).all());
  const quoted = db.prepare("SELECT type, ref, quote FROM evidence WHERE fp = ? AND type IN ('code', 'doc') AND quote IS NOT NULL ORDER BY id");
  const last = db.prepare('SELECT state, commits_json FROM deliveries WHERE fp = ? ORDER BY id DESC LIMIT 1');
  const ins = db.prepare('INSERT INTO deliveries (fp, run_id, head_sha, state, found, total, commits_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  /** @type {Change[]} */
  const changes = [];
  /** @type {Record<string, number>} */
  const states = {};
  let checked = 0;
  for (const c of cards) {
    const quotes = /** @type {Row[]} */ (quoted.all(c.fp));
    if (!quotes.length) continue;
    checked++;
    const found = quotes.filter((q) => findQuote(root, String(q.ref), String(q.quote), { rev: head }).found !== false).length;
    const state = found === quotes.length ? 'present' : found === 0 ? 'resolved' : 'partly';
    states[state] = (states[state] ?? 0) + 1;
    const needles = [c.issue_ref, c.external_ref].filter((x) => typeof x === 'string');
    const commits = head && typeof c.decided_at === 'string' ? commitsNaming(root, head, c.decided_at, needles) : undefined;
    const commitsJson = commits?.length ? JSON.stringify(commits) : null;
    const prev = /** @type {Row | undefined} */ (last.get(c.fp));
    if (prev && prev.state === state && (prev.commits_json ?? null) === commitsJson) continue;
    ins.run(c.fp, runId, sql(head), state, found, quotes.length, commitsJson, now());
    changes.push(/** @type {Change} */ (clean({
      fp: c.fp, title: c.title, issue_ref: c.issue_ref ?? undefined, external_ref: c.external_ref ?? undefined,
      from: prev ? String(prev.state) : undefined, to: state, found, total: quotes.length, commits: commits?.length ? commits : undefined,
    })));
  }
  return /** @type {any} */ (clean({
    run: runId, checked, states, changes,
    note: head ? undefined : 'the run has no head commit git can read: quotes were read from the working tree and no commits were searched',
  }));
}
