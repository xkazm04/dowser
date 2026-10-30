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
/** A pushed record's `quote_sha` (wire mode): the first 16 hex of sha256 of the whitespace-normalised quote. */
export const QUOTE_SHA_RE = /^[0-9a-f]{16}$/;
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
 * Length caps on the free-text and list fields of a candidate (chars for strings, items for lists). They bound
 * what one record may store, here and on push. Each sits well above what real scans write (measured on a
 * 134-record campaign store, 2026-10: body 2978, rationale 416, quote 394, confidence_why 245, evidence 10 keys
 * accumulated over 10 waves, anchors 4, anchor 62, ref 58, url 58, kind 26, topic 42, doc_impact 5 x 63,
 * basis 4 x 62). `evidence` counts a record's accumulated evidence: an outbox record carries all of it.
 * `list`/`item` cap `doc_impact` and `effort.basis`; `provenance` caps each provenance string.
 */
export const FIELD_LIMITS = Object.freeze({
  kind: 64, topic: 160, anchors: 12, anchor: 300, rationale: 2000, body: 12000, confidence_why: 1000,
  evidence: 100, ref: 500, quote: 2000, url: 2000, list: 20, item: 300, provenance: 200,
});
/** Supporting views a card may carry (`artifacts[]`): one message each, drawn from the card's own evidence. */
export const ARTIFACT_KINDS = /** @type {const} */ (['table', 'flow', 'before-after', 'matrix']);
export const FLOW_MARKS = /** @type {const} */ (['friction', 'failure', 'missing', 'new']);
export const ARTIFACT_LIMITS = Object.freeze({
  perCard: 3, message: 120, alt: 400, label: 40, cell: 80,
  tableColumns: 6, tableRows: 12, flowSteps: 8, sideLines: 8, matrixRows: 8, matrixColumns: 6,
});

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
export const DECIDER_RE = /^[a-z][a-z-]*:[A-Za-z0-9._@:-]+$/;

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
 * @typedef {{type: EvidenceType, ref: string, quote?: string, quote_sha?: string, url?: string}} Evidence
 * @typedef {{size: Size, days_low?: number, days_high?: number, basis?: string[]}} Effort
 * @typedef {{blast: typeof BLASTS[number], bus_factor?: number}} DeliveryRisk
 * @typedef {{lens_version: string, model?: string, harness?: string, run_id?: string, focus?: string}} Provenance
 * @typedef {{columns: string[], rows: string[][], highlight?: number[]}} TableData
 * @typedef {{steps: {label: string, mark?: typeof FLOW_MARKS[number]}[]}} FlowData
 * @typedef {{measure: string, before: string[], after: string[]}} BeforeAfterData
 * @typedef {{rows: string[], columns: string[], cells: {v: string, level?: 0|1|2|3}[][]}} MatrixData
 * @typedef {{kind: typeof ARTIFACT_KINDS[number], message: string, alt: string, refs: string[],
 *   data: TableData | FlowData | BeforeAfterData | MatrixData}} Artifact
 * @typedef {{
 *   fp?: string, lens: Lens, kind: string, topic: string, anchors: string[],
 *   title: string, rationale: string, body: string,
 *   evidence: Evidence[], effort: Effort, confidence: Confidence, confidence_why: string,
 *   doc_impact?: string[], delivery_risk?: DeliveryRisk, artifacts?: Artifact[], provenance: Provenance
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
  'confidence', 'confidence_why', 'doc_impact', 'delivery_risk', 'artifacts', 'provenance'];
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

/** @param {unknown} v @param {number} max */
const tooLong = (v, max) => typeof v === 'string' && v.length > max;
/**
 * True when `v` parses as an absolute `https:` URL.
 * @param {unknown} v
 */
export function isHttpsUrl(v) {
  if (typeof v !== 'string') return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

/**
 * Why an optional string list (`doc_impact`, `effort.basis`) breaks the list caps, or undefined.
 * @param {string} at
 * @param {unknown} v
 * @returns {string | undefined}
 */
function listProblem(at, v) {
  if (!Array.isArray(v)) return undefined;
  if (v.length > FIELD_LIMITS.list) return `${at}:at most ${FIELD_LIMITS.list} items`;
  const i = v.findIndex((x) => tooLong(x, FIELD_LIMITS.item));
  return i >= 0 ? `${at}[${i}]:longer than ${FIELD_LIMITS.item} chars` : undefined;
}

/** @param {unknown} v @param {number} max */
const short = (v, max) => str(v) && /** @type {string} */ (v).length <= max && !/[\r\n]/.test(/** @type {string} */ (v));
/** @param {unknown} v @param {number} maxItems @param {number} maxLen */
const shortList = (v, maxItems, maxLen) => Array.isArray(v) && v.length > 0 && v.length <= maxItems && v.every((x) => short(x, maxLen));

/**
 * Why `artifacts` is invalid, or undefined. Each artifact is one supporting view: a one-line message, a text
 * alternative, the refs of the card's own evidence it was drawn from, and kind-specific data within the caps.
 * @param {unknown} list
 * @param {string[]} evidenceRefs
 * @returns {string | undefined}
 */
export function artifactsProblem(list, evidenceRefs) {
  const L = ARTIFACT_LIMITS;
  if (!Array.isArray(list) || list.length === 0) return 'artifacts:must be a non-empty array (omit when none)';
  if (list.length > L.perCard) return `artifacts:at most ${L.perCard} per card`;
  for (let i = 0; i < list.length; i++) {
    const at = `artifacts[${i}]`;
    const a = list[i];
    if (!obj(a)) return `${at}:not an object`;
    const x = extraKey(a, ['kind', 'message', 'alt', 'refs', 'data']);
    if (x) return `${at}:unknown field ${x}`;
    if (!isOneOf(ARTIFACT_KINDS, a.kind)) return `${at}.kind:must be one of ${ARTIFACT_KINDS.join('|')}`;
    if (!short(a.message, L.message)) return `${at}.message:one line, at most ${L.message} chars`;
    if (!str(a.alt) || /** @type {string} */ (a.alt).length > L.alt) return `${at}.alt:required, at most ${L.alt} chars`;
    if (!strList(a.refs) || /** @type {string[]} */ (a.refs).length === 0) return `${at}.refs:at least one evidence ref`;
    if (/** @type {string[]} */ (a.refs).length > FIELD_LIMITS.evidence) return `${at}.refs:at most ${FIELD_LIMITS.evidence} refs`;
    const stray = /** @type {string[]} */ (a.refs).find((r) => !evidenceRefs.includes(r));
    if (stray) return `${at}.refs:${stray} is not in this card's evidence`;
    if (!obj(a.data)) return `${at}.data:required`;
    const d = /** @type {Record<string, unknown>} */ (a.data);
    if (a.kind === 'table') {
      const dx = extraKey(d, ['columns', 'rows', 'highlight']);
      if (dx) return `${at}.data:unknown field ${dx}`;
      if (!shortList(d.columns, L.tableColumns, L.label)) return `${at}.data.columns:1-${L.tableColumns} labels of at most ${L.label} chars`;
      const n = /** @type {string[]} */ (d.columns).length;
      if (!Array.isArray(d.rows) || d.rows.length === 0 || d.rows.length > L.tableRows) return `${at}.data.rows:1-${L.tableRows} rows`;
      const bad = d.rows.findIndex((r) => !Array.isArray(r) || r.length !== n || !r.every((c) => typeof c === 'string' && c.length <= L.cell && !/[\r\n]/.test(c)));
      if (bad >= 0) return `${at}.data.rows[${bad}]:must have ${n} one-line cells of at most ${L.cell} chars`;
      if (d.highlight !== undefined && !(Array.isArray(d.highlight) && d.highlight.length > 0
        && d.highlight.every((h) => Number.isInteger(h) && h >= 0 && h < /** @type {unknown[]} */ (d.rows).length))) {
        return `${at}.data.highlight:row indexes (omit when none)`;
      }
    } else if (a.kind === 'flow') {
      const dx = extraKey(d, ['steps']);
      if (dx) return `${at}.data:unknown field ${dx}`;
      if (!Array.isArray(d.steps) || d.steps.length < 2 || d.steps.length > L.flowSteps) return `${at}.data.steps:2-${L.flowSteps} steps`;
      for (let s = 0; s < d.steps.length; s++) {
        const st = d.steps[s];
        if (!obj(st) || extraKey(st, ['label', 'mark'])) return `${at}.data.steps[${s}]:{label, mark?}`;
        if (!short(st.label, L.label)) return `${at}.data.steps[${s}].label:at most ${L.label} chars`;
        if (st.mark !== undefined && !isOneOf(FLOW_MARKS, st.mark)) return `${at}.data.steps[${s}].mark:must be one of ${FLOW_MARKS.join('|')}`;
      }
    } else if (a.kind === 'before-after') {
      const dx = extraKey(d, ['measure', 'before', 'after']);
      if (dx) return `${at}.data:unknown field ${dx}`;
      if (!short(d.measure, L.label)) return `${at}.data.measure:at most ${L.label} chars`;
      if (!shortList(d.before, L.sideLines, L.cell)) return `${at}.data.before:1-${L.sideLines} lines of at most ${L.cell} chars`;
      if (!shortList(d.after, L.sideLines, L.cell)) return `${at}.data.after:1-${L.sideLines} lines of at most ${L.cell} chars`;
    } else {
      const dx = extraKey(d, ['rows', 'columns', 'cells']);
      if (dx) return `${at}.data:unknown field ${dx}`;
      if (!shortList(d.rows, L.matrixRows, L.label)) return `${at}.data.rows:1-${L.matrixRows} labels of at most ${L.label} chars`;
      if (!shortList(d.columns, L.matrixColumns, L.label)) return `${at}.data.columns:1-${L.matrixColumns} labels of at most ${L.label} chars`;
      const nr = /** @type {string[]} */ (d.rows).length;
      const nc = /** @type {string[]} */ (d.columns).length;
      if (!Array.isArray(d.cells) || d.cells.length !== nr) return `${at}.data.cells:one row of cells per row label`;
      for (let r = 0; r < nr; r++) {
        const row = d.cells[r];
        if (!Array.isArray(row) || row.length !== nc) return `${at}.data.cells[${r}]:one cell per column`;
        for (let c = 0; c < nc; c++) {
          const cell = row[c];
          if (!obj(cell) || extraKey(cell, ['v', 'level'])) return `${at}.data.cells[${r}][${c}]:{v, level?}`;
          if (typeof cell.v !== 'string' || cell.v.length > L.label) return `${at}.data.cells[${r}][${c}].v:a string of at most ${L.label} chars`;
          if (cell.level !== undefined && ![0, 1, 2, 3].includes(/** @type {number} */ (cell.level))) return `${at}.data.cells[${r}][${c}].level:0-3 (omit when none)`;
        }
      }
    }
  }
  return undefined;
}

/**
 * Validates one candidate line (a `dowser-proposal/1` record without the store-owned triage fields).
 * Checks shape and enums, title <= 80 and the FIELD_LIMITS caps, the five body sections, a quote on every
 * code/doc evidence, an evidence `url` that is https, no `null` anywhere, no 0 for unmeasured numbers. It does not check `kind` against the lens's kinds (fingerprint does).
 * `opts.wire` checks a pushed record instead (forge-mcp-2): code/doc evidence carries `quote` OR `quote_sha`
 * (16 lowercase hex, `quoteSha` in fingerprint.mjs), for a team that withholds source lines (`quotes=omit`).
 * `quote_sha` is an evidence key only in wire mode; every other rule is the same.
 * @param {unknown} input
 * @param {{wire?: boolean}} [opts]
 * @returns {Validation}
 */
export function validateCandidate(input, opts = {}) {
  const wire = opts.wire === true;
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
  const F = FIELD_LIMITS;
  /** @param {string} at @param {unknown} v @param {number} max */
  const long = (at, v, max) => (tooLong(v, max) ? `${at}:longer than ${max} chars` : undefined);
  if (!str(o.kind)) return no('kind:required');
  const kl = long('kind', o.kind, F.kind); if (kl) return no(kl);
  if (!str(o.topic)) return no('topic:required');
  const tl = long('topic', o.topic, F.topic); if (tl) return no(tl);
  if (!Array.isArray(o.anchors) || !o.anchors.every(str)) return no('anchors:must be an array of non-empty strings');
  if (o.anchors.length > F.anchors) return no(`anchors:at most ${F.anchors} items`);
  const longAnchor = o.anchors.findIndex((a) => tooLong(a, F.anchor));
  if (longAnchor >= 0) return no(`anchors[${longAnchor}]:longer than ${F.anchor} chars`);

  if (!str(o.title)) return no('title:required');
  if (/** @type {string} */ (o.title).length > TITLE_MAX) return no(`title:longer than ${TITLE_MAX} chars`);
  if (/[\r\n]/.test(/** @type {string} */ (o.title))) return no('title:must be one line');
  if (!str(o.rationale)) return no('rationale:required');
  const rl = long('rationale', o.rationale, F.rationale); if (rl) return no(rl);
  if (!str(o.body)) return no('body:required');
  const bl = long('body', o.body, F.body); if (bl) return no(bl);
  const have = bodySections(/** @type {string} */ (o.body)).map((s) => s.toLowerCase());
  const missing = BODY_SECTIONS.filter((s) => !have.includes(s.toLowerCase()));
  if (missing.length) return no(`body:missing section(s) ${missing.map((s) => `## ${s}`).join(', ')}`);

  if (!Array.isArray(o.evidence) || o.evidence.length === 0) return no('evidence:at least one item required');
  if (o.evidence.length > F.evidence) return no(`evidence:at most ${F.evidence} items`);
  for (let i = 0; i < o.evidence.length; i++) {
    const e = o.evidence[i];
    if (!obj(e)) return no(`evidence[${i}]:not an object`);
    const ex = extraKey(e, wire ? ['type', 'ref', 'quote', 'quote_sha', 'url'] : ['type', 'ref', 'quote', 'url']);
    if (ex) return no(`evidence[${i}]:unknown field ${ex}`);
    if (!isOneOf(EVIDENCE_TYPES, e.type)) return no(`evidence[${i}].type:must be one of ${EVIDENCE_TYPES.join('|')}`);
    if (!str(e.ref)) return no(`evidence[${i}].ref:required`);
    const el = long(`evidence[${i}].ref`, e.ref, F.ref) ?? long(`evidence[${i}].quote`, e.quote, F.quote) ?? long(`evidence[${i}].url`, e.url, F.url);
    if (el) return no(el);
    if (e.quote_sha !== undefined) {
      if (typeof e.quote_sha !== 'string' || !QUOTE_SHA_RE.test(e.quote_sha)) return no(`evidence[${i}].quote_sha:must be 16 lowercase hex chars`);
      if (!isOneOf(QUOTED_TYPES, e.type)) return no(`evidence[${i}].quote_sha:only on ${QUOTED_TYPES.join('|')} evidence`);
    }
    if (isOneOf(QUOTED_TYPES, e.type) && !str(e.quote) && !(wire && e.quote_sha !== undefined)) {
      return no(`evidence[${i}].quote:required for ${e.type} evidence${wire ? ' (or quote_sha)' : ''}`);
    }
    if (e.quote !== undefined && typeof e.quote !== 'string') return no(`evidence[${i}].quote:must be a string`);
    if (e.url !== undefined && !str(e.url)) return no(`evidence[${i}].url:must be a non-empty string`);
    if (e.url !== undefined && !isHttpsUrl(e.url)) return no(`evidence[${i}].url:must be an https:// URL`);
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
  const efl = listProblem('effort.basis', ef.basis); if (efl) return no(efl);

  if (!isOneOf(CONFIDENCES, o.confidence)) return no(`confidence:must be one of ${CONFIDENCES.join('|')}`);
  if (!str(o.confidence_why)) return no('confidence_why:required');
  const cl = long('confidence_why', o.confidence_why, F.confidence_why); if (cl) return no(cl);

  if (o.doc_impact !== undefined && !strList(o.doc_impact)) return no('doc_impact:must be an array of strings');
  const dl = listProblem('doc_impact', o.doc_impact); if (dl) return no(dl);
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

  if (o.artifacts !== undefined) {
    const why = artifactsProblem(o.artifacts, /** @type {Record<string, unknown>[]} */ (o.evidence).map((e) => String(e.ref)));
    if (why) return no(why);
  }

  if (!obj(o.provenance)) return no('provenance:required');
  const pv = /** @type {Record<string, unknown>} */ (o.provenance);
  const pvx = extraKey(pv, ['lens_version', 'model', 'harness', 'run_id', 'focus']);
  if (pvx) return no(`provenance:unknown field ${pvx}`);
  if (!str(pv.lens_version)) return no('provenance.lens_version:required');
  for (const k of ['model', 'harness', 'run_id', 'focus']) {
    if (pv[k] !== undefined && !str(pv[k])) return no(`provenance.${k}:must be a non-empty string`);
  }
  for (const k of ['lens_version', 'model', 'harness', 'run_id', 'focus']) {
    const pl = long(`provenance.${k}`, pv[k], F.provenance); if (pl) return no(pl);
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

/**
 * The resurfacing predicate (D4), pure. `then` is the evidence when the item entered its current status,
 * `now` the evidence after this proposal's refs were appended.
 *  - snoozed: any new evidence key (now.refs > then.refs);
 *  - dropped: any new evidence key (a retry after a failed verify);
 *  - rejected: a NEW evidence type AND now.refs >= 2 x then.refs;
 *  - any other status never resurfaces.
 * @param {string} status
 * @param {{refs: number, types: string[]}} then
 * @param {{refs: number, types: string[]}} now
 * @returns {{resurface: boolean, rule: string}}
 */
export function resurfaces(status, then, now) {
  if (status === 'snoozed' || status === 'dropped') {
    return { resurface: now.refs > then.refs, rule: `${status}:refs ${then.refs}->${now.refs}` };
  }
  if (status === 'rejected') {
    const newTypes = now.types.filter((t) => !then.types.includes(t));
    const doubled = now.refs >= 2 * then.refs;
    return {
      resurface: newTypes.length > 0 && doubled,
      rule: `rejected:new-types [${newTypes.join(',')}] refs ${then.refs}->${now.refs} (needs >= ${2 * then.refs})`,
    };
  }
  return { resurface: false, rule: `${status}:never` };
}
