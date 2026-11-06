// @ts-check
// temper-fixmes - the known-red specs of a tree: every `test.fixme(` in a `*.spec.*` file, with the ticket it names. A
// spec-only cycle (.claude/skills/temper/references/runner.md) leaves them for the next day's builder, and a growing
// list must stay visible: temper.mjs report and tools/e2e-coverage.mjs both count them from here. No dependencies, and
// `*.test.*` files are not read, so a test that quotes the marker is not counted.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const FIXME_CALL = /\btest(?:\.describe)?(?:\.only)?\.fixme\(/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const TICKET = /\b[A-Z][A-Z0-9]*-\d+\b/;
const SPEC = /\.spec\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', 'results', 'dist', 'build', 'out', 'coverage', 'target', 'vendor']);

/**
 * The fixme marks of one spec: their 1-based lines and the ticket each names, read from its line and the lines beside
 * it (a title on the next line, a comment on the one before). `ticket` is null when none is named.
 * @param {string} text
 * @returns {{line: number, ticket: string | null}[]}
 */
export function fixmesIn(text) {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((l, i) => {
    if (!FIXME_CALL.test(l) || COMMENT.test(l)) return [];
    const near = [l, lines[i + 1] ?? '', lines[i - 1] ?? ''].map((x) => x.match(TICKET)?.[0]).find(Boolean);
    return [{ line: i + 1, ticket: near ?? null }];
  });
}

/** @param {string} dir @returns {string[]} */
function specFiles(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('.') || SKIP.has(e.name) ? [] : specFiles(p);
    return e.isFile() && SPEC.test(e.name) ? [p] : [];
  });
}

/**
 * Every fixme under `dir` (default the whole tree), sorted by place, as `<file>:<line>` relative to `root`.
 * @param {string} root @param {string} [dir]
 * @returns {{at: string, ticket: string | null}[]}
 */
export function fixmeSpecs(root, dir = root) {
  return specFiles(dir).sort().flatMap((f) => {
    const rel = relative(root, f).replaceAll('\\', '/');
    return fixmesIn(readFileSync(f, 'utf8')).map((x) => ({ at: `${rel}:${x.line}`, ticket: x.ticket }));
  });
}
