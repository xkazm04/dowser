// @ts-check
// `dowser deps` (lens-quality-plan WP4): runs the dependency auditors present on this machine (npm audit,
// osv-scanner, pip-audit), read-only against the repo, normalises their findings to `dep` source items and caches
// them on the run, so the security-cra lens cites them and `verify` can re-check a cited dep ref. An auditor that
// is absent or fails is reported as skipped, never as "no vulnerabilities".
// STUB: the Director committed this signature before the fan-out; WP4 implements it.
import { DowserError } from './model.mjs';

/**
 * @typedef {{tool: string, state: 'ran' | 'skipped', reason?: string, found?: number}} AuditorReport
 */

/**
 * @param {import('./store.mjs').Db} db
 * @param {{root: string, runId: string}} o
 * @returns {{out: {auditors: AuditorReport[], refs: {type: 'dep', ref: string, title: string}[]}}}
 */
export function runDeps(db, o) {
  void db; void o;
  throw new DowserError('deps: not implemented yet', 3);
}
