// @ts-check
// The proposal-quality ledger: how the cards a scan produced actually fared, per lens, lens version and model -
// the evidence a lens pack bump, a scan-score change or a model swap needs before it is called better.
//  - decided: the cards a PERSON accepted, rejected or snoozed (merges are housekeeping, not a judgement);
//    accept_rate = accepted / decided;
//  - by_band: the same for the ranked and the reserve band (is the cut in the right place?);
//  - prediction: of the decided cards that carried a predicted verdict, how many the person agreed with;
//  - outcomes: the latest rating of each accepted card that has one (right / partly / wrong);
//  - delivery: the newest code re-check of each accepted card (resolved / partly / present);
//  - pending: pushed cards nobody has decided yet.
// Every count carries its n; a rate exists only when its n is above zero (unmeasured is never 0). Read-only.
import { DECIDED } from './predict.mjs';

/** @typedef {import('./store-core.mjs').Db} Db */
/** @typedef {Record<string, any>} Row */

const rate = (/** @type {number} */ k, /** @type {number} */ n) => (n > 0 ? Math.round((k / n) * 1000) / 1000 : undefined);
const HUMAN = /^(forge|human):/;

/**
 * @param {Db} db
 * @returns {{slices: Row[]}}
 */
export function qualityReport(db) {
  const rows = /** @type {Row[]} */ (db.prepare(
    `SELECT p.fp, p.lens, p.status, p.band, p.predicted_verdict, p.decided_by, p.provenance_json,
       (SELECT o.rating FROM outcomes o WHERE o.fp = p.fp ORDER BY o.recorded_at DESC, o.id DESC LIMIT 1) AS rating,
       (SELECT d.state FROM deliveries d WHERE d.fp = p.fp ORDER BY d.id DESC LIMIT 1) AS delivery
     FROM proposals p WHERE p.status IN ('accepted', 'rejected', 'snoozed', 'pushed') ORDER BY p.lens, p.fp`,
  ).all());
  /** @type {Map<string, Row>} */
  const slices = new Map();
  for (const r of rows) {
    const prov = JSON.parse(String(r.provenance_json));
    const version = typeof prov.lens_version === 'string' ? prov.lens_version : 'unknown';
    const model = typeof prov.model === 'string' ? prov.model : 'unknown';
    const key = `${r.lens}|${version}|${model}`;
    const s = slices.get(key) ?? { lens: r.lens, lens_version: version, model, decided: { n: 0, accepted: 0 }, by_band: {},
      prediction: { n: 0, agreed: 0 }, outcomes: { right: 0, partly: 0, wrong: 0 }, delivery: { checked: 0, resolved: 0, partly: 0, present: 0 }, pending: 0 };
    slices.set(key, s);
    if (r.status === 'pushed') { s.pending++; continue; }
    if (!HUMAN.test(String(r.decided_by ?? ''))) continue;
    const accepted = r.status === 'accepted' ? 1 : 0;
    s.decided.n++;
    s.decided.accepted += accepted;
    if (r.band === 'ranked' || r.band === 'reserve') {
      const b = (s.by_band[r.band] ??= { n: 0, accepted: 0 });
      b.n++;
      b.accepted += accepted;
    }
    if (typeof r.predicted_verdict === 'string') {
      s.prediction.n++;
      if (/** @type {Record<string, string>} */ (DECIDED)[String(r.status)] === r.predicted_verdict) s.prediction.agreed++;
    }
    if (accepted && typeof r.rating === 'string' && r.rating in s.outcomes) s.outcomes[r.rating]++;
    if (accepted && typeof r.delivery === 'string' && r.delivery in s.delivery) { s.delivery.checked++; s.delivery[r.delivery]++; }
  }
  const out = [...slices.values()].filter((s) => s.decided.n > 0 || s.pending > 0).map((s) => {
    /** @type {Row} */
    const by = {};
    for (const [band, b] of Object.entries(/** @type {Record<string, {n: number, accepted: number}>} */ (s.by_band))) by[band] = { ...b, accept_rate: rate(b.accepted, b.n) };
    const rated = s.outcomes.right + s.outcomes.partly + s.outcomes.wrong;
    return Object.fromEntries(Object.entries({
      lens: s.lens, lens_version: s.lens_version, model: s.model, decided: s.decided, accept_rate: rate(s.decided.accepted, s.decided.n),
      by_band: Object.keys(by).length ? by : undefined,
      prediction: s.prediction.n ? { ...s.prediction, rate: rate(s.prediction.agreed, s.prediction.n) } : undefined,
      outcomes: rated ? s.outcomes : undefined,
      delivery: s.delivery.checked ? s.delivery : undefined,
      pending: s.pending || undefined,
    }).filter(([, v]) => v !== undefined));
  });
  return { slices: out };
}
