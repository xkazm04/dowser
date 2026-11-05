// @ts-check
// How the schema migrations run, without @forge/sql (adapters/forge-sql.mjs and index.js wire the real runner),
// so the rules are under test.
//
// @forge/sql 4.x `migrationRunner.run()` (out/migration.js) runs each new statement and only then INSERTs its
// name into `__migrations`. When that INSERT fails (MigrationCheckPointError) the DDL is applied but unrecorded,
// and the next run executes it again. The shipped CREATE INDEX and ALTER TABLE ADD COLUMN statements are not
// idempotent and the file is append-only (sql/migrations.mjs), so the re-run fails with a duplicate key or
// column name for good, and no later migration runs. That one error means "already applied": record the name
// and carry on.

/** TiDB/MySQL: 1060 ER_DUP_FIELDNAME (Duplicate column name), 1061 ER_DUP_KEYNAME (Duplicate key name). */
const ALREADY_APPLIED_RE = /Duplicate column name|Duplicate key name|ER_DUP_FIELDNAME|ER_DUP_KEYNAME/i;

/** @forge/sql out/errors.js MigrationExecutionError (MigrationCheckPointError says "Failed to checkpoint"). */
const EXECUTION_RE = /^Failed to execute migration with name /;

/**
 * True when `e` is a MigrationExecutionError whose statement failed only because its column or index exists.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isAlreadyApplied(e) {
  const err = /** @type {any} */ (e);
  // every @forge/sql error has name 'ForgeSQLError'; the execution error is told apart by its message
  if (typeof err?.migrationName !== 'string' || !EXECUTION_RE.test(String(err?.message ?? ''))) return false;
  const cause = err.cause;
  const debug = cause?.context?.debug;
  if (debug?.errno === 1060 || debug?.errno === 1061) return true;
  return ALREADY_APPLIED_RE.test(`${String(cause?.code ?? '')} ${String(cause?.message ?? '')} ${String(debug?.code ?? '')} ${String(debug?.message ?? '')}`);
}

/**
 * Runs the migrations; a statement that fails only because it was applied before (a lost checkpoint) is recorded
 * as applied and the run goes on. Any other failure throws as before.
 * @param {{enqueue: (name: string, statement: string) => unknown, run: () => Promise<string[]>}} runner
 * @param {(name: string) => Promise<unknown>} record  INSERTs `name` into `__migrations`
 * @param {readonly {name: string, statement: string}[]} migrations
 * @returns {Promise<string[]>} the names that ran (or were recorded) now, in order
 */
export async function runMigrationsWith(runner, record, migrations) {
  for (const m of migrations) runner.enqueue(m.name, m.statement);
  /** @type {string[]} */
  const ran = [];
  // each pass records at least one name, so the loop ends; the bound is a guard, not a budget
  for (let pass = 0; pass <= migrations.length; pass++) {
    try {
      ran.push(...(await runner.run()));
      return ran;
    } catch (e) {
      if (!isAlreadyApplied(e)) throw e;
      const err = /** @type {{migrationName: string, migrationsYetToRun?: string[]}} */ (e);
      const yet = Array.isArray(err.migrationsYetToRun) ? err.migrationsYetToRun : [];
      const at = yet.indexOf(err.migrationName);
      if (at > 0) ran.push(...yet.slice(0, at)); // these ran in the failed pass before it
      await record(err.migrationName);
      ran.push(err.migrationName);
      console.log(JSON.stringify({ dowser: 'migration-recovered', migration: err.migrationName }));
    }
  }
  throw new Error('migrations did not settle');
}

/**
 * The in-request schema guard (index.js): when a call fails on a missing table or column, run the migrations once
 * per installation in this runtime and retry. The install trigger normally migrates; `avi:forge:upgraded:app`
 * fires only on a major version (Forge SQL docs), so this covers a minor upgrade that ships a new migration until
 * the daily migrate runs. A warm runtime may serve more than one installation.
 * @param {{runMigrations: () => Promise<unknown>, installationId: () => string, isSchemaBehind: (e: unknown) => boolean}} ports
 */
export function schemaGuard({ runMigrations, installationId, isSchemaBehind }) {
  /** Installations this runtime has migrated. */
  const migrated = new Set();

  /**
   * The Deps `ensureSchema` port: migrate once per installation when `e` says the schema is behind.
   * @param {unknown} e
   * @returns {Promise<boolean>} true when it migrated now
   */
  async function ensureSchema(e) {
    const inst = installationId();
    if (migrated.has(inst) || !isSchemaBehind(e)) return false;
    migrated.add(inst);
    await runMigrations();
    return true;
  }

  /**
   * Runs `fn`; when it fails on a missing table or column, migrates once per installation and retries.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withSchema(fn) {
    try {
      return await fn();
    } catch (e) {
      const inst = installationId();
      if (migrated.has(inst) || !isSchemaBehind(e)) throw e;
      migrated.add(inst);
      await runMigrations();
      return fn();
    }
  }

  /** The migrate trigger ran the migrations for the current installation. */
  const markMigrated = () => { migrated.add(installationId()); };

  return { ensureSchema, withSchema, markMigrated };
}
