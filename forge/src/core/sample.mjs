// @ts-check
// The sample inbox (the judge's first run): a real Dowser scan of Dowser's own public repository, bundled with the
// app (src/sample/self-scan.json, built by tools/sample-capture.mjs) and replayed through the same core push code a
// scan uses - proposals, areas and trust - into the reserved inbox SAMPLE_KEY. The key IS the sample predicate (no
// flag column): cards and summaries of it say `sample: true` (cards.mjs), an accept marks its Jira issue
// (verdicts.mjs), and every MCP tool and Rovo write refuses the key (app.mjs, store.mjs refuseSampleKey), so a scan
// and the sample never mix in one inbox. Only this module passes the core's `{sample: true}` bypass.
//
// `setupStatus` is the setup checklist: the MCP URL and whether any MCP tool call has reached the app ("calls
// seen", from the tool_calls table app.mjs writes; whether an admin enabled the tools cannot be read).
import SELF_SCAN from '../sample/self-scan.json' with { type: 'json' };
import { accessFor } from './access.mjs';
import { areaProblem, pushAreas } from './areas.mjs';
import { checkRecord, parseLensKinds, pushProposals } from './push.mjs';
import { reflectSync } from './reflect.mjs';
import { getInbox, isSampleKey } from './store.mjs';
import { PUSH_MAX, SAMPLE_KEY } from './types.mjs';
import { AppError, isObj, str } from './util.mjs';
import { deciderOf } from './verdicts.mjs';

export { SAMPLE_KEY, isSampleKey };

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./types.mjs').SampleLoadOutput} SampleLoadOutput
 * @typedef {import('./types.mjs').SampleRemoveOutput} SampleRemoveOutput
 * @typedef {import('./types.mjs').SetupStatus} SetupStatus
 * @typedef {{repo_url: string, head_sha: string, scanned_at: string, run_id: string, harness?: string, model?: string}} SampleFileSource
 * @typedef {{schema: 'dowser-sample/1', source: SampleFileSource, lens_kinds_json: string, proposals: Record<string, any>[],
 *   areas: Record<string, any>[], trust_json?: string, placeholder?: boolean}} SampleFile
 */

export const SAMPLE_SCHEMA = 'dowser-sample/1';
/**
 * Cards per push of the sample load: a whole push (PUSH_MAX). A push files its cards as sets (push.mjs `fileAll`),
 * about a dozen statements however many cards it carries, so a chunk is well under a second on Forge SQL.
 */
export const SAMPLE_CHUNK = PUSH_MAX;
/** The load's own time budget per call (ms): past it, no new step starts and the answer carries `more: true`. */
export const SAMPLE_BUDGET_MS = 12_000;

/**
 * Every table that holds rows of one inbox, and how a row names it. `removeSample` deletes each, children first,
 * the inbox row last (so a remove cut short can be run again: the inbox, and with it the access check, is still
 * there). Evidence rows name their proposal, not the inbox.
 */
const REMOVE = /** @type {const} */ ([
  ['evidence', 'DELETE FROM evidence WHERE proposal_id IN (SELECT id FROM proposals WHERE project_key = ?)'],
  ['verdicts', 'DELETE FROM verdicts WHERE project_key = ?'],
  ['outcomes', 'DELETE FROM outcomes WHERE project_key = ?'],
  ['rules', 'DELETE FROM rules WHERE project_key = ?'],
  ['directions', 'DELETE FROM directions WHERE project_key = ?'],
  ['trust', 'DELETE FROM trust WHERE project_key = ?'],
  ['areas', 'DELETE FROM areas WHERE project_key = ?'],
  ['deliveries', 'DELETE FROM deliveries WHERE project_key = ?'],
  ['work_reports', 'DELETE FROM work_reports WHERE project_key = ?'],
  ['page_links', 'DELETE FROM page_links WHERE project_key = ?'],
  ['pushes', 'DELETE FROM pushes WHERE project_key = ?'],
  ['proposals', 'DELETE FROM proposals WHERE project_key = ?'],
  ['counters', 'DELETE FROM counters WHERE name = ?'], // the inbox's verdict seq (verdicts.mjs `seq:<project_key>`)
  ['inboxes', 'DELETE FROM inboxes WHERE project_key = ?'],
]);

/**
 * The sample file, checked whole before anything is written: its shape, every record as a push would check it
 * (`checkRecord` with the file's lens kinds) and every area as an areas push would. A bad bundle is the app's
 * fault, not the caller's: `unavailable`, and nothing is written.
 * @param {unknown} raw
 * @returns {SampleFile}
 */
export function checkSample(raw) {
  const bad = (/** @type {string} */ why) => new AppError('unavailable', `the bundled sample is not usable (${why}); report it`);
  if (!isObj(raw) || raw.schema !== SAMPLE_SCHEMA) throw bad(`schema is not ${SAMPLE_SCHEMA}`);
  const s = raw.source;
  if (!isObj(s) || !str(s.repo_url) || !str(s.head_sha) || !str(s.scanned_at) || !str(s.run_id)) throw bad('source needs repo_url, head_sha, scanned_at and run_id');
  if (!Array.isArray(raw.proposals) || raw.proposals.length === 0) throw bad('it holds no proposals');
  if (!Array.isArray(raw.areas)) throw bad('areas is not a list');
  if (raw.trust_json !== undefined && typeof raw.trust_json !== 'string') throw bad('trust_json is not a string');
  /** @type {Record<string, string[]> | undefined} */
  let kinds;
  try { kinds = parseLensKinds({ lens_kinds_json: raw.lens_kinds_json }); } catch (e) { throw bad(/** @type {Error} */ (e).message); }
  if (!kinds) throw bad('lens_kinds_json is missing');
  for (const [i, p] of raw.proposals.entries()) {
    const c = checkRecord(p, kinds);
    if (!c.ok) throw bad(`proposals[${i}]: ${c.why}`);
  }
  for (const [i, a] of raw.areas.entries()) {
    const why = areaProblem(a);
    if (why) throw bad(`areas[${i}]: ${why}`);
  }
  return /** @type {SampleFile} */ (raw);
}

/**
 * `sample.load`: replays the sample into SAMPLE_KEY as the caller (who becomes the inbox's creator): proposals in
 * pushes of SAMPLE_CHUNK, then the areas, then the trust. Resumable: a load cut short (a function timeout) leaves an
 * inbox that a second load completes, filing only the records it does not hold yet. A complete sample answers
 * `already: true` and writes nothing. The sample is open to everyone (core/access.mjs), so a second person on the site
 * who presses Load gets the loaded sample (`already: true`), never a refusal.
 *
 * Time budget: a Forge resolver has 25 s and a Forge SQL statement costs 30-60 ms. The load files cards in pushes
 * of SAMPLE_CHUNK and starts no new step (a chunk, the areas, the trust) once `budgetMs` of its own time
 * (`deps.now`) has passed; it then answers `more: true` and the next call resumes. A sample of up to a few hundred
 * cards fits one call; the budget stays as the guard for a larger one or a slow store. The first step always runs, so
 * every call makes progress. The call that finishes answers without `more`.
 * @param {Deps} deps
 * @param {string} accountId
 * @param {unknown} [sample]  the sample file (default: the bundled one; tests pass their own)
 * @param {{budgetMs?: number}} [o]  default SAMPLE_BUDGET_MS
 * @returns {Promise<SampleLoadOutput>}
 */
export async function loadSample(deps, accountId, sample = SELF_SCAN, { budgetMs = SAMPLE_BUDGET_MS } = {}) {
  const start = deps.now().getTime();
  let steps = 0;
  /** True when the next step may start: the first always may, later ones only within the budget. */
  const mayStart = () => steps++ === 0 || deps.now().getTime() - start < budgetMs;
  const s = checkSample(sample);
  const { db } = deps;
  const inbox = await getInbox(db, SAMPLE_KEY);
  if (inbox) await accessFor(deps, accountId).inbox(SAMPLE_KEY); // open to everyone; kept so the sample follows the one access rule
  const have = new Set(inbox ? (await db.query('SELECT fp FROM proposals WHERE project_key = ?', [SAMPLE_KEY])).map((r) => String(r.fp)) : []);
  const todo = s.proposals.filter((p) => !have.has(String(p.fp)));
  const areasDone = inbox !== undefined && Number((await db.query('SELECT COUNT(*) AS n FROM areas WHERE project_key = ?', [SAMPLE_KEY]))[0]?.n ?? 0) === s.areas.length;
  const trustDone = !s.trust_json || (inbox !== undefined && (await db.query('SELECT project_key FROM trust WHERE project_key = ?', [SAMPLE_KEY])).length > 0);
  if (inbox && todo.length === 0 && areasDone && trustDone) return { project_key: SAMPLE_KEY, created: 0, already: true };

  const opt = { sample: true, scannedAt: s.source.scanned_at };
  let created = 0;
  const more = () => ({ project_key: SAMPLE_KEY, created, more: /** @type {const} */ (true) });
  for (let i = 0; i < todo.length; i += SAMPLE_CHUNK) {
    if (!mayStart()) return more();
    const out = await pushProposals(deps, {
      project_key: SAMPLE_KEY, run_id: s.source.run_id, repo_url: s.source.repo_url, head_sha: s.source.head_sha,
      proposals_json: JSON.stringify(todo.slice(i, i + SAMPLE_CHUNK)), lens_kinds_json: s.lens_kinds_json,
    }, accountId, opt);
    created += out.results.filter((r) => r.result === 'created').length;
  }
  if (!areasDone) {
    if (!mayStart()) return more();
    await pushAreas(deps, { project_key: SAMPLE_KEY, run_id: s.source.run_id, areas_json: JSON.stringify(s.areas) }, accountId, opt);
  }
  if (!trustDone) {
    if (!mayStart()) return more();
    await reflectSync(deps, { project_key: SAMPLE_KEY, trust_json: s.trust_json }, opt);
  }
  return { project_key: SAMPLE_KEY, created };
}

/**
 * `sample.remove`: deletes every row of the sample inbox, in every table (REMOVE). Allowed for the person who
 * loaded it and for a Jira admin, else `forbidden`. The Jira issues accepted sample cards created stay in Jira
 * (`issues_kept` counts them; a measured 0 is sent). No sample inbox: nothing to remove, `issues_kept: 0`. DW
 * numbers are never reused, so a reload numbers its cards anew.
 * @param {Deps} deps
 * @param {string} accountId
 * @returns {Promise<SampleRemoveOutput>}
 */
export async function removeSample(deps, accountId) {
  const { db } = deps;
  const inbox = await getInbox(db, SAMPLE_KEY);
  if (!inbox) return { removed: true, issues_kept: 0 };
  if (inbox.created_by !== deciderOf(accountId) && !(await accessFor(deps, accountId).may('ADMINISTER'))) {
    throw new AppError('forbidden', 'Only the person who loaded the sample inbox, or a Jira admin, can remove it');
  }
  const kept = Number((await db.query('SELECT COUNT(*) AS n FROM proposals WHERE project_key = ? AND issue_ref IS NOT NULL', [SAMPLE_KEY]))[0]?.n ?? 0);
  for (const [table, statement] of REMOVE) await db.exec(statement, [table === 'counters' ? `seq:${SAMPLE_KEY}` : SAMPLE_KEY]);
  return { removed: true, issues_kept: kept };
}

/**
 * `setup.status`: the app's MCP URL (when the app context knows it), the MCP tool calls that reached the app
 * (`calls` is 0 when none has: a measured count; `last_at` / `last_tool` only once one has) and whether the
 * sample inbox exists.
 * @param {Deps} deps
 * @returns {Promise<SetupStatus>}
 */
export async function setupStatus(deps) {
  const { db } = deps;
  const rows = await db.query("SELECT name, calls, last_at FROM tool_calls WHERE name LIKE 'mcp:%'");
  let calls = 0;
  /** @type {{at: string, tool: string} | undefined} */
  let last;
  for (const r of rows) {
    calls += Number(r.calls);
    const at = String(r.last_at);
    if (!last || at > last.at) last = { at, tool: String(r.name).slice('mcp:'.length) };
  }
  /** @type {string | undefined} */
  let mcpUrl;
  try { mcpUrl = deps.links.mcpUrl?.(); } catch { mcpUrl = undefined; }
  return {
    ...(mcpUrl ? { mcp_url: mcpUrl } : {}),
    tools: { calls, ...(last ? { last_at: last.at, last_tool: last.tool } : {}) },
    sample: { loaded: (await getInbox(db, SAMPLE_KEY)) !== undefined },
  };
}
