#!/usr/bin/env node
// @ts-check
// sample-capture - builds the Forge app's sample inbox (forge/src/sample/self-scan.json, `dowser-sample/1`) from a
// normal Dowser scan of Dowser's own public repository, so a judge without a local skill can load a real scan
// (forge/src/core/sample.mjs replays it through the app's own push code).
//
//   node tools/sample-capture.mjs --home <DOWSER_HOME> --repo <scanned checkout> [--run <id>]
//                                 --repo-url https://github.com/xkazm04/dowser --out forge/src/sample/self-scan.json
//     --home      the Dowser home the scan wrote to (a dogfood run's temp home, or a --campaign folder)
//     --repo      the checkout that was scanned (the dogfood clone, kept with --keep): its project key finds the
//                 store, and its git history measures the areas
//     --run       the run to capture (default: the newest done run)
//     --repo-url  the public web URL the evidence links point at (forced: a dogfood clone's origin is a local path)
//     --out       where the file goes; never inside --repo
//
// What it reads, through the skill's own modules (nothing re-implemented, nothing written to the store or the repo):
//  - the cards: every proposal in status verified OR pushed whose last run is the captured run, ranked and reserve,
//    each as the record the outbox sends (lib/sync.mjs `proposalRecord`), quotes included (the sample is public
//    code), store-owned fields dropped and status `verified`. The outbox itself is not reused: it skips a pushed
//    card whose evidence did not grow and records what it sent in sync_state, and the sample needs every card;
//  - the kinds of each lens a card uses, from the lens packs (lib/memory.mjs `loadLensPack`), as lens_kinds_json;
//  - the areas the `areas` command would push (lib/sync.mjs `areas`), at the run's head commit;
//  - the trust `reflect export` would sync (lib/reflect.mjs `exportOffers`), when the store has any.
// Every record and area is then checked as the Forge push checks it (forge/src/core push.mjs `checkRecord`,
// areas.mjs `areaProblem`), so a file this writes loads. Output is deterministic for a given store: fixed key order,
// cards sorted by lens, MVP first, ranked before reserve, score desc, then fp.
//
// Exit codes: 0 written, 2 bad arguments, 3 the store, the run or a card is unusable.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENSES, STORE_OWNED, isOneOf } from '../skill/scripts/lib/model.mjs';
import { dbPath, isInside, projectKey, repoRoot } from '../skill/scripts/lib/paths.mjs';
import { checkRecord, parseLensKinds, webRepoUrl } from '../forge/src/core/push.mjs';
import { areaProblem } from '../forge/src/core/areas.mjs';

/** @typedef {Record<string, any>} Obj */

export const SAMPLE_SCHEMA = 'dowser-sample/1';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--home', '--repo', '--run', '--repo-url', '--out'].includes(a)) throw new Error(`unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    o[a.slice(2)] = v;
    i++;
  }
  for (const k of ['home', 'repo', 'repo-url', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  if (/\/\/[^/]*@/.test(o['repo-url']) || !webRepoUrl(o['repo-url'])) throw new Error('--repo-url must be an https:// (or http://) web URL without credentials');
  return { home: resolve(o.home), repo: resolve(o.repo), run: o.run, repoUrl: o['repo-url'], out: resolve(o.out) };
}

/** @param {unknown} lens @returns {number} */
const lensIdx = (lens) => /** @type {readonly unknown[]} */ (LENSES).indexOf(lens);

/** Sort rank of a card: lens order, MVP first, ranked before reserve, score desc, fp. @param {Obj} a @param {Obj} b */
const byRank = (a, b) => lensIdx(a.lens) - lensIdx(b.lens)
  || (b.mvp === true ? 1 : 0) - (a.mvp === true ? 1 : 0)
  || (a.band === 'reserve' ? 1 : 0) - (b.band === 'reserve' ? 1 : 0)
  || (typeof b.score === 'number' ? b.score : -Infinity) - (typeof a.score === 'number' ? a.score : -Infinity)
  || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0);

/**
 * Builds the `dowser-sample/1` document from the scan's store. Read-only.
 * @param {{home: string, repo: string, run?: string, repoUrl: string}} o
 * @returns {Promise<Obj>}
 */
export async function capture(o) {
  process.env.DOWSER_HOME = o.home;
  const store = await import('../skill/scripts/lib/store.mjs');
  const syncLib = await import('../skill/scripts/lib/sync.mjs');
  const reflectLib = await import('../skill/scripts/lib/reflect.mjs');
  const { loadLensPack } = await import('../skill/scripts/lib/memory.mjs');
  const root = repoRoot(o.repo);
  const file = dbPath(root);
  if (!existsSync(file)) throw Object.assign(new Error(`no Dowser store at ${file} (check --home and --repo)`), { exit: 3 });
  const db = store.openStore(file);
  try {
    const runId = o.run ?? store.lastDoneRun(db)?.id;
    const run = runId ? store.getRun(db, String(runId)) : undefined;
    if (!run) throw Object.assign(new Error(o.run ? `run ${o.run} does not exist` : 'the store has no done run'), { exit: 3 });
    if (run.status !== 'done') throw Object.assign(new Error(`run ${run.id} is ${run.status}, not done`), { exit: 3 });
    if (typeof run.head_sha !== 'string') throw Object.assign(new Error(`run ${run.id} has no head commit`), { exit: 3 });
    const pk = projectKey(root);

    const fps = /** @type {Obj[]} */ (db.prepare("SELECT fp FROM proposals WHERE status IN ('verified', 'pushed') AND last_run_id = ?").all(run.id)).map((r) => String(r.fp));
    if (fps.length === 0) throw Object.assign(new Error(`run ${run.id} kept no verified or pushed card`), { exit: 3 });
    const proposals = fps.map((fp) => {
      const rec = syncLib.proposalRecord(db, fp);
      /** @type {Obj} */
      const out = {};
      for (const [k, v] of Object.entries(rec)) if (!STORE_OWNED.includes(k)) out[k] = v;
      out.status = 'verified';
      return out;
    }).sort(byRank);

    const lenses = [...new Set(proposals.map((p) => String(p.lens)))].filter((l) => isOneOf(LENSES, l)).sort((a, b) => lensIdx(a) - lensIdx(b));
    const lensKindsJson = JSON.stringify(Object.fromEntries(lenses.map((l) => [l, loadLensPack(l).kinds])));
    const areas = JSON.parse(syncLib.areas(db, { root, projectKey: pk, runId: String(run.id) }).areas_json);
    const trustJson = reflectLib.exportOffers(db, pk).trust_json;

    const kinds = /** @type {Record<string, string[]>} */ (parseLensKinds({ lens_kinds_json: lensKindsJson }));
    for (const p of proposals) {
      const c = checkRecord(p, kinds);
      if (!c.ok) throw Object.assign(new Error(`card ${p.fp} would be refused by Forge: ${c.why}`), { exit: 3 });
    }
    for (const a of areas) {
      const why = areaProblem(a);
      if (why) throw Object.assign(new Error(`area ${a?.path} would be refused by Forge: ${why}`), { exit: 3 });
    }
    /** @type {Obj} */
    const source = { repo_url: o.repoUrl, head_sha: run.head_sha, scanned_at: String(run.finished_at ?? run.started_at), run_id: String(run.id) };
    if (typeof run.harness === 'string') source.harness = run.harness;
    if (typeof run.model === 'string') source.model = run.model;
    return {
      schema: SAMPLE_SCHEMA, source, lens_kinds_json: lensKindsJson, proposals, areas,
      ...(typeof trustJson === 'string' ? { trust_json: trustJson } : {}),
    };
  } finally {
    db.close();
  }
}

/** @param {string[]} argv */
async function main(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let o;
  try { o = parseArgs(argv); } catch (e) {
    console.error(`sample-capture: ${/** @type {Error} */ (e).message}`);
    console.error('usage: sample-capture.mjs --home <DOWSER_HOME> --repo <scanned checkout> [--run <id>] --repo-url <https or http url> --out <file>');
    process.exit(2);
  }
  if (isInside(o.repo, o.out)) { console.error(`sample-capture: --out ${o.out} is inside the scanned checkout ${o.repo}; write it elsewhere`); process.exit(2); }
  try {
    const doc = await capture(o);
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, `${JSON.stringify(doc, null, 2)}\n`);
    console.error(`sample-capture: ${doc.proposals.length} cards, ${doc.areas.length} areas${doc.trust_json ? ', trust' : ''} from run ${doc.source.run_id} at ${doc.source.head_sha} -> ${o.out}`);
  } catch (e) {
    const err = /** @type {any} */ (e);
    console.error(`sample-capture: ${err?.message ?? err}`);
    process.exit(err?.exit === 2 ? 2 : 3);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
