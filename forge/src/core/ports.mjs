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
// `tx(fn)` is therefore a plain sequential call on Forge, and the SQLite test port matches it (test/helpers.mjs),
// so a reliance on rollback fails a test. The core never relies on it for correctness: every status move is a compare-and-set
// (`UPDATE ... WHERE status = ?` + affectedRows), ids come from a CAS counter, inserts are check-then-insert
// guarded by UNIQUE, and a decision whose verdict row did not land is repaired from the decision stamp on the
// proposal row before every pull (verdicts.mjs `repairVerdicts`).
//
// Sets. Because every statement is a request (30-60 ms on Forge SQL), bulk work is set-based (store.mjs): IN reads,
// multi-row `INSERT ... VALUES (...), (...)` chunked under the request caps, and DW numbers in blocks by one CAS.
// A single statement is atomic in TiDB and SQLite alike, so a multi-row INSERT that hits a duplicate wrote nothing
// and is retried row by row: the check-then-insert and CAS guarantees above hold unchanged.

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
 *   createIssue: (f: {projectKey: string, issueTypeId: string, summary: string, description: AdfDoc, labels?: string[]}) => Promise<{key: string, url: string}>,
 *   addComment: (issueKey: string, body: AdfDoc) => Promise<void>,
 *   listProjects: () => Promise<{key: string, name: string, issue_types: {id: string, name: string}[]}[]>,
 *   issueStatuses: (keys: string[]) => Promise<Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>>,
 *   setIssueProperty?: (issueKey: string, key: string, value: Record<string, string | number>) => Promise<void>,
 * }} Jira
 *  `issueStatuses` reads as the calling user and answers only the keys Jira returned (a missing key is one the user
 *  cannot browse, or gone); it throws on failure.
 *  `labels` (createIssue) is set only on an issue from the sample inbox (`dowser-sample`) or one a delegate accepted
 *  (`dowser-delegate`, core/delegate.mjs).
 *  `setIssueProperty` writes an issue entity property as the app (core/issue-property.mjs); optional, so a
 *  port without it simply writes none.
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
 * Links into the product. `mcpUrl` is the app's MCP server URL a coding agent connects to (the setup checklist);
 * undefined where the app context is unknown, and the method is absent where there is no MCP server (local).
 * @typedef {{
 *   inboxUrl: (ref: string) => Promise<string>,
 *   mcpUrl?: () => string | undefined,
 * }} Links
 */

/**
 * Display names for Atlassian account ids. Best effort: an id Jira will not name is absent from the answer, and
 * the adapter tolerates a failed batch (the core then omits the names).
 * @typedef {{names: (accountIds: string[]) => Promise<Record<string, string>>}} Users
 */

/**
 * What the signed-in person may do in Jira, AS THE USER (Jira's /mypermissions): the answer has one boolean per
 * asked permission key (BROWSE_PROJECTS, CREATE_ISSUES, ADD_COMMENTS, ADMINISTER). `on` narrows it to one project
 * or one issue; without `on` only global permissions (ADMINISTER) are meaningful. A project or issue the person
 * cannot see, or that does not exist, answers every key false. It throws on a Jira failure; a missing user grant
 * is rethrown as is, so a Custom UI surface can show Forge's consent screen.
 * @typedef {{
 *   mine: (keys: string[], on?: {projectKey?: string, issueKey?: string}) => Promise<Record<string, boolean>>,
 * }} Perms
 */

/**
 * Everything a core function may need. `now` is injected so tests control time; `log` receives the dispatch
 * door's structured lines (default console.log). `perms` is required wherever an inbox is read or decided
 * (core/access.mjs): without it, only the scan-source tools work.
 * Confluence writes, AS THE USER (write:comment:confluence): Confluence's own permission decides. Throws on failure.
 * @typedef {{addFooterComment: (pageId: string, body: AdfDoc) => Promise<{id: string}>}} Confluence
 */

/**
 * @typedef {{db: Db, jira?: Jira, confluence?: Confluence, sources?: Sources, links: Links, users?: Users, perms?: Perms, now: () => Date, log?: (line: string) => void,
 *   ensureSchema?: (e: unknown) => Promise<boolean>}} Deps
 *   `ensureSchema(e)`: when `e` says the schema is behind and this installation has not migrated in this runtime,
 *   runs the migrations and answers true (the caller may retry its own statement once); else false. For writes that
 *   must not fail their call (recordCall) and so cannot let the entry point's retry-the-whole-call path see the error.
 */

export {};
