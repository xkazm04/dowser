// @ts-check
// Exact-tier fingerprint (D3): the first 16 hex of sha256(`lens|kind|topic|anchors`), where `kind` is one of
// the lens's closed kinds (declared in the lens pack's frontmatter - passed in, never hardcoded here), `topic`
// is a normalized kebab slug and `anchors` are sorted, de-duplicated `path#symbol` strings with line numbers
// stripped. Title and body wording never enter the fingerprint. Pure: no I/O.
import { createHash } from 'node:crypto';
import { DowserError, LENSES, isOneOf } from './model.mjs';

/**
 * A topic as a lowercase kebab slug: diacritics folded, apostrophes and quotes dropped (`don't` -> `dont`),
 * every other run of non-alphanumerics one `-`, no leading or trailing `-`.
 * @param {string} s
 * @returns {string}
 */
export function normalizeTopic(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’`"“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `:12`, `:12:5`, `:12-20` at the end of a path or symbol. */
const LINE_SUFFIX = /(?::\d+(?:[-:]\d+)?)+$/;
/** GitHub-style line fragments `#L12`, `#L12-L20`, `#L12C3`. */
const LINE_FRAGMENT = /^L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;

/**
 * An anchor as `path[#symbol]`: forward slashes, no leading `./`, no `:line[:col]` suffix (on the path or the
 * symbol), no `#L12` line fragment; a `#symbol` is kept.
 * @param {string} a
 * @returns {string}
 */
export function normalizeAnchor(a) {
  let s = String(a).trim().replace(/\\/g, '/');
  const hash = s.indexOf('#');
  let path = hash >= 0 ? s.slice(0, hash) : s;
  let symbol = hash >= 0 ? s.slice(hash + 1).trim() : '';
  path = path.replace(LINE_SUFFIX, '').replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '');
  symbol = symbol.replace(LINE_SUFFIX, '');
  if (LINE_FRAGMENT.test(symbol)) symbol = '';
  return symbol ? `${path}#${symbol}` : path;
}

/**
 * The exact fingerprint. Throws DowserError (exit 2) when the lens is unknown, `kind` is not one of `kinds`,
 * or the topic normalizes to nothing.
 * @param {{lens: string, kind: string, topic: string, anchors: string[]}} identity
 * @param {readonly string[]} kinds the lens's closed kind list (from its lens pack)
 * @returns {string} 16 lowercase hex
 */
export function fingerprint({ lens, kind, topic, anchors }, kinds) {
  if (!isOneOf(LENSES, lens)) throw new DowserError(`unknown lens ${JSON.stringify(lens)}`, 2);
  if (!Array.isArray(kinds) || kinds.length === 0) throw new DowserError(`no kinds declared for lens ${lens}`, 2);
  if (!kinds.includes(kind)) throw new DowserError(`kind ${JSON.stringify(kind)} is not one of ${lens}'s kinds (${kinds.join(',')})`, 2);
  const t = normalizeTopic(topic);
  if (!t) throw new DowserError(`topic ${JSON.stringify(topic)} normalizes to nothing`, 2);
  const norm = [...new Set((anchors ?? []).map(normalizeAnchor).filter(Boolean))].sort();
  const key = `${lens}|${kind}|${t}|${norm.join(',')}`;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------------------------------- evidence keys

/**
 * Whitespace-normalized text: every whitespace run is one space, trimmed.
 * @param {string} s
 * @returns {string}
 */
export const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * A withheld quote's stand-in on the wire (`quotes=omit`): the first 16 hex of sha256 of the `squash`ed quote,
 * so the same line yields the same evidence key wherever it moves, without the line itself leaving the machine.
 * @param {string} quote
 * @returns {string}
 */
export const quoteSha = (quote) => createHash('sha256').update(squash(quote)).digest('hex').slice(0, 16);

/**
 * Splits an evidence ref into its repo-relative path and an optional line hint.
 * `src/a.js:12`, `src/a.js:12:5`, `src/a.js#L12`, `src/a.js#symbol`, `src/a.js#symbol:12`.
 * @param {string} ref
 * @returns {{path: string, line?: number}}
 */
export function parseRef(ref) {
  let s = ref.trim().replace(/\\/g, '/');
  /** @type {number | undefined} */
  let line;
  const hash = s.indexOf('#');
  let frag = '';
  if (hash >= 0) { frag = s.slice(hash + 1); s = s.slice(0, hash); }
  const tail = /:(\d+)(?:[-:]\d+)?$/;
  const m = s.match(tail);
  if (m) { line = Number(m[1]); s = s.slice(0, m.index); }
  if (line === undefined && frag) {
    const lf = frag.match(/^L(\d+)/) ?? frag.match(tail);
    if (lf) line = Number(lf[1]);
  }
  s = s.replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '');
  return line !== undefined && line > 0 ? { path: s, line } : { path: s };
}

/**
 * The identity of one evidence item within a proposal (WP1b): for `code`/`doc`, the path plus the
 * whitespace-normalized quote - the line is only a hint, so a line shift is not new evidence; for every other
 * type, the trimmed ref. A pushed code/doc item without a quote but with `quote_sha` (`quotes=omit`) keys on the
 * path plus `#sha:<quote_sha>` instead.
 * @param {{type: string, ref: string, quote?: string, quote_sha?: string}} e
 * @returns {{key: string, path?: string, line?: number}}
 */
export function evidenceKey(e) {
  if (e.type === 'code' || e.type === 'doc') {
    const { path, line } = parseRef(e.ref);
    const key = e.quote === undefined && e.quote_sha !== undefined
      ? `${path}\n#sha:${e.quote_sha}`
      : `${path}\n${squash(e.quote ?? '')}`;
    return line !== undefined ? { key, path, line } : { key, path };
  }
  return { key: e.ref.trim() };
}
