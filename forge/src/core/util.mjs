// @ts-check
// Small pure helpers shared by the core: the error type every tool and resolver answers with, absent-value
// handling (SQL NULL <-> omitted key), and argument checks. No Forge imports.
import { createHash } from 'node:crypto';

/** A failure the caller can act on: becomes `{error, message}` (forge-mcp-2 "Errors"). */
export class AppError extends Error {
  /**
   * @param {import('./types.mjs').ErrorCode} code
   * @param {string} message one sentence for a person
   */
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/**
 * Thrown by a Db adapter when an INSERT hits a UNIQUE / PRIMARY KEY constraint. The core treats it as "someone
 * else got there first" and re-reads; correctness never rests on the constraint alone (check-then-insert).
 */
export class DuplicateKey extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DuplicateKey';
  }
}

/** MySQL/TiDB `Duplicate entry ... for key` (errno 1062) and SQLite `UNIQUE constraint failed`. */
export const DUPLICATE_RE = /Duplicate entry|UNIQUE constraint failed|PRIMARY KEY constraint failed|ER_DUP_ENTRY|\b1062\b/i;

/**
 * The object without keys whose value is `undefined` or `null` (SQL NULL -> omitted key).
 * @template {Record<string, any>} T
 * @param {T} o
 * @returns {T}
 */
export function omitAbsent(o) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return /** @type {T} */ (out);
}

/**
 * A value for a SQL parameter: `undefined` becomes NULL (an omitted key is stored as NULL).
 * @param {unknown} v
 * @returns {unknown}
 */
export const sqlv = (v) => (v === undefined ? null : v);

/** @param {unknown} v @returns {v is string} */
export const str = (v) => typeof v === 'string' && v.trim().length > 0;

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A number column as a number (drivers may return BIGINT as a string), or undefined for NULL.
 * @param {unknown} v
 * @returns {number | undefined}
 */
export const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/**
 * A required non-empty string argument, else `bad-input`.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string}
 */
export function needStr(args, key) {
  const v = args[key];
  if (!str(v)) throw new AppError('bad-input', `${key} is required and must be a non-empty string`);
  return v.trim();
}

/**
 * An optional string argument: undefined when absent or empty, `bad-input` when not a string.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string | undefined}
 */
export function optStr(args, key) {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError('bad-input', `${key} must be a string`);
  return v.trim() || undefined;
}

/** sha256 hex of a string. @param {string} s */
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** ISO 8601 UTC with milliseconds (`2026-10-27T10:00:00.000Z`). */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** @param {unknown} v @returns {boolean} */
export const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

/** A Jira issue key (`SHOP-123`). */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*$/;
/** A proposal fingerprint. */
export const FP_RE = /^[0-9a-f]{16}$/;
