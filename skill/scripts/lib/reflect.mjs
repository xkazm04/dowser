// @ts-check
// Dowser reflection (WP2 of the learning loop): the skill's side of the `dowser_reflect_sync` Forge tool
// (docs/contracts/forge-mcp-2.md, additive tool 7; wire types in forge/src/core/types.mjs).
//   exportOffers   -> the tool's arguments {project_key, rules_json?, trust_json?, more?}: the rules in state
//                     `offered` (oldest first, at most RULES_MAX, titles at most TITLES_MAX) and the per-slice trust
//                     (trust.mjs trustReport, the newest TRUST_EVENTS_MAX events) for the Learning tab; read-only
//   ingestReflect  <- the tool's response {rules: RuleDecision[], outcomes: Outcome[]}: each decided rule is a
//                     compare-and-set offered -> accepted|declined (a rule not `offered` is skipped, so a replay
//                     is a no-op); each outcome is an append-only row in `outcomes`, unique (fp, recorded_at)
//   outcomeCounts / outcomesOf   what `context` and `show` read back
// Offers are created by `rules offer` (memory.mjs); nothing here creates one.
import { DECIDER_RE, DowserError, isOneOf } from './model.mjs';
import { clean, now, tx } from './store.mjs';
import { trustReport } from './trust.mjs';

/** @typedef {import('./store.mjs').Db} Db @typedef {import('./store.mjs').Row} Row */

export const OUTCOME_RATINGS = /** @type {const} */ (['right', 'partly', 'wrong']);
/** At most this many offered rules per `dowser_reflect_sync` call, and titles per rule (forge/src/core/types.mjs). */
export const RULES_MAX = 50;
export const TITLES_MAX = 10;
/** The newest trust events `trust_json` carries (forge/src/core/types.mjs TRUST_EVENTS_MAX). */
export const TRUST_EVENTS_MAX = 50;
/** The decider kind for a Forge decision whose `decided_by` carries no `<kind>:` of its own. */
const FORGE_KIND = 'forge';

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v.trim().length > 0;
/** @param {unknown} v @returns {v is Row} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A decider as the store keeps it: `<kind>:<name>`. A bare Forge account id becomes `forge:<id>`.
 * @param {unknown} v
 * @returns {string | undefined}
 */
function decider(v) {
  if (!str(v)) return undefined;
  const s = String(v).trim();
  if (DECIDER_RE.test(s)) return s;
  const prefixed = `${FORGE_KIND}:${s}`;
  return DECIDER_RE.test(prefixed) ? prefixed : undefined;
}

/**
 * The `dowser_reflect_sync` arguments. Read-only. `rules_json` is omitted when no rule is offered (the call is
 * still worth making: it brings back decisions and outcomes). `more: true` = more than RULES_MAX rules are
 * offered, so only the oldest RULES_MAX went out; the rest follow once those are decided. The agent passes
 * every field but `more`.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Row}
 */
export function exportOffers(db, projectKey) {
  const rows = /** @type {Row[]} */ (db.prepare("SELECT * FROM rules WHERE state = 'offered' ORDER BY offered_at, id LIMIT ?").all(RULES_MAX + 1));
  const more = rows.length > RULES_MAX;
  const offers = rows.slice(0, RULES_MAX).map((r) => {
    const fps = r.cluster_json ? /** @type {string[]} */ (JSON.parse(r.cluster_json).fps ?? []) : [];
    const titles = fps.slice(0, TITLES_MAX).map((fp) => {
      const p = /** @type {Row | undefined} */ (db.prepare('SELECT title FROM proposals WHERE fp = ?').get(fp));
      return p ? String(p.title) : undefined;
    }).filter((t) => t !== undefined);
    return clean({ id: r.id, lens: r.lens, text: r.text, titles: titles.length ? titles : undefined, offered_at: r.offered_at });
  });
  const trust = trustReport(db, { sync: false, maxEvents: TRUST_EVENTS_MAX });
  return /** @type {Row} */ (clean({
    project_key: projectKey, rules_json: offers.length ? JSON.stringify(offers) : undefined,
    trust_json: trust.slices.length || trust.events.length ? JSON.stringify(trust) : undefined,
    more: more ? true : undefined,
  }));
}

/**
 * Applies one Forge rule decision. Returns `applied`, `skipped` (unknown, or no longer `offered`) or `invalid`.
 * @param {Db} db
 * @param {unknown} raw
 * @returns {{outcome: 'applied' | 'skipped' | 'invalid', id?: string, why?: string}}
 */
function applyDecision(db, raw) {
  if (!isObj(raw) || !str(raw.id)) return { outcome: 'invalid', why: 'a rule decision needs id' };
  const id = String(raw.id);
  if (raw.state !== 'accepted' && raw.state !== 'declined') return { outcome: 'invalid', id, why: 'state must be accepted|declined' };
  const by = decider(raw.decided_by);
  if (!by) return { outcome: 'invalid', id, why: 'decided_by is required (<kind>:<name>)' };
  if (raw.text !== undefined && !str(raw.text)) return { outcome: 'invalid', id, why: 'text is empty (omit it when absent)' };
  if (raw.decided_at !== undefined && !str(raw.decided_at)) return { outcome: 'invalid', id, why: 'decided_at is empty (omit it when absent)' };
  const to = raw.state;
  return tx(db, () => {
    const cur = /** @type {Row | undefined} */ (db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
    if (!cur) return { outcome: 'skipped', id, why: 'no local rule with this id' };
    if (cur.state !== 'offered') return { outcome: 'skipped', id, why: `rule is ${cur.state}, not offered` };
    const cluster = cur.cluster_json ? JSON.parse(cur.cluster_json) : {};
    cluster.decided_by = by;
    const text = to === 'accepted' && str(raw.text) ? String(raw.text).trim() : String(cur.text);
    if (text !== cur.text) cluster.draft_text = cur.text;
    const row = db.prepare("UPDATE rules SET state = ?, text = ?, cluster_json = ?, decided_at = ? WHERE id = ? AND state = 'offered' RETURNING id")
      .get(to, text, JSON.stringify(cluster), str(raw.decided_at) ? String(raw.decided_at) : now(), id);
    return row ? { outcome: 'applied', id } : { outcome: 'skipped', id, why: 'changed under us' };
  });
}

/**
 * Validates and appends one outcome. `added` = a new row, `seen` = (fp, recorded_at) already stored.
 * @param {Db} db
 * @param {unknown} raw
 * @returns {{outcome: 'added' | 'seen' | 'invalid', why?: string}}
 */
function appendOutcome(db, raw) {
  if (!isObj(raw)) return { outcome: 'invalid', why: 'an outcome is an object' };
  for (const k of ['ref', 'fp', 'issue_ref', 'recorded_at']) if (!str(raw[k])) return { outcome: 'invalid', why: `${k} is required` };
  if (!isOneOf(OUTCOME_RATINGS, raw.rating)) return { outcome: 'invalid', why: `rating must be one of ${OUTCOME_RATINGS.join('|')}` };
  const by = decider(raw.decided_by);
  if (!by) return { outcome: 'invalid', why: 'decided_by is required (<kind>:<name>)' };
  if (raw.note !== undefined && typeof raw.note !== 'string') return { outcome: 'invalid', why: 'note is a string (omit it when absent)' };
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note : null;
  const r = db.prepare('INSERT OR IGNORE INTO outcomes (fp, ref, rating, note, issue_ref, decided_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(raw.fp), String(raw.ref), String(raw.rating), note, String(raw.issue_ref), by, String(raw.recorded_at));
  return { outcome: Number(r.changes) > 0 ? 'added' : 'seen' };
}

/**
 * Applies a `dowser_reflect_sync` response. Idempotent: a replay applies nothing and adds nothing.
 * Output `{rules_applied, rules_skipped, outcomes_added, outcomes_seen}` (+ `invalid` and exit 1 when an entry
 * was malformed; the rest is still applied). `outcomes_seen` = outcomes in the response, new or not.
 * @param {Db} db
 * @param {unknown} doc
 * @returns {{code: number, out: Row}}
 */
export function ingestReflect(db, doc) {
  if (!isObj(doc) || !Array.isArray(doc.rules) || !Array.isArray(doc.outcomes)) {
    throw new DowserError('not a dowser_reflect_sync response: expected {"rules": [...], "outcomes": [...]}', 2);
  }
  let rulesApplied = 0;
  let rulesSkipped = 0;
  let outcomesAdded = 0;
  /** @type {Row[]} */
  const invalid = [];
  for (const [i, raw] of doc.rules.entries()) {
    const r = applyDecision(db, raw);
    if (r.outcome === 'applied') rulesApplied++;
    else if (r.outcome === 'skipped') rulesSkipped++;
    else invalid.push({ kind: 'rule', index: i, ...clean({ id: r.id, why: r.why }) });
  }
  for (const [i, raw] of doc.outcomes.entries()) {
    const r = tx(db, () => appendOutcome(db, raw));
    if (r.outcome === 'added') outcomesAdded++;
    else if (r.outcome === 'invalid') invalid.push({ kind: 'outcome', index: i, why: r.why });
  }
  return {
    code: invalid.length ? 1 : 0,
    out: /** @type {Row} */ (clean({
      rules_applied: rulesApplied, rules_skipped: rulesSkipped, outcomes_added: outcomesAdded, outcomes_seen: doc.outcomes.length,
      invalid: invalid.length ? invalid : undefined,
    })),
  };
}

/**
 * Per lens, the latest rating of each proposal that has an outcome: `{right, partly, wrong}`; `undefined` when
 * the lens has none (absent, not zero). Outcomes of fingerprints this store does not know are not counted.
 * @param {Db} db
 * @param {string} lens
 * @returns {{right: number, partly: number, wrong: number} | undefined}
 */
export function outcomeCounts(db, lens) {
  const rows = /** @type {Row[]} */ (db.prepare(
    `SELECT o.rating, COUNT(*) AS n FROM outcomes o JOIN proposals p ON p.fp = o.fp
     WHERE p.lens = ? AND o.id = (SELECT MAX(o2.id) FROM outcomes o2 WHERE o2.fp = o.fp)
     GROUP BY o.rating`,
  ).all(lens));
  if (rows.length === 0) return undefined;
  const c = { right: 0, partly: 0, wrong: 0 };
  for (const r of rows) c[/** @type {'right' | 'partly' | 'wrong'} */ (String(r.rating))] = Number(r.n);
  return c;
}

/**
 * The newest outcome notes of a lens's items (latest rating per item, only ratings that carry a note), newest first:
 * `[{title, rating, note}]`, each note clipped to `noteCap` characters. What a person said once the item was built is
 * memory the judge reads before predicting (scan-finding/1 "Memory feeds the verdict").
 * @param {Db} db
 * @param {string} lens
 * @param {number} max
 * @param {number} noteCap
 * @returns {{title: string, rating: string, note: string}[]}
 */
export function outcomeNotes(db, lens, max, noteCap) {
  return /** @type {Row[]} */ (db.prepare(
    `SELECT p.title, o.rating, o.note FROM outcomes o JOIN proposals p ON p.fp = o.fp
     WHERE p.lens = ? AND o.note IS NOT NULL AND o.id = (SELECT MAX(o2.id) FROM outcomes o2 WHERE o2.fp = o.fp)
     ORDER BY o.recorded_at DESC, o.id DESC LIMIT ?`,
  ).all(lens, max)).map((r) => {
    const note = String(r.note).replace(/\s+/g, ' ').trim();
    return { title: String(r.title), rating: String(r.rating), note: note.length > noteCap ? `${note.slice(0, noteCap - 1)}…` : note };
  });
}

/**
 * Every outcome row of `fp`, oldest first, absent columns omitted.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function outcomesOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare('SELECT ref, rating, note, issue_ref, decided_by, recorded_at FROM outcomes WHERE fp = ? ORDER BY id').all(fp))
    .map((r) => /** @type {Row} */ (clean(r)));
}
