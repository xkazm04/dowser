// @ts-check
// Every resolver key the Custom UI calls is registered and allowed for the module that renders it, read from the
// UI source itself: router.jsx names each module's (and each global page's) root component, the relative imports
// from that root are walked, and every call('<key>') found on the way must be a RESOLVERS key that MODULE_KEYS
// lets that module call. The dev bridges answer any key from any surface, so without this only a deploy finds a
// key that is missing or gated off (`... is not available from this Dowser view`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_KEYS, RESOLVERS, resolverAllowed } from '../src/core/app.mjs';

const SRC = fileURLToPath(new URL('../static/app/src/', import.meta.url));
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');

/**
 * The relative imports of a file, resolved to files under src (dev/ stand-ins excluded), each with the names it
 * takes: a named import takes those names, a default or namespace import takes everything ('*').
 * @param {string} file
 * @returns {{file: string, names: string[]}[]}
 */
function importsOf(file) {
  return [...read(file).matchAll(/^import\s([^;]*?)\sfrom\s+'(\.{1,2}\/[^']+)'/gms)].map((m) => {
    const named = /^\{([^}]*)\}$/.exec(m[1].trim());
    const names = named ? named[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean) : ['*'];
    return { file: join(dirname(file), m[2]), names };
  }).filter((i) => /\.(jsx?|mjs)$/.test(i.file) && existsSync(i.file) && !relative(SRC, i.file).startsWith('dev'));
}

/** Every file reachable from `root` by relative imports, with the names taken from it. @param {string} root */
function reach(root) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map([[root, new Set(['*'])]]);
  for (const f of seen.keys()) {
    for (const i of importsOf(f)) {
      const have = seen.get(i.file) ?? new Set();
      for (const n of i.names) have.add(n);
      seen.set(i.file, have);
    }
  }
  return seen;
}

/**
 * The keys called in a file, each with the top-level declaration it sits in (a line at column 0 starting a
 * function or const). Only literal keys are used in this UI; a non-literal one fails below.
 * @param {string} file
 * @returns {{raw: string, owner: string, exported: boolean}[]}
 */
function callsOf(file) {
  const out = [];
  let owner = '';
  let exported = false;
  for (const line of read(file).split(/\r?\n/)) {
    const decl = /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/.exec(line);
    if (decl) { owner = decl[2]; exported = Boolean(decl[1]); }
    for (const m of line.matchAll(/\bcall\(\s*([^,)]*)/g)) out.push({ raw: m[1].trim(), owner, exported });
  }
  return out;
}

/** module key -> root component file, from router.jsx (MODULES, and PAGES for the global page dowser-inbox). */
function roots() {
  const router = read(join(SRC, 'router.jsx'));
  const files = Object.fromEntries([...router.matchAll(/^import (\w+) from '(\.\/routes\/[^']+)';$/gm)].map((m) => [m[1], join(SRC, m[2])]));
  const obj = (/** @type {string} */ name) => Object.fromEntries([...(new RegExp(`const ${name} = \\{([^}]*)\\}`).exec(router)?.[1] ?? '').matchAll(/'?([\w-]+)'?:\s*(\w+)/g)].map((m) => [m[1], m[2]]));
  /** @type {[string, string][]} */
  const out = Object.entries(obj('MODULES')).map(([mod, comp]) => [mod, files[comp]]);
  for (const comp of Object.values(obj('PAGES'))) out.push(['dowser-inbox', files[comp]]);
  return out;
}

test('every call() key in the Custom UI is a registered resolver its module may call', () => {
  const r = roots();
  assert.deepEqual([...new Set(r.map(([m]) => m))].sort(), Object.keys(MODULE_KEYS).sort(), 'router.jsx renders every module MODULE_KEYS gates');
  /** @type {string[]} */
  const problems = [];
  let calls = 0;
  for (const [mod, root] of r) {
    assert.ok(root && existsSync(root), `${mod} root ${root}`);
    for (const [file, names] of reach(root)) {
      if (file.endsWith('api.js')) continue; // the definition of call itself
      for (const { raw, owner, exported } of callsOf(file)) {
        // a call inside an exported declaration counts only where that name is imported (SampleStrip.jsx serves
        // SampleChip to the panel and byline, SampleStrip only to the global page); a helper's call counts always
        if (exported && !names.has('*') && !names.has(owner)) continue;
        calls++;
        const key = /^'([^']+)'$/.exec(raw)?.[1];
        const at = `${relative(SRC, file).replace(/\\/g, '/')} (${mod})`;
        if (!key) problems.push(`${at}: call(${raw}) - use a literal key so this test can read it`);
        else if (!Object.hasOwn(RESOLVERS, key)) problems.push(`${at}: ${key} is not a registered resolver`);
        else if (!resolverAllowed(mod, key)) problems.push(`${at}: ${key} is not allowed for ${mod} (core/app.mjs MODULE_KEYS)`);
      }
    }
  }
  assert.ok(calls > 20, `found ${calls} call sites`);
  assert.deepEqual(problems, []);
});

test('jira.projects (the Accept dialog and Settings) is registered and open to the global page only', () => {
  assert.ok(Object.hasOwn(RESOLVERS, 'jira.projects'));
  assert.equal(resolverAllowed('dowser-inbox', 'jira.projects'), true);
  for (const m of ['dowser-evidence', 'dowser-doc-impact', 'dowser-doc-banner']) assert.equal(resolverAllowed(m, 'jira.projects'), false, m);
});
