// @ts-check
// scan-score - scan-score/1, the one ranking number of the scan-finding/1 contract (docs/contracts/scan-finding-1.md).
//
// Source: a copy of ai-registry skills/scan-sweep/scripts/score.mjs (spark backlog-scan-family, 2026-10-30), with
// JSDoc casts added for this repo's checkJs. Change the formula there first; a change is scan-score/2, never an edit.
// (lib/score.mjs in this folder is something else: lens-quality scoring against the seeded fixture.)
//
// Why: three scanners ranked their backlogs three ways - a client-side "value" sort in Personas, an invented ev in
// bp's UI, and none in Dowser - so the same finding ranked differently in every app. The producer now stores ONE
// number with its breakdown; consumers (the Forge inbox) sort by it and never recompute.
//
// Contract: scanScore({ impact, confidence, effort, risk }) -> { score, score_parts } | null. impact and effort are
// required (1-10 integers): without either the finding is UNSCORED and the function returns null - never 0, because
// unmeasured is not a measurement. confidence absent counts as low (0.5); risk absent as the midpoint factor 0.75.
// Out-of-range input throws: a scale bug must fail at the producer, not rank silently. sizeToEffort maps XS..XL when
// only a size is known; blastToRisk maps a low/medium/high blast radius to 2/5/8.

export const FORMULA = 'scan-score/1';
/** @type {Readonly<Record<string, number>>} */
const CONFIDENCE_W = Object.freeze({ low: 0.5, medium: 0.75, high: 0.95 });
/** @type {Readonly<Record<string, number>>} */
const SIZE_EFFORT = Object.freeze({ XS: 1, S: 2, M: 4, L: 7, XL: 10 });
/** @type {Readonly<Record<string, number>>} */
const BLAST_RISK = Object.freeze({ low: 2, medium: 5, high: 8 });

/**
 * @param {string} name
 * @param {unknown} v
 * @returns {number}
 */
const scale = (name, v) => {
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 10) {
    throw new RangeError(`${name} must be an integer 1-10 (got ${JSON.stringify(v)})`);
  }
  return /** @type {number} */ (v);
};

/** @param {string | undefined} size @returns {number | undefined} */
export function sizeToEffort(size) {
  return size && Object.hasOwn(SIZE_EFFORT, size) ? SIZE_EFFORT[size] : undefined;
}

/** @param {string | undefined} blast @returns {number | undefined} */
export function blastToRisk(blast) {
  return blast && Object.hasOwn(BLAST_RISK, blast) ? BLAST_RISK[blast] : undefined;
}

/**
 * @typedef {{impact: number, confidence_w: number, effort_div: number, risk_factor: number, formula: string}} ScoreParts
 */

/**
 * @param {{ impact?: number, confidence?: string, effort?: number, risk?: number }} [f]
 * @returns {{ score: number, score_parts: ScoreParts } | null}
 */
export function scanScore({ impact, confidence, effort, risk } = {}) {
  if (impact === undefined || impact === null || effort === undefined || effort === null) return null;
  scale('impact', impact);
  scale('effort', effort);
  if (risk !== undefined && risk !== null) scale('risk', risk);
  if (confidence !== undefined && confidence !== null && !Object.hasOwn(CONFIDENCE_W, confidence)) {
    throw new RangeError(`confidence must be low|medium|high (got ${JSON.stringify(confidence)})`);
  }
  const confidence_w = CONFIDENCE_W[confidence ?? 'low'];
  const effort_div = 1 + (effort - 1) / 9;
  const risk_factor = risk === undefined || risk === null ? 0.75 : 1 - (risk - 1) / 20;
  const score = Math.round(((10 * impact * confidence_w) / effort_div) * risk_factor * 10) / 10;
  return {
    score,
    score_parts: { impact, confidence_w, effort_div: Math.round(effort_div * 1000) / 1000, risk_factor, formula: FORMULA },
  };
}
