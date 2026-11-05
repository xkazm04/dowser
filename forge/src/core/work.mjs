// @ts-check
// The agent work queue (moonshot 2026-11-04, idea 2; additive to forge-mcp-2). A person's Accept turns a proposal
// into work; these three tools let any coding agent connected to the rovo:mcp server pick that work up and say how
// it is going, without a person copying it across:
//  - dowser_work_list {project_key, queue: open|all}: the accepted items, oldest decision first; `open` leaves out
//    what Jira already reports delivered or abandoned (core/delivery.mjs). Each with its latest work status.
//  - dowser_work_get {ref}: the brief - the card (body, evidence linked to the scanned commit), its Jira issue, and
//    `done_when`: the quoted lines that must be gone, which the skill's `delivery` re-check verifies on the next scan.
//  - dowser_work_report {ref, status, note?, url?}: started | pr_open | done | blocked, appended to `work_reports`
//    (v028) and left as a comment on the Jira issue.
// Only accepted items are work: an open item has not had its human decision, so it is refused.
import { cardOf } from './cards.mjs';
import { deliveriesOf } from './delivery.mjs';
import { findProposal, needInbox, nextCounter, toProposal } from './store.mjs';
import { AppError, errTag, needStr, omitAbsent, optStr } from './util.mjs';
import { namesOf } from './names.mjs';

/** @typedef {import('./ports.mjs').Deps} Deps */
/** @typedef {import('./ports.mjs').AdfDoc} AdfDoc */

export const WORK_STATUSES = /** @type {const} */ (['started', 'pr_open', 'done', 'blocked']);
export const WORK_PAGE = 50;
const NOTE_MAX = 2000;

/**
 * The newest work report per item.
 * @param {Deps} deps
 * @param {number[]} ids
 * @returns {Promise<Map<number, Record<string, any>>>}
 */
async function latestReports(deps, ids) {
  if (!ids.length) return new Map();
  const rows = await deps.db.query(`SELECT * FROM work_reports WHERE proposal_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids);
  return new Map(rows.map((r) => [Number(r.proposal_id), r]));
}

/**
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 */
export async function workList(deps, args) {
  const projectKey = needStr(args, 'project_key');
  const queue = args.queue;
  if (queue !== 'open' && queue !== 'all') throw new AppError('bad-input', 'queue is open (not yet delivered) or all');
  await needInbox(deps.db, projectKey);
  const rows = (await deps.db.query(
    "SELECT * FROM proposals WHERE project_key = ? AND status = 'accepted' ORDER BY decided_at, id", [projectKey])).map(toProposal);
  const ids = rows.map((p) => p.id);
  const fate = await deliveriesOf(deps.db, ids);
  const work = await latestReports(deps, ids);
  const items = rows
    .filter((p) => queue === 'all' || !['delivered', 'abandoned'].includes(String(fate.get(p.id)?.jira_state ?? '')))
    .map((p) => {
      const rec = /** @type {Record<string, any>} */ (p.record ?? {});
      const dv = fate.get(p.id);
      return omitAbsent({
        ref: p.ref, fp: p.fp, title: p.title, lens: p.lens, score: typeof rec.score === 'number' ? rec.score : undefined,
        issue_ref: p.issue_ref, issue_url: p.issue_url, decided_at: p.decided_at,
        delivery: dv?.jira_state ?? undefined, code_state: dv?.code_state ?? undefined,
        work_status: work.get(p.id)?.status ?? undefined,
      });
    });
  return items.length > WORK_PAGE ? { items: items.slice(0, WORK_PAGE), more: true } : { items };
}

/**
 * The accepted item `ref`, or bad-input.
 * @param {Deps} deps
 * @param {string} ref
 */
async function acceptedItem(deps, ref) {
  const p = await findProposal(deps.db, ref);
  if (p.status !== 'accepted' || !p.issue_ref) throw new AppError('bad-input', `${p.ref} is ${p.status}, not accepted work: only a person's Accept makes an item work`);
  return p;
}

/**
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 */
export async function workGet(deps, args) {
  const p = await acceptedItem(deps, needStr(args, 'ref'));
  const card = await cardOf(deps.db, p);
  const done = (card.evidence ?? [])
    .filter((/** @type {any} */ e) => (e.type === 'code' || e.type === 'doc') && typeof e.quote === 'string' && e.quote.trim())
    .map((/** @type {any} */ e) => `${e.ref} no longer contains: ${e.quote}`);
  return omitAbsent({ card, issue_ref: p.issue_ref, issue_url: p.issue_url, done_when: done.length ? done : undefined });
}

/**
 * The comment a report leaves on the Jira issue. It names the person the agent works for, never their raw account
 * id: their display name when the Users port knows it, else an ADF mention, which Jira renders as the name.
 * @param {string} ref @param {string} by @param {string} status @param {string | undefined} note @param {string | undefined} url
 * @param {string | undefined} name  the display name of `by`, when known
 * @returns {AdfDoc}
 */
function reportComment(ref, by, status, note, url, name) {
  /** @type {any[]} */
  const content = [{ type: 'text', text: `Dowser ${ref}: ${status.replace('_', ' ')}${note ? ` - ${note}` : ''}` }];
  if (url) content.push({ type: 'text', text: ' ' }, { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] });
  const account = by.startsWith('forge:') ? by.slice('forge:'.length) : undefined;
  if (name) content.push({ type: 'text', text: ` (reported by a coding agent for ${name})` });
  else if (account) content.push({ type: 'text', text: ' (reported by a coding agent for ' }, { type: 'mention', attrs: { id: account } }, { type: 'text', text: ')' });
  else content.push({ type: 'text', text: ` (reported by ${by})` });
  return /** @type {AdfDoc} */ ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });
}

/**
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @param {string} by  the caller as a decider (`forge:<account>`)
 */
export async function workReport(deps, args, by) {
  const p = await acceptedItem(deps, needStr(args, 'ref'));
  const status = args.status;
  if (!(/** @type {readonly unknown[]} */ (WORK_STATUSES)).includes(status)) throw new AppError('bad-input', `status is one of ${WORK_STATUSES.join('|')}`);
  const note = optStr(args, 'note');
  if (note && note.length > NOTE_MAX) throw new AppError('bad-input', `note is at most ${NOTE_MAX} characters`);
  const url = optStr(args, 'url');
  if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new AppError('bad-input', 'url must be an https link (a pull request, a build)');
  if (!deps.jira) throw new AppError('unavailable', 'Jira is not reachable from this module');
  const at = deps.now().toISOString();
  try {
    const name = (await namesOf(deps, [by]))[by];
    await deps.jira.addComment(/** @type {string} */ (p.issue_ref), reportComment(p.ref, by, String(status), note, url, name));
  } catch (e) {
    throw new AppError('unavailable', `Jira did not take the comment on ${p.issue_ref} (${errTag(e)}); nothing was recorded`);
  }
  await deps.db.exec('INSERT INTO work_reports (id, proposal_id, project_key, status, note, url, by_who, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [await nextCounter(deps.db, 'work_reports'), p.id, p.project_key, status, note ?? null, url ?? null, by, at]);
  return { report: omitAbsent({ ref: p.ref, issue_ref: p.issue_ref, status, note, url, by, at }) };
}
