// @ts-check
// Per-lens direction (lens-quality-plan WP3): what a team set in Forge Settings for one inbox - focus, exclude,
// notes and, for doc-drift, the Confluence spaces to search - cached on the run so `context --lens` can hand it
// to the lens pack. The agent calls `dowser_direction_get` and runs `ingest-direction` with the saved response.
// STUB: the Director committed these signatures before the fan-out; WP3 implements them.
import { DowserError } from './model.mjs';

/**
 * @typedef {{focus?: string[], exclude?: string[], notes?: string, spaces?: string[]}} LensDirection
 * @typedef {{lenses: Partial<Record<import('./model.mjs').Lens, LensDirection>>}} DirectionDoc
 */

/**
 * Applies a `dowser_direction_get` response to the run (replaces what the run held).
 * @param {import('./store.mjs').Db} db
 * @param {{runId: string, doc: unknown}} o
 * @returns {{out: Record<string, unknown>}}
 */
export function ingestDirection(db, o) {
  void db; void o;
  throw new DowserError('ingest-direction: not implemented yet', 3);
}

/**
 * The direction the run holds for one lens, or undefined (absent: the run has none for that lens).
 * @param {import('./store.mjs').Db} db
 * @param {string} runId
 * @param {string} lens
 * @returns {LensDirection | undefined}
 */
export function directionFor(db, runId, lens) {
  void db; void runId; void lens;
  return undefined;
}
