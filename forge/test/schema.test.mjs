// @ts-check
// sql/schema.mjs: how migrations run. The runner is @forge/sql's own MigrationRunner class over a fake SQL client
// on node:sqlite that answers like TiDB (a duplicate column or index is errno 1060 / 1061), so a lost checkpoint
// can be replayed exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ForgeSQLAPIError, migrationRunner } from '@forge/sql';
import { MIGRATIONS } from '../src/sql/migrations.mjs';
import { isAlreadyApplied, runMigrationsWith, schemaGuard } from '../src/sql/schema.mjs';

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

// ------------------------------------------------------------------------------------------- schemaGuard
// The shipped in-request migrate-and-retry rule (index.js wires it with the real runner and installation id).

/** @param {{fail?: number}} [opts] */
function guardPorts(opts = {}) {
  const s = { inst: 'inst-a', runs: 0, fail: opts.fail ?? 0, behind: new Set(['inst-a', 'inst-b']) };
  const ports = {
    installationId: () => s.inst,
    isSchemaBehind: (/** @type {unknown} */ e) => /no such table/.test(String(/** @type {any} */ (e)?.message)),
    runMigrations: async () => {
      s.runs += 1;
      await new Promise((r) => setImmediate(r));
      if (s.fail > 0) { s.fail -= 1; throw new Error('Forge SQL 503'); }
      s.behind.delete(s.inst);
      return [];
    },
  };
  /** a call that fails until this installation's schema is migrated */
  const call = async () => { if (s.behind.has(s.inst)) throw new Error('no such table: tool_calls'); return { ok: true }; };
  return { s, ports, call };
}

test('withSchema migrates once and retries when a call hits a missing table', async () => {
  const { s, ports, call } = guardPorts();
  const g = schemaGuard(ports);
  assert.deepEqual(await g.withSchema(call), { ok: true });
  assert.equal(s.runs, 1);
  assert.deepEqual(await g.withSchema(call), { ok: true });
  assert.equal(s.runs, 1);
});

test('withSchema rethrows an error that is not a schema gap, without migrating', async () => {
  const { s, ports } = guardPorts();
  const g = schemaGuard(ports);
  await assert.rejects(g.withSchema(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(s.runs, 0);
});

test('a schema gap that survives the migration is not migrated again in this runtime', async () => {
  const { s, ports } = guardPorts();
  const g = schemaGuard(ports);
  const gap = async () => { throw new Error('no such table: nowhere'); };
  await assert.rejects(g.withSchema(gap), /no such table/);
  await assert.rejects(g.withSchema(gap), /no such table/);
  assert.equal(s.runs, 1);
  assert.equal(await g.ensureSchema(new Error('no such table: nowhere')), false);
});

test('each installation a warm runtime serves migrates on its own', async () => {
  const { s, ports, call } = guardPorts();
  const g = schemaGuard(ports);
  await g.withSchema(call);
  s.inst = 'inst-b';
  assert.deepEqual(await g.withSchema(call), { ok: true });
  assert.equal(s.runs, 2);
});

test('ensureSchema migrates once for a schema gap and answers whether it did; markMigrated skips it', async () => {
  const { s, ports } = guardPorts();
  const g = schemaGuard(ports);
  assert.equal(await g.ensureSchema(new Error('boom')), false);
  assert.equal(await g.ensureSchema(new Error('no such table: x')), true);
  assert.equal(await g.ensureSchema(new Error('no such table: x')), false);
  s.inst = 'inst-b';
  g.markMigrated();
  assert.equal(await g.ensureSchema(new Error('no such table: x')), false);
  assert.equal(s.runs, 1);
});

test('index.js wires the shipped guard, not its own copy of the rule', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /schemaGuard\(\{ runMigrations, installationId, isSchemaBehind \}\)/);
  assert.doesNotMatch(src, /migrated\.add|new Set\(\)/);
});

test('a failed in-request migration is retried on the next call, not remembered as done', async () => {
  const { s, ports, call } = guardPorts({ fail: 1 });
  const g = schemaGuard(ports);
  await assert.rejects(g.withSchema(call), /Forge SQL 503/);
  assert.deepEqual(await g.withSchema(call), { ok: true });
  assert.equal(s.runs, 2);
  await assert.rejects(schemaGuard(guardPorts({ fail: 1 }).ports).ensureSchema(new Error('no such table: x')), /503/);
});

test('concurrent calls on a missing table share one migration and all succeed', async () => {
  const { s, ports, call } = guardPorts();
  const g = schemaGuard(ports);
  const out = await Promise.all([g.withSchema(call), g.withSchema(call), g.withSchema(call)]);
  assert.deepEqual(out, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(s.runs, 1);
});
