// @ts-check
// In-memory ports for the core tests: the Db port over node:sqlite running the real migrations (the core SQL
// is written to be portable between SQLite and MySQL/TiDB), a fake Jira, fixed links and a controllable clock.
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from '../src/shared/fingerprint.mjs';
import { DUPLICATE_RE, DuplicateKey } from '../src/core/util.mjs';
import { MIGRATIONS } from '../src/sql/migrations.mjs';

/**
 * @typedef {import('../src/core/ports.mjs').Db} Db
 * @typedef {import('../src/core/ports.mjs').Deps} Deps
 * @typedef {import('../src/core/ports.mjs').AdfDoc} AdfDoc
 */

export const ME_ID = '712020:7d1c-person';
export const ME = ME_ID;

/** @param {unknown} v */
const bind = (v) => (typeof v === 'boolean' ? Number(v) : /** @type {any} */ (v));

/**
 * @returns {Db & {raw: DatabaseSync, failNext?: RegExp}}
 */
export function sqliteDb() {
  const raw = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) raw.exec(m.statement);
  /** @type {Db & {raw: DatabaseSync, failNext?: RegExp}} */
  const db = {
    raw,
    async query(sql, params = []) {
      return /** @type {any[]} */ (raw.prepare(sql).all(...params.map(bind))).map((r) => ({ ...r }));
    },
    async exec(sql, params = []) {
      if (db.failNext && db.failNext.test(sql)) { db.failNext = undefined; throw new Error('injected failure'); }
      try {
        const r = raw.prepare(sql).run(...params.map(bind));
        return { affectedRows: Number(r.changes) };
      } catch (e) {
        const msg = /** @type {Error} */ (e).message;
        if (DUPLICATE_RE.test(msg)) throw new DuplicateKey(msg);
        throw e;
      }
    },
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return db;
}

/**
 * A fake Jira that records calls; `fail = true` makes every write throw.
 */
export function fakeJira() {
  const j = {
    fail: false,
    /** `true` makes issueStatuses throw (Jira unreadable). */
    failStatus: false,
    n: 40,
    /** @type {Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>} */
    statuses: {},
    /** @type {{projectKey: string, issueTypeId: string, summary: string, description: AdfDoc}[]} */
    created: [],
    /** @type {{issueKey: string, body: AdfDoc}[]} */
    comments: [],
    /** @param {{projectKey: string, issueTypeId: string, summary: string, description: AdfDoc}} f */
    async createIssue(f) {
      if (j.fail) throw new Error('Jira answered 503');
      j.created.push(f);
      const key = `${f.projectKey}-${++j.n}`;
      j.statuses[key] = { name: 'To Do', category: 'new' };
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    /** @param {string} issueKey @param {AdfDoc} body */
    async addComment(issueKey, body) {
      if (j.fail) throw new Error('Jira answered 503');
      j.comments.push({ issueKey, body });
    },
    /** Moves an issue to Done in the fake. @param {string} key */
    setDone(key) { j.statuses[key] = { name: 'Done', category: 'done' }; },
    /** @param {string[]} keys */
    async issueStatuses(keys) {
      if (j.failStatus) throw new Error('Jira answered 503');
      /** @type {Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>} */
      const out = {};
      for (const k of keys) if (j.statuses[k]) out[k] = j.statuses[k];
      return out;
    },
    async listProjects() { return [{ key: 'SHOP', name: 'Shop', issue_types: [{ id: '10001', name: 'Story' }] }]; },
  };
  return j;
}

/** A fake directory: account id -> display name; `fail = true` makes it throw. */
export function fakeUsers() {
  const u = {
    fail: false,
    /** @type {Record<string, string>} */
    directory: { [ME_ID]: 'Pat Person' },
    /** @type {string[][]} */
    calls: [],
    /** @param {string[]} ids */
    async names(ids) {
      u.calls.push(ids);
      if (u.fail) throw new Error('Jira answered 500');
      return Object.fromEntries(ids.filter((i) => u.directory[i]).map((i) => [i, u.directory[i]]));
    },
  };
  return u;
}

/**
 * A fake Perms port: every permission is granted unless `deny` holds it, as `KEY` (everywhere, e.g. ADMINISTER)
 * or `KEY:<project or issue key>` (e.g. BROWSE_PROJECTS:SHOP). `calls` records each lookup; `fail = true` throws.
 */
export function fakePerms() {
  const p = {
    fail: false,
    /** @type {Set<string>} */
    deny: new Set(),
    /** @type {{keys: string[], on?: {projectKey?: string, issueKey?: string}}[]} */
    calls: [],
    /** @param {string[]} keys @param {{projectKey?: string, issueKey?: string}} [on] */
    async mine(keys, on) {
      p.calls.push({ keys, on });
      if (p.fail) throw new Error('Jira answered 503');
      const where = on?.projectKey ?? on?.issueKey;
      return Object.fromEntries(keys.map((k) => [k, !p.deny.has(k) && !(where && p.deny.has(`${k}:${where}`))]));
    },
  };
  return p;
}

/** A clock the test moves. */
export function clock(start = '2026-10-27T10:00:00.000Z') {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    /** @param {number} ms */
    tick(ms = 1000) { t += ms; },
  };
}

/**
 * Deps over fresh in-memory ports.
 * @returns {Deps & {db: ReturnType<typeof sqliteDb>, jira: ReturnType<typeof fakeJira>, users: ReturnType<typeof fakeUsers>, perms: ReturnType<typeof fakePerms>, logs: string[], clock: ReturnType<typeof clock>}}
 */
export function makeDeps() {
  const c = clock();
  const db = sqliteDb();
  const jira = fakeJira();
  const users = fakeUsers();
  const perms = fakePerms();
  /** @type {string[]} */
  const logs = [];
  return {
    db, jira, users, perms, logs, clock: c, now: c.now, log: (/** @type {string} */ l) => { logs.push(l); },
    links: { inboxUrl: async (ref) => `https://acme.atlassian.net/jira/apps/app/env/inbox?ref=${ref}` },
    sources: {
      tickets: async () => [],
      pages: async () => [],
      goals: async () => [],
    },
  };
}

const BODY = '## Summary\nAdd CSV export.\n\n## Description\nUsers ask for `csv`.\n\n## Flow\n- open report\n- click export\n\n## Expected impact\nFewer tickets.\n\n## Evaluation\nCount exports.';

/**
 * A valid `dowser-proposal/1` record with a correct fp.
 * @param {{topic?: string, lens?: string, kind?: string, anchors?: string[], evidence?: {type: string, ref: string, quote?: string, url?: string}[], status?: string, confidence?: string, doc_impact?: string[]}} [o]
 */
export function record(o = {}) {
  const lens = o.lens ?? 'opportunity';
  const kind = o.kind ?? 'missing-capability';
  const topic = o.topic ?? 'csv export';
  const anchors = o.anchors ?? ['src/reports/export.js#exportReport'];
  const fp = fingerprint({ lens, kind, topic, anchors }, [kind]);
  return {
    fp, lens, kind, topic, anchors,
    title: `Add ${topic}`, rationale: `Customers keep asking for ${topic}.`, body: BODY,
    evidence: o.evidence ?? [{ type: 'code', ref: 'src/reports/export.js:12', quote: 'export function exportReport() {' }],
    effort: { size: 'S', basis: ['one module'] }, confidence: o.confidence ?? 'medium', confidence_why: 'two sources agree',
    ...(o.doc_impact ? { doc_impact: o.doc_impact } : {}),
    delivery_risk: { blast: 'low' },
    provenance: { lens_version: '1' },
    status: o.status ?? 'verified',
  };
}

/**
 * The push tool arguments for `records`.
 * @param {unknown[]} records
 * @param {{project_key?: string, run_id?: string, head_sha?: string, repo_url?: string}} [o]
 */
export const pushArgs = (records, o = {}) => ({
  project_key: o.project_key ?? 'github-com-Acme-Shop', run_id: o.run_id ?? 'r-1',
  repo_url: o.repo_url ?? 'https://github.com/Acme/Shop', head_sha: o.head_sha ?? 'abc123',
  proposals_json: JSON.stringify(records),
});


