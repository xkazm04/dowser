// @ts-check
// The scan-finding/1 fields propose fills in (docs/contracts/scan-finding-1.md): the defaults a judge may leave out
// (effort.score from size, risk from the blast radius, category from the lens), the scan-score/1 number, and the
// predicted verdict with the closest decided precedent quoted. Reads the store only; imports store-core.mjs, never
// proposals.mjs or memory.mjs (memory.mjs re-exports topicTokens from here).
import { LENS_CATEGORY } from './model.mjs';
import { blastToRisk, scanScore, sizeToEffort } from './scan-score.mjs';

/** @import { Db, Row } from './store-core.mjs' */
/** @typedef {import('./model.mjs').Candidate} Candidate */

/** Short words that carry no topic on their own. */
const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'not', 'are', 'was', 'its', 'via', 'per', 'out', 'all', 'any', 'has', 'can', 'use', 'when', 'that', 'this', 'than', 'then', 'onto', 'over', 'non']);

/**
 * The tokens of a normalized (kebab) topic that can carry meaning: 3+ characters, not a stop word, de-duplicated.
 * @param {string} topic
 * @returns {string[]}
 */
export function topicTokens(topic) {
  return [...new Set(String(topic).split('-').filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** Statuses that are a person's decision, and the verdict each one is. */
export const DECIDED = Object.freeze({ accepted: 'accept', rejected: 'reject', snoozed: 'defer' });
/** What `predicted_why` says when memory holds no decision on similar work. */
export const NO_PRECEDENT = 'no recorded decision on similar work';
const WHY_MAX = 300;

/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The category a card is stored with. A card's category is its lens pack's declared default (LENS_CATEGORY); the
 * judge may move it technical -> product (a doc fix users feel), never product -> technical. Category picks the
 * trust slice, and technical slices start at L1, so a product lens relabelling its cards would skip the person's
 * gate (self-scan cycle 2, defect 2). Such a request is clamped to the lens default and reported, not refused: the
 * card's evidence is sound, only the label is the store's to set.
 * @param {string} lens
 * @param {string | undefined} asked  the judge's category, if any
 * @returns {{category: string, clamped?: {asked: string, stored: string}}}
 */
export function categoryOf(lens, asked) {
  const fallback = /** @type {Record<string, string>} */ (LENS_CATEGORY)[lens];
  if (asked === undefined) return { category: fallback };
  if (fallback === 'product' && asked !== 'product') return { category: fallback, clamped: { asked, stored: fallback } };
  return { category: asked };
}

/**
 * The scan-finding/1 values propose stores for a candidate: effort with `score` (the judge's, else from size),
 * `risk` (the judge's, else from delivery_risk.blast, else absent), `category` (categoryOf: the lens's, or the
 * judge's move technical -> product; `clamped` when a product lens's card asked for technical), and
 * `score` + `score_parts` (absent when the card has no impact: unscored, never 0).
 * @param {Candidate} c
 * @returns {{effort: Candidate['effort'], risk?: number, category: string, clamped?: {asked: string, stored: string}, score?: number, score_parts?: Row}}
 */
export function scoreOf(c) {
  const effortScore = c.effort.score ?? sizeToEffort(c.effort.size);
  const effort = effortScore === undefined ? c.effort : { ...c.effort, score: effortScore };
  const risk = c.risk ?? blastToRisk(c.delivery_risk?.blast);
  const { category, clamped } = categoryOf(c.lens, c.category);
  const s = scanScore({ impact: c.impact, confidence: c.confidence, effort: effortScore, risk });
  return { effort, ...(risk !== undefined ? { risk } : {}), category, ...(clamped ? { clamped } : {}), ...(s ? { score: s.score, score_parts: s.score_parts } : {}) };
}

/**
 * The closest decided item of the same lens: an accepted, rejected or snoozed proposal that shares at least one
 * normalized anchor or two topic tokens with the candidate (anchors weigh 10, tokens 1; ties go to the newest
 * decision). Its reason and note come along: titles alone are not memory.
 * @param {Db} db
 * @param {{fp: string, lens: string, topic: string, anchors: string[]}} c  topic normalized, anchors normalized
 * @returns {Row | undefined}
 */
export function closestPrecedent(db, { fp, lens, topic, anchors }) {
  const mine = new Set(anchors);
  const tokens = new Set(topicTokens(topic));
  /** @type {{row: Row, weight: number} | undefined} */
  let best;
  for (const r of /** @type {Row[]} */ (db.prepare(
    `SELECT fp, title, topic, anchors_json, status, reason, note, decided_by, decided_at FROM proposals
     WHERE lens = ? AND fp <> ? AND status IN ('accepted', 'rejected', 'snoozed') ORDER BY decided_at DESC, fp`,
  ).all(lens, fp))) {
    const shared = /** @type {string[]} */ (JSON.parse(r.anchors_json)).filter((a) => mine.has(a)).length;
    const words = topicTokens(String(r.topic)).filter((t) => tokens.has(t)).length;
    if (shared < 1 && words < 2) continue;
    const weight = shared * 10 + words;
    if (!best || weight > best.weight) best = { row: r, weight };
  }
  return best?.row;
}

/**
 * One line naming a precedent: its title, fp, status, reason and note.
 * @param {Row} p
 * @param {string} [label] `closest precedent`, or `counter-precedent` when its decision contradicts the verdict
 * @returns {string}
 */
export function precedentLine(p, label = 'closest precedent') {
  return `${label} "${p.title}" (${p.fp}) ${p.status}${p.reason ? ` as ${p.reason}` : ''}${p.note ? `: ${String(p.note).replace(/\s+/g, ' ').trim()}` : ''}`;
}

/** A proposal fingerprint quoted in free text (16 hex characters): the judge named a precedent. */
const FP_IN_TEXT = /\b[0-9a-f]{16}\b/;

/**
 * The predicted verdict a card is stored with (shadow mode: recorded before any person sees it). The judge's
 * `predicted_verdict` is kept; without one the precedent's decision is the prediction, and with no precedent the
 * card is `defer` (a person decides). The judge's `predicted_why` gets the store's precedent appended only when it
 * names no precedent at all (neither the found one's title or fp nor any other fp): the judge's choice of precedent
 * stands. An appended precedent whose decision contradicts the predicted verdict (a snoozed item on a predicted
 * `accept`) is labelled `counter-precedent`, never `closest precedent`, so the line does not read as support.
 * `predicted_by` is `dowser-<lens>@<lens_version>:<model>`, with `memory` as the model when the store derived the
 * verdict.
 * @param {Candidate} c
 * @param {Row | undefined} precedent
 * @param {string | undefined} model
 * @returns {{predicted_verdict: string, predicted_why: string, predicted_by: string}}
 */
export function predictionOf(c, precedent, model) {
  const line = precedent ? precedentLine(precedent) : undefined;
  const by = (/** @type {string} */ m) => clip(`dowser-${c.lens}@${c.provenance.lens_version}:${m}`, 200);
  if (c.predicted_verdict !== undefined) {
    const own = c.predicted_why;
    const names = own !== undefined && (FP_IN_TEXT.test(own) || (precedent !== undefined && own.includes(String(precedent.title))));
    const agrees = precedent !== undefined && /** @type {Record<string, string>} */ (DECIDED)[String(precedent.status)] === c.predicted_verdict;
    const shown = precedent ? precedentLine(precedent, agrees ? 'closest precedent' : 'counter-precedent') : undefined;
    const why = own === undefined ? shown ?? NO_PRECEDENT : shown && !names ? `${own} [${shown}]` : own;
    return { predicted_verdict: c.predicted_verdict, predicted_why: clip(why, WHY_MAX), predicted_by: by(model ?? 'unknown-model') };
  }
  const verdict = precedent ? /** @type {Record<string, string>} */ (DECIDED)[String(precedent.status)] : 'defer';
  return { predicted_verdict: verdict, predicted_why: clip(line ?? `${NO_PRECEDENT}; a person decides`, WHY_MAX), predicted_by: by('memory') };
}
