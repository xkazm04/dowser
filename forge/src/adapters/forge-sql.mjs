// @ts-check
// The Db port over @forge/sql 4.x (checked against node_modules/@forge/sql/out/*.d.ts):
//  - `sql.prepare<T>(query).bindParams(...params).execute()` -> `Result<T>` = `{rows, metadata?}`; for DML,
//    `rows` is an `UpdateQueryResponse` `{affectedRows, insertId, ...}` (out/utils/types.d.ts).
//  - every execute is one HTTP POST (out/sql.js `storageApi`), one statement per request (Forge SQL query
//    policy), so `tx` cannot be atomic here; see core/ports.mjs for how the core stays correct without it.
//  - `migrationRunner.enqueue(name, ddl).run()` records names in `__migrations` and runs only new ones
//    (out/migration.js); DDL goes to the /api/v1/execute/ddl endpoint.
//  - failures are `ForgeSQLAPIError {code, message}` (out/errors.d.ts); a UNIQUE / PRIMARY KEY violation is
//    reported by TiDB as `Duplicate entry ... for key` (MySQL errno 1062), mapped to DuplicateKey.
import { migrationRunner, sql } from '@forge/sql';
import { DUPLICATE_RE, DuplicateKey } from '../core/util.mjs';
import { MIGRATIONS } from '../sql/migrations.mjs';

/** @typedef {import('../core/ports.mjs').Db} Db */

/**
 * @param {unknown} e
 * @returns {never}
 */
function rethrow(e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (DUPLICATE_RE.test(msg)) throw new DuplicateKey(msg);
  throw e;
}

/** @type {Db} */
export const forgeDb = {
  async query(q, params = []) {
    try {
      const r = await sql.prepare(q).bindParams(...params).execute();
      return Array.isArray(r.rows) ? /** @type {Record<string, any>[]} */ (r.rows) : [];
    } catch (e) { return rethrow(e); }
  },
  async exec(q, params = []) {
    try {
      const r = await sql.prepare(q).bindParams(...params).execute();
      const rows = /** @type {any} */ (r.rows);
      return { affectedRows: Number(rows?.affectedRows ?? 0) };
    } catch (e) { return rethrow(e); }
  },
  // Not atomic on Forge SQL (see the header); runs `fn` as is.
  async tx(fn) { return fn(); },
};

/**
 * Runs the schema migrations (the `migrate` trigger on install and upgrade).
 * @returns {Promise<string[]>} the names that ran now
 */
export async function runMigrations() {
  for (const m of MIGRATIONS) migrationRunner.enqueue(m.name, m.statement);
  return migrationRunner.run();
}
