#!/usr/bin/env node
// @ts-check
// quality-snapshot - one row of structural measurements of this repository, so a long run of changes (a dogfood
// campaign) can show whether the code is getting better or quietly worse. Deterministic and offline: it reads the
// committed tree (git ls-files) and runs the two gates.
//
//   node tools/quality-snapshot.mjs [--label wave-03] [--append <file.jsonl>] [--no-gates]
//
// Measures, per area: files, non-blank lines; the largest code files; functions longer than LONG_FN lines (top
// level `function` declarations and `const x = (...) =>` blocks, ended by the first `}` at the same indent);
// duplicated windows of DUP_WINDOW non-trivial lines across code files; import cycles among skill/scripts/lib;
// the words an agent reads (SKILL.md, references, lens packs); TODO/FIXME count; CLI command count; tests and gate
// results. With --append, prints the delta against the file's last row.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LONG_FN = 60;
const DUP_WINDOW = 6;
const AREAS = /** @type {const} */ ({
  'skill-lib': (/** @type {string} */ p) => p.startsWith('skill/scripts/') && !p.includes('/tests/') && p.endsWith('.mjs'),
  'skill-tests': (/** @type {string} */ p) => p.startsWith('skill/scripts/tests/') && p.endsWith('.mjs'),
  'skill-prose': (/** @type {string} */ p) => p.startsWith('skill/') && p.endsWith('.md') && !p.includes('/tests/'),
  tools: (/** @type {string} */ p) => p.startsWith('tools/') && p.endsWith('.mjs'),
  'forge-core': (/** @type {string} */ p) => p.startsWith('forge/src/') && /\.m?js$/.test(p),
  'forge-ui': (/** @type {string} */ p) => p.startsWith('forge/static/app/src/') && /\.(jsx?|css)$/.test(p),
  docs: (/** @type {string} */ p) => p.startsWith('docs/') && p.endsWith('.md'),
});
const CODE = /\.(mjs|js|jsx)$/;

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const label = flag('--label');
const appendTo = flag('--append');
const gates = !argv.includes('--no-gates');

const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();
const files = git(['ls-files']).split('\n').filter(Boolean).filter((p) => !p.includes('/fixtures/') && existsSync(join(ROOT, p)));
/** @type {Map<string, string[]>} */
const text = new Map();
const lines = (/** @type {string} */ p) => {
  if (!text.has(p)) text.set(p, readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n').split('\n'));
  return /** @type {string[]} */ (text.get(p));
};
const nonBlank = (/** @type {string} */ p) => lines(p).filter((l) => l.trim()).length;
const words = (/** @type {string} */ p) => lines(p).join(' ').split(/\s+/).filter(Boolean).length;

/** @type {Record<string, {files: number, lines: number}>} */
const areas = {};
for (const [name, test] of Object.entries(AREAS)) {
  const fs = files.filter(test);
  areas[name] = { files: fs.length, lines: fs.reduce((n, p) => n + nonBlank(p), 0) };
}

const code = files.filter((p) => CODE.test(p) && !p.endsWith('.min.js') && (p.startsWith('skill/') || p.startsWith('tools/') || p.startsWith('forge/src/') || p.startsWith('forge/static/app/src/')));
const largest = code.map((p) => ({ file: p, lines: nonBlank(p) })).sort((a, b) => b.lines - a.lines).slice(0, 6);

/** Long top-level functions: a declaration line at indent 0, ended by the first line that is `}` or `};` at indent 0. */
const longFns = [];
for (const p of code) {
  const ls = lines(p);
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/);
    if (!m || ls[i].trimEnd().endsWith('}') || ls[i].trimEnd().endsWith('};')) continue;
    let j = i + 1;
    while (j < ls.length && !/^\}[;)]*\s*$/.test(ls[j])) j++;
    const n = j - i + 1;
    if (n > LONG_FN) longFns.push({ fn: `${p}#${m[1] ?? m[2]}`, lines: n });
  }
}
longFns.sort((a, b) => b.lines - a.lines);

/** Duplicated windows: DUP_WINDOW consecutive non-trivial lines (trimmed, not comments, 12+ chars) seen in 2+ places. */
/** @type {Map<string, Set<string>>} */
const windows = new Map();
for (const p of code) {
  if (p.startsWith('forge/src/shared/')) continue; // the synced copies of the skill's modules, checked by check-shared
  const ls = lines(p).map((l) => l.trim()).filter((l) => l.length >= 12 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
  for (let i = 0; i + DUP_WINDOW <= ls.length; i++) {
    const key = ls.slice(i, i + DUP_WINDOW).join('\n');
    if (!windows.has(key)) windows.set(key, new Set());
    /** @type {Set<string>} */ (windows.get(key)).add(`${p}:${i}`);
  }
}
const dups = [...windows.values()].filter((s) => s.size > 1);
const dupFiles = [...new Set(dups.flatMap((s) => [...s].map((x) => x.split(':')[0])))].sort();

/** Import cycles among skill/scripts/lib (relative imports only). */
const lib = files.filter((p) => p.startsWith('skill/scripts/lib/') && p.endsWith('.mjs'));
/** @type {Map<string, string[]>} */
const graph = new Map(lib.map((p) => [p, lines(p).flatMap((l) => {
  const m = l.match(/^\s*(?:import|export)\b.*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/);
  const rel = m?.[1] ?? m?.[2];
  return rel ? [posix.join(posix.dirname(p), rel)] : [];
}).filter((t) => lib.includes(t))]));
const cycles = new Set();
for (const start of lib) {
  /** @param {string} n @param {string[]} path */
  const walk = (n, path) => {
    for (const t of graph.get(n) ?? []) {
      if (t === start) cycles.add([...path].sort().join(' -> '));
      else if (!path.includes(t) && path.length < 8) walk(t, [...path, t]);
    }
  };
  walk(start, [start]);
}
const libEdges = [...graph.values()].reduce((n, e) => n + e.length, 0);

const prose = files.filter((p) => p === 'skill/SKILL.md' || p.startsWith('skill/references/') || p.startsWith('skill/lenses/'));
const agentWords = Object.fromEntries([['SKILL.md', words('skill/SKILL.md')],
  ['references', prose.filter((p) => p.startsWith('skill/references/')).reduce((n, p) => n + words(p), 0)],
  ['lenses', prose.filter((p) => p.startsWith('skill/lenses/')).reduce((n, p) => n + words(p), 0)]]);
const todos = code.filter((p) => p !== 'tools/quality-snapshot.mjs').reduce((n, p) => n + lines(p).filter((l) => /\b(TODO|FIXME|XXX|HACK)\b/.test(l)).length, 0);
const cliCommands = (readFileSync(join(ROOT, 'skill/scripts/dowser.mjs'), 'utf8').match(/^ {2}(?:'[\w-]+'|\w+)\(a, ctx\)/gm) ?? []).length;

/** @type {Record<string, unknown>} */
const g = {};
if (gates) {
  const tc = spawnSync('npm run typecheck', { cwd: ROOT, encoding: 'utf8', shell: true });
  g.typecheck = tc.status === 0 ? 'pass' : 'fail';
  const t = spawnSync('npm test', { cwd: ROOT, encoding: 'utf8', shell: true });
  const num = (/** @type {string} */ k) => Number((t.stdout.match(new RegExp(`ℹ ${k} (\\d+)`)) ?? [])[1] ?? NaN);
  g.tests = num('tests'); g.tests_fail = num('fail');
}

const row = {
  ts: new Date().toISOString(), ...(label ? { label } : {}), head: git(['rev-parse', '--short', 'HEAD']),
  areas, largest, long_functions: longFns.length, longest: longFns.slice(0, 5),
  dup_windows: dups.length, dup_files: dupFiles.length, lib_import_edges: libEdges, lib_cycles: [...cycles],
  agent_words: agentWords, todos, cli_commands: cliCommands, ...g,
};

if (appendTo) {
  const file = join(ROOT, appendTo);
  const prev = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1) : undefined;
  appendFileSync(file, JSON.stringify(row) + '\n');
  if (prev) {
    /** @type {Record<string, string>} */
    const delta = {};
    const d = (/** @type {string} */ k, /** @type {number} */ a, /** @type {number} */ b) => { if (a !== b) delta[k] = `${a} -> ${b} (${b - a > 0 ? '+' : ''}${b - a})`; };
    for (const k of Object.keys(areas)) d(`${k}.lines`, prev.areas?.[k]?.lines ?? 0, areas[k].lines);
    d('long_functions', prev.long_functions, row.long_functions);
    d('dup_windows', prev.dup_windows, row.dup_windows);
    d('lib_import_edges', prev.lib_import_edges, row.lib_import_edges);
    d('lib_cycles', prev.lib_cycles?.length ?? 0, row.lib_cycles.length);
    for (const k of Object.keys(agentWords)) d(`agent_words.${k}`, prev.agent_words?.[k] ?? 0, agentWords[k]);
    d('todos', prev.todos, row.todos);
    d('cli_commands', prev.cli_commands, row.cli_commands);
    if (gates) d('tests', prev.tests ?? 0, /** @type {number} */ (g.tests));
    console.log(JSON.stringify({ row, delta_since: prev.label ?? prev.head, delta }, null, 2));
  } else console.log(JSON.stringify({ row }, null, 2));
} else console.log(JSON.stringify(row, null, 2));
void dirname;
