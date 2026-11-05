#!/usr/bin/env node
// @ts-check
// temper-cards - the cards a temper scan left in an inbox's scan home, for triage, read-only.
//
//   node tools/temper-cards.mjs --project-key <k> [--status s] [--lens l] [--quotes]
//
// temper-scan keys the store by the inbox key (the clone's origin is set to it), so `dowser.mjs list --repo <path>` on
// the real checkout reads a different project and answers nothing. This reads the scan home's own store,
// <temper home>/homes/<k>/projects/<k>/dowser.db, through the skill's store library (never by hand), and prints
// {project_key, db, cards: [{fp, ref?, url?, status, lens, title, evidence: [{type, ref, path?, line?, quote?}]}]},
// most recently updated first. Quotes are left out unless --quotes. Exit 0, 1 (no store for that key), 2 (usage).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DowserError } from '../skill/scripts/lib/model.mjs';
import * as memory from '../skill/scripts/lib/memory.mjs';
import * as store from '../skill/scripts/lib/store.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from './temper-lib.mjs';

/** No scan has written that home yet (exit 1). */
export class NoStore extends Error {}

const USAGE = 'usage: node tools/temper-cards.mjs --project-key <k> [--status s] [--lens l] [--quotes]';

/** The store file of a scan home. @param {string} home the Temper home @param {string} key */
export const scanStore = (home, key) => join(home, 'homes', key, 'projects', key, 'dowser.db');

/**
 * One card as triage reads it, from a `show` output (the skill's memory.show).
 * @param {any} s @param {boolean} [quotes]
 */
export function cardRow(s, quotes = false) {
  const c = s.card ?? {};
  return {
    fp: s.fp, ...(s.external_ref ? { ref: s.external_ref } : {}), ...(s.external_url ? { url: s.external_url } : {}),
    status: c.status, lens: c.lens, title: c.title,
    evidence: (s.evidence ?? []).map((/** @type {any} */ e) => ({ type: e.type, ref: e.ref, ...(e.path ? { path: e.path } : {}), ...(e.line ? { line: e.line } : {}),
      ...(quotes && e.quote ? { quote: e.quote } : {}) })),
  };
}

/**
 * The cards of one scan home. Throws NoStore when no scan wrote that home yet.
 * @param {{home: string, key: string, status?: string, lens?: string, quotes?: boolean}} o
 */
export function listCards(o) {
  const db = scanStore(o.home, o.key);
  if (!existsSync(db)) throw new NoStore(`no scan home store for ${o.key} (${db}): no temper-scan has written it`);
  const s = store.openStore(db);
  try {
    const { proposals } = memory.list(s, { status: o.status, lens: o.lens });
    return { project_key: o.key, db, cards: proposals.map((/** @type {any} */ p) => cardRow(memory.show(s, p.fp), o.quotes)) };
  } finally { s.close(); }
}

if (isMain(import.meta.url)) {
  try {
    const { flags: f, rest } = parseFlags(process.argv.slice(2), { values: ['project-key', 'status', 'lens'], bool: ['quotes'] });
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
    const key = checkProjectKey(f['project-key']);
    const out = listCards({ home: temperHome(), key, status: typeof f.status === 'string' ? f.status : undefined, lens: typeof f.lens === 'string' ? f.lens : undefined, quotes: f.quotes === true });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof NoStore || e instanceof DowserError)) throw e;
    console.error(`temper-cards: ${e.message}${e instanceof NoStore ? '' : `\n${USAGE}`}`);
    process.exitCode = e instanceof NoStore ? 1 : 2;
  }
}
