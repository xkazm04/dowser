#!/usr/bin/env node
// @ts-check
// mock-forge-mcp - a zero-dependency stdio MCP server that stands in for Dowser's Forge app (rovo:mcp), so the
// skill and its scripts are testable end to end without a Jira site. It implements the eight tools of
// docs/contracts/forge-mcp-2.md over an in-memory backend, plus four test-only tools: `mock_decide` simulates a
// person's verdict in the inbox, `mock_inbox` reads an inbox item back (its status and whether it reopened),
// `mock_decide_rule` simulates a person accepting or declining an offered rule in Forge, and `mock_outcome`
// simulates a person rating an accepted item's built result.
//
// Tool 7, `dowser_reflect_sync` {project_key, rules_json?}: rules_json (a JSON array of at most 50 RuleOffer
// {id, lens, text, titles?(<=10), offered_at}) is upserted - a new id is stored `offered`, an `offered` one takes
// the new text and titles, a decided one is never reverted - and the reply is {rules, outcomes}: every rule a
// person decided (RuleDecision) and the newest 200 outcomes (oldest first). Idempotent both ways.
//
// Tool 8, `dowser_direction_get` {project_key, lens?}: the lens direction a team set in Settings, from the seed's
// `directions` - {lenses: {[lens]: {focus?, exclude?, notes?, spaces?}}}; `lens` (one id, or `all`) narrows it.
// A project with neither items nor a seeded direction is `unknown-project`, as in Forge.
//
// forge-mcp-2 semantics mirrored here: tool inputs are scalar (array inputs arrive as `*_json` strings, as a
// rovo:mcp tool requires); a push files the proposal as an inbox item `DW-<n>` (`external_ref`) and creates no
// Jira issue; an `accepted` decision fabricates the Jira issue (`issue_ref` MOCK-<n>, `issue_url`) and the
// verdict carries it. A re-push unites evidence by evidence key (skill/scripts/lib/fingerprint.mjs evidenceKey)
// and reopens a snoozed item on any new key, a rejected one under the store's resurfacing rule
// (skill/scripts/lib/model.mjs resurfaces); an accepted or merged item only gains evidence.
//
// Framing copied from bp's apps/mcp/bp-mcp.mjs: JSON-RPC 2.0 over newline-delimited stdin/stdout, Node builtins
// only (no SDK); stdout carries protocol only, logs go to stderr. Methods: initialize (echoes the client's
// protocolVersion), notifications/initialized, ping, tools/list, tools/call. A tool result carries the JSON both as
// `structuredContent` and as one text content item; a bad call is `isError: true` with `{error, message}`.
//
//   node tools/mock-forge-mcp.mjs [--seed <file>] [--state <file>]
//     --seed   JSON {tickets?: [...], pages?: [...], goals?: [...], merge_existing?: {<fp>: <external_ref>},
//              directions?: {<project_key>: {lenses: {[lens]: LensDirection}}}}
//              (source items in the contract's item shapes; `space` on a page and `status` on a goal are matched
//              by the tools' filters). Read once at start when there is no state file yet.
//     --state  JSON file the whole backend is loaded from (if it exists) and saved to after every tool call, so
//              a second process sees the first one's items and verdicts.
//
// Exit codes: 0 stdin closed, 2 bad arguments, 3 a seed/state file is unreadable.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceKey } from '../skill/scripts/lib/fingerprint.mjs';
import { LENSES, resurfaces } from '../skill/scripts/lib/model.mjs';

/**
 * @typedef {Record<string, any>} Obj
 * @typedef {{ref: string, title: string, url: string, body: string, created_at?: string, updated_at?: string, labels?: string[], components?: string[], status?: string, space?: string}} SourceItem
 * @typedef {{type: string, key: string}} EvidenceId
 * @typedef {{refs: number, types: string[]}} Snapshot
 * @typedef {{fp: string, external_ref: string, external_url: string, record: Obj, evidence: EvidenceId[], pushes: number,
 *   run_ids: string[], status: string, reopened?: boolean, decided_snapshot?: Snapshot, issue_ref?: string, issue_url?: string,
 *   repo_url?: string, head_sha?: string}} Item
 * @typedef {{seq: number, fp: string, status: string, reason?: string, note?: string, merged_into?: string, decided_by: string,
 *   decided_at: string, external_ref: string, issue_ref?: string, issue_url?: string}} Verdict
 * @typedef {{path: string, files: number, churn_90d: number, authors_90d?: number, last_change?: string}} Area
 * @typedef {{id: string, lens: string, text: string, titles?: string[], offered_at: string, state: 'offered' | 'accepted' | 'declined',
 * decided_by?: string, decided_at?: string}} RuleRecord
 * @typedef {{ref: string, fp: string, rating: string, note?: string, issue_ref: string, decided_by: string, recorded_at: string}} OutcomeRecord
 * @typedef {{items: Record<string, Item>, verdicts: Verdict[], areas: Area[], areas_run_id?: string,
 *   rules?: Record<string, RuleRecord>, outcomes?: OutcomeRecord[]}} Project
 * @typedef {{
 *   tickets: SourceItem[], pages: SourceItem[], goals: SourceItem[], merge_existing: Record<string, string>,
 *   projects: Record<string, Project>, next_item: number, next_issue: number, next_seq: number,
 *   directions: Record<string, {lenses: Record<string, Obj>}>
 * }} Backend
 */

const SERVER = { name: 'dowser-forge-mock', version: '2' };
const INBOX_URL = 'https://mock-forge.example/jira/apps/dowser/inbox/';
const JIRA_URL = 'https://mock-forge.example/browse/';
/** forge-mcp-2 caps: records per push, areas per areas push, parsed size of a `*_json` input. */
const PUSH_MAX = 50;
const AREAS_MAX = 200;
const JSON_MAX = 4 * 1024 * 1024;
const RULES_MAX = 50;
const TITLES_MAX = 10;
const OUTCOMES_MAX = 200;
const RATINGS = ['right', 'partly', 'wrong'];
/** @type {readonly string[]} */
const LENS_IDS = LENSES;
const log = (/** @type {unknown[]} */ ...a) => console.error('[mock-forge]', ...a);

/** @returns {Backend} */
export const emptyBackend = () => ({ tickets: [], pages: [], goals: [], merge_existing: {}, projects: {}, next_item: 1, next_issue: 1, next_seq: 1, directions: {} });

/**
 * @param {Obj} seed
 * @returns {Backend}
 */
export function seeded(seed) {
  const b = emptyBackend();
  for (const k of /** @type {const} */ (['tickets', 'pages', 'goals'])) if (Array.isArray(seed[k])) b[k] = seed[k];
  if (seed.merge_existing && typeof seed.merge_existing === 'object') b.merge_existing = seed.merge_existing;
  if (isObj(seed.directions)) b.directions = seed.directions;
  return b;
}

// Input schemas are scalar only (string / integer), as a Forge rovo:mcp tool requires.
const S = { type: 'string' };
const I = { type: 'integer', minimum: 1 };
/** Tool definitions (input schemas match docs/contracts/forge-mcp-2.md). */
export const TOOLS = [
  { name: 'dowser_sources_tickets', description: 'Search Jira tickets. Returns {items:[{ref,title,url,body,created_at,labels?}]}.',
    inputSchema: { type: 'object', properties: { query: S, since: S, limit: I }, required: ['query', 'limit'], additionalProperties: false } },
  { name: 'dowser_sources_pages', description: 'Search Confluence pages. Returns {items:[{ref,title,url,body,updated_at}]}.',
    inputSchema: { type: 'object', properties: { query: S, space: S }, required: ['query'], additionalProperties: false } },
  { name: 'dowser_sources_goals', description: 'List the team goals (TWG). Returns {items:[{ref,title,url,body,status?}]}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'dowser_proposals_push', description: 'File dowser-proposal/1 records (proposals_json, a JSON array of at most 50) in the Dowser inbox; idempotent on (project_key, fp). Returns {results:[{fp,result,external_ref?,external_url?,why?}]}.',
    inputSchema: { type: 'object', properties: { project_key: S, run_id: S, proposals_json: S, repo_url: S, head_sha: S }, required: ['project_key', 'run_id', 'proposals_json'], additionalProperties: false } },
  { name: 'dowser_verdicts_pull', description: 'Verdicts decided in the inbox since the cursor. Returns {verdicts:[...], cursor}.',
    inputSchema: { type: 'object', properties: { project_key: S, cursor: S }, required: ['project_key'], additionalProperties: false } },
  { name: 'dowser_areas_push', description: 'Replace the project\'s area stats (areas_json, a JSON array of at most 200 {path,files,churn_90d,authors_90d?,last_change?}). Returns {stored}.',
    inputSchema: { type: 'object', properties: { project_key: S, run_id: S, areas_json: S }, required: ['project_key', 'run_id', 'areas_json'], additionalProperties: false } },
  { name: 'dowser_reflect_sync', description: 'Offer rules (rules_json, a JSON array of at most 50 {id,lens,text,titles?,offered_at}) and read back every rule a person decided plus the newest 200 outcomes. Idempotent. Returns {rules:[{id,lens,state,text,decided_by,decided_at}], outcomes:[{ref,fp,rating,note?,issue_ref,decided_by,recorded_at}]}.',
    inputSchema: { type: 'object', properties: { project_key: S, rules_json: S }, required: ['project_key'], additionalProperties: false } },
  { name: 'dowser_direction_get', description: 'What the team set in Settings for each lens of this inbox (lens = one lens id, or all). Returns {lenses:{[lens]:{focus?,exclude?,notes?,spaces?}}}.',
    inputSchema: { type: 'object', properties: { project_key: S, lens: S }, required: ['project_key'], additionalProperties: false } },
  { name: 'mock_decide', description: 'TEST ONLY: simulate a person\'s verdict in the inbox on a pushed fp (status accepted|rejected|merged|snoozed).',
    inputSchema: { type: 'object', properties: { fp: S, status: S, reason: S, note: S, merged_into: S, decided_by: S, project_key: S }, required: ['fp', 'status'], additionalProperties: false } },
  { name: 'mock_decide_rule', description: 'TEST ONLY: simulate a person accepting or declining an offered rule in Forge (state accepted|declined, text = the edited wording).',
    inputSchema: { type: 'object', properties: { project_key: S, id: S, state: S, text: S, decided_by: S }, required: ['project_key', 'id', 'state'], additionalProperties: false } },
  { name: 'mock_outcome', description: 'TEST ONLY: simulate a person rating the built result of an accepted item (ref = its inbox ref DW-n; rating right|partly|wrong).',
    inputSchema: { type: 'object', properties: { ref: S, rating: S, note: S, project_key: S, decided_by: S }, required: ['ref', 'rating'], additionalProperties: false } },
  { name: 'mock_inbox', description: 'TEST ONLY: read one inbox item back. Returns {item:{fp,external_ref,status,reopened?,evidence,pushes,issue_ref?,issue_url?}}.',
    inputSchema: { type: 'object', properties: { fp: S, project_key: S }, required: ['fp'], additionalProperties: false } },
];

/** A tool-level error (becomes `isError: true`). */
class ToolError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v.trim().length > 0;
/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
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
 * @returns {Project}
 */
const project = (b, key) => {
  const p = (b.projects[key] ??= { items: {}, verdicts: [], areas: [] });
  p.items ??= {};
  p.areas ??= [];
  p.rules ??= {};
  p.outcomes ??= [];
  return p;
};

/**
 * Parses a `*_json` string input into an array, or throws `bad-input`.
 * @param {unknown} v
 * @param {string} name
 * @param {number} max
 * @returns {unknown[]}
 */
function jsonArray(v, name, max) {
  if (typeof v !== 'string') throw new ToolError('bad-input', `${name} is a string holding a JSON array`);
  if (Buffer.byteLength(v, 'utf8') > JSON_MAX) throw new ToolError('bad-input', `${name} is larger than 4 MB`);
  /** @type {unknown} */
  let doc;
  try { doc = JSON.parse(v); } catch (e) { throw new ToolError('bad-input', `${name} does not parse as JSON (${/** @type {Error} */ (e).message})`); }
  if (!Array.isArray(doc)) throw new ToolError('bad-input', `${name} must hold a JSON array`);
  if (doc.length > max) throw new ToolError('bad-input', `${name} holds ${doc.length} items; at most ${max}`);
  return doc;
}

/**
 * The evidence snapshot of an item: distinct evidence keys and the sorted evidence types.
 * @param {EvidenceId[]} ev
 * @returns {Snapshot}
 */
const snapshot = (ev) => ({ refs: ev.length, types: [...new Set(ev.map((e) => e.type))].sort() });

/**
 * Unites `record.evidence` into the item's evidence by evidence key. Returns the number of new keys.
 * @param {Item} item
 * @param {Obj} record
 * @returns {number}
 */
function uniteEvidence(item, record) {
  let added = 0;
  for (const e of /** @type {Obj[]} */ (record.evidence)) {
    if (!isObj(e) || !str(e.type) || !str(e.ref)) continue;
    const key = evidenceKey(/** @type {{type: string, ref: string, quote?: string}} */ (e)).key;
    if (item.evidence.some((x) => x.type === e.type && x.key === key)) continue;
    item.evidence.push({ type: e.type, key });
    added++;
  }
  return added;
}

/**
 * Validates one `areas_json` element per the contract table, or throws `bad-input`.
 * @param {unknown} raw
 * @param {number} i
 * @returns {Area}
 */
function checkArea(raw, i) {
  const at = `areas_json[${i}]`;
  if (!isObj(raw)) throw new ToolError('bad-input', `${at} is an object`);
  const extra = Object.keys(raw).find((k) => !['path', 'files', 'churn_90d', 'authors_90d', 'last_change'].includes(k));
  if (extra) throw new ToolError('bad-input', `${at}: unknown field ${extra}`);
  const { path, files, churn_90d: churn, authors_90d: authors, last_change: last } = raw;
  if (typeof path !== 'string' || !/^[^/\\]+(\/[^/\\]+)?$/.test(path) || path === '.' || path === '..' || /(^|\/)\.\.?$/.test(path)) {
    throw new ToolError('bad-input', `${at}.path is a repo-relative directory at most two levels deep, forward slashes, no trailing slash`);
  }
  if (!Number.isInteger(files) || files < 1) throw new ToolError('bad-input', `${at}.files is an integer >= 1`);
  if (!Number.isInteger(churn) || churn < 0) throw new ToolError('bad-input', `${at}.churn_90d is an integer >= 0`);
  if (authors !== undefined) {
    if (churn === 0) throw new ToolError('bad-input', `${at}.authors_90d is omitted when churn_90d is 0`);
    if (!Number.isInteger(authors) || authors < 1) throw new ToolError('bad-input', `${at}.authors_90d is an integer >= 1`);
  }
  if (last !== undefined && (typeof last !== 'string' || Number.isNaN(Date.parse(last)))) throw new ToolError('bad-input', `${at}.last_change is an ISO timestamp`);
  return /** @type {Area} */ (omitAbsent({ path, files, churn_90d: churn, authors_90d: authors, last_change: last }));
}

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
        .map((t) => omitAbsent({ ref: t.ref, title: t.title, url: t.url, body: t.body, created_at: t.created_at, labels: t.labels, components: t.components }));
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
      for (const k of ['repo_url', 'head_sha']) if (args[k] !== undefined && !str(args[k])) throw new ToolError('bad-input', `${k} is a non-empty string (omit it when absent)`);
      const records = jsonArray(args.proposals_json, 'proposals_json', PUSH_MAX);
      const p = project(b, args.project_key);
      const results = records.map((raw) => {
        const r = isObj(raw) ? raw : {};
        if (!str(r.fp)) return { fp: '', result: 'refused', why: 'missing fp' };
        if (!str(r.title) || !Array.isArray(r.evidence) || r.evidence.length === 0) return { fp: r.fp, result: 'refused', why: 'not a dowser-proposal/1 record (title and evidence are required)' };
        if (r.status !== 'verified' && r.status !== 'pushed') return { fp: r.fp, result: 'refused', why: `only verified or pushed records are filed, not ${String(r.status)}` };
        const existing = p.items[r.fp];
        if (existing) {
          existing.record = r;
          existing.pushes++;
          if (!existing.run_ids.includes(args.run_id)) existing.run_ids.push(args.run_id);
          if (str(args.repo_url)) existing.repo_url = args.repo_url;
          if (str(args.head_sha)) existing.head_sha = args.head_sha;
          const before = snapshot(existing.evidence);
          const grew = uniteEvidence(existing, r) > 0;
          // reopen on growth: snoozed on any new key; rejected only under the store's resurfacing rule
          if (grew && existing.status === 'snoozed') { existing.status = 'open'; existing.reopened = true; }
          if (grew && existing.status === 'rejected' && resurfaces('rejected', existing.decided_snapshot ?? before, snapshot(existing.evidence)).resurface) {
            existing.status = 'open';
            existing.reopened = true;
          }
          return { fp: r.fp, result: 'updated', external_ref: existing.external_ref, external_url: existing.external_url };
        }
        const into = b.merge_existing[r.fp];
        if (into) return { fp: r.fp, result: 'merged-existing', external_ref: into, external_url: INBOX_URL + into };
        const ref = `DW-${b.next_item++}`;
        /** @type {Item} */
        const item = /** @type {Item} */ (omitAbsent({
          fp: r.fp, external_ref: ref, external_url: INBOX_URL + ref, record: r, evidence: [], pushes: 1, run_ids: [args.run_id],
          status: 'open', repo_url: str(args.repo_url) ? args.repo_url : undefined, head_sha: str(args.head_sha) ? args.head_sha : undefined,
        }));
        uniteEvidence(item, r);
        p.items[r.fp] = item;
        return { fp: r.fp, result: 'created', external_ref: ref, external_url: INBOX_URL + ref };
      });
      return { results };
    }
    case 'dowser_verdicts_pull': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      const p = project(b, args.project_key);
      const max = p.verdicts.length ? p.verdicts[p.verdicts.length - 1].seq : 0;
      if (args.cursor !== undefined && (!/^\d+$/.test(String(args.cursor)) || Number(args.cursor) > max)) {
        throw new ToolError('bad-cursor', `cursor ${JSON.stringify(args.cursor)} was not issued by this server`);
      }
      const after = args.cursor === undefined ? 0 : Number(args.cursor);
      const page = p.verdicts.filter((v) => v.seq > after);
      const last = page.length ? page[page.length - 1].seq : after;
      return { verdicts: page.map(({ seq, ...v }) => omitAbsent(v)), cursor: String(last) };
    }
    case 'dowser_areas_push': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      if (!str(args.run_id)) throw new ToolError('bad-input', 'run_id is required');
      const list = jsonArray(args.areas_json, 'areas_json', AREAS_MAX).map(checkArea);
      const paths = new Set(list.map((a) => a.path));
      if (paths.size !== list.length) throw new ToolError('bad-input', 'areas_json lists a path twice');
      const p = project(b, args.project_key);
      p.areas = list; // the set replaces the previous one whole
      p.areas_run_id = args.run_id;
      return { stored: list.length };
    }
    case 'dowser_reflect_sync': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      const offers = args.rules_json === undefined ? [] : jsonArray(args.rules_json, 'rules_json', RULES_MAX);
      const p = project(b, args.project_key);
      const rules = /** @type {Record<string, RuleRecord>} */ (p.rules);
      offers.forEach((raw, i) => {
        const at = `rules_json[${i}]`;
        if (!isObj(raw)) throw new ToolError('bad-input', `${at} is an object`);
        for (const k of ['id', 'lens', 'text', 'offered_at']) if (!str(raw[k])) throw new ToolError('bad-input', `${at}.${k} is required`);
        if (raw.titles !== undefined && (!Array.isArray(raw.titles) || raw.titles.length > TITLES_MAX || raw.titles.some((/** @type {unknown} */ t) => !str(t)))) {
          throw new ToolError('bad-input', `${at}.titles is at most ${TITLES_MAX} non-empty strings`);
        }
      });
      for (const raw of /** @type {Obj[]} */ (offers)) {
        const cur = rules[raw.id];
        if (cur && cur.state !== 'offered') continue; // a decided rule is never reverted
        rules[raw.id] = /** @type {RuleRecord} */ (omitAbsent({ id: raw.id, lens: raw.lens, text: raw.text, titles: raw.titles, offered_at: raw.offered_at, state: 'offered' }));
      }
      const decided = Object.values(rules).filter((r) => r.state !== 'offered')
        .sort((x, y) => String(x.decided_at).localeCompare(String(y.decided_at)) || x.id.localeCompare(y.id))
        .map((r) => omitAbsent({ id: r.id, lens: r.lens, state: r.state, text: r.text, decided_by: r.decided_by, decided_at: r.decided_at }));
      const outcomes = /** @type {OutcomeRecord[]} */ (p.outcomes).slice(-OUTCOMES_MAX).map((o) => omitAbsent(o));
      return { rules: decided, outcomes };
    }
    case 'dowser_direction_get': {
      if (!str(args.project_key)) throw new ToolError('bad-input', 'project_key is required');
      const lens = str(args.lens) ? String(args.lens) : 'all';
      if (lens !== 'all' && !LENS_IDS.includes(lens)) throw new ToolError('bad-input', `lens is all or one of ${LENS_IDS.join(', ')}`);
      const seededDir = (b.directions ?? {})[args.project_key];
      if (!seededDir && !b.projects[args.project_key]) throw new ToolError('unknown-project', `no inbox for project ${args.project_key}; push proposals first`);
      const all = isObj(seededDir?.lenses) ? seededDir.lenses : {};
      const lenses = Object.fromEntries(Object.entries(all).filter(([l]) => lens === 'all' || l === lens));
      return { lenses };
    }
    case 'mock_decide_rule': {
      if (!str(args.project_key) || !str(args.id)) throw new ToolError('bad-input', 'project_key and id are required');
      if (args.state !== 'accepted' && args.state !== 'declined') throw new ToolError('bad-input', 'state is accepted|declined');
      const p = project(b, args.project_key);
      const rule = /** @type {Record<string, RuleRecord>} */ (p.rules)[args.id];
      if (!rule) throw new ToolError('bad-input', `no rule ${args.id} offered in ${args.project_key}`);
      if (rule.state !== 'offered') throw new ToolError('bad-input', `rule ${args.id} is already ${rule.state}`);
      rule.state = args.state;
      if (args.state === 'accepted' && str(args.text)) rule.text = args.text.trim();
      rule.decided_by = str(args.decided_by) ? args.decided_by : 'forge:mock-user';
      rule.decided_at = new Date(Date.now() + b.next_seq++).toISOString();
      return { rule: omitAbsent({ id: rule.id, lens: rule.lens, state: rule.state, text: rule.text, decided_by: rule.decided_by, decided_at: rule.decided_at }) };
    }
    case 'mock_outcome': {
      if (!str(args.ref)) throw new ToolError('bad-input', 'ref is required');
      if (!RATINGS.includes(args.rating)) throw new ToolError('bad-input', `rating is ${RATINGS.join('|')}`);
      const keys = str(args.project_key) ? [String(args.project_key)] : Object.keys(b.projects);
      const key = keys.find((k) => Object.values(b.projects[k]?.items ?? {}).some((it) => it.external_ref === args.ref));
      if (!key) throw new ToolError('bad-input', `no inbox item ${args.ref}`);
      const item = Object.values(b.projects[key].items).find((it) => it.external_ref === args.ref);
      if (!item || item.status !== 'accepted' || !item.issue_ref) throw new ToolError('bad-input', `${args.ref} is not an accepted item with a Jira issue`);
      const p = project(b, key);
      const recordedAt = new Date(Date.now() + b.next_seq++).toISOString();
      const o = /** @type {OutcomeRecord} */ (omitAbsent({
        ref: item.external_ref, fp: item.fp, rating: args.rating, note: str(args.note) ? args.note : undefined, issue_ref: item.issue_ref,
        decided_by: str(args.decided_by) ? args.decided_by : 'forge:mock-user', recorded_at: recordedAt,
      }));
      /** @type {OutcomeRecord[]} */ (p.outcomes).push(o);
      return { outcome: o };
    }
    case 'mock_decide': {
      if (!str(args.fp)) throw new ToolError('bad-input', 'fp is required');
      if (!['accepted', 'rejected', 'merged', 'snoozed'].includes(args.status)) throw new ToolError('bad-input', 'status is accepted|rejected|merged|snoozed');
      const keys = str(args.project_key) ? [String(args.project_key)] : Object.keys(b.projects);
      const key = keys.find((k) => b.projects[k]?.items?.[args.fp]);
      if (!key) throw new ToolError('bad-input', `no inbox item for fp ${args.fp}`);
      const p = b.projects[key];
      const item = p.items[args.fp];
      item.status = args.status;
      delete item.reopened;
      if (args.status === 'rejected') item.decided_snapshot = snapshot(item.evidence);
      if (args.status === 'accepted') {
        // an accept creates the Jira issue first; the verdict carries it
        const issue = `MOCK-${b.next_issue++}`;
        item.issue_ref = issue;
        item.issue_url = JIRA_URL + issue;
      }
      const decidedAt = new Date(Date.now() + p.verdicts.length).toISOString();
      /** @type {Verdict} */
      const v = /** @type {Verdict} */ (omitAbsent({
        seq: b.next_seq++, fp: args.fp, status: args.status, reason: args.reason, note: args.note, merged_into: args.merged_into,
        decided_by: str(args.decided_by) ? args.decided_by : 'forge:mock-user', decided_at: decidedAt, external_ref: item.external_ref,
        issue_ref: args.status === 'accepted' ? item.issue_ref : undefined, issue_url: args.status === 'accepted' ? item.issue_url : undefined,
      }));
      p.verdicts.push(v);
      const { seq, ...out } = v;
      return { verdict: out };
    }
    case 'mock_inbox': {
      if (!str(args.fp)) throw new ToolError('bad-input', 'fp is required');
      const keys = str(args.project_key) ? [String(args.project_key)] : Object.keys(b.projects);
      const key = keys.find((k) => b.projects[k]?.items?.[args.fp]);
      if (!key) throw new ToolError('bad-input', `no inbox item for fp ${args.fp}`);
      const it = b.projects[key].items[args.fp];
      return { item: omitAbsent({ fp: it.fp, external_ref: it.external_ref, status: it.status, reopened: it.reopened, evidence: it.evidence.length, pushes: it.pushes, issue_ref: it.issue_ref, issue_url: it.issue_url }) };
    }
    default:
      throw new ToolError('bad-input', `no tool ${name}`);
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
