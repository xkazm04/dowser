// @ts-check
// The real ports for a local Forge (tools/local-forge.mjs): the Db port over node:sqlite on a file, plus a local
// Jira, Users and Sources that keep their rows in the same file. The Forge core (forge/src/core) runs unchanged
// on top; only these adapters stand in for @forge/sql and @forge/api (forge/src/adapters).
//
// Db: the statement mapping (booleans as 0/1, `changes` -> affectedRows, a UNIQUE / PRIMARY KEY failure ->
// DuplicateKey) is copied from forge/test/helpers.mjs `sqliteDb`, which runs the same migrations in memory.
// Importing it would pull test-only fakes into a tool, so it is copied, not imported. Differences: a file, not
// :memory:; WAL and a busy timeout so a second process on the same file waits instead of failing; `tx` is
// BEGIN IMMEDIATE so two processes serialize their writes; the migrations are tracked in `__migrations` (as
// @forge/sql's migrationRunner does), so a restart runs only the new ones.
//
// The local tables are prefixed `local_` and are not Forge migrations: they belong to the stand-ins, not to the
// app's schema.
import { DatabaseSync } from 'node:sqlite';
import { DUPLICATE_RE, DuplicateKey } from '../../forge/src/core/util.mjs';
import { MIGRATIONS } from '../../forge/src/sql/migrations.mjs';

/**
 * @typedef {import('../../forge/src/core/ports.mjs').Db} Db
 * @typedef {import('../../forge/src/core/ports.mjs').Jira} Jira
 * @typedef {import('../../forge/src/core/ports.mjs').Users} Users
 * @typedef {import('../../forge/src/core/ports.mjs').Sources} Sources
 * @typedef {import('../../forge/src/core/ports.mjs').AdfDoc} AdfDoc
 * @typedef {import('../../forge/src/core/types.mjs').SourceItem} SourceItem
 * @typedef {'new' | 'indeterminate' | 'done'} StatusCategory
 * @typedef {{key: string, name: string, issue_types: {id: string, name: string}[]}} Project
 * @typedef {{tickets?: Record<string, any>[], pages?: Record<string, any>[], goals?: Record<string, any>[],
 *   projects?: Project[], users?: Record<string, string>}} Seed
 */

/** Waits this long for another process's write lock before failing a statement. */
export const BUSY_MS = 5000;
/** The default Jira project: accepts land here unless the seed or the settings say otherwise. */
export const DEFAULT_PROJECT = /** @type {Project} */ ({ key: 'DOW', name: 'Dowser (local)', issue_types: [{ id: '10001', name: 'Story' }] });
/** The default person: `--account` defaults to this id. */
export const DEFAULT_ACCOUNT = 'local-user';
export const DEFAULT_NAME = 'Local Operator';
/** Default status names per category, for an issue moved without a name. */
export const STATUS_NAMES = /** @type {const} */ ({ new: 'To Do', indeterminate: 'In Progress', done: 'Done' });
const SOURCE_KINDS = /** @type {const} */ (['tickets', 'pages', 'goals']);

/** @param {unknown} v */
const bind = (v) => (typeof v === 'boolean' ? Number(v) : /** @type {any} */ (v));

const LOCAL_DDL = [
  `CREATE TABLE IF NOT EXISTS __migrations (name VARCHAR(255) NOT NULL PRIMARY KEY, migrated_at VARCHAR(32) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_jira_projects (key TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, issue_types_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_jira_issues (key TEXT NOT NULL PRIMARY KEY, project_key TEXT NOT NULL, n INTEGER NOT NULL,
    issue_type_id TEXT NOT NULL, summary TEXT NOT NULL, description_json TEXT NOT NULL, status_name TEXT NOT NULL,
    status_category TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_key, n))`,
  `CREATE TABLE IF NOT EXISTS local_jira_comments (id INTEGER PRIMARY KEY, issue_key TEXT NOT NULL, body_json TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_users (account_id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_sources (kind TEXT NOT NULL, ref TEXT NOT NULL, item_json TEXT NOT NULL, PRIMARY KEY (kind, ref))`,
];

/**
 * Runs `fn` inside BEGIN IMMEDIATE (the write lock, waited for up to BUSY_MS).
 * @template T
 * @param {DatabaseSync} raw
 * @param {() => T} fn
 * @returns {T}
 */
function immediate(raw, fn) {
  raw.exec('BEGIN IMMEDIATE');
  try { const out = fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
}

/**
 * Opens (creating) the file, sets WAL and the busy timeout, creates the local tables and runs the Forge
 * migrations that `__migrations` does not list yet.
 * @param {string} file
 * @returns {{raw: DatabaseSync, db: Db, ran: string[]}}
 */
export function openLocalDb(file) {
  const raw = new DatabaseSync(file, { timeout: BUSY_MS });
  raw.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  raw.exec('PRAGMA journal_mode = WAL');
  const ran = immediate(raw, () => {
    for (const s of LOCAL_DDL) raw.exec(s);
    const done = new Set(raw.prepare('SELECT name FROM __migrations').all().map((r) => String(r.name)));
    const mark = raw.prepare('INSERT INTO __migrations (name, migrated_at) VALUES (?, ?)');
    /** @type {string[]} */
    const out = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      raw.exec(m.statement);
      mark.run(m.name, new Date().toISOString());
      out.push(m.name);
    }
    return out;
  });
  return { raw, db: dbPort(raw), ran };
}

/**
 * The Db port (see the header for where it comes from).
 * @param {DatabaseSync} raw
 * @returns {Db}
 */
export function dbPort(raw) {
  return {
    async query(sql, params = []) {
      return /** @type {any[]} */ (raw.prepare(sql).all(...params.map(bind))).map((r) => ({ ...r }));
    },
    async exec(sql, params = []) {
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
      // The caller (local-forge.mjs) runs one core call at a time per process, so no other statement of this
      // connection interleaves with an open transaction.
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

/**
 * Loads the defaults (project DOW, the local person) and then the seed, if any. Re-running replaces seeded
 * rows by key and keeps everything else (issues, the app's tables).
 * @param {DatabaseSync} raw
 * @param {Seed} [seed]
 */
export function applySeed(raw, seed = {}) {
  immediate(raw, () => {
    const project = raw.prepare('INSERT OR REPLACE INTO local_jira_projects (key, name, issue_types_json) VALUES (?, ?, ?)');
    raw.prepare('INSERT OR IGNORE INTO local_jira_projects (key, name, issue_types_json) VALUES (?, ?, ?)')
      .run(DEFAULT_PROJECT.key, DEFAULT_PROJECT.name, JSON.stringify(DEFAULT_PROJECT.issue_types));
    raw.prepare('INSERT OR IGNORE INTO local_users (account_id, name) VALUES (?, ?)').run(DEFAULT_ACCOUNT, DEFAULT_NAME);
    for (const p of seed.projects ?? []) {
      if (!p || typeof p.key !== 'string' || !Array.isArray(p.issue_types)) throw new Error('seed.projects[] needs {key, name, issue_types: [{id, name}]}');
      project.run(p.key, String(p.name ?? p.key), JSON.stringify(p.issue_types));
    }
    const user = raw.prepare('INSERT OR REPLACE INTO local_users (account_id, name) VALUES (?, ?)');
    for (const [id, name] of Object.entries(seed.users ?? {})) user.run(id, String(name));
    const src = raw.prepare('INSERT OR REPLACE INTO local_sources (kind, ref, item_json) VALUES (?, ?, ?)');
    for (const kind of SOURCE_KINDS) {
      for (const it of seed[kind] ?? []) {
        if (!it || typeof it.ref !== 'string') throw new Error(`seed.${kind}[] items need a ref`);
        src.run(kind, it.ref, JSON.stringify(it));
      }
    }
  });
}

/**
 * Jira over the local tables. Keys are `<PROJECT>-<n>`, numbered per project in one statement (atomic in
 * SQLite, also across processes). A new issue is `To Do` / `new`.
 * @param {DatabaseSync} raw
 * @param {() => string} browseBase  e.g. `http://127.0.0.1:4710/browse/` (read per issue: the port is known once the server listens)
 * @param {() => Date} now
 * @returns {Jira}
 */
export function localJira(raw, browseBase, now) {
  return {
    async createIssue({ projectKey, issueTypeId, summary, description }) {
      const p = /** @type {any} */ (raw.prepare('SELECT issue_types_json FROM local_jira_projects WHERE key = ?').get(projectKey));
      if (!p) throw new Error(`Jira answered 404: no project ${projectKey}`);
      if (!JSON.parse(String(p.issue_types_json)).some((/** @type {any} */ t) => t.id === issueTypeId)) {
        throw new Error(`Jira answered 400: issue type ${issueTypeId} is not in ${projectKey}`);
      }
      const r = /** @type {any} */ (raw.prepare(`INSERT INTO local_jira_issues (key, project_key, n, issue_type_id, summary, description_json,
          status_name, status_category, created_at)
        SELECT ? || '-' || n, ?, n, ?, ?, ?, ?, 'new', ? FROM (SELECT COALESCE(MAX(n), 0) + 1 AS n FROM local_jira_issues WHERE project_key = ?)
        RETURNING key`).get(projectKey, projectKey, issueTypeId, summary, JSON.stringify(description), STATUS_NAMES.new, now().toISOString(), projectKey));
      const key = String(r.key);
      return { key, url: `${browseBase()}${key}` };
    },
    async addComment(issueKey, body) {
      if (!raw.prepare('SELECT 1 FROM local_jira_issues WHERE key = ?').get(issueKey)) throw new Error(`Jira answered 404: no issue ${issueKey}`);
      raw.prepare('INSERT INTO local_jira_comments (issue_key, body_json, at) VALUES (?, ?, ?)').run(issueKey, JSON.stringify(body), now().toISOString());
    },
    async listProjects() {
      return raw.prepare('SELECT key, name, issue_types_json FROM local_jira_projects ORDER BY key').all()
        .map((r) => ({ key: String(r.key), name: String(r.name), issue_types: JSON.parse(String(r.issue_types_json)) }));
    },
    async issueStatuses(keys) {
      /** @type {Record<string, {name: string, category: StatusCategory}>} */
      const out = {};
      const get = raw.prepare('SELECT status_name, status_category FROM local_jira_issues WHERE key = ?');
      for (const k of keys) {
        const r = /** @type {any} */ (get.get(k));
        if (r) out[k] = { name: String(r.status_name), category: r.status_category };
      }
      return out;
    },
  };
}

/**
 * Moves a local issue (the dev endpoint that simulates an issue shipping).
 * @param {DatabaseSync} raw
 * @param {string} key
 * @param {StatusCategory} category
 * @param {string} [name]
 * @returns {boolean} false when there is no such issue
 */
export function setIssueStatus(raw, key, category, name) {
  const r = raw.prepare('UPDATE local_jira_issues SET status_name = ?, status_category = ? WHERE key = ?').run(name ?? STATUS_NAMES[category], category, key);
  return Number(r.changes) === 1;
}

/**
 * One issue with its comments, for `GET /browse/<key>`.
 * @param {DatabaseSync} raw
 * @param {string} key
 */
export function issueOf(raw, key) {
  const r = /** @type {any} */ (raw.prepare('SELECT * FROM local_jira_issues WHERE key = ?').get(key));
  if (!r) return undefined;
  return {
    key: String(r.key), project_key: String(r.project_key), issue_type_id: String(r.issue_type_id), summary: String(r.summary),
    status: { name: String(r.status_name), category: String(r.status_category) }, created_at: String(r.created_at),
    description: JSON.parse(String(r.description_json)),
    comments: raw.prepare('SELECT body_json, at FROM local_jira_comments WHERE issue_key = ? ORDER BY id').all(key)
      .map((c) => ({ at: String(c.at), body: JSON.parse(String(c.body_json)) })),
  };
}

/**
 * Display names from `local_users`.
 * @param {DatabaseSync} raw
 * @returns {Users}
 */
export function localUsers(raw) {
  return {
    async names(ids) {
      /** @type {Record<string, string>} */
      const out = {};
      const get = raw.prepare('SELECT name FROM local_users WHERE account_id = ?');
      for (const id of ids) {
        const r = /** @type {any} */ (get.get(id));
        if (r) out[id] = String(r.name);
      }
      return out;
    },
  };
}

/**
 * The `text ~ "<term>"` terms of a JQL/CQL string the core built (sources.mjs textClause).
 * @param {string} q
 * @returns {string[]}
 */
const textTerms = (q) => [...q.matchAll(/text ~ "([^"]*)"/g)].map((m) => m[1].toLowerCase()).filter(Boolean);

/**
 * @param {Record<string, any>} it
 * @param {string[]} ts
 */
const hits = (it, ts) => ts.length === 0 || ts.some((t) => `${it.title ?? ''}\n${it.body ?? ''}`.toLowerCase().includes(t));

/**
 * Sources over the seeded items. The query is the JQL/CQL the core built: its text terms are matched
 * case-insensitively against title and body (any term), `created >= "<date>"` and `space = "<key>"` filter,
 * and the `limit` caps the answer. Tickets are newest first, pages most recently updated first.
 * @param {DatabaseSync} raw
 * @returns {Sources}
 */
export function localSources(raw) {
  /** @param {string} kind @returns {Record<string, any>[]} */
  const all = (kind) => raw.prepare('SELECT item_json FROM local_sources WHERE kind = ? ORDER BY ref').all(kind).map((r) => JSON.parse(String(r.item_json)));
  /** @param {Record<string, any>} it @returns {SourceItem} */
  const shape = (it) => {
    const { space: _space, ...rest } = it;
    return /** @type {SourceItem} */ (rest);
  };
  return {
    async tickets({ jql, limit }) {
      const ts = textTerms(jql);
      const since = /created >= "([^"]+)"/.exec(jql)?.[1];
      const from = since ? Date.parse(`${since.replace(' ', 'T')}:00Z`) : undefined;
      return all('tickets')
        .filter((it) => hits(it, ts) && (from === undefined || Date.parse(String(it.created_at ?? '')) >= from))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
        .slice(0, limit).map(shape);
    },
    async pages({ cql, limit }) {
      const ts = textTerms(cql);
      const space = /space = "([^"]+)"/.exec(cql)?.[1];
      return all('pages')
        .filter((it) => hits(it, ts) && (space === undefined || it.space === space))
        .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
        .slice(0, limit).map(shape);
    },
    async goals() { return all('goals').map(shape); },
  };
}

/**
 * Row counts of every table (`GET /dev/state`).
 * @param {DatabaseSync} raw
 * @returns {Record<string, number>}
 */
export function rowCounts(raw) {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => String(r.name));
  return Object.fromEntries(tables.map((t) => [t, Number(/** @type {any} */ (raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).n)]));
}
