#!/usr/bin/env node
// @ts-check
// e2e-coverage - what the e2e specs cover, and a ratchet on what they do not (e2e/README.md "Coverage").
//
//   node tools/e2e-coverage.mjs [--root <dir>] [--baseline <file>] [--against <git ref>|none] [--write]
//
// The ids come from the app's own sources, so a new route, resolver or fixture condition is uncovered the moment
// it lands:
//   route:<page>       forge/manifest.yml jira:globalPage `pages` routes        (inbox, map, reflect, settings)
//   route:<module>     forge/static/app/src/router.jsx MODULES keys             (dowser-evidence, ...)
//   resolver:<key>     forge/src/core/app.mjs RESOLVERS keys: a spec sees the key's success answer
//   fail:<key>         the same keys: a spec forces `&fail=<key>` and sees the failure on its surface
//   fixture:<name>     forge/static/app/src/dev/bridge.js `params().get|has('<name>')`, plus link.js LINK_KEYS
// A spec covers an id with a `@covers <id> [<id> ...]` line anywhere in an `e2e/**/*.spec.mjs` file. Other id
// kinds (`live:sidebar`) are free-form and listed, never gated; an unknown id of a derived kind is an error (a typo
// would otherwise look like coverage).
//
// The baseline (default e2e/coverage-baseline.json, `{"uncovered": [ids]}`) lists the ids allowed to stay
// uncovered. It may only shrink:
//   - an uncovered id missing from the baseline fails (new code needs a spec, not a baseline line);
//   - a baseline id that is now covered, or no longer exists, fails as stale until --write drops it;
//   - a baseline id that the baseline at --against (default HEAD; `none` skips) did not list fails as growth.
// Prints one JSON object; exit 0 ok, 1 the gate failed, 2 bad arguments or unreadable sources.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = join('e2e', 'coverage-baseline.json');
/** The id kinds derived from the sources; only these are gated. */
export const DERIVED = ['route', 'resolver', 'fail', 'fixture'];

/** @param {string} root @param {string} rel */
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

/**
 * The `route` values under `jira:globalPage` in the manifest.
 * @param {string} manifest
 * @returns {string[]}
 */
export function manifestRoutes(manifest) {
  const out = [];
  let inPage = false;
  for (const line of manifest.split(/\r?\n/)) {
    if (/^ {2}\S/.test(line)) { inPage = line.trim() === 'jira:globalPage:'; continue; }
    const m = inPage && line.match(/^\s+route:\s*([A-Za-z0-9_-]+)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The keys of `const MODULES = { ... }` in router.jsx. @param {string} router @returns {string[]} */
export function routerModules(router) {
  const body = router.match(/const MODULES = \{([^}]*)\}/)?.[1] ?? '';
  return [...body.matchAll(/'([a-z0-9-]+)'\s*:/g)].map((m) => m[1]);
}

/** The keys of `export const RESOLVERS = { ... };` in app.mjs (its two-space-indented `'key':` lines). @param {string} app */
export function resolverKeys(app) {
  const start = app.indexOf('export const RESOLVERS = {');
  if (start < 0) return [];
  const end = app.indexOf('\n};', start);
  const body = app.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/^ {2}'([a-z]+\.[A-Za-z]+)'\s*:/gm)].map((m) => m[1]);
}

/** The hash parameters the fixture bridge reads, and the deep-link keys of link.js. @param {string} bridge @param {string} link */
export function fixtureConditions(bridge, link) {
  const names = new Set([...bridge.matchAll(/params\(\)\.(?:get|has)\('([a-z]+)'\)/g)].map((m) => m[1]));
  const keys = link.match(/LINK_KEYS = \[([^\]]*)\]/)?.[1] ?? '';
  for (const m of keys.matchAll(/'([a-z]+)'/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * Every derived id, sorted.
 * @param {string} root
 * @returns {string[]}
 */
export function derivedIds(root) {
  const keys = resolverKeys(read(root, 'forge/src/core/app.mjs'));
  const routes = [...manifestRoutes(read(root, 'forge/manifest.yml')), ...routerModules(read(root, 'forge/static/app/src/router.jsx'))];
  const conds = fixtureConditions(read(root, 'forge/static/app/src/dev/bridge.js'), read(root, 'forge/static/app/src/dev/link.js'));
  if (!keys.length || !routes.length || !conds.length) throw new Error('could not read the routes, resolver keys or fixture conditions');
  return [...routes.map((r) => `route:${r}`), ...keys.map((k) => `resolver:${k}`), ...keys.map((k) => `fail:${k}`), ...conds.map((c) => `fixture:${c}`)]
    .filter((v, i, a) => a.indexOf(v) === i).sort();
}

/** @param {string} dir @returns {string[]} */
function specFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'results' || e.name === 'node_modules' ? [] : specFiles(p);
    return e.name.endsWith('.spec.mjs') ? [p] : [];
  });
}

/**
 * The `@covers` tags of every spec under <root>/e2e: id -> ['e2e/<file>:<line>', ...].
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
export function coversOf(root) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const f of specFiles(join(root, 'e2e')).sort()) {
    const rel = relative(root, f).replaceAll('\\', '/');
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/@covers\s+(.+)$/);
      if (!m) return;
      for (const id of m[1].trim().split(/\s+/)) {
        if (!/^[a-z]+:\S+$/.test(id)) continue;
        out.set(id, [...(out.get(id) ?? []), `${rel}:${i + 1}`]);
      }
    });
  }
  return out;
}

/** @param {string} text @returns {string[]} */
function parseBaseline(text) {
  const b = JSON.parse(text);
  if (!b || !Array.isArray(b.uncovered) || b.uncovered.some((/** @type {unknown} */ x) => typeof x !== 'string')) throw new Error('the baseline is {"uncovered": [ids]}');
  return b.uncovered;
}

/**
 * The baseline as committed at `ref`, or undefined when there is none (no git, or the file is new).
 * @param {string} root @param {string} file  repo-relative @param {string} ref
 */
function baselineAt(root, file, ref) {
  try {
    const text = execFileSync('git', ['-C', root, 'show', `${ref}:${file.replaceAll('\\', '/')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseBaseline(text);
  } catch { return undefined; }
}

/**
 * The whole report.
 * @param {{root: string, baseline?: string, against?: string}} o
 */
export function coverage({ root, baseline = BASELINE, against = 'HEAD' }) {
  const ids = derivedIds(root);
  const covers = coversOf(root);
  const known = new Set(ids);
  const baseFile = join(root, baseline);
  const listed = existsSync(baseFile) ? parseBaseline(readFileSync(baseFile, 'utf8')) : [];
  const uncovered = ids.filter((id) => !covers.has(id));
  const before = against === 'none' ? undefined : baselineAt(root, relative(root, baseFile), against);
  const report = {
    ids: Object.fromEntries(ids.map((id) => [id, covers.get(id) ?? []])),
    free: Object.fromEntries([...covers].filter(([id]) => !DERIVED.includes(id.split(':')[0])).sort(([a], [b]) => a.localeCompare(b))),
    covered: ids.length - uncovered.length,
    total: ids.length,
    uncovered,
    /** uncovered and not in the baseline: needs a spec */
    unlisted: uncovered.filter((id) => !listed.includes(id)),
    /** in the baseline but covered now, or gone: drop it (--write) */
    stale: listed.filter((id) => !known.has(id) || covers.has(id)),
    /** in the baseline but not in the baseline at --against: the baseline may only shrink */
    grew: before ? listed.filter((id) => !before.includes(id)) : [],
    /** tags of a derived kind that name no id (typos) */
    unknown: [...covers.keys()].filter((id) => DERIVED.includes(id.split(':')[0]) && !known.has(id)).sort(),
  };
  return { ...report, ok: !report.unlisted.length && !report.stale.length && !report.grew.length && !report.unknown.length };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{root: string, baseline?: string, against?: string, write: boolean}} */
  const o = { root: REPO, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--root') o.root = resolve(val());
    else if (a === '--baseline') o.baseline = val();
    else if (a === '--against') o.against = val();
    else if (a === '--write') o.write = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** @param {string[]} argv @returns {number} the exit code */
export function main(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let o;
  try { o = parseArgs(argv); } catch (e) {
    process.stderr.write(`${/** @type {Error} */ (e).message}; usage: e2e-coverage.mjs [--root <dir>] [--baseline <file>] [--against <git ref>|none] [--write]\n`);
    return 2;
  }
  /** @type {ReturnType<typeof coverage>} */
  let r;
  try { r = coverage(o); } catch (e) {
    process.stderr.write(`e2e-coverage: ${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
  if (o.write && r.stale.length) {
    // shrink only: keep the listed ids that are still uncovered, drop the stale ones
    const file = join(o.root, o.baseline ?? BASELINE);
    const keep = r.uncovered.filter((id) => !r.unlisted.includes(id));
    writeFileSync(file, `${JSON.stringify({ uncovered: keep }, null, 2)}\n`);
    r = coverage(o);
  }
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
