// @ts-check
// The Dowser store - the ONLY writer of ~/.dowser/projects/<key>/dowser.db, so the agent never writes SQL.
// Pattern taken from ai-registry lens-scan store.mjs: node:sqlite DatabaseSync, WAL, the DDL applied inside one
// BEGIN IMMEDIATE transaction that re-reads user_version, compare-and-set status moves
// (`UPDATE ... WHERE fp = ? AND status = ? RETURNING *`), deciders written as `<kind>:<name>`, NULL columns never
// printed. The schema is Dowser's own (docs/data-model.md).
//
// Store rules this module owns:
//  - `evidence` and `transitions` are append-only: no code path UPDATEs or DELETEs them, and triggers refuse it;
//  - every status move is a compare-and-set against model.TRANSITIONS and appends one `transitions` row;
//  - proposals are written only into a run whose status is `running`;
//  - absent values are NULL in SQL and omitted in JSON, never 0 or null placeholders.
//  - `outcomes` is append-only too (triggers); lib/reflect.mjs writes it.
// `rules`, `sources_cache` and `sync_state` are DDL only here; WP2 (memory) and WP4 (sync) own their logic.
//
// The store is split by concern; this file is the facade every caller imports:
//  - store-core.mjs: USER_VERSION, SYSTEM_DECIDER, DDL, MIGRATIONS, openStore, tx, clean, sql, now, localDate,
//    newRunId, getRun, lastDoneRun, requireRunning, and the typedefs (Db, Row, ...);
//  - proposals.mjs: getProposal, evidenceOf, transitionsOf, assertedEvidence, evidenceSnapshot, resurfaces
//    (re-exported from model.mjs), propose, move, candidatesOfRun, untilProblem, wakeSnoozed, withSnoozeUntil;
//  - runs.mjs: runStart, checkLenses, runFinish, truncationNote, statusSummary.
// The three import each other directly (core <- proposals <- runs), never through this facade.
export * from './store-core.mjs';
export * from './proposals.mjs';
export * from './runs.mjs';
