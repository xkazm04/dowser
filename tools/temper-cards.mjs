#!/usr/bin/env node
// @ts-check
// temper-cards - the cards a temper scan left in an inbox's scan home, for triage, read-only.
//
//   node tools/temper-cards.mjs --project-key <k> [--status s] [--lens l] [--quotes] [--full] [--undecided] [--date d] [--ledger f]
//
// temper-scan keys the store by the inbox key (the clone's origin is set to it), so `dowser.mjs list --repo <path>` on
// the real checkout reads a different project and answers nothing. This reads the scan home's own store,
// <temper home>/homes/<k>/projects/<k>/dowser.db, through the skill's store library (never by hand), and prints
// {project_key, db, cards: [{fp, ref?, url?, status, lens, title, evidence: [{type, ref, path?, line?, quote?}]}]},
// most recently updated first. Quotes are left out unless --quotes. --full (quotes included) adds what the QA step
// writes a card's acceptance from: rationale, impact (with why), effort, confidence (with why), doc_impact,
// delivery_risk, the body's five sections by heading (Summary, Description, Flow, Expected impact, Evaluation), and
// `acceptance`, the card's own done-when: its Evaluation section (Claim, After, Falsified if) - the store keeps no
// other acceptance field.
//
// The scan home's store keeps a card `pushed` after triage: a local verdict (recorded `local` in the day ledger, the
// inbox had no valid delegation) and a live one (Forge recorded it) are both in the loop checkout's day ledger,
// docs/evals/temper/<date>.jsonl (--date, default today; --ledger names another file). Each card with a ref is joined
// to its newest verdict of that inbox there: `decided_local: {verdict, cycle}` or `decided_live: {verdict, cycle}`.
// --undecided keeps only the cards with neither and with no decided store status (accepted, rejected, snoozed, merged).
// Exit 0, 1 (no store for that key), 2 (usage).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DowserError, bodyParts } from '../skill/scripts/lib/model.mjs';
import * as memory from '../skill/scripts/lib/memory.mjs';
import * as store from '../skill/scripts/lib/store.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from './temper-lib.mjs';

/** No scan has written that home yet (exit 1). */
export class NoStore extends Error {}

const USAGE = 'usage: node tools/temper-cards.mjs --project-key <k> [--status s] [--lens l] [--quotes] [--full] [--undecided] [--date YYYY-MM-DD] [--ledger <file>]';

/** The loop checkout this tool runs from. */
const LOOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Store statuses a decision already moved a card to. */
const DECIDED_STATUSES = new Set(['accepted', 'rejected', 'snoozed', 'merged']);

/** The day ledger of a date in a loop checkout. @param {string} date @param {string} [root] */
export const dayLedger = (date, root = LOOP_ROOT) => join(root, 'docs', 'evals', 'temper', `${date}.jsonl`);

/** Today as YYYY-MM-DD in local time. @param {Date} [d] */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Each ref's newest verdict of one inbox in a day ledger (cycle rows' self_reported.verdicts, in file order):
 * {verdict, cycle, recorded}. A missing file is no verdict; a line that does not parse is skipped.
 * @param {string} file @param {string} key @returns {Map<string, {verdict: string, cycle: number, recorded: 'local' | 'live'}>}
 */
export function ledgerVerdicts(file, key) {
  /** @type {Map<string, {verdict: string, cycle: number, recorded: 'local' | 'live'}>} */
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.kind !== 'cycle') continue;
    for (const v of r.self_reported?.verdicts ?? []) {
      if (!v || v.inbox !== key || typeof v.ref !== 'string' || typeof v.verdict !== 'string') continue;
      m.set(v.ref, { verdict: v.verdict, cycle: r.n, recorded: v.recorded === 'live' ? 'live' : 'local' });
    }
  }
  return m;
}

/** The store file of a scan home. @param {string} home the Temper home @param {string} key */
export const scanStore = (home, key) => join(home, 'homes', key, 'projects', key, 'dowser.db');

/**
 * What --full adds to a card: the judged fields and the body's sections by heading, and `acceptance` (the Evaluation
 * section, the card's own done-when). Absent fields are left out. @param {any} c a proposal record
 */
export function cardDetail(c) {
  /** @type {Record<string, string>} */
  const sections = {};
  for (const p of bodyParts(c.body)) sections[p.heading || 'Body'] = p.text;
  const has = (/** @type {unknown} */ v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
  const pick = Object.fromEntries(['rationale', 'impact', 'impact_why', 'effort', 'confidence', 'confidence_why', 'doc_impact', 'delivery_risk']
    .filter((k) => has(c[k])).map((k) => [k, c[k]]));
  const acceptance = Object.entries(sections).find(([h]) => /^evaluation$/i.test(h))?.[1];
  return { ...pick, ...(Object.keys(sections).length ? { sections } : {}), ...(acceptance ? { acceptance } : {}) };
}

/**
 * One card as triage reads it, from a `show` output (the skill's memory.show). `full` implies quotes.
 * @param {any} s @param {boolean} [quotes] @param {boolean} [full]
 */
export function cardRow(s, quotes = false, full = false) {
  const c = s.card ?? {};
  if (full) quotes = true;
  return {
    fp: s.fp, ...(s.external_ref ? { ref: s.external_ref } : {}), ...(s.external_url ? { url: s.external_url } : {}),
    status: c.status, lens: c.lens, title: c.title,
    evidence: (s.evidence ?? []).map((/** @type {any} */ e) => ({ type: e.type, ref: e.ref, ...(e.path ? { path: e.path } : {}), ...(e.line ? { line: e.line } : {}),
      ...(quotes && e.quote ? { quote: e.quote } : {}) })),
    ...(full ? cardDetail(c) : {}),
  };
}

/**
 * A card row joined to the ledger's verdict of its ref. @param {any} row a cardRow
 * @param {Map<string, {verdict: string, cycle: number, recorded: 'local' | 'live'}>} verdicts
 */
export function withVerdict(row, verdicts) {
  const v = typeof row.ref === 'string' ? verdicts.get(row.ref) : undefined;
  return v ? { ...row, [v.recorded === 'live' ? 'decided_live' : 'decided_local']: { verdict: v.verdict, cycle: v.cycle } } : row;
}

/** True when neither the ledger nor the store holds a decision for the card. @param {any} row a withVerdict row */
export const undecided = (row) => !row.decided_local && !row.decided_live && !DECIDED_STATUSES.has(row.status);

/**
 * The cards of one scan home. Throws NoStore when no scan wrote that home yet.
 * @param {{home: string, key: string, status?: string, lens?: string, quotes?: boolean, full?: boolean, undecided?: boolean, ledger?: string}} o
 * `ledger` is the day ledger to join (default: today's in the loop checkout).
 */
export function listCards(o) {
  const db = scanStore(o.home, o.key);
  if (!existsSync(db)) throw new NoStore(`no scan home store for ${o.key} (${db}): no temper-scan has written it`);
  const s = store.openStore(db);
  try {
    const { proposals } = memory.list(s, { status: o.status, lens: o.lens });
    const ledger = o.ledger ?? dayLedger(localDate());
    const verdicts = ledgerVerdicts(ledger, o.key);
    const cards = proposals.map((/** @type {any} */ p) => withVerdict(cardRow(memory.show(s, p.fp), o.quotes, o.full), verdicts));
    return { project_key: o.key, db, ledger, cards: o.undecided ? cards.filter(undecided) : cards };
  } finally { s.close(); }
}

if (isMain(import.meta.url)) {
  try {
    const { flags: f, rest } = parseFlags(process.argv.slice(2), { values: ['project-key', 'status', 'lens', 'date', 'ledger'], bool: ['quotes', 'full', 'undecided'] });
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
    const key = checkProjectKey(f['project-key']);
    if (typeof f.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new UsageError('--date is YYYY-MM-DD');
    if (f.date && f.ledger) throw new UsageError('--date and --ledger name the same file: give one');
    const ledger = typeof f.ledger === 'string' ? f.ledger : dayLedger(typeof f.date === 'string' ? f.date : localDate());
    const out = listCards({ home: temperHome(), key, status: typeof f.status === 'string' ? f.status : undefined, lens: typeof f.lens === 'string' ? f.lens : undefined,
      quotes: f.quotes === true, full: f.full === true, undecided: f.undecided === true, ledger });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof NoStore || e instanceof DowserError)) throw e;
    console.error(`temper-cards: ${e.message}${e instanceof NoStore ? '' : `\n${USAGE}`}`);
    process.exitCode = e instanceof NoStore ? 1 : 2;
  }
}
