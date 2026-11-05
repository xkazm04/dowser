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
  /** @type {Map<string, Promise<void>>} the migration in flight per installation */
  const running = new Map();

  /**
   * Migrates the current installation once. A concurrent caller awaits the same run; a failed run is forgotten,
   * so the next call migrates again instead of answering "not ready" for the rest of the runtime.
   * @param {unknown} e
   * @returns {Promise<boolean>} true when a migration ran (or was awaited) now
   */
  async function migrateFor(e) {
    const inst = installationId();
    if (migrated.has(inst) || !isSchemaBehind(e)) return false;
    let run = running.get(inst);
    if (!run) {
      run = (async () => {
        try { await runMigrations(); migrated.add(inst); } finally { running.delete(inst); }
      })();
      running.set(inst, run);
    }
    await run;
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
      if (!(await migrateFor(e))) throw e;
      return fn();
    }
  }

  /** The migrate trigger ran the migrations for the current installation. */
  const markMigrated = () => { migrated.add(installationId()); };

  // the Deps `ensureSchema` port is the same rule: true when it migrated now
  return { ensureSchema: migrateFor, withSchema, markMigrated };
}

/**
 * The metadata of a storage failure for one log line: error class, code, errno, the failing migration and how many
 * were still to run, and the Forge SQL trace id, from the error or its cause. No message: a SQL message can quote
 * row values. Absent fields are omitted.
 * @param {unknown} e
 * @returns {Record<string, string | number>}
 */
export function storageFailure(e) {
  const err = /** @type {any} */ (e);
  const cause = err?.cause;
  /** @type {Record<string, string | number | undefined>} */
  const out = {
    dowser: 'storage-not-ready',
    error: String(err?.constructor?.name && err.constructor.name !== 'Object' ? err.constructor.name : err?.name ?? typeof e),
    code: str(err?.code) ?? str(cause?.code),
    errno: num(err?.context?.debug?.errno) ?? num(cause?.context?.debug?.errno),
    sql_code: str(err?.context?.debug?.code) ?? str(cause?.context?.debug?.code),
    migration: str(err?.migrationName),
    yet_to_run: Array.isArray(err?.migrationsYetToRun) ? err.migrationsYetToRun.length : undefined,
    trace_id: str(err?.responseDetails?.traceId) ?? str(cause?.responseDetails?.traceId),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return /** @type {Record<string, string | number>} */ (out);
}

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
