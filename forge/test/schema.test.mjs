// @ts-check
// sql/schema.mjs: how migrations run. The runner is @forge/sql's own MigrationRunner class over a fake SQL client
// on node:sqlite that answers like TiDB (a duplicate column or index is errno 1060 / 1061), so a lost checkpoint
// can be replayed exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ForgeSQLAPIError, migrationRunner } from '@forge/sql';
import { MIGRATIONS } from '../src/sql/migrations.mjs';
import { isAlreadyApplied, runMigrationsWith } from '../src/sql/schema.mjs';

/** @typedef {{executeDDL: (q: string) => Promise<{rows: any[]}>, prepare: (q: string) => {bindParams: (...p: unknown[]) => {execute: () => Promise<{rows: any}>}}}} SqlClient */

/** A TiDB-shaped API error (the shape core/app.mjs isSchemaBehind reads: context.debug). @param {string} message @param {number} errno */
const tidbError = (message, errno) => new ForgeSQLAPIError({ status: 400, statusText: 'Bad Request' },
  { code: 'SQL_EXECUTION_ERROR', message, context: { debug: { errno, message } } });

/**
 * @param {{failCheckpointFor?: string, failDdlFor?: string}} [opts]
 * @returns {{client: SqlClient, raw: DatabaseSync, recorded: () => string[], opts: {failCheckpointFor?: string, failDdlFor?: string}}}
 */
function fakeSql(opts = {}) {
  const raw = new DatabaseSync(':memory:');
  /** @param {string} q */
  const run = (q) => {
    const sqlite = q.replace('BIGINT PRIMARY KEY AUTO_INCREMENT', 'INTEGER PRIMARY KEY AUTOINCREMENT');
    try {
      if (/^\s*SELECT/i.test(sqlite)) return { rows: /** @type {any[]} */ (raw.prepare(sqlite).all()) };
      raw.exec(sqlite);
      return { rows: [] };
    } catch (e) {
      const msg = /** @type {Error} */ (e).message;
      if (/duplicate column name/i.test(msg)) throw tidbError(`Duplicate column name '${msg.split(': ').pop()}'`, 1060);
      if (/index .* already exists/i.test(msg)) throw tidbError(`Duplicate key name '${/index (\S+)/.exec(msg)?.[1]}'`, 1061);
      throw e;
    }
  };
  /** @type {SqlClient} */
  const client = {
    async executeDDL(q) {
      if (opts.failDdlFor && q.includes(opts.failDdlFor)) throw tidbError('Service unavailable', 9999);
      return run(q);
    },
    prepare(q) {
      return {
        bindParams: (...p) => ({
          async execute() {
            if (opts.failCheckpointFor && p[0] === opts.failCheckpointFor) {
              opts.failCheckpointFor = undefined; // one lost checkpoint
              throw tidbError('upstream timeout', 9998);
            }
            raw.prepare(q).run(.../** @type {any[]} */ (p));
            return { rows: { affectedRows: 1 } };
          },
        }),
      };
    },
  };
  const recorded = () => /** @type {any[]} */ (raw.prepare('SELECT name FROM __migrations ORDER BY id').all()).map((r) => String(r.name));
  return { client, raw, recorded, opts };
}

/** A fresh @forge/sql MigrationRunner over `client` (the package exports only its singleton). @param {SqlClient} client */
const runnerOver = (client) => new (/** @type {any} */ (migrationRunner).constructor)(client);

/** @param {ReturnType<typeof fakeSql>} f */
const recordWith = (f) => (/** @type {string} */ name) => f.client.prepare('INSERT INTO __migrations (name) VALUES (?);').bindParams(name).execute();

test('a fresh database runs every migration once, and a second run runs none', async () => {
  const f = fakeSql();
  assert.deepEqual(await runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS), MIGRATIONS.map((m) => m.name));
  assert.deepEqual(await runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS), []);
  assert.deepEqual(f.recorded(), MIGRATIONS.map((m) => m.name));
});

for (const name of ['v016_proposals_snooze_until', 'v029_work_reports_proposal_ix', 'v031_page_edits']) {
  test(`a lost checkpoint on ${name} no longer wedges the later migrations`, async () => {
    const f = fakeSql({ failCheckpointFor: name });
    // the lost checkpoint itself still fails that run, as @forge/sql reports it
    await assert.rejects(runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS), (e) => /^Failed to checkpoint/.test(/** @type {Error} */ (e).message));
    assert.ok(!f.recorded().includes(name));
    // the next run re-executes the applied statement, records it as applied and runs the rest
    const ran = await runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS);
    const at = MIGRATIONS.findIndex((m) => m.name === name);
    assert.deepEqual(ran, MIGRATIONS.slice(at).map((m) => m.name));
    assert.deepEqual(f.recorded().sort(), MIGRATIONS.map((m) => m.name).sort());
    assert.deepEqual(await runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS), []);
  });
}

test('any other migration failure still throws, and nothing is recorded for it', async () => {
  const f = fakeSql({ failDdlFor: 'ADD COLUMN snooze_until VARCHAR(10)' });
  await assert.rejects(runMigrationsWith(runnerOver(f.client), recordWith(f), MIGRATIONS),
    (e) => /^Failed to execute migration/.test(/** @type {Error} */ (e).message) && /** @type {any} */ (e).migrationName === 'v016_proposals_snooze_until');
  assert.ok(!f.recorded().includes('v016_proposals_snooze_until'));
});

test('isAlreadyApplied reads only a MigrationExecutionError caused by a duplicate column or key name', () => {
  const exec = (/** @type {unknown} */ cause) => Object.assign(new Error('Failed to execute migration with name v016'), { name: 'ForgeSQLError', migrationName: 'v016', migrationsYetToRun: ['v016'], cause });
  assert.equal(isAlreadyApplied(exec(tidbError("Duplicate column name 'a'", 1060))), true);
  assert.equal(isAlreadyApplied(exec(tidbError("Duplicate key name 'ix'", 1061))), true);
  assert.equal(isAlreadyApplied(exec(tidbError("Table 'proposals' doesn't exist", 1146))), false);
  assert.equal(isAlreadyApplied(exec(new Error('socket hang up'))), false);
  assert.equal(isAlreadyApplied(tidbError("Duplicate column name 'a'", 1060)), false);
  const checkpoint = Object.assign(new Error('Failed to checkpoint after running migration with name v016'), { migrationName: 'v016', cause: tidbError("Duplicate column name 'a'", 1060) });
  assert.equal(isAlreadyApplied(checkpoint), false);
  assert.equal(isAlreadyApplied(undefined), false);
});
