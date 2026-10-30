// @ts-check
// The mechanical verification pass (D8): detection and verification are separate. For every `candidate` the
// run touched, each `code`/`doc` evidence quote must be found (whitespace-normalized substring) in the file at
// the ref's path in the CURRENT working tree. A ref may carry `:line[:col]` (or `#L12`); the quote counts when
// it is within +-30 lines of that line (`near-line`) or anywhere in the file (`in-file`), and the result says
// which. `line` is the line the quote was FOUND on (the occurrence nearest the hint); `claimed_line` is the hint
// when it differs, and `drift` (the distance) flags a hint more than DRIFT_MAX lines off.
// All found -> `verified`; any missing -> `dropped` with note `verify-failed:<ref>`.
// A `ticket`, `page`, `goal` or `dep` ref must have been fetched THIS run: it is looked up in the run's
// sources_cache (same type and ref, written by `ingest-sources` / `deps`); one that is not there drops the card
// with note `ref-not-ingested:<type>:<ref>` - an unconnected run never ingested any, so such a card was never
// valid. `git` and `sarif` evidence is passed through unchecked and reported as such - the agent judges it.
// When several refs fail, the first in evidence order names the note.
// Only the evidence the fingerprint's newest propose line carried is checked (store.assertedEvidence): a quote an
// earlier line carried and the agent no longer emits is stale and never re-checked.
// The bus factor (card 0abc6bdd204b318b) is measured here, not guessed by the agent: the distinct author e-mails of
// the non-merge commits that touched the card's anchor paths in the CHURN_DAYS (90) before the run's head commit -
// the same window and the same one `git log` pass as the areas map (sync.mjs areas). A measured value is written
// into `delivery_risk.bus_factor` and wins over the card's own (the result says what the card claimed); when no
// commit in the window touched the anchors, or git cannot answer, the card's value stays (`source: 'card'`). A card
// without `delivery_risk` is left without one: no blast radius is invented.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { QUOTED_TYPES, isOneOf } from './model.mjs';
import { parseRef, squash } from './fingerprint.mjs';
import { assertedEvidence, candidatesOfRun, move, requireRunning } from './store.mjs';
import { allocateRun } from './budget.mjs';
import { loadLensPack } from './memory.mjs';
import { commitDate, commitsSince } from './git.mjs';
import { CHURN_DAYS } from './sync.mjs';

/** A lens pack's `budget`, or undefined when the pack cannot be read (the allocation then uses its default). */
const packBudget = (/** @type {string} */ lens) => { try { return loadLensPack(lens).budget; } catch { return undefined; } };

export const LINE_WINDOW = 30;
/** A line hint further than this from where the quote was found is flagged as `drift`. */
export const DRIFT_MAX = 3;
export const VERIFY_DECIDER = 'skill:dowser-verify';
/** The evidence types whose ref must be in the run's sources_cache. */
export const INGESTED_TYPES = /** @type {const} */ (['ticket', 'page', 'goal', 'dep']);

/**
 * @typedef {{found: 'near-line' | 'in-file' | false, why?: string, line?: number, claimed_line?: number, drift?: number}} Found
 * @typedef {{type: string, ref: string} & Found} Check
 * @typedef {{type: string, ref: string, ingested: boolean}} SourceCheck
 * @typedef {{type: string, ref: string, checked: false}} Unchecked
 * @typedef {{value: number, source: 'git-90d' | 'card', claimed?: number}} BusFactor
 * @typedef {{fp: string, result: 'verified' | 'dropped', note?: string, checks: Check[], sources: SourceCheck[], unchecked: Unchecked[], bus_factor?: BusFactor}} FpResult
 */

export { squash, parseRef };

/**
 * Looks for `quote` in the file at `ref` under `root`.
 * @param {string} root
 * @param {string} ref
 * @param {string} quote
 * @returns {Found}
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
  // the squashed file with the offset each line starts at: squash(text) is exactly the non-empty squashed lines
  // joined by one space, so an offset in it maps back to the line it falls on
  /** @type {number[]} */
  const starts = [];
  /** @type {number[]} */
  const lineNo = [];
  let flat = '';
  text.split(/\r?\n/).forEach((l, i) => {
    const t = squash(l);
    if (!t) return;
    if (flat) flat += ' ';
    starts.push(flat.length);
    lineNo.push(i + 1);
    flat += t;
  });
  const lineAt = (/** @type {number} */ off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lineNo[lo];
  };
  /** @type {number | undefined} */
  let at;
  for (let off = flat.indexOf(q); off >= 0; off = flat.indexOf(q, off + 1)) {
    const l = lineAt(off);
    if (at === undefined || (line !== undefined && Math.abs(l - line) < Math.abs(at - line))) at = l;
    if (line === undefined || l === line) break;
  }
  if (at === undefined) return { found: false, why: 'quote-not-found' };
  if (line === undefined) return { found: 'in-file', line: at };
  const off = Math.abs(at - line);
  return {
    found: off <= LINE_WINDOW ? 'near-line' : 'in-file', line: at,
    ...(off ? { claimed_line: line } : {}), ...(off > DRIFT_MAX ? { drift: off } : {}),
  };
}

/**
 * The anchor-path authors of the window, from one `git log` pass: `(paths) => count | undefined` (undefined when no
 * commit in the window touched them, or git cannot walk the history). The window is the CHURN_DAYS before the head
 * commit's own date, as in the areas map.
 * @param {string} root
 * @param {string | undefined} head
 * @returns {(paths: string[]) => number | undefined}
 */
export function authorCounter(root, head) {
  /** @type {{email: string, paths: string[]}[] | undefined} */
  let commits;
  let read = false;
  return (paths) => {
    if (!read) {
      read = true;
      const at = head ? commitDate(root, head) : undefined;
      if (head && at) commits = commitsSince(root, head, new Date(Date.parse(at) - CHURN_DAYS * 86400000).toISOString());
    }
    if (!commits || !paths.length) return undefined;
    const hit = (/** @type {string} */ p) => paths.some((a) => p === a || p.startsWith(`${a.replace(/\/+$/, '')}/`));
    const emails = new Set(commits.filter((c) => c.paths.some(hit)).map((c) => c.email));
    return emails.size || undefined;
  };
}

/**
 * Measures a verified card's bus factor and writes it into `delivery_risk.bus_factor` (see the header). Returns
 * what the result reports, or undefined for a card without `delivery_risk` or without any value.
 * @param {import('./store.mjs').Db} db
 * @param {string} fp
 * @param {(paths: string[]) => number | undefined} count
 * @returns {BusFactor | undefined}
 */
function measureBusFactor(db, fp, count) {
  const row = /** @type {Record<string, any> | undefined} */ (db.prepare('SELECT anchors_json, delivery_risk_json FROM proposals WHERE fp = ?').get(fp));
  if (!row?.delivery_risk_json) return undefined;
  const dr = JSON.parse(String(row.delivery_risk_json));
  const paths = [...new Set(/** @type {string[]} */ (JSON.parse(String(row.anchors_json))).map((a) => a.split('#')[0]).filter(Boolean))];
  const n = count(paths);
  if (n === undefined) return dr.bus_factor === undefined ? undefined : { value: dr.bus_factor, source: 'card' };
  if (dr.bus_factor !== n) db.prepare('UPDATE proposals SET delivery_risk_json = ? WHERE fp = ?').run(JSON.stringify({ ...dr, bus_factor: n }), fp);
  return { value: n, source: 'git-90d', ...(dr.bus_factor !== undefined && dr.bus_factor !== n ? { claimed: dr.bus_factor } : {}) };
}

/**
 * Verifies every `candidate` the run touched and moves each to `verified` or `dropped`, then allocates the run's
 * verified cards to ranked and reserve slots (budget.mjs allocateRun; `perLens` / `perRun` override the packs'
 * budget and the run cap of 16). `allocation` is that result. A verified card's bus factor is measured before its
 * move (see the header). `per_lens` counts per lens the candidates this call checked (`emitted`) and how many
 * verified and dropped; a lens this call checked nothing for is absent.
 * @param {import('./store.mjs').Db} db
 * @param {string} root the repo root (its current working tree is read)
 * @param {string} runId a running run
 * @param {{perLens?: number, perRun?: number}} [budget]
 * @returns {{run: string, verified: number, dropped: number, per_lens: Record<string, {emitted: number, verified: number, dropped: number}>, results: FpResult[], allocation: Record<string, any>}}
 */
export function verifyRun(db, root, runId, budget = {}) {
  const run = requireRunning(db, runId);
  const cached = db.prepare('SELECT 1 FROM sources_cache WHERE run_id = ? AND type = ? AND ref = ?');
  const lensOf = db.prepare('SELECT lens FROM proposals WHERE fp = ?');
  const count = authorCounter(root, typeof run.head_sha === 'string' ? run.head_sha : undefined);
  /** @type {FpResult[]} */
  const results = [];
  /** @type {Record<string, {emitted: number, verified: number, dropped: number}>} */
  const perLens = {};
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
    const bus = note ? undefined : measureBusFactor(db, fp, count);
    /** @type {FpResult} */
    const res = note
      ? { fp, result: 'dropped', note, checks, sources, unchecked }
      : { fp, result: 'verified', checks, sources, unchecked, ...(bus ? { bus_factor: bus } : {}) };
    move(db, fp, res.result, { from: 'candidate', by: VERIFY_DECIDER, note: res.note, runId });
    results.push(res);
    const lens = String(/** @type {Record<string, any>} */ (lensOf.get(fp)).lens);
    const pl = (perLens[lens] ??= { emitted: 0, verified: 0, dropped: 0 });
    pl.emitted++;
    pl[res.result]++;
  }
  return {
    run: runId,
    verified: results.filter((r) => r.result === 'verified').length,
    dropped: results.filter((r) => r.result === 'dropped').length,
    per_lens: perLens,
    results,
    allocation: allocateRun(db, runId, { capOf: packBudget, ...budget }),
  };
}
