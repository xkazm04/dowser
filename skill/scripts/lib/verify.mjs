// @ts-check
// The mechanical verification pass (D8): detection and verification are separate. For every `candidate` the
// run touched, each `code`/`doc` evidence quote must be found (whitespace-normalized substring) in the file at
// the ref's path in the CURRENT working tree. A ref may carry `:line[:col]` (or `#L12`); the quote counts when
// it is within +-30 lines of that line (`near-line`) or anywhere in the file (`in-file`), and the result says
// which. All found -> `verified`; any missing -> `dropped` with note `verify-failed:<ref>`.
// A `ticket`, `page`, `goal` or `dep` ref must have been fetched THIS run: it is looked up in the run's
// sources_cache (same type and ref, written by `ingest-sources` / `deps`); one that is not there drops the card
// with note `ref-not-ingested:<type>:<ref>` - an unconnected run never ingested any, so such a card was never
// valid. `git` and `sarif` evidence is passed through unchecked and reported as such - the agent judges it.
// When several refs fail, the first in evidence order names the note.
// Only the evidence the fingerprint's newest propose line carried is checked (store.assertedEvidence): a quote an
// earlier line carried and the agent no longer emits is stale and never re-checked.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { QUOTED_TYPES, isOneOf } from './model.mjs';
import { parseRef, squash } from './fingerprint.mjs';
import { assertedEvidence, candidatesOfRun, move, requireRunning } from './store.mjs';

export const LINE_WINDOW = 30;
export const VERIFY_DECIDER = 'skill:dowser-verify';
/** The evidence types whose ref must be in the run's sources_cache. */
export const INGESTED_TYPES = /** @type {const} */ (['ticket', 'page', 'goal', 'dep']);

/**
 * @typedef {{type: string, ref: string, found: 'near-line' | 'in-file' | false, why?: string, line?: number}} Check
 * @typedef {{type: string, ref: string, ingested: boolean}} SourceCheck
 * @typedef {{type: string, ref: string, checked: false}} Unchecked
 * @typedef {{fp: string, result: 'verified' | 'dropped', note?: string, checks: Check[], sources: SourceCheck[], unchecked: Unchecked[]}} FpResult
 */

export { squash, parseRef };

/**
 * Looks for `quote` in the file at `ref` under `root`.
 * @param {string} root
 * @param {string} ref
 * @param {string} quote
 * @returns {{found: 'near-line' | 'in-file' | false, why?: string, line?: number}}
 */
export function findQuote(root, ref, quote) {
  const { path, line } = parseRef(ref);
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (!path || rel.startsWith('..') || isAbsolute(rel)) return { found: false, why: 'path-outside-repo' };
  /** @type {string} */
  let text;
  try {
    if (!statSync(abs).isFile()) return { found: false, why: 'not-a-file' };
    text = readFileSync(abs, 'utf8');
  } catch {
    return { found: false, why: 'file-missing' };
  }
  const q = squash(quote);
  if (!q) return { found: false, why: 'empty-quote' };
  if (line !== undefined) {
    const lines = text.split(/\r?\n/);
    const lo = Math.max(0, line - 1 - LINE_WINDOW);
    const hi = Math.min(lines.length, line + LINE_WINDOW);
    if (squash(lines.slice(lo, hi).join('\n')).includes(q)) return { found: 'near-line', line };
  }
  if (squash(text).includes(q)) return line !== undefined ? { found: 'in-file', line } : { found: 'in-file' };
  return { found: false, why: 'quote-not-found' };
}

/**
 * Verifies every `candidate` the run touched and moves each to `verified` or `dropped`.
 * @param {import('./store.mjs').Db} db
 * @param {string} root the repo root (its current working tree is read)
 * @param {string} runId a running run
 * @returns {{run: string, verified: number, dropped: number, results: FpResult[]}}
 */
export function verifyRun(db, root, runId) {
  requireRunning(db, runId);
  const cached = db.prepare('SELECT 1 FROM sources_cache WHERE run_id = ? AND type = ? AND ref = ?');
  /** @type {FpResult[]} */
  const results = [];
  for (const fp of candidatesOfRun(db, runId)) {
    /** @type {Check[]} */
    const checks = [];
    /** @type {SourceCheck[]} */
    const sources = [];
    /** @type {Unchecked[]} */
    const unchecked = [];
    /** @type {string | undefined} */
    let note;
    for (const e of assertedEvidence(db, fp)) {
      const ref = String(e.ref);
      if (isOneOf(QUOTED_TYPES, e.type)) {
        const f = findQuote(root, ref, String(e.quote ?? ''));
        checks.push({ type: e.type, ref, ...f });
        if (f.found === false) note ??= `verify-failed:${ref}`;
      } else if (isOneOf(INGESTED_TYPES, e.type)) {
        const ingested = cached.get(runId, e.type, ref.trim()) !== undefined;
        sources.push({ type: e.type, ref, ingested });
        if (!ingested) note ??= `ref-not-ingested:${e.type}:${ref}`;
      } else {
        unchecked.push({ type: e.type, ref, checked: false });
      }
    }
    /** @type {FpResult} */
    const res = note
      ? { fp, result: 'dropped', note, checks, sources, unchecked }
      : { fp, result: 'verified', checks, sources, unchecked };
    move(db, fp, res.result, { from: 'candidate', by: VERIFY_DECIDER, note: res.note, runId });
    results.push(res);
  }
  return {
    run: runId,
    verified: results.filter((r) => r.result === 'verified').length,
    dropped: results.filter((r) => r.result === 'dropped').length,
    results,
  };
}
