// @ts-check
// The `dowser-proposal/1` record (design note "Data & API"), its closed enums, the status transition table
// (D4) as data, and the candidate validator. Pure: no I/O. The JSON Schema twin is
// ../../schema/dowser-proposal-1.schema.json - change both together.
//
// Absent values: a key with no value is OMITTED. `null` is never written, and `0` is never written for
// something unmeasured (a missing `bus_factor` means "not computed").

export const SCHEMA_ID = 'dowser-proposal/1';

/** The four gate lenses (D-wave 2). */
export const LENSES = /** @type {const} */ (['opportunity', 'ux-friction', 'doc-drift', 'security-cra']);
/** Every status a proposal can hold (D4). */
export const STATUSES = /** @type {const} */ (['candidate', 'verified', 'dropped', 'rejected', 'snoozed', 'merged', 'pushed', 'accepted']);
/** Closed reject reason codes (D5); `other` requires a note. */
export const REASONS = /** @type {const} */ (['false-positive', 'already-known', 'not-our-direction', 'not-worth-it', 'wrong-size', 'other']);
export const EVIDENCE_TYPES = /** @type {const} */ (['code', 'doc', 'git', 'ticket', 'page', 'goal', 'dep', 'sarif']);
/** Evidence types whose `quote` is mandatory and mechanically re-checked by `verify` (D8). */
export const QUOTED_TYPES = /** @type {const} */ (['code', 'doc']);
export const SIZES = /** @type {const} */ (['XS', 'S', 'M', 'L', 'XL']);
export const CONFIDENCES = /** @type {const} */ (['low', 'medium', 'high']);
export const BLASTS = /** @type {const} */ (['low', 'medium', 'high']);
/** The five `## ` sections every card body carries. */
export const BODY_SECTIONS = /** @type {const} */ (['Summary', 'Description', 'Flow', 'Expected impact', 'Evaluation']);
export const RUN_MODES = /** @type {const} */ (['full', 'incremental', 'focused']);
export const RUN_STATUSES = /** @type {const} */ (['running', 'done', 'failed']);
export const LENS_STATES = /** @type {const} */ (['ran', 'skipped', 'partial']);
export const TITLE_MAX = 80;

/**
 * Status transition table (D4): from -> the statuses it may move to. Every move is a compare-and-set
 * against this table.
 *  - candidate -> verified | dropped            (verify)
 *  - verified  -> rejected | snoozed | merged | pushed   (pre-triage, outbox)
 *  - verified  -> accepted                      (offline acceptance; decider kind `human` only, see DECIDER_GUARDS)
 *  - pushed    -> accepted | rejected | merged | snoozed (verdicts pulled from Forge; any decider kind)
 *  - snoozed   -> verified (unsnooze) | candidate (resurfaced: new evidence key, re-verified)
 *  - rejected  -> candidate (resurfaced: new evidence type AND >= 2x the keys at rejection)
 *  - dropped   -> candidate (retry: propose added a new evidence key)
 *  - merged, accepted: terminal
 * @type {Readonly<Record<Status, readonly Status[]>>}
 */
export const TRANSITIONS = Object.freeze({
  candidate: Object.freeze(/** @type {Status[]} */ (['verified', 'dropped'])),
  verified: Object.freeze(/** @type {Status[]} */ (['rejected', 'snoozed', 'merged', 'pushed', 'accepted'])),
  pushed: Object.freeze(/** @type {Status[]} */ (['accepted', 'rejected', 'merged', 'snoozed'])),
  snoozed: Object.freeze(/** @type {Status[]} */ (['verified', 'candidate'])),
  rejected: Object.freeze(/** @type {Status[]} */ (['candidate'])),
  dropped: Object.freeze(/** @type {Status[]} */ (['candidate'])),
  merged: Object.freeze(/** @type {Status[]} */ ([])),
  accepted: Object.freeze(/** @type {Status[]} */ ([])),
});

/**
 * Moves only some decider kinds may make: `<from>><to>` -> the allowed kinds. A move not listed is open to
 * every kind. `verified -> accepted` is a person's offline call; `pushed -> accepted` arrives as `forge:`.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DECIDER_GUARDS = Object.freeze({
  'verified>accepted': Object.freeze(['human']),
});

/**
 * A decider is `<kind>:<name>`: `human:<name>` for people, `agent:<harness>` for the scanning agent,
 * `forge:<jira-user>` for verdicts pulled from Jira, `skill:dowser` / `skill:dowser-verify` for the store's own moves.
 */
export const DECIDER_RE = /^[a-z][a-z-]*:[A-Za-z0-9._@-]+$/;

/**
 * True when decider `by` may make the move `from -> to` (DECIDER_GUARDS).
 * @param {string} from
 * @param {string} to
 * @param {string} by
 * @returns {boolean}
 */
export function deciderAllowed(from, to, by) {
  const kinds = DECIDER_GUARDS[`${from}>${to}`];
  return !kinds || kinds.includes(by.split(':')[0]);
}

/**
 * @typedef {typeof LENSES[number]} Lens
 * @typedef {typeof STATUSES[number]} Status
 * @typedef {typeof REASONS[number]} Reason
 * @typedef {typeof EVIDENCE_TYPES[number]} EvidenceType
 * @typedef {typeof SIZES[number]} Size
 * @typedef {typeof CONFIDENCES[number]} Confidence
 * @typedef {{type: EvidenceType, ref: string, quote?: string, url?: string}} Evidence
 * @typedef {{size: Size, days_low?: number, days_high?: number, basis?: string[]}} Effort
 * @typedef {{blast: typeof BLASTS[number], bus_factor?: number}} DeliveryRisk
 * @typedef {{lens_version: string, model?: string, harness?: string, run_id?: string, focus?: string}} Provenance
 * @typedef {{
 *   fp?: string, lens: Lens, kind: string, topic: string, anchors: string[],
 *   title: string, rationale: string, body: string,
 *   evidence: Evidence[], effort: Effort, confidence: Confidence, confidence_why: string,
 *   doc_impact?: string[], delivery_risk?: DeliveryRisk, provenance: Provenance
 * }} Candidate
 * @typedef {Candidate & {
 *   fp: string, status: Status, reason?: Reason, note?: string, merged_into?: string,
 *   external_ref?: string, external_url?: string, decided_by?: string, decided_at?: string
 * }} Proposal
 * @typedef {{ok: true, value: Candidate} | {ok: false, why: string}} Validation
 */

/** An error the CLI turns into an exit code; `detail` (if any) is printed as JSON on stdout. */
export class DowserError extends Error {
  /**
   * @param {string} message
   * @param {number} [code] 2 bad input / refused move, 3 store or connection unavailable
   * @param {Record<string, unknown>} [detail]
   */
  constructor(message, code = 2, detail) {
    super(message);
    this.name = 'DowserError';
    this.code = code;
    this.detail = detail;
  }
}

/** A refused status move (illegal per TRANSITIONS, or stale CAS). Exit 2; carries the current status. */
export class MoveRefused extends DowserError {
  /**
   * @param {string} message
   * @param {{fp: string, current: string, to: string, from?: string}} info
   */
  constructor(message, info) {
    super(message, 2, { error: 'refused', ...info });
    this.name = 'MoveRefused';
    this.fp = info.fp;
    this.current = info.current;
    this.to = info.to;
  }
}

/**
 * @param {readonly string[]} list
 * @param {unknown} v
 * @returns {boolean}
 */
export const isOneOf = (list, v) => typeof v === 'string' && list.includes(v);

/**
 * True when `from -> to` is a legal move.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canMove(from, to) {
  return isOneOf(STATUSES, from) && /** @type {readonly string[]} */ (TRANSITIONS[/** @type {Status} */ (from)]).includes(to);
}

const CANDIDATE_KEYS = ['fp', 'lens', 'kind', 'topic', 'anchors', 'title', 'rationale', 'body', 'evidence', 'effort',
  'confidence', 'confidence_why', 'doc_impact', 'delivery_risk', 'provenance'];
/** Triage fields the store owns; a candidate line that carries one is refused. */
export const STORE_OWNED = ['status', 'reason', 'note', 'merged_into', 'external_ref', 'external_url', 'decided_by', 'decided_at'];

/**
 * The path of the first `null` inside `v`, or undefined.
 * @param {unknown} v
 * @param {string} at
 * @returns {string | undefined}
 */
function findNull(v, at) {
  if (v === null) return at;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = findNull(v[i], `${at}[${i}]`); if (p) return p; }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = findNull(x, at ? `${at}.${k}` : k); if (p) return p; }
  }
  return undefined;
}

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v.trim().length > 0;
/** @param {unknown} v */
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const strList = (v) => Array.isArray(v) && v.every(str);
/** @param {unknown} v */
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/**
 * @param {Record<string, unknown>} o
 * @param {string[]} allowed
 */
const extraKey = (o, allowed) => Object.keys(o).find((k) => !allowed.includes(k));

/**
 * The `## ` section headings present in a Markdown body, in order.
 * @param {string} body
 * @returns {string[]}
 */
export function bodySections(body) {
  return [...body.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => m[1].trim());
}

/**
 * Validates one candidate line (a `dowser-proposal/1` record without the store-owned triage fields).
 * Checks shape and enums, title <= 80, the five body sections, a quote on every code/doc evidence, no `null`
 * anywhere, no 0 for unmeasured numbers. It does not check `kind` against the lens's kinds (fingerprint does).
 * @param {unknown} input
 * @returns {Validation}
 */
export function validateCandidate(input) {
  /** @param {string} why @returns {{ok: false, why: string}} */
  const no = (why) => ({ ok: false, why });
  if (!obj(input)) return no('not-an-object');
  const o = /** @type {Record<string, unknown>} */ (input);
  const nul = findNull(o, '');
  if (nul) return no(`null-at:${nul} (omit the key instead)`);
  const owned = Object.keys(o).find((k) => STORE_OWNED.includes(k));
  if (owned) return no(`store-owned-field:${owned}`);
  const extra = extraKey(o, CANDIDATE_KEYS);
  if (extra) return no(`unknown-field:${extra}`);

  if (!isOneOf(LENSES, o.lens)) return no(`lens:must be one of ${LENSES.join('|')}`);
  if (!str(o.kind)) return no('kind:required');
  if (!str(o.topic)) return no('topic:required');
  if (!Array.isArray(o.anchors) || !o.anchors.every(str)) return no('anchors:must be an array of non-empty strings');

  if (!str(o.title)) return no('title:required');
  if (/** @type {string} */ (o.title).length > TITLE_MAX) return no(`title:longer than ${TITLE_MAX} chars`);
  if (/[\r\n]/.test(/** @type {string} */ (o.title))) return no('title:must be one line');
  if (!str(o.rationale)) return no('rationale:required');
  if (!str(o.body)) return no('body:required');
  const have = bodySections(/** @type {string} */ (o.body)).map((s) => s.toLowerCase());
  const missing = BODY_SECTIONS.filter((s) => !have.includes(s.toLowerCase()));
  if (missing.length) return no(`body:missing section(s) ${missing.map((s) => `## ${s}`).join(', ')}`);

  if (!Array.isArray(o.evidence) || o.evidence.length === 0) return no('evidence:at least one item required');
  for (let i = 0; i < o.evidence.length; i++) {
    const e = o.evidence[i];
    if (!obj(e)) return no(`evidence[${i}]:not an object`);
    const ex = extraKey(e, ['type', 'ref', 'quote', 'url']);
    if (ex) return no(`evidence[${i}]:unknown field ${ex}`);
    if (!isOneOf(EVIDENCE_TYPES, e.type)) return no(`evidence[${i}].type:must be one of ${EVIDENCE_TYPES.join('|')}`);
    if (!str(e.ref)) return no(`evidence[${i}].ref:required`);
    if (isOneOf(QUOTED_TYPES, e.type) && !str(e.quote)) return no(`evidence[${i}].quote:required for ${e.type} evidence`);
    if (e.quote !== undefined && typeof e.quote !== 'string') return no(`evidence[${i}].quote:must be a string`);
    if (e.url !== undefined && !str(e.url)) return no(`evidence[${i}].url:must be a non-empty string`);
  }

  if (!obj(o.effort)) return no('effort:required');
  const ef = /** @type {Record<string, unknown>} */ (o.effort);
  const efx = extraKey(ef, ['size', 'days_low', 'days_high', 'basis']);
  if (efx) return no(`effort:unknown field ${efx}`);
  if (!isOneOf(SIZES, ef.size)) return no(`effort.size:must be one of ${SIZES.join('|')}`);
  if (ef.days_low !== undefined && !posNum(ef.days_low)) return no('effort.days_low:must be > 0 (omit when unmeasured)');
  if (ef.days_high !== undefined && !posNum(ef.days_high)) return no('effort.days_high:must be > 0 (omit when unmeasured)');
  if (typeof ef.days_low === 'number' && typeof ef.days_high === 'number' && ef.days_low > ef.days_high) return no('effort:days_low > days_high');
  if (ef.basis !== undefined && !strList(ef.basis)) return no('effort.basis:must be an array of strings');

  if (!isOneOf(CONFIDENCES, o.confidence)) return no(`confidence:must be one of ${CONFIDENCES.join('|')}`);
  if (!str(o.confidence_why)) return no('confidence_why:required');

  if (o.doc_impact !== undefined && !strList(o.doc_impact)) return no('doc_impact:must be an array of strings');
  if (o.delivery_risk !== undefined) {
    if (!obj(o.delivery_risk)) return no('delivery_risk:must be an object');
    const dr = /** @type {Record<string, unknown>} */ (o.delivery_risk);
    const drx = extraKey(dr, ['blast', 'bus_factor']);
    if (drx) return no(`delivery_risk:unknown field ${drx}`);
    if (!isOneOf(BLASTS, dr.blast)) return no(`delivery_risk.blast:must be one of ${BLASTS.join('|')}`);
    if (dr.bus_factor !== undefined && !(Number.isInteger(dr.bus_factor) && /** @type {number} */ (dr.bus_factor) >= 1)) {
      return no('delivery_risk.bus_factor:must be an integer >= 1 (omit when not computed)');
    }
  }

  if (!obj(o.provenance)) return no('provenance:required');
  const pv = /** @type {Record<string, unknown>} */ (o.provenance);
  const pvx = extraKey(pv, ['lens_version', 'model', 'harness', 'run_id', 'focus']);
  if (pvx) return no(`provenance:unknown field ${pvx}`);
  if (!str(pv.lens_version)) return no('provenance.lens_version:required');
  for (const k of ['model', 'harness', 'run_id', 'focus']) {
    if (pv[k] !== undefined && !str(pv[k])) return no(`provenance.${k}:must be a non-empty string`);
  }
  if (o.fp !== undefined && !(typeof o.fp === 'string' && /^[0-9a-f]{16}$/.test(o.fp))) return no('fp:must be 16 lowercase hex (or omitted)');

  return { ok: true, value: /** @type {Candidate} */ (/** @type {unknown} */ (o)) };
}

/**
 * Checks a triage decision's fields: a reject needs a reason code, `other` needs a note.
 * @param {{to: string, reason?: string, note?: string}} d
 * @returns {string | undefined} why it is invalid, or undefined
 */
export function decisionProblem({ to, reason, note }) {
  if (reason !== undefined && !isOneOf(REASONS, reason)) return `reason must be one of ${REASONS.join('|')}`;
  if (to === 'rejected' && reason === undefined) return 'a reject needs --reason';
  if (reason === 'other' && !str(note)) return 'reason other needs --note';
  return undefined;
}
