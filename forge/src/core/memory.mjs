// @ts-check
// `dowser_memory_pull` (additive to forge-mcp-2): the inbox as the team's memory of record. A skill store is per
// machine, so a teammate, a reinstall or a CI runner starts with no decisions and would re-propose everything the
// team already rejected. This tool pages the inbox's DECIDED items (accepted, rejected, snoozed, merged) with the
// record each was pushed with and its decision, oldest item first, plus the rules decided in Forge on the first
// page; the skill's `hydrate` stores them as decided cards. Read-only. Open items stay out: they are the inbox's
// work, not memory.
import { evidenceOfMany, needInbox, toProposal } from './store.mjs';
import { AppError, needStr, omitAbsent } from './util.mjs';

/** @typedef {import('./ports.mjs').Deps} Deps */

/** Decided items per page (a record with its evidence and body runs to a few KB). */
export const MEMORY_PAGE = 50;
const DECIDED = ['accepted', 'rejected', 'snoozed', 'merged'];

/**
 * @param {Deps} deps
 * @param {Record<string, unknown>} args  {project_key, after}: `after` is "0" for the first page, then the cursor
 * @returns {Promise<{items: Record<string, unknown>[], cursor: string, more?: true, rules?: Record<string, unknown>[]}>}
 */
export async function memoryPull(deps, args) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  const raw = args.after;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new AppError('bad-cursor', `after ${JSON.stringify(raw)} was not issued by this server; send "0" for the first page`);
  }
  await needInbox(db, projectKey);
  const after = Number(raw);
  const rows = await db.query(
    `SELECT * FROM proposals WHERE project_key = ? AND status IN (${DECIDED.map(() => '?').join(', ')}) AND id > ? ORDER BY id LIMIT ${MEMORY_PAGE + 1}`,
    [projectKey, ...DECIDED, after],
  );
  const page = rows.slice(0, MEMORY_PAGE);
  const props = page.map(toProposal);
  // the record is stored without its evidence (its own table): one batched read puts it back, as {type, ref, quote?, url?}
  const ev = await evidenceOfMany(db, props);
  const items = props.map((p) => {
    const { status: _pushed, ...rec } = /** @type {Record<string, unknown>} */ (p.record ?? {});
    const evidence = (ev.get(p.id) ?? []).map((e) => omitAbsent({ type: e.type, ref: e.ref, quote: e.quote, url: e.url }));
    return omitAbsent({
      ...rec, evidence, fp: p.fp, external_ref: p.ref, status: p.status, reason: p.reason, note: p.note, merged_into: p.merged_into,
      decided_by: p.decided_by, decided_at: p.decided_at, issue_ref: p.issue_ref, issue_url: p.issue_url,
      snooze_until: p.status === 'snoozed' ? p.snooze_until : undefined,
    });
  });
  const cursor = page.length ? String(page[page.length - 1].id) : raw;
  /** @type {{items: Record<string, unknown>[], cursor: string, more?: true, rules?: Record<string, unknown>[]}} */
  const out = { items, cursor };
  if (rows.length > MEMORY_PAGE) out.more = true;
  if (after === 0) {
    out.rules = (await db.query("SELECT * FROM rules WHERE project_key = ? AND state IN ('accepted', 'declined') ORDER BY decided_at, id", [projectKey]))
      .map((r) => omitAbsent({ id: r.id, lens: r.lens, state: r.state, text: r.text, offered_at: r.offered_at, decided_by: r.decided_by, decided_at: r.decided_at }));
  }
  return out;
}
