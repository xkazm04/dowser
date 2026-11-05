// @ts-check
// Delegated triage: a person lets a named delegate (`delegate:temper`) decide in one inbox for a while, under caps.
//
// The delegation lives on the inbox row (`delegate_until`, `delegate_accepts_per_day`, `delegate_rejects_per_day`,
// v032-v034). Only the `settings.set` resolver writes it (core/app.mjs), and only the inbox global page may call that
// resolver (MODULE_KEYS): no MCP tool or Rovo action reaches it, so a delegate can never extend its own mandate.
//
// `dowser_verdicts_record` is the delegate's door. It is an extra gate in front of the one decision path the inbox
// and the Rovo agent use (core/verdicts.mjs accept / reject / snooze / merge, with the caller's own inbox access and
// Jira permission checks in core/app.mjs): the caller is still the signed-in account, and every check that applies to
// a person's decision applies here too. What the gate adds:
//  - the delegation must hold today (UTC): set, and `delegate_until` not past; else the whole call is `forbidden`;
//  - per UTC day, at most `delegate_accepts_per_day` accepts and `delegate_rejects_per_day` other verdicts (reject,
//    snooze, merge), counted from the verdict log (rows whose `decided_by` is a delegate). A verdict past its cap is
//    `refused` with the cap in `why`. Two concurrent calls can each pass the count (Forge SQL has no transaction), so
//    a cap may be overrun by at most one call's worth; one delegate runs one call at a time;
//  - each verdict is recorded with decided_by DELEGATE_DECIDER and via `mcp`, and an accept's issue carries
//    DELEGATE_LABEL (core/verdicts.mjs accept);
//  - a call takes at most RECORD_MAX verdicts and starts no new verdict once RECORD_BUDGET_MS have passed: it then
//    answers `more: true`, and the verdicts after the last result are sent again.
import { DELEGATE_CAP_MAX, DELEGATE_DECIDER, DELEGATE_KIND, RECORD_MAX } from './types.mjs';
import { repairVerdicts } from './verdicts.mjs';
import { AppError, str } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./store.mjs').InboxRow} InboxRow
 * @typedef {import('./types.mjs').DelegateVerdict} DelegateVerdict
 * @typedef {import('./types.mjs').RecordResult} RecordResult
 * @typedef {import('./types.mjs').RecordOutput} RecordOutput
 * @typedef {{until: string, accepts: number, rejects: number}} Delegation
 */

/** A call's own time budget (ms): an accept is a Jira call and a dozen statements, and a tool call has ~25 s. */
export const RECORD_BUDGET_MS = 15_000;
/** The delegate verbs and the inbox status each records. */
export const VERBS = Object.freeze({ accept: 'accepted', reject: 'rejected', snooze: 'snoozed', merge: 'merged' });
/** The keys a delegate verdict may carry. */
const VERDICT_KEYS = new Set(['ref', 'verdict', 'reason', 'note', 'into', 'until']);

/** @param {string | undefined} by */
export const isDelegate = (by) => typeof by === 'string' && by.startsWith(`${DELEGATE_KIND}:`);

/** The UTC day of `now`, `YYYY-MM-DD`. @param {Date} now */
export const utcDay = (now) => now.toISOString().slice(0, 10);

/**
 * The inbox's delegation as set, whether or not it still holds; undefined when off (or only partly written).
 * @param {InboxRow} inbox
 * @returns {Delegation | undefined}
 */
export function delegationOf(inbox) {
  const { delegate_until: until, delegate_accepts_per_day: accepts, delegate_rejects_per_day: rejects } = inbox;
  if (!until || accepts === undefined || rejects === undefined) return undefined;
  return { until, accepts, rejects };
}

/**
 * The `settings.set` delegation fields as the UPDATE values: `delegate_until: ''` alone switches the delegation off
 * (all three NULL); otherwise a real calendar day that is not past anywhere on Earth (the browser checks the
 * person's own today, as core/verdicts.mjs untilOf) and both caps, whole numbers 0..DELEGATE_CAP_MAX.
 * @param {Record<string, unknown>} p
 * @param {Date} now
 * @returns {[string | null, number | null, number | null]}
 */
export function delegationInput(p, now) {
  const until = p.delegate_until;
  const a = p.delegate_accepts_per_day;
  const r = p.delegate_rejects_per_day;
  if (until === '') {
    if ((a !== undefined && a !== null) || (r !== undefined && r !== null)) throw new AppError('bad-input', 'switching the delegation off takes delegate_until "" alone');
    return [null, null, null];
  }
  const m = typeof until === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(until) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !d || d.toISOString().slice(0, 10) !== until) throw new AppError('bad-input', `delegate_until is a calendar date YYYY-MM-DD (got ${JSON.stringify(until)})`);
  const earliest = new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
  if (m[0] < earliest) throw new AppError('bad-input', `delegate_until must be today or later (${earliest}); got ${m[0]}`);
  /** @param {unknown} v @param {string} k */
  const cap = (v, k) => {
    if (!Number.isInteger(v) || /** @type {number} */ (v) < 0 || /** @type {number} */ (v) > DELEGATE_CAP_MAX) {
      throw new AppError('bad-input', `${k} is a whole number from 0 to ${DELEGATE_CAP_MAX}`);
    }
    return /** @type {number} */ (v);
  };
  return [m[0], cap(a, 'delegate_accepts_per_day'), cap(r, 'delegate_rejects_per_day')];
}

/**
 * Today's delegate verdicts in one inbox, from the verdict log (after repairing rows a lost append left out, so a
 * stamped decision always counts): `accepts`, and `rejects` = every other verdict.
 * @param {Db} db
 * @param {string} projectKey
 * @param {Date} now
 * @returns {Promise<{accepts: number, rejects: number}>}
 */
export async function delegateCounts(db, projectKey, now) {
  await repairVerdicts(db, projectKey, now);
  const rows = await db.query(
    `SELECT status, COUNT(*) AS n FROM verdicts WHERE project_key = ? AND decided_by LIKE ? AND decided_at >= ? GROUP BY status`,
    [projectKey, `${DELEGATE_KIND}:%`, `${utcDay(now)}T00:00:00.000Z`],
  );
  let accepts = 0;
  let rejects = 0;
  for (const r of rows) {
    if (String(r.status) === 'accepted') accepts += Number(r.n);
    else rejects += Number(r.n);
  }
  return { accepts, rejects };
}

/**
 * Parses `verdicts_json`: a JSON array of 1..RECORD_MAX DelegateVerdict, else `bad-input` naming the index.
 * @param {unknown} raw
 * @returns {DelegateVerdict[]}
 */
export function parseVerdicts(raw) {
  if (typeof raw !== 'string') throw new AppError('bad-input', 'verdicts_json is a string holding a JSON array');
  /** @type {unknown} */
  let list;
  try { list = JSON.parse(raw); } catch { throw new AppError('bad-input', 'verdicts_json is not valid JSON'); }
  if (!Array.isArray(list) || list.length === 0) throw new AppError('bad-input', 'verdicts_json is a non-empty JSON array');
  if (list.length > RECORD_MAX) throw new AppError('bad-input', `verdicts_json holds ${list.length} verdicts; at most ${RECORD_MAX} per call`);
  return list.map((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('bad-input', `verdicts_json[${i}] is an object`);
    const o = /** @type {Record<string, unknown>} */ (v);
    const extra = Object.keys(o).find((k) => !VERDICT_KEYS.has(k));
    if (extra) throw new AppError('bad-input', `verdicts_json[${i}].${extra} is not a verdict field (ref, verdict, reason, note, into, until)`);
    if (!str(o.ref)) throw new AppError('bad-input', `verdicts_json[${i}].ref is required`);
    if (typeof o.verdict !== 'string' || !Object.hasOwn(VERBS, o.verdict)) throw new AppError('bad-input', `verdicts_json[${i}].verdict is accept, reject, snooze or merge`);
    for (const k of ['reason', 'note', 'into', 'until']) {
      if (o[k] !== undefined && typeof o[k] !== 'string') throw new AppError('bad-input', `verdicts_json[${i}].${k} is a string (omit it when absent)`);
    }
    return /** @type {DelegateVerdict} */ (o);
  });
}

/**
 * `dowser_verdicts_record`: the delegation gate, the caps and the time budget around `decideOne`, which records one
 * verdict through the shared decision path as DELEGATE_DECIDER (core/app.mjs). The caller has opened the inbox and
 * refused the sample inbox already. A verdict whose decision fails for a reason the caller can act on (an AppError:
 * not open, a missing reason, Jira refused) is `refused` with that message; the others still run.
 * @param {Deps} deps
 * @param {InboxRow} inbox
 * @param {unknown} verdictsJson
 * @param {(v: DelegateVerdict) => Promise<{issue_ref?: string}>} decideOne
 * @param {{budgetMs?: number}} [o]
 * @returns {Promise<RecordOutput>}
 */
export async function recordVerdicts(deps, inbox, verdictsJson, decideOne, { budgetMs = RECORD_BUDGET_MS } = {}) {
  const verdicts = parseVerdicts(verdictsJson);
  const start = deps.now();
  const d = delegationOf(inbox);
  if (!d) throw new AppError('forbidden', `${inbox.project_key} has no delegated triage; a person switches it on in Dowser Settings`);
  if (utcDay(start) > d.until) throw new AppError('forbidden', `the delegated triage of ${inbox.project_key} ended on ${d.until}; a person renews it in Dowser Settings`);
  const used = await delegateCounts(deps.db, inbox.project_key, start);
  /** @type {RecordResult[]} */
  const results = [];
  for (const [i, v] of verdicts.entries()) {
    if (i > 0 && deps.now().getTime() - start.getTime() >= budgetMs) return { results, more: true };
    const accept = v.verdict === 'accept';
    const cap = accept ? d.accepts : d.rejects;
    if ((accept ? used.accepts : used.rejects) >= cap) {
      results.push({ ref: v.ref, result: 'refused', why: accept
        ? `today's delegate accept cap (${cap}) is reached; it resets at 00:00 UTC`
        : `today's delegate cap of ${cap} rejects, snoozes and merges is reached; it resets at 00:00 UTC` });
      continue;
    }
    try {
      const out = await decideOne(v);
      if (accept) used.accepts++; else used.rejects++;
      results.push(out.issue_ref && accept ? { ref: v.ref, result: 'recorded', issue_ref: out.issue_ref } : { ref: v.ref, result: 'recorded' });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      results.push({ ref: v.ref, result: 'refused', why: e.message });
    }
  }
  return { results };
}

/** The decider a delegate verdict is recorded as. */
export const DELEGATE = Object.freeze({ by: DELEGATE_DECIDER, via: /** @type {const} */ ('mcp') });
