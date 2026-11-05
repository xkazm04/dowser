#!/usr/bin/env node
// @ts-check
// temper-verdicts - records /temper's delegated triage verdicts in a LIVE Dowser inbox through the MCP tool
// `dowser_verdicts_record` (docs/contracts/forge-mcp-2.md; on a development install the tool is
// `dowser_verdicts_record_development`, matched as tools/forge-live-e2e.mjs does), called through a headless
// `claude -p` connected to the live dowser server (tools/live-mcp.mjs). Forge records each as decided by
// `delegate:temper` and refuses it without a valid delegation in the inbox's Settings, past the day's caps, or for the
// sample inbox; this tool only checks the shape first and reports what Forge answered.
//
//   node tools/temper-verdicts.mjs --project-key <k> --verdicts <json> [--retry] [--dry-run]
//
// A verdicts file is an array of {ref, verdict: accept|reject|snooze|merge, reason?, note?, into?, until?}:
// `ref` is DW-n; a reject needs a reason (skill/scripts/lib/model.mjs REASONS; `other` needs a note); a merge needs
// `into` (DW-n, a 16-hex fp or a Jira issue key); `until` (YYYY-MM-DD) goes only with a snooze; a snooze's why goes in
// `note` (reason is a reject's code). The same file passes `temper.mjs triage check`, and it may carry the cycle
// file's ledger keys `inbox` (must equal --project-key), `recorded` (live|local) and `deferred` ("cap", only on a
// snooze: snoozed only because the day's accept cap is reached): they are checked, never sent.
// The tool answers {results: [{ref, result: recorded|refused, why?, issue_ref?}], more?}; with `more`, the verdicts not
// answered yet are sent again until none is left. Output: JSON {project_key, recorded, refused, results}.
// When Forge answers `forbidden` (no valid delegation in the inbox's Settings), the output is
// {project_key, recorded: 0, forbidden: true, record_as: "local", why} and the exit code is 1; the answer is remembered
// for the inbox for the day (<temper home>/verdicts-forbidden.json), so a later call the same day answers the same
// without a `claude -p` run. --retry asks Forge again (after the operator set up a delegation).
// Exit codes: 0 every verdict recorded (or dry run), 1 forbidden, a call failed or a verdict was refused, 2 bad arguments.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REASONS, decisionProblem, isOneOf } from '../skill/scripts/lib/model.mjs';
import { callLiveTool, liveDowserServer, writeMcpConfig } from './live-mcp.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from './temper-lib.mjs';

export const TOOL = 'dowser_verdicts_record';
export const VERDICTS = /** @type {const} */ (['accept', 'reject', 'snooze', 'merge']);
const REF_RE = /^DW-[1-9][0-9]*$/;
const INTO_RE = /^(DW-[1-9][0-9]*|[0-9a-f]{16}|[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = ['ref', 'verdict', 'reason', 'note', 'into', 'until'];
/** The cycle file's keys on a verdict: checked here, stripped before the call. */
const LEDGER_KEYS = ['inbox', 'recorded', 'deferred'];
/** Rounds of `more` before giving up (a tool that never shrinks the pending list). */
const MAX_ROUNDS = 20;
const USAGE = 'usage: node tools/temper-verdicts.mjs --project-key <k> --verdicts <json> [--retry] [--dry-run]';

/** Forge refused the call: the inbox has no valid delegation. */
export class ForbiddenError extends Error {}

/** The local calendar day. @param {Date} d */
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** @param {string} home */
const memoFile = (home) => join(home, 'verdicts-forbidden.json');
/** @param {string} home @returns {Record<string, string>} */
const readMemo = (home) => { try { const m = JSON.parse(readFileSync(memoFile(home), 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; } };

/** True when Forge answered forbidden for this inbox earlier on `date`. @param {string} home @param {string} key @param {Date} date */
export const forbiddenToday = (home, key, date) => readMemo(home)[key] === localDay(date);

/** Remembers a forbidden answer for this inbox for the day. @param {string} home @param {string} key @param {Date} date */
export function rememberForbidden(home, key, date) {
  mkdirSync(home, { recursive: true });
  writeFileSync(memoFile(home), `${JSON.stringify({ ...readMemo(home), [key]: localDay(date) }, null, 2)}\n`);
}

/** The output of a forbidden inbox. @param {string} key @param {string} why */
export const forbiddenOut = (key, why) => ({ project_key: key, recorded: 0, forbidden: true, record_as: 'local', why });

/** @typedef {{ref: string, verdict: typeof VERDICTS[number], reason?: string, note?: string, into?: string, until?: string}} Verdict */
/** @typedef {{ref: string, result: 'recorded' | 'refused', why?: string, issue_ref?: string}} VerdictResult */
/** @typedef {(name: string, args: Record<string, unknown>) => any} ToolCall */

/**
 * Checks one verdict against the contract; returns it (without the ledger keys), or throws UsageError naming the field.
 * @param {unknown} raw @param {number} i @param {string} [projectKey] the inbox an `inbox` key must name
 * @returns {Verdict}
 */
export function checkVerdict(raw, i, projectKey) {
  const at = `verdict ${i}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError(`${at} is not an object`);
  const v = /** @type {Record<string, unknown>} */ (raw);
  for (const k of Object.keys(v)) {
    if (!KEYS.includes(k) && !LEDGER_KEYS.includes(k)) throw new UsageError(`${at}: unknown key ${k}`);
    if (typeof v[k] !== 'string') throw new UsageError(`${at}: ${k} must be a string (omit an absent value)`);
  }
  const s = /** @type {Record<string, string>} */ (v);
  if (s.recorded !== undefined && !['live', 'local'].includes(s.recorded)) throw new UsageError(`${at}: recorded is live or local`);
  if (s.deferred !== undefined && (s.deferred !== 'cap' || s.verdict !== 'snooze')) throw new UsageError(`${at}: deferred is "cap", and only on a snooze (snoozed only because the day's accept cap is reached)`);
  if (s.inbox !== undefined && projectKey !== undefined && s.inbox !== projectKey) throw new UsageError(`${at}: inbox ${s.inbox} is not ${projectKey}`);
  if (!REF_RE.test(s.ref ?? '')) throw new UsageError(`${at}: ref must be DW-n`);
  if (!isOneOf(VERDICTS, s.verdict)) throw new UsageError(`${at}: verdict must be one of ${VERDICTS.join(', ')}`);
  if (s.reason !== undefined && !isOneOf(REASONS, s.reason)) throw new UsageError(`${at}: reason must be one of ${REASONS.join(', ')}`);
  if (s.verdict === 'reject') {
    const problem = decisionProblem({ to: 'rejected', reason: s.reason, note: s.note });
    if (problem) throw new UsageError(`${at}: ${problem.replace(/--/g, '')}`);
  } else if (s.reason !== undefined) throw new UsageError(`${at}: reason goes only with a reject (a snooze or accept says why in note)`);
  if (s.verdict === 'merge' ? !INTO_RE.test(s.into ?? '') : s.into !== undefined) throw new UsageError(`${at}: into (DW-n, a 16-hex fp or an issue key) goes with a merge, and only there`);
  if (s.until !== undefined && (s.verdict !== 'snooze' || !DATE_RE.test(s.until))) throw new UsageError(`${at}: until (YYYY-MM-DD) goes only with a snooze`);
  return /** @type {Verdict} */ (Object.fromEntries(KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])));
}

/** A verdicts file's content as checked verdicts, one per ref. @param {unknown} doc @param {string} [projectKey] @returns {Verdict[]} */
export function parseVerdicts(doc, projectKey) {
  if (!Array.isArray(doc) || doc.length === 0) throw new UsageError('the verdicts file must hold a non-empty array');
  const list = doc.map((v, i) => checkVerdict(v, i, projectKey));
  const seen = new Set();
  for (const v of list) {
    if (seen.has(v.ref)) throw new UsageError(`${v.ref} has two verdicts`);
    seen.add(v.ref);
  }
  return list;
}

/** The tool's arguments (scalar inputs: the verdicts travel as a JSON string). @param {string} projectKey @param {Verdict[]} verdicts */
export const toolArgs = (projectKey, verdicts) => ({ project_key: projectKey, verdicts_json: JSON.stringify(verdicts) });

/**
 * Records the verdicts through `call`, paging on `more`: each round sends the verdicts with no result yet.
 * Throws when the tool answers an error or stops making progress.
 * @param {string} projectKey @param {Verdict[]} verdicts @param {ToolCall} call
 * @returns {Promise<{project_key: string, recorded: number, refused: VerdictResult[], results: VerdictResult[]}>}
 */
export async function recordVerdicts(projectKey, verdicts, call) {
  /** @type {Map<string, VerdictResult>} */
  const done = new Map();
  let pending = verdicts;
  for (let round = 0; pending.length; round++) {
    if (round >= MAX_ROUNDS) throw new Error(`${TOOL} left ${pending.length} verdicts unanswered after ${MAX_ROUNDS} rounds`);
    const answer = await call(TOOL, toolArgs(projectKey, pending));
    const code = typeof answer?.error === 'string' ? answer.error : answer?.error?.code;
    if (code === 'forbidden') throw new ForbiddenError(`${TOOL} answered forbidden`);
    if (answer?.error) throw new Error(`${TOOL} answered ${code ?? 'an error'}`);
    if (!Array.isArray(answer?.results)) throw new Error(`${TOOL} answered no results`);
    const before = done.size;
    for (const r of answer.results) if (r && typeof r.ref === 'string' && pending.some((v) => v.ref === r.ref)) done.set(r.ref, r);
    pending = pending.filter((v) => !done.has(v.ref));
    if (!answer.more && pending.length) throw new Error(`${TOOL} answered ${done.size} of ${verdicts.length} verdicts and no more`);
    if (done.size === before && pending.length) throw new Error(`${TOOL} answered more but recorded nothing new`);
  }
  const results = verdicts.map((v) => /** @type {VerdictResult} */ (done.get(v.ref)));
  return { project_key: projectKey, recorded: results.filter((r) => r.result === 'recorded').length, refused: results.filter((r) => r.result !== 'recorded'), results };
}

/**
 * The command line; throws UsageError.
 * @param {string[]} argv
 * @returns {{projectKey: string, verdicts: string, dryRun: boolean, retry: boolean}}
 */
export function parseVerdictArgs(argv) {
  const { flags: f, rest } = parseFlags(argv, { values: ['project-key', 'verdicts'], bool: ['dry-run', 'retry'] });
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  if (typeof f.verdicts !== 'string') throw new UsageError('--verdicts <json> is required');
  return { projectKey: checkProjectKey(f['project-key']), verdicts: f.verdicts, dryRun: f['dry-run'] === true, retry: f.retry === true };
}

/** @param {ReturnType<typeof parseVerdictArgs>} a */
async function main(a) {
  /** @type {unknown} */
  let doc;
  try { doc = JSON.parse(readFileSync(a.verdicts, 'utf8')); } catch { throw new UsageError(`cannot read JSON from ${a.verdicts}`); }
  const verdicts = parseVerdicts(doc, a.projectKey);
  if (a.dryRun) return { dry_run: true, tool: TOOL, args: toolArgs(a.projectKey, verdicts) };
  const home = temperHome(), now = new Date();
  if (!a.retry && forbiddenToday(home, a.projectKey, now)) return forbiddenOut(a.projectKey, 'forbidden earlier today (no call made; --retry asks Forge again)');
  const work = mkdtempSync(join(tmpdir(), 'temper-verdicts-'));
  try {
    const mcpConfig = writeMcpConfig(join(work, 'mcp.json'), liveDowserServer());
    return await recordVerdicts(a.projectKey, verdicts, (name, args) => callLiveTool(name, args, { work, mcpConfig }));
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    rememberForbidden(home, a.projectKey, now);
    return forbiddenOut(a.projectKey, 'forbidden: no valid delegation in the inbox Settings');
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  try {
    const out = await main(parseVerdictArgs(process.argv.slice(2)));
    console.log(JSON.stringify(out, null, 2));
    if (('refused' in out && out.refused.length) || 'forbidden' in out) process.exitCode = 1;
  } catch (e) {
    console.error(`temper-verdicts: ${e instanceof Error ? e.message : String(e)}${e instanceof UsageError ? `\n${USAGE}` : ''}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
