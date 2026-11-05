// @ts-check
// Confluence doc-drift closure (moonshot 2026-11-04, app#4).
//  - The page index (`page_links`, v030): which inbox items name which Confluence page, from `page` evidence and
//    numeric `doc_impact` entries. Filled at every push (linkPushed) and once for older items (backfillPageLinks, the
//    daily trigger). The byline and the banner read it instead of scanning every proposal on each page view.
//  - Page edits (`page_edits`, v031): the page-updated trigger records the newest edit of a LINKED page; an unlinked
//    page costs one indexed lookup and stores nothing. The byline flags items decided before that edit: the page
//    changed since, so the next scan's verify of its doc quotes decides whether the drift is fixed.
//  - "Draft the fix" (`byline.draftFix`): a footer comment on the page, posted AS THE PERSON (write:comment:confluence,
//    asUser), so Confluence's own permission decides; it quotes the code against the stale page. It never edits the
//    page body.
import { cardOf } from './cards.mjs';
import { logLine } from './observe.mjs';
import { counterValue, evidenceRefsOfMany, findProposal, nextCounter, setCounter, toProposal } from './store.mjs';
import { AppError, DuplicateKey, errTag, needStr } from './util.mjs';

/** @typedef {import('./ports.mjs').Deps} Deps */
/** @typedef {import('./ports.mjs').Db} Db */
/** @typedef {import('./ports.mjs').AdfDoc} AdfDoc */

export const PAGE_ID_RE = /^[0-9]{1,32}$/;
const BACKFILL_COUNTER = 'page_links_backfill_v1';
const BACKFILL_PAGE = 200;
/** The last proposal id the page-link backfill has linked (its resume point). */
const BACKFILL_CURSOR = 'page_links_backfill_after';
/** The page-link backfill's own time budget per run (ms); it shares the daily trigger with migrations and the property backfill. */
export const BACKFILL_BUDGET_MS = 8_000;

/**
 * The page ids an item names: its `page` evidence refs and the numeric entries of its `doc_impact`.
 * @param {Record<string, any>} record
 * @param {{type: string, ref: string}[]} evidence
 * @returns {string[]}
 */
export function pageIdsOf(record, evidence) {
  const ids = new Set(evidence.filter((e) => e.type === 'page').map((e) => String(e.ref).trim()));
  for (const d of Array.isArray(record?.doc_impact) ? record.doc_impact : []) ids.add(String(d).trim());
  return [...ids].filter((id) => PAGE_ID_RE.test(id));
}

/**
 * Links one item to its pages; a link already there is kept. Returns the links added.
 * @param {Db} db
 * @param {{id: number, project_key: string}} p
 * @param {string[]} pageIds
 */
async function linkPages(db, p, pageIds) {
  let added = 0;
  for (const pageId of pageIds) {
    try {
      await db.exec('INSERT INTO page_links (page_id, proposal_id, project_key) VALUES (?, ?, ?)', [pageId, p.id, p.project_key]);
      added++;
    } catch (e) {
      if (!(e instanceof DuplicateKey)) throw e;
    }
  }
  return added;
}

/**
 * After a push: links every item of the push to the pages it names now (a re-push may name a new page).
 * @param {Deps} deps
 * @param {string} projectKey
 * @param {string[]} fps
 */
export async function linkPushed(deps, projectKey, fps) {
  if (!fps.length) return;
  const rows = (await deps.db.query(`SELECT * FROM proposals WHERE project_key = ? AND fp IN (${fps.map(() => '?').join(', ')})`, [projectKey, ...fps])).map(toProposal);
  const refs = await evidenceRefsOfMany(deps.db, rows);
  for (const p of rows) await linkPages(deps.db, p, pageIdsOf(p.record, refs.get(p.id) ?? []));
}

/**
 * Once per installation: links the items filed before the index existed. Idempotent (a counter marks it done).
 * Resumable: the last item linked is stored after each page of BACKFILL_PAGE, and no new page starts past
 * `budgetMs` of its own time, so a large site finishes over a few daily runs instead of restarting from id 0.
 * @param {Deps} deps
 * @param {{budgetMs?: number, page?: number}} [o]  default BACKFILL_BUDGET_MS, BACKFILL_PAGE items a page
 * @returns {Promise<{linked: number, more?: true}>}
 */
export async function backfillPageLinks(deps, { budgetMs = BACKFILL_BUDGET_MS, page = BACKFILL_PAGE } = {}) {
  if (await counterValue(deps.db, BACKFILL_COUNTER) > 0) return { linked: 0 };
  const start = deps.now().getTime();
  let linked = 0;
  for (let after = await counterValue(deps.db, BACKFILL_CURSOR), first = true; ; first = false) {
    if (!first && deps.now().getTime() - start >= budgetMs) return { linked, more: true };
    const limit = Number.isInteger(page) && page > 0 ? page : BACKFILL_PAGE;
    const rows = (await deps.db.query(`SELECT * FROM proposals WHERE id > ? ORDER BY id LIMIT ${limit}`, [after])).map(toProposal);
    if (!rows.length) break;
    const refs = await evidenceRefsOfMany(deps.db, rows);
    for (const p of rows) linked += await linkPages(deps.db, p, pageIdsOf(p.record, refs.get(p.id) ?? []));
    after = rows[rows.length - 1].id;
    if (rows.length < limit) break; // the last page: nothing to resume
    await setCounter(deps.db, BACKFILL_CURSOR, after);
  }
  await nextCounter(deps.db, BACKFILL_COUNTER);
  return { linked };
}

/**
 * The page-updated trigger (`dowser-page-events`). Never throws for a bad event.
 * @param {Deps} deps
 * @param {Record<string, any>} event
 * @returns {Promise<{matched: number}>}
 */
export async function onPageEvent(deps, event) {
  const pageId = String(event?.content?.id ?? '');
  if (!PAGE_ID_RE.test(pageId)) return { matched: 0 };
  const links = await deps.db.query('SELECT proposal_id FROM page_links WHERE page_id = ?', [pageId]);
  if (!links.length) return { matched: 0 };
  const when = typeof event?.content?.version?.when === 'string' ? new Date(Date.parse(event.content.version.when)).toISOString() : deps.now().toISOString();
  const version = Number.isInteger(event?.content?.version?.number) ? event.content.version.number : null;
  const by = typeof event?.atlassianId === 'string' ? `forge:${event.atlassianId}` : null;
  try {
    await deps.db.exec('INSERT INTO page_edits (page_id, edited_at, version, edited_by) VALUES (?, ?, ?, ?)', [pageId, when, version, by]);
  } catch (e) {
    if (!(e instanceof DuplicateKey)) throw e;
    await deps.db.exec('UPDATE page_edits SET edited_at = ?, version = ?, edited_by = ? WHERE page_id = ? AND edited_at < ?', [when, version, by, pageId, when]);
  }
  logLine(deps, { dowser: 'page-edit', page: pageId, items: links.length });
  return { matched: links.length };
}

/**
 * The newest recorded edit of a page, or undefined.
 * @param {Db} db
 * @param {string} pageId
 * @returns {Promise<string | undefined>}
 */
export async function pageEditedAt(db, pageId) {
  const rows = await db.query('SELECT edited_at FROM page_edits WHERE page_id = ?', [pageId]);
  return rows.length ? String(rows[0].edited_at) : undefined;
}

/**
 * The footer comment "Draft the fix" leaves.
 * @param {Record<string, any>} card
 * @param {string} inboxUrl
 * @returns {AdfDoc}
 */
function fixComment(card, inboxUrl) {
  const text = (/** @type {string} */ t, /** @type {any[]} */ marks = []) => (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
  const para = (/** @type {any[]} */ content) => ({ type: 'paragraph', content });
  const quotes = (card.evidence ?? []).filter((/** @type {any} */ e) => (e.type === 'code' || e.type === 'doc') && typeof e.quote === 'string' && e.quote.trim());
  /** @type {any[]} */
  const content = [
    para([text(`Dowser ${card.ref}: this page may no longer match the code. `, [{ type: 'strong' }]), text(String(card.title))]),
    para([text(String(card.rationale ?? ''))]),
  ];
  if (quotes.length) {
    content.push(para([text('What the code says now:')]));
    content.push({ type: 'bulletList', content: quotes.slice(0, 5).map((/** @type {any} */ e) => ({ type: 'listItem', content: [para([
      e.url ? text(String(e.ref), [{ type: 'link', attrs: { href: e.url } }]) : text(String(e.ref)), text(': '), text(String(e.quote), [{ type: 'code' }]),
    ])] })) });
  }
  content.push(para([text('The finding, its evidence and its triage: '), text(card.ref, [{ type: 'link', attrs: { href: inboxUrl } }])]));
  return /** @type {AdfDoc} */ ({ type: 'doc', version: 1, content });
}

/**
 * `byline.draftFix {page_id, ref}`: a footer comment on the page for an item that names it.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 */
export async function draftFix(deps, args) {
  const pageId = needStr(args, 'page_id');
  if (!PAGE_ID_RE.test(pageId)) throw new AppError('bad-input', 'page_id must be a Confluence page id');
  const p = await findProposal(deps.db, needStr(args, 'ref'));
  const linked = await deps.db.query('SELECT 1 FROM page_links WHERE page_id = ? AND proposal_id = ?', [pageId, p.id]);
  if (!linked.length) throw new AppError('bad-input', `${p.ref} does not name page ${pageId}`);
  if (!deps.confluence) throw new AppError('unavailable', 'Confluence is not reachable from this module');
  const card = await cardOf(deps.db, p);
  /** @type {{id: string}} */
  let made;
  try {
    made = await deps.confluence.addFooterComment(pageId, fixComment(card, await deps.links.inboxUrl(p.ref)));
  } catch (e) {
    throw new AppError('unavailable', `Confluence did not take the comment (${errTag(e)}); you may need permission to comment on this page`);
  }
  return { comment: { page_id: pageId, id: made.id, ref: p.ref } };
}
