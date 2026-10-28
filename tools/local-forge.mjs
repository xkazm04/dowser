#!/usr/bin/env node
// @ts-check
// local-forge - the real Forge core (forge/src/core) on node:sqlite, so the skill and the Custom UI can run the
// whole loop on one machine without a Jira site. Unlike tools/mock-forge-mcp.mjs (a stand-in that reimplements
// the contract), every call here goes through the app's own dispatch door (core/app.mjs runTool/runResolver),
// over the app's own migrations; only the ports are local (tools/local-forge/ports.mjs): a SQLite file, a local
// Jira whose issues live in the same file, display names and scan sources from a seed.
//
//   node tools/local-forge.mjs [--db <file>] [--http <port>] [--stdio] [--seed <file>] [--account <id>] [--reset]
//     --db       SQLite file (default <os tmp>/dowser-local-forge/forge.db). Two processes may share one file.
//     --http     serve the resolvers on 127.0.0.1:<port> (0 picks a free port; the port is logged to stderr):
//                  POST /invoke {key, payload, module?}  -> the resolver's JSON (`via` is panel for module
//                                                          dowser-evidence, else inbox)
//                  POST /dev/jira-status {key, category: new|indeterminate|done, name?}  moves a local issue
//                  GET  /dev/state                       row counts per table
//                  GET  /browse/<key>                    a local Jira issue with its comments
//                CORS: any http://localhost / 127.0.0.1 origin.
//     --stdio    an MCP server on stdin/stdout (JSON-RPC 2.0, newline-delimited; framing as the mock): the seven
//                forge-mcp-2 tools. stdout carries protocol only; every log line goes to stderr.
//     --seed     JSON {tickets?, pages?, goals?, projects?: [{key, name, issue_types: [{id, name}]}], users?: {<accountId>: <name>}}
//                loaded on start (replaces seeded rows by key). Project DOW (issue type 10001) and the person
//                `local-user` -> "Local Operator" are always there.
//     --account  the Atlassian account id every call runs as (default local-user)
//     --reset    delete the db file first
//
// Exit codes: 0 stopped, 2 bad arguments, 3 the seed or the db is unusable.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES, runResolver, runTool } from '../forge/src/core/app.mjs';
import {
  DEFAULT_ACCOUNT, applySeed, issueOf, localJira, localSources, localUsers, openLocalDb, rowCounts, setIssueStatus,
} from './local-forge/ports.mjs';

/**
 * @typedef {import('../forge/src/core/ports.mjs').Deps} Deps
 * @typedef {Record<string, any>} Obj
 */

const SERVER = { name: 'dowser-forge-local', version: '2' };
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DB = join(tmpdir(), 'dowser-local-forge', 'forge.db');
/** Where the UI runs in `npm run local:ui` (vite's default port). */
export const UI_ORIGIN = 'http://127.0.0.1:5173';
const BODY_MAX = 5 * 1024 * 1024;
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const CATEGORIES = ['new', 'indeterminate', 'done'];
const log = (/** @type {unknown[]} */ ...a) => console.error('[local-forge]', ...a);

// tools/list: scalar input schemas (rovo:mcp allows no arrays), descriptions and properties from forge/manifest.yml.
const S = (/** @type {string} */ description) => ({ type: 'string', description });
const PK = S('The key Dowser derives from the repo origin.');
export const TOOLS = [
  { name: 'dowser_sources_tickets', description: 'Jira issues matching free text, as scan sources for a Dowser lens.',
    inputSchema: { type: 'object', properties: { query: S('Free text; OR between terms means any of them.'), since: S('ISO timestamp; only issues created at or after it.'),
      limit: { type: 'integer', minimum: 1, description: 'Maximum items, at least 1 (50 recommended).' } }, required: ['query', 'limit'], additionalProperties: false } },
  { name: 'dowser_sources_pages', description: 'Confluence pages matching free text, as scan sources for a Dowser lens.',
    inputSchema: { type: 'object', properties: { query: S('Free text.'), space: S('Confluence space key.') }, required: ['query'], additionalProperties: false } },
  { name: 'dowser_sources_goals', description: "The team's goals from Teamwork Graph, as scan sources for the Opportunity lens.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'dowser_proposals_push', description: 'File verified Dowser proposals in the triage inbox. Idempotent per project and fingerprint.',
    inputSchema: { type: 'object', properties: { project_key: PK, run_id: S('The Dowser run that pushed.'), proposals_json: S('JSON array of dowser-proposal/1 records, at most 50.'),
      repo_url: S('The repo web URL without credentials.'), head_sha: S('The commit the run scanned.') }, required: ['project_key', 'run_id', 'proposals_json'], additionalProperties: false } },
  { name: 'dowser_verdicts_pull', description: 'Triage decisions made in Jira since the cursor, oldest first.',
    inputSchema: { type: 'object', properties: { project_key: PK, cursor: S('The cursor from the previous pull; omit on the first pull.') }, required: ['project_key'], additionalProperties: false } },
  { name: 'dowser_areas_push', description: "Per-directory churn and author counts for the opportunity map. Replaces the project's previous set.",
    inputSchema: { type: 'object', properties: { project_key: PK, run_id: S('The Dowser run that measured the areas.'), areas_json: S('JSON array of at most 200 areas.') },
      required: ['project_key', 'run_id', 'areas_json'], additionalProperties: false } },
  { name: 'dowser_reflect_sync', description: "Offer the skill's learned rules and read back the rules decided in Jira and the outcomes of accepted items. Idempotent.",
    inputSchema: { type: 'object', properties: { project_key: PK, rules_json: S('JSON array of at most 50 offered rules with id and lens and text and offered_at and optional titles. Send an empty array to only read.') },
      required: ['project_key'], additionalProperties: false } },
];

/**
 * One core call at a time in this process: the Db port's `tx` holds the connection's transaction across
 * awaits, so nothing else on the connection may interleave with it.
 */
function serializer() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Builds the deps over a db file and returns them with the raw handle.
 * @param {{db: string, httpPort?: number, account?: string}} o
 */
export function localForge(o) {
  const { raw, db, ran } = openLocalDb(o.db);
  const now = () => new Date();
  /** The issue url names the HTTP port, known only once the server listens (`--http 0`). @type {{browseBase: string}} */
  const site = { browseBase: `http://127.0.0.1:${o.httpPort || 4710}/browse/` };
  /** @type {Deps} */
  const deps = {
    db, now, log: (line) => { console.error(line); },
    jira: localJira(raw, () => site.browseBase, now), users: localUsers(raw), sources: localSources(raw),
    links: { inboxUrl: async (ref) => `${UI_ORIGIN}/#inbox&ref=${encodeURIComponent(ref)}` },
  };
  const account = o.account ?? DEFAULT_ACCOUNT;
  const serial = serializer();
  return {
    raw, deps, ran, site, account,
    /** @param {string} name @param {unknown} args */
    tool: (name, args) => serial(() => runTool(deps, name, args, account)),
    /** @param {string} key @param {unknown} payload @param {'inbox' | 'panel'} via */
    resolver: (key, payload, via) => serial(() => runResolver(deps, key, payload, account, via)),
    close: () => { try { raw.close(); } catch { /* already closed */ } },
  };
}

/** @typedef {ReturnType<typeof localForge>} LocalForge */

// ------------------------------------------------------------------------------------------------- stdio

/**
 * The MCP server: JSON-RPC 2.0, one message per line (framing as tools/mock-forge-mcp.mjs).
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, forge: LocalForge}} o
 * @returns {Promise<void>} resolves when input closes
 */
export function serveStdio({ input, output, forge }) {
  const send = (/** @type {Obj} */ msg) => output.write(`${JSON.stringify(msg)}\n`);
  const reply = (/** @type {unknown} */ id, /** @type {Obj} */ result) => send({ jsonrpc: '2.0', id, result });
  const fail = (/** @type {unknown} */ id, /** @type {number} */ code, /** @type {string} */ message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  /** @param {Obj} msg */
  const handle = async (msg) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER });
      case 'notifications/initialized': case 'notifications/cancelled': return undefined;
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: TOOLS });
      case 'tools/call': {
        if (typeof params?.name !== 'string') return fail(id, -32602, 'tools/call needs params.name');
        if (!(/** @type {readonly string[]} */ (TOOL_NAMES)).includes(params.name)) return fail(id, -32602, `unknown tool ${params.name}`);
        const out = /** @type {Obj} */ (await forge.tool(params.name, params.arguments ?? {}));
        const isError = typeof out.error === 'string';
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, ...(isError ? { isError: true } : {}) });
      }
      default:
        return id !== undefined && id !== null ? fail(id, -32601, `method not found: ${method}`) : undefined;
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  /** @type {Promise<unknown>[]} */
  const inflight = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      return;
    }
    inflight.push(handle(msg).catch((e) => {
      log('internal error', e);
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, /** @type {Error} */ (e).message);
    }));
  });
  return new Promise((done) => rl.on('close', () => { Promise.allSettled(inflight).then(() => done()); }));
}

// -------------------------------------------------------------------------------------------------- http

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readBody(req) {
  return new Promise((done, fail) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > BODY_MAX) { fail(new Error('body larger than 5 MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { done(text.trim() ? JSON.parse(text) : {}); } catch { fail(new Error('body is not JSON')); }
    });
    req.on('error', fail);
  });
}

/**
 * The resolver door over HTTP, bound to 127.0.0.1.
 * @param {{forge: LocalForge, port: number}} o
 * @returns {Promise<import('node:http').Server>} once listening (the real port is `server.address().port`)
 */
export function serveHttp({ forge, port }) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    /** @type {Record<string, string>} */
    const cors = origin && LOCAL_ORIGIN_RE.test(origin)
      ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' }
      : {};
    const json = (/** @type {number} */ status, /** @type {unknown} */ body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(origin && !cors['access-control-allow-origin'] ? 403 : 204, cors); res.end(); return; }
      if (req.method === 'POST' && url.pathname === '/invoke') {
        const b = /** @type {Obj} */ (await readBody(req));
        if (!b || typeof b !== 'object' || typeof b.key !== 'string') return json(400, { error: 'bad-input', message: 'POST /invoke takes {key, payload, module?}' });
        const via = b.module === 'dowser-evidence' ? 'panel' : 'inbox';
        return json(200, await forge.resolver(b.key, b.payload ?? {}, via));
      }
      if (req.method === 'POST' && url.pathname === '/dev/jira-status') {
        const b = /** @type {Obj} */ (await readBody(req));
        if (typeof b?.key !== 'string' || !CATEGORIES.includes(b.category) || (b.name !== undefined && typeof b.name !== 'string')) {
          return json(400, { error: 'bad-input', message: 'POST /dev/jira-status takes {key, category: new|indeterminate|done, name?}' });
        }
        if (!setIssueStatus(forge.raw, b.key, b.category, b.name)) return json(404, { error: 'not-found', message: `no local issue ${b.key}` });
        return json(200, { issue: issueOf(forge.raw, b.key) });
      }
      if (req.method === 'GET' && url.pathname === '/dev/state') return json(200, { tables: rowCounts(forge.raw) });
      if (req.method === 'GET' && url.pathname.startsWith('/browse/')) {
        const issue = issueOf(forge.raw, decodeURIComponent(url.pathname.slice('/browse/'.length)));
        return issue ? json(200, { issue }) : json(404, { error: 'not-found', message: 'no such local issue' });
      }
      if (req.method === 'GET' && url.pathname === '/') return json(200, { server: SERVER, account: forge.account });
      return json(404, { error: 'not-found', message: `${req.method} ${url.pathname} is not served here` });
    } catch (e) {
      return json(400, { error: 'bad-input', message: /** @type {Error} */ (e).message });
    }
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(server); });
  });
}

// -------------------------------------------------------------------------------------------------- main

/** @param {string} child @param {string} parent */
const inside = (child, parent) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{db?: string, http?: number, stdio: boolean, seed?: string, account?: string, reset: boolean}} */
  const o = { stdio: false, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === '--stdio') o.stdio = true;
    else if (a === '--reset') o.reset = true;
    else if (a === '--db') o.db = val();
    else if (a === '--seed') o.seed = val();
    else if (a === '--account') o.account = val();
    else if (a === '--http') {
      const p = Number(val());
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('--http takes a port 0-65535');
      o.http = p;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!o.stdio && o.http === undefined) throw new Error('pass --stdio, --http <port>, or both');
  return o;
}

/** @param {string[]} argv */
async function main(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let o;
  try { o = parseArgs(argv); } catch (e) {
    log(`${/** @type {Error} */ (e).message}; usage: local-forge.mjs [--db <file>] [--http <port>] [--stdio] [--seed <file>] [--account <id>] [--reset]`);
    process.exit(2);
  }
  const db = resolve(o.db ?? DEFAULT_DB);
  if (inside(db, REPO_ROOT)) { log(`--db ${db} is inside the repository; keep the local Forge's data outside it`); process.exit(2); }
  if (o.reset) for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  mkdirSync(dirname(db), { recursive: true });
  /** @type {Obj | undefined} */
  let seed;
  if (o.seed) {
    try { seed = JSON.parse(readFileSync(o.seed, 'utf8')); } catch (e) { log(`cannot read ${o.seed}: ${/** @type {Error} */ (e).message}`); process.exit(3); }
  }
  /** @type {LocalForge} */
  let forge;
  try {
    forge = localForge({ db, httpPort: o.http, account: o.account });
    applySeed(forge.raw, seed);
  } catch (e) { log(`cannot open ${db}: ${/** @type {Error} */ (e).message}`); process.exit(3); }
  log(`db ${db}${forge.ran.length ? ` (migrated: ${forge.ran.join(', ')})` : ''}; account ${forge.account}`);
  const stop = () => { forge.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (o.http !== undefined) {
    const server = await serveHttp({ forge, port: o.http });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    forge.site.browseBase = `http://127.0.0.1:${port}/browse/`;
    log(`http listening on http://127.0.0.1:${port}`);
  }
  if (o.stdio) {
    log('mcp ready on stdio');
    await serveStdio({ input: process.stdin, output: process.stdout, forge });
    if (o.http === undefined) stop();
  }
}

/** @param {string} argv1 @param {string} url */
function isEntry(argv1, url) {
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(url)); } catch { return resolve(argv1) === fileURLToPath(url); }
}

if (process.argv[1] && existsSync(process.argv[1]) && isEntry(process.argv[1], import.meta.url)) await main(process.argv.slice(2));
