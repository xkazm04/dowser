#!/usr/bin/env node
// @ts-check
// mock-forge-mcp - a zero-dependency stdio MCP server that stands in for Dowser's Forge app (rovo:mcp) until it
// exists, so the skill and its scripts are testable end to end. It implements the five tools of
// docs/contracts/forge-mcp-1.md over an in-memory backend, plus one test-only tool, `mock_decide`, that simulates
// a person's verdict in Jira.
//
// Framing copied from bp's apps/mcp/bp-mcp.mjs: JSON-RPC 2.0 over newline-delimited stdin/stdout, Node builtins
// only (no SDK); stdout carries protocol only, logs go to stderr. Methods: initialize (echoes the client's
// protocolVersion), notifications/initialized, ping, tools/list, tools/call. A tool result carries the JSON both as
// `structuredContent` and as one text content item; a bad call is `isError: true` with `{error, message}`.
//
//   node tools/mock-forge-mcp.mjs [--seed <file>] [--state <file>]
//     --seed   JSON {tickets?: [...], pages?: [...], goals?: [...], merge_existing?: {<fp>: <external_ref>}}
//              (source items in the contract's item shapes; `space` on a page and `status` on a goal are matched
//              by the tools' filters). Read once at start when there is no state file yet.
//     --state  JSON file the whole backend is loaded from (if it exists) and saved to after every tool call, so
//              a second process sees the first one's issues and verdicts.
//
// Exit codes: 0 stdin closed, 2 bad arguments, 3 a seed/state file is unreadable.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {Record<string, any>} Obj
 * @typedef {{ref: string, title: string, url: string, body: string, created_at?: string, updated_at?: string, labels?: string[], status?: string, space?: string}} SourceItem
 * @typedef {{fp: string, external_ref: string, external_url: string, record: Obj, pushes: number, run_ids: string[], status: string}} Issue
 * @typedef {{seq: number, fp: string, status: string, reason?: string, note?: string, merged_into?: string, decided_by: string, decided_at: string, external_ref: string}} Verdict
 * @typedef {{
 *   tickets: SourceItem[], pages: SourceItem[], goals: SourceItem[], merge_existing: Record<string, string>,
 *   projects: Record<string, {issues: Record<string, Issue>, verdicts: Verdict[]}>, next_issue: number, next_seq: number
 * }} Backend
 */

const SERVER = { name: 'dowser-forge-mock', version: '1' };
const BASE_URL = 'https://mock-forge.example/browse/';
const log = (/** @type {unknown[]} */ ...a) => console.error('[mock-forge]', ...a);

/** @returns {Backend} */
export const emptyBackend = () => ({ tickets: [], pages: [], goals: [], merge_existing: {}, projects: {}, next_issue: 1, next_seq: 1 });

/**
 * @param {Obj} seed
 * @returns {Backend}
 */
export function seeded(seed) {
  const b = emptyBackend();
  for (const k of /** @type {const} */ (['tickets', 'pages', 'goals'])) if (Array.isArray(seed[k])) b[k] = seed[k];
  if (seed.merge_existing && typeof seed.merge_existing === 'object') b.merge_existing = seed.merge_existing;
  return b;
}

const S = { type: 'string' };
const I = { type: 'integer', minimum: 1 };
/** Tool definitions (input schemas match docs/contracts/forge-mcp-1.md). */
export const TOOLS = [
  { name: 'dowser_sources_tickets', description: 'Search Jira tickets. Returns {items:[{ref,title,url,body,created_at,labels?}]}.',
    inputSchema: { type: 'object', properties: { query: S, since: S, limit: I }, required: ['query', 'limit'], additionalProperties: false } },
  { name: 'dowser_sources_pages', description: 'Search Confluence pages. Returns {items:[{ref,title,url,body,updated_at}]}.',
    inputSchema: { type: 'object', properties: { query: S, space: S }, required: ['query'], additionalProperties: false } },
  { name: 'dowser_sources_goals', description: 'List the team goals (TWG). Returns {items:[{ref,title,url,body,status?}]}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'dowser_proposals_push', description: 'Push dowser-proposal/1 records into the inbox; idempotent on (project_key, fp).',
    inputSchema: { type: 'object', properties: { project_key: S, run_id: S, proposals: { type: 'array', items: { type: 'object' } } }, required: ['project_key', 'run_id', 'proposals'], additionalProperties: false } },
  { name: 'dowser_verdicts_pull', description: 'Verdicts decided in Jira since the cursor. Returns {verdicts:[...], cursor}.',
    inputSchema: { type: 'object', properties: { project_key: S, cursor: S }, required: ['project_key'], additionalProperties: false } },
  { name: 'mock_decide', description: 'TEST ONLY: simulate a Jira verdict on a pushed fp.',
    inputSchema: { type: 'object', properties: { fp: S, status: { enum: ['accepted', 'rejected', 'merged', 'snoozed'] }, reason: S, note: S, merged_into: S, decided_by: S, project_key: S }, required: ['fp', 'status'], additionalProperties: false } },
];

/** A tool-level error (becomes `isError: true`). */
class ToolError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v.trim().length > 0;
/** @param {Obj} o @returns {Obj} */
const omitAbsent = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * Query terms: `a OR b`, quotes dropped, lowercased; an empty query matches everything.
 * @param {string} q
 * @returns {string[]}
 */
const terms = (q) => q.replace(/["']/g, ' ').split(/\s+OR\s+|\s+/).map((t) => t.trim().toLowerCase()).filter((t) => t && t !== 'or');

/**
 * @param {SourceItem} it
 * @param {string[]} ts
 */
const matches = (it, ts) => ts.length === 0 || ts.some((t) => `${it.title}\n${it.body}`.toLowerCase().includes(t));

/**
 * @param {Backend} b
 * @param {string} key
 */
const project = (b, key) => (b.projects[key] ??= { issues: {}, verdicts: [] });

/**
 * Runs one tool against the backend. Throws ToolError for a bad call.
 * @param {Backend} b
 * @param {string} name
 * @param {Obj} args
 * @returns {Obj}
 */
export function callTool(b, name, args) {
  switch (name) {
    case 'dowser_sources_tickets': {
      if (typeof args.query !== 'string') throw new ToolError('bad-input', 'query is required');
      if (!Number.isInteger(args.limit) || args.limit < 1) throw new ToolError('bad-input', 'limit is an integer >= 1');
      const ts = terms(args.query);
      const items = b.tickets
        .filter((t) => matches(t, ts) && (!str(args.since) || String(t.created_at ?? '') >= args.since))
        .slice(0, args.limit)
        .map((t) => omitAbsent({ ref: t.ref, title: t.title, url: t.url, body: t.body, created_at: t.created_at, labels: t.labels }));
      return { items };
    }
    case 'dowser_sources_pages': {
      if (typeof args.query !== 'string') throw new ToolError('bad-input', 'query is required');
      const ts = terms(args.query);
      const items = b.pages
        .filter((p) => matches(p, ts) && (!str(args.space) || p.space === args.space))
        .map((p) => omitAbsent({ ref: p.ref, title: p.title, url: p.url, body: p.body, updated_at: p.updated_at }));
      return { items };
    }
    case 'dowser_sources_goals':
      return { items: b.goals.map((g) => omitAbsent({ ref: g.ref, title: g.title, url: g.url, body: g.body, status: g.status })) };
    case 'dowser_proposals_push': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      if (!str(args.run_id)) throw new ToolError('bad-input', 'run_id is required');
      if (!Array.isArray(args.proposals)) throw new ToolError('bad-input', 'proposals is an array');
      const p = project(b, args.project_key);
      const results = args.proposals.map((/** @type {unknown} */ raw) => {
        const r = /** @type {Obj} */ (raw && typeof raw === 'object' ? raw : {});
        if (!str(r.fp)) return { fp: '', result: 'refused', why: 'missing fp' };
        if (!str(r.title) || !Array.isArray(r.evidence) || r.evidence.length === 0) return { fp: r.fp, result: 'refused', why: 'not a dowser-proposal/1 record (title and evidence are required)' };
        const existing = p.issues[r.fp];
        if (existing) {
          existing.record = r;
          existing.pushes++;
          if (!existing.run_ids.includes(args.run_id)) existing.run_ids.push(args.run_id);
          return { fp: r.fp, result: 'updated', external_ref: existing.external_ref, external_url: existing.external_url };
        }
        const into = b.merge_existing[r.fp];
        if (into) return { fp: r.fp, result: 'merged-existing', external_ref: into, external_url: BASE_URL + into };
        const ref = `DOW-${b.next_issue++}`;
        p.issues[r.fp] = { fp: r.fp, external_ref: ref, external_url: BASE_URL + ref, record: r, pushes: 1, run_ids: [args.run_id], status: 'open' };
        return { fp: r.fp, result: 'created', external_ref: ref, external_url: BASE_URL + ref };
      });
      return { results };
    }
    case 'dowser_verdicts_pull': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      if (args.cursor !== undefined && !/^\d+$/.test(String(args.cursor))) throw new ToolError('bad-cursor', `cursor ${JSON.stringify(args.cursor)} was not issued by this server`);
      const after = args.cursor === undefined ? 0 : Number(args.cursor);
      const p = project(b, args.project_key);
      const page = p.verdicts.filter((v) => v.seq > after);
      const last = page.length ? page[page.length - 1].seq : after;
      return { verdicts: page.map(({ seq, ...v }) => omitAbsent(v)), cursor: String(last) };
    }
    case 'mock_decide': {
      if (!str(args.fp)) throw new ToolError('bad-input', 'fp is required');
      if (!['accepted', 'rejected', 'merged', 'snoozed'].includes(args.status)) throw new ToolError('bad-input', 'status is accepted|rejected|merged|snoozed');
      const keys = str(args.project_key) ? [String(args.project_key)] : Object.keys(b.projects);
      const key = keys.find((k) => b.projects[k]?.issues[args.fp]);
      if (!key) throw new ToolError('not-found', `no pushed issue for fp ${args.fp}`);
      const p = b.projects[key];
      const issue = p.issues[args.fp];
      issue.status = args.status;
      const decidedAt = new Date(Date.now() + p.verdicts.length).toISOString();
      /** @type {Verdict} */
      const v = /** @type {Verdict} */ (omitAbsent({
        seq: b.next_seq++, fp: args.fp, status: args.status, reason: args.reason, note: args.note, merged_into: args.merged_into,
        decided_by: str(args.decided_by) ? args.decided_by : 'forge:mock-user', decided_at: decidedAt, external_ref: issue.external_ref,
      }));
      p.verdicts.push(v);
      const { seq, ...out } = v;
      return { verdict: out };
    }
    default:
      throw new ToolError('unknown-tool', `no tool ${name}`);
  }
}

/**
 * The MCP server loop over `input` / `output`.
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, backend: Backend, save?: (b: Backend) => void}} o
 * @returns {Promise<void>} resolves when input closes
 */
export function serve({ input, output, backend, save }) {
  const send = (/** @type {Obj} */ msg) => output.write(`${JSON.stringify(msg)}\n`);
  const reply = (/** @type {unknown} */ id, /** @type {Obj} */ result) => send({ jsonrpc: '2.0', id, result });
  const fail = (/** @type {unknown} */ id, /** @type {number} */ code, /** @type {string} */ message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  /** @param {Obj} msg */
  const handle = (msg) => {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize':
        return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER });
      case 'notifications/initialized': case 'notifications/cancelled': return undefined;
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: TOOLS });
      case 'tools/call': {
        if (typeof params?.name !== 'string') return fail(id, -32602, 'tools/call needs params.name');
        try {
          const out = callTool(backend, params.name, params.arguments ?? {});
          save?.(backend);
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          const err = { error: e.code, message: e.message };
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(err) }], structuredContent: err, isError: true });
        }
      }
      default:
        return isRequest ? fail(id, -32601, `method not found: ${method}`) : undefined;
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
    }
    try { handle(msg); } catch (e) {
      log('internal error', e);
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, /** @type {Error} */ (e).message);
    }
  });
  return new Promise((done) => rl.on('close', () => done()));
}

/**
 * @param {string} file
 * @returns {Obj}
 */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    log(`cannot read ${file}: ${/** @type {Error} */ (e).message}`);
    process.exit(3);
  }
}

/** @param {string[]} argv */
async function main(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--seed' || a === '--state') && argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[a.slice(2)] = argv[++i]; continue; }
    log(`unknown argument ${a}; usage: mock-forge-mcp.mjs [--seed <file>] [--state <file>]`);
    process.exit(2);
  }
  const stateFile = flags.state;
  /** @type {Backend} */
  const backend = stateFile && existsSync(stateFile)
    ? { ...emptyBackend(), .../** @type {Backend} */ (readJson(stateFile)) }
    : flags.seed ? seeded(readJson(flags.seed)) : emptyBackend();
  const save = stateFile ? (/** @type {Backend} */ b) => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(b, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  } : undefined;
  save?.(backend);
  log(`ready (${backend.tickets.length} tickets, ${backend.pages.length} pages, ${backend.goals.length} goals${stateFile ? `, state ${stateFile}` : ''})`);
  await serve({ input: process.stdin, output: process.stdout, backend, save });
}

if (process.argv[1] && isEntry(process.argv[1], import.meta.url)) await main(process.argv.slice(2));

/** @param {string} argv1 @param {string} url */
function isEntry(argv1, url) {
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(url)); } catch { return resolve(argv1) === fileURLToPath(url); }
}
