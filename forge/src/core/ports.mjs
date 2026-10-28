// @ts-check
// The ports the pure core runs against (design F7). src/adapters/ maps them to @forge/sql and @forge/api;
// the tests implement them in memory (node:sqlite for Db). Types only.
//
// Db. One statement per call, `?` placeholders. The SQL the core writes is portable between MySQL/TiDB (Forge
// SQL) and SQLite: no AUTO_INCREMENT, no ON DUPLICATE KEY, no RETURNING, LIMIT/OFFSET inlined as validated
// integers. An INSERT that hits a UNIQUE / PRIMARY KEY constraint throws `DuplicateKey` (util.mjs).
//
// Transactions. @forge/sql 4.0.9 sends every statement as its own HTTP request (`sql.prepare(q).bindParams()
// .execute()` -> POST /api/v1/execute; out/sql.js), and the Forge SQL query policy allows one statement per
// request and rejects `SET autocommit` - so there is no way to hold a transaction open across statements.
// `tx(fn)` is therefore atomic where the backend can be (the SQLite test port) and a plain sequential call on
// Forge. The core never relies on it for correctness: every status move is a compare-and-set
// (`UPDATE ... WHERE status = ?` + affectedRows), ids come from a CAS counter, inserts are check-then-insert
// guarded by UNIQUE, and a decision whose verdict row did not land is repaired from the decision stamp on the
// proposal row before every pull (verdicts.mjs `repairVerdicts`).

/**
 * @typedef {Record<string, any>} Row
 * @typedef {{affectedRows: number}} ExecResult
 * @typedef {{
 *   query: (sql: string, params?: unknown[]) => Promise<Row[]>,
 *   exec: (sql: string, params?: unknown[]) => Promise<ExecResult>,
 *   tx: <T>(fn: () => Promise<T>) => Promise<T>,
 * }} Db
 */

/**
 * Atlassian document format (ADF) document, `{type: 'doc', version: 1, content: [...]}`.
 * @typedef {{type: string, [k: string]: any}} AdfNode
 * @typedef {{type: 'doc', version: 1, content: AdfNode[]}} AdfDoc
 */

/**
 * Jira, as the app (F5: accept creates the issue as the app). Every method throws on failure; the core turns
 * that into `unavailable` and writes nothing.
 * @typedef {{
 *   createIssue: (f: {projectKey: string, issueTypeId: string, summary: string, description: AdfDoc}) => Promise<{key: string, url: string}>,
 *   addComment: (issueKey: string, body: AdfDoc) => Promise<void>,
 *   listProjects: () => Promise<{key: string, name: string, issue_types: {id: string, name: string}[]}[]>,
 *   issueStatuses: (keys: string[]) => Promise<Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>>,
 * }} Jira
 *  `issueStatuses` answers only the keys Jira returned (a missing key is unreadable or gone); it throws on failure.
 */

/**
 * Scan sources, as the signed-in person. Each returns raw-ish items already mapped to the contract shape.
 * @typedef {import('./types.mjs').SourceItem} SourceItem
 * @typedef {{
 *   tickets: (q: {jql: string, limit: number}) => Promise<SourceItem[]>,
 *   pages: (q: {cql: string, limit: number}) => Promise<SourceItem[]>,
 *   goals: () => Promise<SourceItem[]>,
 * }} Sources
 */

/**
 * Links into the product.
 * @typedef {{
 *   inboxUrl: (ref: string) => Promise<string>,
 * }} Links
 */

/**
 * Display names for Atlassian account ids. Best effort: an id Jira will not name is absent from the answer, and
 * the adapter tolerates a failed batch (the core then omits the names).
 * @typedef {{names: (accountIds: string[]) => Promise<Record<string, string>>}} Users
 */

/**
 * Everything a core function may need. `now` is injected so tests control time; `log` receives the dispatch
 * door's structured lines (default console.log).
 * @typedef {{db: Db, jira?: Jira, sources?: Sources, links: Links, users?: Users, now: () => Date, log?: (line: string) => void}} Deps
 */

export {};
