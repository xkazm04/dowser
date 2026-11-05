#!/usr/bin/env node
// @ts-check
// temper-tickets - files /temper's UAT findings as real Jira issues in project DOW, so the next Dowser scan reads them
// as tickets and a person sees them in Jira. Each issue carries the label `temper-uat` and `temper-fp-<12 hex>`, the
// finding's fingerprint; a finding whose fingerprint already has an unresolved issue is not filed again (deduped).
// Jira REST v3 with basic auth: FORGE_EMAIL and FORGE_API_TOKEN from the environment. They are User environment
// variables on the operator's machine, which a PowerShell session does not always carry; load them first:
//   $env:FORGE_EMAIL=[Environment]::GetEnvironmentVariable('FORGE_EMAIL','User')
//   $env:FORGE_API_TOKEN=[Environment]::GetEnvironmentVariable('FORGE_API_TOKEN','User')
// The token is never printed. JIRA_SITE overrides the site (default https://dowser.atlassian.net).
//
//   node tools/temper-tickets.mjs file --findings <json> [--project DOW] [--issue-type <name>] [--dry-run]
//   node tools/temper-tickets.mjs list [--all] [--project DOW]
//   node tools/temper-tickets.mjs close <KEY>... [--project DOW]
//
// A findings file is an array of findings, or {findings: [...]}. A finding:
//   {title, surface, steps: [string, ...], expected, actual, screenshot?, spec?, fp?}
// `surface` names where it was seen (`fixture #/inbox`, `local settings`, `live issue panel`), `spec` the Playwright
// spec that found it, `screenshot` a path (as text: nothing is uploaded). `fp` (12 hex) overrides the fingerprint,
// which is otherwise sha256 of the surface, spec and title, normalized (case and whitespace), so a reworded actual
// result is the same finding. `--dry-run` validates and prints the plan with no network call.
// Jira search is eventually consistent, so a ticket filed seconds ago may not be found by JQL yet: every filing is
// also remembered in <temper home>/tickets.json (fp -> key), and a remembered key is read back directly (GET issue) first.
// `close` moves an issue to a Done-category status; it refuses an issue without the `temper-uat` label.
// Output: JSON. Exit codes: 0 done, 1 a Jira call failed, 2 bad arguments or findings.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UsageError, isMain, parseFlags, temperHome } from './temper-lib.mjs';

export const UAT_LABEL = 'temper-uat';
export const FP_LABEL_PREFIX = 'temper-fp-';
export const DEFAULT_SITE = 'https://dowser.atlassian.net';
export const DEFAULT_PROJECT = 'DOW';
/** Issue types tried in order when --issue-type is not given. */
export const ISSUE_TYPE_PREFERENCE = ['Bug', 'Task'];
const SUMMARY_MAX = 255;
const TEXT_MAX = 4000;
const STEPS_MAX = 30;
const FP_RE = /^[0-9a-f]{12}$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const USAGE = 'usage: node tools/temper-tickets.mjs file --findings <json> [--project DOW] [--issue-type name] [--dry-run] | list [--all] [--project DOW] | close <KEY>... [--project DOW]';

/** @typedef {{title: string, surface: string, steps: string[], expected: string, actual: string, screenshot?: string, spec?: string, fp?: string}} Finding */

/** Lowercase, whitespace collapsed, trimmed. @param {string | undefined} s */
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The finding's fingerprint: its own `fp`, else the first 12 hex of sha256 over the normalized surface, spec and title.
 * @param {Pick<Finding, 'surface' | 'title' | 'spec' | 'fp'>} f
 */
export function findingFp(f) {
  if (f.fp) return f.fp;
  return createHash('sha256').update(['temper-uat/1', norm(f.surface), norm(f.spec), norm(f.title)].join('\n')).digest('hex').slice(0, 12);
}

/** The dedupe label of a fingerprint. @param {string} fp */
export const fpLabel = (fp) => `${FP_LABEL_PREFIX}${fp}`;

/** @param {unknown} v */
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Checks one finding; returns it trimmed, or throws UsageError naming the field.
 * @param {unknown} raw @param {number} i
 * @returns {Finding}
 */
export function checkFinding(raw, i) {
  const at = `finding ${i}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError(`${at} is not an object`);
  const f = /** @type {Record<string, unknown>} */ (raw);
  for (const k of ['title', 'surface', 'expected', 'actual']) if (!nonEmpty(f[k])) throw new UsageError(`${at}: ${k} must be a non-empty string`);
  if (!Array.isArray(f.steps) || f.steps.length === 0 || f.steps.length > STEPS_MAX || !f.steps.every(nonEmpty)) {
    throw new UsageError(`${at}: steps must be 1-${STEPS_MAX} non-empty strings`);
  }
  for (const k of ['screenshot', 'spec']) if (f[k] !== undefined && !nonEmpty(f[k])) throw new UsageError(`${at}: ${k}, when given, must be a non-empty string`);
  if (f.fp !== undefined && (typeof f.fp !== 'string' || !FP_RE.test(f.fp))) throw new UsageError(`${at}: fp, when given, must be 12 lowercase hex`);
  const s = (/** @type {unknown} */ v) => String(v).trim();
  return {
    title: s(f.title), surface: s(f.surface), steps: f.steps.map(s), expected: s(f.expected), actual: s(f.actual),
    ...(f.screenshot ? { screenshot: s(f.screenshot) } : {}), ...(f.spec ? { spec: s(f.spec) } : {}), ...(f.fp ? { fp: s(f.fp) } : {}),
  };
}

/** A findings file's content (an array, or {findings}) as checked findings. @param {unknown} doc @returns {Finding[]} */
export function parseFindings(doc) {
  const list = Array.isArray(doc) ? doc : /** @type {any} */ (doc)?.findings;
  if (!Array.isArray(list) || list.length === 0) throw new UsageError('the findings file must hold a non-empty array, or {findings: [...]}');
  return list.map(checkFinding);
}

/** @param {string} s */
const clip = (s) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);
/** @param {string} text @param {any[]} [marks] */
const textNode = (text, marks) => ({ type: 'text', text: clip(text), ...(marks ? { marks } : {}) });
/** @param {...any} content */
const para = (...content) => ({ type: 'paragraph', content });
/** @param {string} text */
const heading = (text) => ({ type: 'heading', attrs: { level: 3 }, content: [textNode(text)] });
const CODE = [{ type: 'code' }];

/** The issue summary: `UAT: <title>`, within Jira's 255. @param {Finding} f */
export function summaryOf(f) {
  const s = `UAT: ${f.title.replace(/\s+/g, ' ')}`;
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

/**
 * The issue description in Atlassian Document Format: where it was seen, the steps, expected and actual, the
 * screenshot path and spec name as text, and the fingerprint. No empty text node (Jira refuses one).
 * @param {Finding} f
 */
export function adfOf(f) {
  const evidence = [
    ...(f.screenshot ? [para(textNode('Screenshot: '), textNode(f.screenshot, CODE))] : []),
    ...(f.spec ? [para(textNode('Spec: '), textNode(f.spec, CODE))] : []),
    para(textNode('Fingerprint: '), textNode(fpLabel(findingFp(f)), CODE)),
  ];
  return {
    type: 'doc', version: 1,
    content: [
      para(textNode('Found by the /temper simulated UAT on '), textNode(f.surface, CODE), textNode('.')),
      heading('Steps to reproduce'),
      { type: 'orderedList', content: f.steps.map((s) => ({ type: 'listItem', content: [para(textNode(s))] })) },
      heading('Expected'), para(textNode(f.expected)),
      heading('Actual'), para(textNode(f.actual)),
      heading('Evidence'), ...evidence,
    ],
  };
}

/** The JQL of unresolved temper-uat issues with one fingerprint. @param {string} project @param {string} fp */
export const dedupeJql = (project, fp) => `project = "${project}" AND labels = "${UAT_LABEL}" AND labels = "${fpLabel(fp)}" AND statusCategory != Done ORDER BY created ASC`;

/** @typedef {(method: string, path: string, body?: unknown) => Promise<any>} Jira */

/**
 * A Jira REST client with basic auth. Errors name the method, path, status and Jira's messages, never the token.
 * @param {{site?: string, email?: string, token?: string, fetch?: typeof fetch}} o
 * @returns {Jira}
 */
export function jiraClient(o) {
  if (!o.email || !o.token) throw new UsageError('FORGE_EMAIL and FORGE_API_TOKEN must be set (in PowerShell load them from the User environment first)');
  const site = (o.site ?? DEFAULT_SITE).replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${o.email}:${o.token}`).toString('base64')}`;
  const f = o.fetch ?? fetch;
  return async (method, path, body) => {
    const res = await f(`${site}${path}`, { method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    /** @type {any} */
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const msgs = [...(json.errorMessages ?? []), ...Object.entries(json.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ');
      throw new Error(`Jira ${method} ${path.split('?')[0]} -> ${res.status}${msgs ? `: ${msgs}` : ''}`);
    }
    return json;
  };
}

/**
 * The issue type id to file with: `wanted` by name, else the first of ISSUE_TYPE_PREFERENCE the project has.
 * @param {Jira} jira @param {string} project @param {string} [wanted]
 */
export async function issueTypeId(jira, project, wanted) {
  const meta = await jira('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`);
  /** @type {{id: string, name: string, subtask?: boolean}[]} */
  const types = (meta.issueTypes ?? meta.values ?? []).filter((/** @type {any} */ t) => !t.subtask);
  const names = wanted ? [wanted] : ISSUE_TYPE_PREFERENCE;
  for (const n of names) {
    const t = types.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (t) return { id: t.id, name: t.name };
  }
  throw new Error(`project ${project} has no issue type ${names.join(' or ')} (it has ${types.map((t) => t.name).join(', ') || 'none'})`);
}

/** @param {Jira} jira @param {string} jql @param {number} [max] */
const search = async (jira, jql, max = 50) => (await jira('POST', '/rest/api/3/search/jql', { jql, fields: ['summary', 'status', 'labels', 'created'], maxResults: max })).issues ?? [];

/**
 * True when the issue exists and is not in a Done-category status (a deleted issue answers 404: not unresolved).
 * @param {Jira} jira @param {string} key
 */
async function unresolved(jira, key) {
  try {
    const i = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`);
    return i.fields?.status?.statusCategory?.key !== 'done';
  } catch (e) {
    if (e instanceof Error && / -> 404/.test(e.message)) return false;
    throw e;
  }
}

/** The local ticket ledger, fp -> key. @param {string} file @returns {Map<string, string>} */
export function readLedger(file) {
  if (!existsSync(file)) return new Map();
  try { return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')))); } catch { return new Map(); }
}

/** @param {string} file @param {Map<string, string>} known */
function writeLedger(file, known) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(known), null, 2));
}

/**
 * What filing would do: each finding's fingerprint, summary and labels. Throws UsageError when two findings of one file
 * share a fingerprint.
 * @param {Finding[]} findings
 */
export function planFindings(findings) {
  const plan = findings.map((f) => ({ fp: findingFp(f), summary: summaryOf(f), labels: [UAT_LABEL, fpLabel(findingFp(f))] }));
  const seen = new Set();
  for (const [i, p] of plan.entries()) {
    if (seen.has(p.fp)) throw new UsageError(`finding ${i} repeats fingerprint ${p.fp} in the same file`);
    seen.add(p.fp);
  }
  return plan;
}

/**
 * Files each finding unless an unresolved issue already has its fingerprint label.
 * @param {Finding[]} findings
 * `known` maps a fingerprint to the key it was filed as (the local ticket ledger); it is checked before the search
 * and updated with every new filing.
 * @param {{jira: Jira, project: string, issueType?: string, site?: string, known?: Map<string, string>}} o
 */
export async function fileFindings(findings, o) {
  const plan = planFindings(findings);
  const site = (o.site ?? DEFAULT_SITE).replace(/\/+$/, '');
  /** @type {{fp: string, key: string, url: string}[]} */
  const filed = [];
  /** @type {{fp: string, key: string}[]} */
  const deduped = [];
  /** @type {{id: string, name: string} | undefined} */
  let type;
  for (const [i, f] of findings.entries()) {
    const { fp, summary, labels } = plan[i];
    const remembered = o.known?.get(fp);
    if (remembered && await unresolved(o.jira, remembered)) { deduped.push({ fp, key: remembered }); continue; }
    const [open] = await search(o.jira, dedupeJql(o.project, fp), 1);
    if (open) { deduped.push({ fp, key: open.key }); continue; }
    type ??= await issueTypeId(o.jira, o.project, o.issueType);
    const made = await o.jira('POST', '/rest/api/3/issue', { fields: { project: { key: o.project }, issuetype: { id: type.id }, summary, description: adfOf(f), labels } });
    filed.push({ fp, key: made.key, url: `${site}/browse/${made.key}` });
    o.known?.set(fp, made.key);
  }
  return { project: o.project, ...(type ? { issue_type: type.name } : {}), filed, deduped };
}

/** @param {Jira} jira @param {string} project @param {boolean} all */
export async function listTickets(jira, project, all) {
  const jql = `project = "${project}" AND labels = "${UAT_LABEL}"${all ? '' : ' AND statusCategory != Done'} ORDER BY created DESC`;
  const issues = await search(jira, jql, 100);
  return { project, tickets: issues.map((/** @type {any} */ i) => {
    /** @type {string | undefined} */
    const label = (i.fields?.labels ?? []).find((/** @type {string} */ l) => l.startsWith(FP_LABEL_PREFIX));
    return { key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, ...(label ? { fp: label.slice(FP_LABEL_PREFIX.length) } : {}) };
  }) };
}

/** Moves temper-uat issues to a Done-category status. @param {Jira} jira @param {string[]} keys */
export async function closeTickets(jira, keys) {
  /** @type {{key: string, result: 'closed' | 'already-done', status?: string}[]} */
  const out = [];
  for (const key of keys) {
    const issue = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=labels,status`);
    if (!(issue.fields?.labels ?? []).includes(UAT_LABEL)) throw new UsageError(`${key} has no ${UAT_LABEL} label; temper-tickets closes only its own issues`);
    if (issue.fields?.status?.statusCategory?.key === 'done') { out.push({ key, result: 'already-done', status: issue.fields.status.name }); continue; }
    const { transitions = [] } = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const t = transitions.find((/** @type {any} */ x) => x.to?.statusCategory?.key === 'done' && /^done$/i.test(x.to?.name ?? x.name))
      ?? transitions.find((/** @type {any} */ x) => x.to?.statusCategory?.key === 'done');
    if (!t) throw new Error(`${key} has no transition to a Done status`);
    await jira('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    out.push({ key, result: 'closed', status: t.to?.name ?? t.name });
  }
  return { closed: out };
}

/**
 * The command line as a command; throws UsageError.
 * @param {string[]} argv
 * @returns {{cmd: 'file', findings: string, project: string, issueType?: string, dryRun: boolean} | {cmd: 'list', project: string, all: boolean} | {cmd: 'close', project: string, keys: string[]}}
 */
export function parseTicketArgs(argv) {
  const [cmd, ...rest] = argv;
  const { flags: f, rest: pos } = parseFlags(rest, { values: ['findings', 'project', 'issue-type'], bool: ['dry-run', 'all'] });
  const project = typeof f.project === 'string' ? f.project : DEFAULT_PROJECT;
  if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new UsageError(`--project ${project} is not a Jira project key`);
  const only = (/** @type {string[]} */ ok) => { for (const k of Object.keys(f)) if (!ok.includes(k)) throw new UsageError(`--${k} does not apply to ${cmd}`); };
  if (cmd === 'file') {
    only(['findings', 'project', 'issue-type', 'dry-run']);
    if (pos.length) throw new UsageError(`unexpected argument ${pos[0]}`);
    if (typeof f.findings !== 'string') throw new UsageError('file needs --findings <json>');
    return { cmd, findings: f.findings, project, ...(typeof f['issue-type'] === 'string' ? { issueType: f['issue-type'] } : {}), dryRun: f['dry-run'] === true };
  }
  if (cmd === 'list') {
    only(['project', 'all']);
    if (pos.length) throw new UsageError(`unexpected argument ${pos[0]}`);
    return { cmd, project, all: f.all === true };
  }
  if (cmd === 'close') {
    only(['project']);
    if (!pos.length) throw new UsageError('close needs at least one issue key');
    for (const k of pos) if (!JIRA_KEY_RE.test(k) || !k.startsWith(`${project}-`)) throw new UsageError(`${k} is not an issue key in ${project}`);
    return { cmd, project, keys: pos };
  }
  throw new UsageError(cmd ? `unknown command ${cmd}` : 'a command is required');
}

/** @param {ReturnType<typeof parseTicketArgs>} a */
async function main(a) {
  const env = process.env;
  const client = () => jiraClient({ site: env.JIRA_SITE, email: env.FORGE_EMAIL, token: env.FORGE_API_TOKEN });
  if (a.cmd === 'file') {
    /** @type {unknown} */
    let doc;
    try { doc = JSON.parse(readFileSync(a.findings, 'utf8')); } catch { throw new UsageError(`cannot read JSON from ${a.findings}`); }
    const findings = parseFindings(doc);
    if (a.dryRun) return { dry_run: true, project: a.project, plan: planFindings(findings) };
    const ledger = join(temperHome(), 'tickets.json');
    const known = readLedger(ledger);
    try {
      return await fileFindings(findings, { project: a.project, issueType: a.issueType, site: env.JIRA_SITE, jira: client(), known });
    } finally { writeLedger(ledger, known); }
  }
  if (a.cmd === 'list') return listTickets(client(), a.project, a.all);
  return closeTickets(client(), a.keys);
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main(parseTicketArgs(process.argv.slice(2))), null, 2));
  } catch (e) {
    console.error(`temper-tickets: ${e instanceof Error ? e.message : String(e)}${e instanceof UsageError ? `\n${USAGE}` : ''}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
