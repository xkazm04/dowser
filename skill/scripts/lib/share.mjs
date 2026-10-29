// @ts-check
// `dowser share`: one run's kept proposals as markdown, for a team that reads them outside Jira (a doc, a slide).
// Read-only. "Kept" = proposed or grown in that run and still verified, pushed or accepted. Evidence is listed by
// ref only: a quoted source line stays out of a document that may travel further than the inbox.
import { DowserError } from './model.mjs';
import { getProposal, getRun } from './store.mjs';

/** @typedef {import('./store.mjs').Db} Db */

const KEPT = ['verified', 'pushed', 'accepted'];

/** The card's one-paragraph Summary section, or undefined. @param {unknown} body */
const summaryOf = (body) => String(body ?? '').match(/## Summary\n+([^\n#][^\n]*)/)?.[1]?.trim();

/** @param {Record<string, any>} c @returns {string} */
function cardMd(c) {
  const facts = [c.lens, c.effort?.size && `size ${c.effort.size}`, c.confidence && `confidence ${c.confidence}`, c.status,
    c.external_ref].filter(Boolean).join(' · ');
  const summary = summaryOf(c.body);
  const refs = (c.evidence ?? []).map((/** @type {{type: string, ref: string}} */ e) => `${e.type} ${e.ref}`);
  return [`## ${c.title}`, '', facts, '', String(c.rationale ?? ''), ...(summary ? ['', `**Proposed:** ${summary}`] : []),
    '', `Evidence: ${refs.join('; ')}`, ''].join('\n');
}

/**
 * @param {Db} db
 * @param {string} runId
 * @returns {{run_id: string, cards: number, markdown: string}}
 */
export function shareRun(db, runId) {
  const run = getRun(db, runId);
  if (!run) throw new DowserError(`run ${runId} does not exist`, 2, { error: 'not-found', run_id: runId });
  const fps = /** @type {{fp: string}[]} */ (db.prepare(
    `SELECT fp FROM proposals WHERE last_run_id = ? AND status IN (${KEPT.map(() => '?').join(', ')}) ORDER BY lens, created_at, fp`,
  ).all(runId, ...KEPT)).map((r) => r.fp);
  const cards = fps.map((fp) => /** @type {Record<string, any>} */ (getProposal(db, fp)));
  const lenses = Object.entries(run.lenses ?? {}).map(([l, r]) => `${l} ${/** @type {any} */ (r).state}`).join(', ');
  const head = [`# Dowser scan ${String(run.started_at).slice(0, 10)}`, '',
    [`${run.mode} scan`, run.head_sha && `at ${String(run.head_sha).slice(0, 7)}`, lenses && `lenses: ${lenses}`,
      `${cards.length} kept proposals`].filter(Boolean).join(' · '), ''];
  return { run_id: runId, cards: cards.length, markdown: [...head, ...cards.map(cardMd)].join('\n') };
}
