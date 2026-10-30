// @ts-check
// Reflection (forge-mcp-2 tool 7, additive): the Learning tab's data, the rules a person decides in Forge and
// the outcomes of accepted items. `dowser_reflect_sync` is the skill's one idempotent round trip: it pushes its
// `offered` rules and reads back every rule decided in Forge plus the newest outcomes.
//
// Everything the Learning tab shows is derived from proposals, pushes, the verdict log and the two new tables
// (`rules`, `outcomes`); nothing is stored twice.
import { LENSES, isOneOf } from '../shared/model.mjs';
import { namesOf } from './names.mjs';
import { logLine } from './observe.mjs';
import { findProposal, needInbox, toProposal } from './store.mjs';
import { INBOX_STATUSES, NOTE_MAX, OUTCOMES_MAX, OUTCOME_RATINGS, RULES_MAX, RULE_TEXT_MAX, RULE_TITLES_MAX, TRUST_EVENTS_MAX, TRUST_SLICES_MAX } from './types.mjs';
import { AppError, DuplicateKey, isIso, isObj, needStr, omitAbsent, optStr, sqlv, str } from './util.mjs';
import { deciderOf } from './verdicts.mjs';
import { parseJsonArray } from './push.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./ports.mjs').Row} Row
 * @typedef {import('./types.mjs').RuleOffer} RuleOffer
 * @typedef {import('./types.mjs').RuleDecision} RuleDecision
 * @typedef {import('./types.mjs').RuleRow} RuleRow
 * @typedef {import('./types.mjs').Outcome} Outcome
 * @typedef {import('./types.mjs').OutcomeCandidate} OutcomeCandidate
 * @typedef {import('./types.mjs').ReflectData} ReflectData
 * @typedef {import('./types.mjs').PushRetro} PushRetro
 * @typedef {import('./types.mjs').LensYield} LensYield
 */

/** Pushes shown in the retro, newest first. */
export const RETRO_PUSHES = 8;
/** Decision notes shown, newest first. */
export const NOTES_MAX_SHOWN = 10;
/** Outcome candidates returned. */
export const CANDIDATES_MAX = 20;
/** Accepted-without-outcome items whose Jira status is read per call (newest decisions first). */
const CANDIDATE_SCAN = 200;
const RULE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// -------------------------------------------------------------------------------------------- sync (tool 7)

/**
 * Checks one offered rule; the problem names its position.
 * @param {unknown} raw
 * @param {number} i
 * @returns {RuleOffer}
 */
function checkOffer(raw, i) {
  const at = `rules_json[${i}]`;
  if (!isObj(raw)) throw new AppError('bad-input', `${at} is not an object`);
  if (typeof raw.id !== 'string' || !RULE_ID_RE.test(raw.id)) throw new AppError('bad-input', `${at}.id must be 1-64 characters of letters, digits and . _ : -`);
  if (!isOneOf(LENSES, raw.lens)) throw new AppError('bad-input', `${at}.lens must be one of ${LENSES.join(', ')}`);
  if (!str(raw.text) || raw.text.trim().length > RULE_TEXT_MAX) throw new AppError('bad-input', `${at}.text must be 1-${RULE_TEXT_MAX} characters`);
  if (!isIso(raw.offered_at)) throw new AppError('bad-input', `${at}.offered_at must be an ISO 8601 timestamp`);
  /** @type {string[] | undefined} */
  let titles;
  if (raw.titles !== undefined) {
    if (!Array.isArray(raw.titles) || raw.titles.length > RULE_TITLES_MAX || !raw.titles.every((t) => str(t) && t.length <= 255)) {
      throw new AppError('bad-input', `${at}.titles must be at most ${RULE_TITLES_MAX} non-empty strings`);
    }
    titles = raw.titles.length ? raw.titles : undefined;
  }
  return /** @type {RuleOffer} */ (omitAbsent({ id: raw.id, lens: raw.lens, text: raw.text.trim(), titles, offered_at: raw.offered_at }));
}

/**
 * `dowser_reflect_sync`. Upserts the offered rules (a rule decided in Forge is never reverted, an offered one
 * has its text and titles refreshed), then answers the decided rules and the newest outcomes.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @returns {Promise<import('./types.mjs').ReflectOutput>}
 */
export async function reflectSync(deps, args) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  const raw = args.rules_json;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new AppError('bad-input', 'rules_json must be a JSON array as a string');
  const offers = typeof raw === 'string' && raw.trim() !== '' ? parseJsonArray(args, 'rules_json', RULES_MAX).map(checkOffer) : [];
  const trust = checkTrust(args.trust_json);
  await needInbox(db, projectKey);
  for (const o of offers) await upsertOffer(db, projectKey, o);
  if (trust) await putTrust(db, projectKey, trust, deps.now().toISOString());

  const rules = (await db.query("SELECT * FROM rules WHERE project_key = ? AND state IN ('accepted', 'declined') ORDER BY decided_at, id", [projectKey]))
    .map((r) => /** @type {RuleDecision} */ ({
      id: String(r.id), lens: String(r.lens), state: r.state, text: String(r.text),
      decided_by: String(r.decided_by ?? ''), decided_at: String(r.decided_at ?? ''),
    }));
  const outcomes = (await db.query(`SELECT * FROM outcomes WHERE project_key = ? ORDER BY recorded_at DESC, ref DESC LIMIT ${OUTCOMES_MAX}`, [projectKey])).map(toOutcome);
  return { rules, outcomes };
}

/**
 * Inserts the offer, or refreshes it while it is still offered (CAS on the state). A decided rule is left alone.
 * @param {Db} db
 * @param {string} projectKey
 * @param {RuleOffer} o
 */
async function upsertOffer(db, projectKey, o) {
  const titles = o.titles ? JSON.stringify(o.titles) : null;
  const have = await db.query('SELECT state FROM rules WHERE project_key = ? AND id = ?', [projectKey, o.id]);
  if (have.length === 0) {
    try {
      await db.exec(
        "INSERT INTO rules (project_key, id, lens, text, titles_json, state, offered_at) VALUES (?, ?, ?, ?, ?, 'offered', ?)",
        [projectKey, o.id, o.lens, o.text, titles, o.offered_at],
      );
      return;
    } catch (e) {
      if (!(e instanceof DuplicateKey)) throw e; // a concurrent sync inserted it first; refresh below
    }
  }
  await db.exec("UPDATE rules SET lens = ?, text = ?, titles_json = ?, offered_at = ? WHERE project_key = ? AND id = ? AND state = 'offered'",
    [o.lens, o.text, titles, o.offered_at, projectKey, o.id]);
}

/**
 * Checks `trust_json` (the skill's trust.mjs trustReport): `{slices: TrustSlice[], events: TrustEvent[]}`, at most
 * TRUST_SLICES_MAX slices and TRUST_EVENTS_MAX events. Absent or empty -> undefined (nothing stored). The levels are
 * the skill's store's; Forge shows them and never computes or trusts one for a decision of its own.
 * @param {unknown} raw
 * @returns {import('./types.mjs').Trust | undefined}
 */
export function checkTrust(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new AppError('bad-input', 'trust_json must be a JSON object as a string');
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new AppError('bad-input', 'trust_json is larger than 1 MB');
  /** @type {any} */
  let t;
  try { t = JSON.parse(raw); } catch (e) { throw new AppError('bad-input', `trust_json is not valid JSON (${/** @type {Error} */ (e).message})`); }
  if (!isObj(t) || !Array.isArray(t.slices) || !Array.isArray(t.events)) throw new AppError('bad-input', 'trust_json must be {"slices": [...], "events": [...]}');
  if (t.slices.length > TRUST_SLICES_MAX || t.events.length > TRUST_EVENTS_MAX) {
    throw new AppError('bad-input', `trust_json holds at most ${TRUST_SLICES_MAX} slices and ${TRUST_EVENTS_MAX} events`);
  }
  const lvl = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 3;
  const cnt = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
  const share = (/** @type {unknown} */ v) => v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);
  const line = (/** @type {unknown} */ v, /** @type {number} */ max) => str(v) && /** @type {string} */ (v).length <= max;
  const slices = t.slices.map((/** @type {any} */ s, /** @type {number} */ i) => {
    const at = `trust_json.slices[${i}]`;
    if (!isObj(s) || !line(s.slice, 200) || !lvl(s.level) || !lvl(s.ceiling) || !lvl(s.start) || !cnt(s.n) || !share(s.agreement)) {
      throw new AppError('bad-input', `${at} needs slice, level, ceiling, start (0-3), n (>= 0) and an optional agreement 0-1`);
    }
    if (s.changed_at !== undefined && !isIso(s.changed_at)) throw new AppError('bad-input', `${at}.changed_at must be an ISO 8601 timestamp`);
    if (s.reason !== undefined && !line(s.reason, 500)) throw new AppError('bad-input', `${at}.reason must be 1-500 characters`);
    return omitAbsent({ slice: s.slice, level: s.level, ceiling: s.ceiling, start: s.start, n: s.n, agreement: s.agreement, changed_at: s.changed_at, reason: s.reason });
  });
  const events = t.events.map((/** @type {any} */ e, /** @type {number} */ i) => {
    const at = `trust_json.events[${i}]`;
    if (!isObj(e) || !line(e.slice, 200) || !lvl(e.from) || !lvl(e.to) || !line(e.reason, 500) || !cnt(e.n) || !share(e.agreement) || !isIso(e.at)) {
      throw new AppError('bad-input', `${at} needs slice, from, to (0-3), reason, n, at and an optional agreement 0-1`);
    }
    if (e.item_id !== undefined && !(typeof e.item_id === 'string' && /^[0-9a-f]{16}$/.test(e.item_id))) throw new AppError('bad-input', `${at}.item_id must be a 16-hex fingerprint`);
    return omitAbsent({ slice: e.slice, from: e.from, to: e.to, reason: e.reason, agreement: e.agreement, n: e.n, item_id: e.item_id, at: e.at });
  });
  return /** @type {import('./types.mjs').Trust} */ ({ slices, events });
}

/**
 * Replaces the inbox's trust row (check-then-insert; a concurrent insert falls back to the update).
 * @param {Db} db
 * @param {string} projectKey
 * @param {import('./types.mjs').Trust} trust
 * @param {string} at
 */
async function putTrust(db, projectKey, trust, at) {
  const json = JSON.stringify(trust);
  const have = await db.query('SELECT project_key FROM trust WHERE project_key = ?', [projectKey]);
  if (have.length === 0) {
    try {
      await db.exec('INSERT INTO trust (project_key, trust_json, updated_at) VALUES (?, ?, ?)', [projectKey, json, at]);
      return;
    } catch (e) {
      if (!(e instanceof DuplicateKey)) throw e;
    }
  }
  await db.exec('UPDATE trust SET trust_json = ?, updated_at = ? WHERE project_key = ?', [json, at, projectKey]);
}

/**
 * The inbox's trust as last synced, with `updated_at`; undefined when the skill never sent one.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<(import('./types.mjs').Trust & {updated_at: string}) | undefined>}
 */
async function trustOf(db, projectKey) {
  const rows = await db.query('SELECT trust_json, updated_at FROM trust WHERE project_key = ?', [projectKey]);
  if (!rows.length) return undefined;
  try { return { ...JSON.parse(String(rows[0].trust_json)), updated_at: String(rows[0].updated_at) }; } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------- row mapping

/** @param {Row} r @returns {Outcome} */
const toOutcome = (r) => /** @type {Outcome} */ (omitAbsent({
  ref: String(r.ref), fp: String(r.fp), rating: r.rating, note: r.note, issue_ref: String(r.issue_ref),
  decided_by: String(r.decided_by), recorded_at: String(r.recorded_at),
}));

/** @param {Row} r @returns {RuleRow} */
function toRuleRow(r) {
  /** @type {string[] | undefined} */
  let titles;
  if (typeof r.titles_json === 'string' && r.titles_json) { try { titles = JSON.parse(r.titles_json); } catch { /* unreadable titles are omitted */ } }
  return /** @type {RuleRow} */ (omitAbsent({
    id: String(r.id), lens: String(r.lens), text: String(r.text), titles, state: r.state, offered_at: String(r.offered_at), decided_at: r.decided_at,
  }));
}

// ------------------------------------------------------------------------------------------ reflect.data

/**
 * The newest pushes with today's status of the items each one created. A push is a run: pushes of one
 * `run_id` (a run of more than 50 records is several calls) are one row. An item belongs to the push in
 * which it first appeared (`proposals.first_run_id`), not to the latest push that grew it (`last_run_id`):
 * "what did that scan yield, and what became of it" has one stable answer per item, while `last_run_id`
 * moves the item to a newer push every time its evidence grows. `created`/`updated` come from the push rows.
 * Merged items count in no status column, so `open + accepted + rejected + snoozed` may be below `created`.
 * `deciding_minutes` (with `first_decided_at`) and `triage_minutes` (with `decided_at`) are time to triage:
 * see `triageOf`.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<PushRetro[]>}
 */
async function pushRetros(db, projectKey) {
  const rows = await db.query('SELECT run_id, head_sha, at, created, updated FROM pushes WHERE project_key = ? ORDER BY at DESC, id LIMIT 500', [projectKey]);
  /** @type {Map<string, {run_id: string, head_sha?: string, at: string, first_at: string, created: number, updated: number}>} */
  const byRun = new Map();
  for (const r of rows) {
    const k = String(r.run_id);
    const g = byRun.get(k);
    if (!g) {
      byRun.set(k, /** @type {any} */ (omitAbsent({ run_id: k, head_sha: r.head_sha, at: String(r.at), first_at: String(r.at), created: Number(r.created), updated: Number(r.updated) })));
    } else {
      g.created += Number(r.created);
      g.updated += Number(r.updated);
      g.first_at = String(r.at); // rows come `at DESC`: the last one seen is the run's earliest push
    }
  }
  const newest = [...byRun.values()].slice(0, RETRO_PUSHES);
  if (newest.length === 0) return [];
  const marks = newest.map(() => '?').join(', ');
  const counts = await db.query(
    `SELECT first_run_id, status, COUNT(*) AS n, MIN(decided_at) AS first_at, MAX(decided_at) AS last_at FROM proposals
      WHERE project_key = ? AND first_run_id IN (${marks}) GROUP BY first_run_id, status`,
    [projectKey, ...newest.map((g) => g.run_id)],
  );
  return newest.map(({ first_at, ...g }) => {
    /** @type {Record<string, number>} */
    const by = { open: 0, accepted: 0, rejected: 0, snoozed: 0 };
    const mine = counts.filter((c) => String(c.first_run_id) === g.run_id);
    for (const c of mine) if (String(c.status) in by) by[String(c.status)] = Number(c.n);
    const total = g.created + g.updated;
    return /** @type {PushRetro} */ (omitAbsent({
      ...g, dup_rate: total > 0 ? Math.round((g.updated / total) * 100) / 100 : undefined,
      open: by.open, accepted: by.accepted, rejected: by.rejected, snoozed: by.snoozed,
      ...(by.open === 0 ? triageOf(first_at, mine) : {}),
    }));
  });
}

/**
 * Time to triage one push whose items are all decided, as two figures over its accepted, rejected and snoozed
 * items. `deciding_minutes` runs from the first decision (`first_decided_at`) to the last one (`decided_at`):
 * the time spent deciding, which goal G-1 reads. `triage_minutes` runs from the run's earliest push to the last
 * decision, so it also counts the time the inbox waited (a Friday push decided on Monday). Both are whole
 * minutes rounded up. Merged items are not a triage answer of their own, so a push whose items are all merged
 * has none of the keys; so does a clock that runs backwards (a last decision stamped before the push).
 * @param {string} pushedAt
 * @param {Row[]} groups  this push's `(status, n, first_at, last_at)` rows, without open ones
 * @returns {{first_decided_at?: string, decided_at?: string, deciding_minutes?: number, triage_minutes?: number}}
 */
function triageOf(pushedAt, groups) {
  let first = '';
  let last = '';
  for (const c of groups) {
    const s = String(c.status);
    if (s !== 'accepted' && s !== 'rejected' && s !== 'snoozed') continue;
    if (isIso(c.last_at) && String(c.last_at) > last) last = String(c.last_at);
    if (isIso(c.first_at) && (!first || String(c.first_at) < first)) first = String(c.first_at);
  }
  const ms = last ? Date.parse(last) - Date.parse(pushedAt) : NaN;
  if (!(ms >= 0)) return {};
  if (!first) first = last;
  return {
    first_decided_at: first, decided_at: last,
    deciding_minutes: Math.ceil((Date.parse(last) - Date.parse(first)) / 60000), triage_minutes: Math.ceil(ms / 60000),
  };
}

/**
 * Accepted items without an outcome, with the Jira status of their issue. Items whose issue is done come
 * first (newest decision first inside each group). When Jira cannot be read, every candidate answers
 * `issue_status: "unknown"` and `done: false`; the call never fails for it.
 * @param {Deps} deps
 * @param {string} projectKey
 * @returns {Promise<OutcomeCandidate[]>}
 */
export async function candidatesOf(deps, projectKey) {
  const rows = await deps.db.query(
    `SELECT * FROM proposals p WHERE p.project_key = ? AND p.status = 'accepted' AND p.issue_ref IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.ref = p.ref) ORDER BY p.decided_at DESC, p.id DESC LIMIT ${CANDIDATE_SCAN}`,
    [projectKey],
  );
  const items = rows.map(toProposal);
  /** @type {Record<string, {name: string, category: string}>} */
  let status = {};
  if (items.length && deps.jira) {
    try { status = await deps.jira.issueStatuses([...new Set(items.map((p) => /** @type {string} */ (p.issue_ref)))]); } catch (e) {
      logLine(deps, { dowser: 'warn', what: 'jira issue statuses', message: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) });
    }
  }
  const all = items.map((p) => {
    const s = status[/** @type {string} */ (p.issue_ref)];
    return /** @type {OutcomeCandidate} */ ({
      ref: p.ref, title: p.title, issue_ref: /** @type {string} */ (p.issue_ref), issue_url: p.issue_url ?? '',
      issue_status: s ? s.name : 'unknown', done: s ? s.category === 'done' : false,
    });
  });
  return [...all.filter((c) => c.done), ...all.filter((c) => !c.done)].slice(0, CANDIDATES_MAX);
}

/**
 * `reflect.data`: the whole Learning tab for one inbox.
 * @param {Deps} deps
 * @param {Record<string, any>} p
 * @returns {Promise<ReflectData>}
 */
export async function reflectData(deps, p) {
  const { db } = deps;
  const projectKey = needStr(p, 'project_key');
  await needInbox(db, projectKey);

  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(INBOX_STATUSES.map((s) => [s, 0]));
  /** @type {Map<string, LensYield>} */
  const yields = new Map();
  for (const r of await db.query('SELECT lens, status, COUNT(*) AS n FROM proposals WHERE project_key = ? GROUP BY lens, status', [projectKey])) {
    const n = Number(r.n);
    const s = String(r.status);
    if (s in totals) totals[s] += n;
    let y = yields.get(String(r.lens));
    if (!y) yields.set(String(r.lens), (y = { lens: String(r.lens), proposed: 0, accepted: 0, rejected: 0, snoozed: 0, open: 0 }));
    y.proposed += n;
    if (s === 'accepted' || s === 'rejected' || s === 'snoozed' || s === 'open') y[s] += n;
  }
  // Only lenses that proposed something: a lens with no row was not run (unmeasured), not a measured zero.
  const lens_yield = [...yields.keys()].sort((a, b) => lensRank(a) - lensRank(b) || a.localeCompare(b)).map((l) => /** @type {LensYield} */ (yields.get(l)));

  const rejects = (await db.query(
    "SELECT lens, reason, COUNT(*) AS n FROM proposals WHERE project_key = ? AND status = 'rejected' AND reason IS NOT NULL GROUP BY lens, reason ORDER BY n DESC, lens, reason",
    [projectKey],
  )).map((r) => ({ lens: String(r.lens), reason: String(r.reason), count: Number(r.n) }));

  const noteRows = await db.query(
    `SELECT v.status, v.note, v.decided_by, v.decided_at, v.external_ref, p.title FROM verdicts v
      JOIN proposals p ON p.project_key = v.project_key AND p.fp = v.fp
      WHERE v.project_key = ? AND v.note IS NOT NULL AND v.note <> '' AND v.status IN ('accepted', 'rejected', 'snoozed')
      ORDER BY v.decided_at DESC, v.seq DESC LIMIT ${NOTES_MAX_SHOWN}`,
    [projectKey],
  );
  const ruleRows = await db.query("SELECT * FROM rules WHERE project_key = ? ORDER BY CASE state WHEN 'offered' THEN 0 ELSE 1 END, offered_at DESC, id", [projectKey]);
  const outcomeRows = await db.query(
    `SELECT o.*, p.title FROM outcomes o JOIN proposals p ON p.ref = o.ref WHERE o.project_key = ? ORDER BY o.recorded_at DESC, o.ref DESC LIMIT ${OUTCOMES_MAX}`,
    [projectKey],
  );
  const names = await namesOf(deps, [...noteRows.map((r) => r.decided_by), ...ruleRows.map((r) => r.decided_by), ...outcomeRows.map((r) => r.decided_by)]);
  const trust = await trustOf(db, projectKey);

  return {
    totals: /** @type {ReflectData['totals']} */ (totals),
    rejects,
    notes: noteRows.map((r) => omitAbsent({
      ref: String(r.external_ref), title: String(r.title), status: r.status, note: String(r.note),
      decided_by_name: names[String(r.decided_by)], decided_at: String(r.decided_at),
    })),
    pushes: await pushRetros(db, projectKey),
    lens_yield,
    rules: ruleRows.map((r) => omitAbsent({ ...toRuleRow(r), decided_by_name: r.decided_by ? names[String(r.decided_by)] : undefined })),
    candidates: await candidatesOf(deps, projectKey),
    outcomes: outcomeRows.map((r) => omitAbsent({ ...toOutcome(r), title: String(r.title), decided_by_name: names[String(r.decided_by)] })),
    ...(trust ? { trust } : {}),
  };
}

/** @param {string} lens */
const lensRank = (lens) => { const i = /** @type {readonly string[]} */ (LENSES).indexOf(lens); return i < 0 ? LENSES.length : i; };

// --------------------------------------------------------------------------------------------- rule.decide

/**
 * `rule.decide`: offered -> accepted|declined by the caller (compare-and-set). `text` (accept only) replaces
 * the draft wording. A rule that is no longer offered is refused with its current state.
 * @param {Deps} deps
 * @param {Record<string, any>} p
 * @param {string} accountId
 * @returns {Promise<{rule: RuleRow}>}
 */
export async function ruleDecide(deps, p, accountId) {
  const { db } = deps;
  const projectKey = needStr(p, 'project_key');
  const id = needStr(p, 'id');
  const state = p.state;
  if (state !== 'accepted' && state !== 'declined') throw new AppError('bad-input', 'state must be accepted or declined');
  const text = optStr(p, 'text');
  if (text !== undefined && state !== 'accepted') throw new AppError('bad-input', 'text goes only with accepting a rule');
  if (text !== undefined && text.length > RULE_TEXT_MAX) throw new AppError('bad-input', `text is longer than ${RULE_TEXT_MAX} characters`);
  await needInbox(db, projectKey);
  const cur = await db.query('SELECT * FROM rules WHERE project_key = ? AND id = ?', [projectKey, id]);
  if (cur.length === 0) throw new AppError('bad-input', `no rule ${id} in ${projectKey}`);
  const by = deciderOf(accountId);
  const at = deps.now().toISOString();
  const r = await db.exec(
    "UPDATE rules SET state = ?, text = ?, decided_by = ?, decided_at = ? WHERE project_key = ? AND id = ? AND state = 'offered'",
    [state, text ?? String(cur[0].text), by, at, projectKey, id],
  );
  if (r.affectedRows !== 1) {
    const now = (await db.query('SELECT state FROM rules WHERE project_key = ? AND id = ?', [projectKey, id]))[0];
    throw new AppError('bad-input', `rule ${id} is ${now?.state ?? 'gone'}, not offered; reload it`);
  }
  const row = (await db.query('SELECT * FROM rules WHERE project_key = ? AND id = ?', [projectKey, id]))[0];
  const names = await namesOf(deps, [by]);
  return { rule: /** @type {RuleRow} */ (omitAbsent({ ...toRuleRow(row), decided_by_name: names[by] })) };
}

// ------------------------------------------------------------------------------------------ outcome.record

/**
 * `outcome.record`: how an accepted item turned out. One outcome per ref, for accepted items only; it is not
 * overwritten (a second call is refused with the rating on file).
 * @param {Deps} deps
 * @param {Record<string, any>} p
 * @param {string} accountId
 * @returns {Promise<{outcome: Outcome & {title: string, decided_by_name?: string}, candidates: OutcomeCandidate[]}>}
 */
export async function outcomeRecord(deps, p, accountId) {
  const { db } = deps;
  const item = await findProposal(db, needStr(p, 'ref'));
  if (!isOneOf(OUTCOME_RATINGS, p.rating)) throw new AppError('bad-input', `rating must be one of ${OUTCOME_RATINGS.join(', ')}`);
  const note = optStr(p, 'note');
  if (note !== undefined && note.length > NOTE_MAX) throw new AppError('bad-input', `note is longer than ${NOTE_MAX} characters`);
  if (item.status !== 'accepted' || !item.issue_ref) throw new AppError('bad-input', `${item.ref} is ${item.status}; an outcome is recorded only for an accepted item`);
  const have = await db.query('SELECT rating FROM outcomes WHERE ref = ?', [item.ref]);
  if (have.length) throw new AppError('bad-input', `${item.ref} already has an outcome (${have[0].rating})`);
  const by = deciderOf(accountId);
  const at = deps.now().toISOString();
  try {
    await db.exec('INSERT INTO outcomes (ref, project_key, fp, rating, note, issue_ref, decided_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [item.ref, item.project_key, item.fp, p.rating, sqlv(note), item.issue_ref, by, at]);
  } catch (e) {
    if (!(e instanceof DuplicateKey)) throw e;
    throw new AppError('bad-input', `${item.ref} already has an outcome`);
  }
  const names = await namesOf(deps, [by]);
  const outcome = omitAbsent({
    ref: item.ref, fp: item.fp, rating: p.rating, note, issue_ref: item.issue_ref, decided_by: by, recorded_at: at,
    title: item.title, decided_by_name: names[by],
  });
  return { outcome: /** @type {any} */ (outcome), candidates: await candidatesOf(deps, item.project_key) };
}
