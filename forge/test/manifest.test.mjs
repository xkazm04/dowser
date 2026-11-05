// @ts-check
// forge/manifest.yml is the platform's ground truth; the code keeps its own lists of the same keys (core/app.mjs
// TOOL_NAMES, ROVO_ACTIONS, MODULE_KEYS, RESOLVERS; src/index.js KEYS and its exported handlers). A key on one
// side only ships a tool no agent can call, or a button whose resolver is undefined. The manifest is read with a
// small line parser (no YAML dependency); src/index.js imports @forge/*, so it is read as source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_KEYS, RESOLVERS, ROVO_ACTIONS, TOOL_NAMES } from '../src/core/app.mjs';

/** @typedef {{key: string, fields: Record<string, string>, lists: Record<string, string[]>, resolverFunction?: string}} Item */

/**
 * The `modules:` section as module type -> items, plus the function key -> handler map.
 * Only the shapes this manifest uses: `  type:`, `    - key: k`, `      field: value`, `      list:` + `        - v`.
 * @param {string} text
 * @returns {Record<string, Item[]>}
 */
function parseModules(text) {
  /** @type {Record<string, Item[]>} */
  const out = {};
  let inModules = false;
  /** @type {string | undefined} */ let type;
  /** @type {Item | undefined} */ let item;
  /** @type {string | undefined} */ let list;
  let inResolver = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!line.trim()) continue;
    if (/^\S/.test(line)) { inModules = line.startsWith('modules:'); type = undefined; item = undefined; continue; }
    if (!inModules) continue;
    let m;
    if ((m = /^ {2}([\w:]+):\s*$/.exec(line))) { type = m[1]; out[type] = []; item = undefined; continue; }
    if (!type) continue;
    if ((m = /^ {4}- key: (\S+)\s*$/.exec(line))) {
      item = { key: m[1], fields: {}, lists: {} };
      out[type].push(item);
      list = undefined; inResolver = false;
      continue;
    }
    if (!item) continue;
    if ((m = /^ {6}(\w+):\s*$/.exec(line))) { list = m[1]; inResolver = list === 'resolver'; if (!inResolver) item.lists[list] = []; continue; }
    if ((m = /^ {6}(\w+): (.+)$/.exec(line))) { item.fields[m[1]] = m[2].trim(); list = undefined; inResolver = false; continue; }
    if (inResolver && (m = /^ {8}function: (\S+)\s*$/.exec(line))) { item.resolverFunction = m[1]; continue; }
    if (list && !inResolver && (m = /^ {8}- (\S+)\s*$/.exec(line))) item.lists[list].push(m[1]);
  }
  return out;
}

const modules = parseModules(readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8'));
const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** @param {Iterable<string>} xs */
const sorted = (xs) => [...xs].sort();
/** @param {string} type */
const keysOf = (type) => (modules[type] ?? []).map((i) => i.key);

test('the manifest parser sees every module section this test relies on', () => {
  for (const t of ['rovo:mcp', 'action', 'rovo:agent', 'jira:globalPage', 'jira:issuePanel', 'confluence:contentBylineItem', 'confluence:pageBanner', 'function']) {
    assert.ok(keysOf(t).length > 0, `no ${t} items parsed from manifest.yml`);
  }
});

test('the rovo:mcp tools are exactly TOOL_NAMES', () => {
  const tools = (modules['rovo:mcp'] ?? []).flatMap((i) => i.lists.tools ?? []);
  assert.deepEqual(sorted(tools), sorted(TOOL_NAMES));
});

test('the action keys are TOOL_NAMES plus ROVO_ACTIONS, each on the function of its list', () => {
  const actions = modules.action ?? [];
  assert.deepEqual(sorted(actions.map((a) => a.key)), sorted([...TOOL_NAMES, ...ROVO_ACTIONS]));
  for (const a of actions) {
    const want = /** @type {readonly string[]} */ (TOOL_NAMES).includes(a.key) ? 'mcp' : 'rovo';
    assert.equal(a.fields.function, want, `action ${a.key} must run function ${want}`);
  }
});

test('every Rovo agent action is a manifest action the code knows', () => {
  const known = new Set(/** @type {string[]} */ ([...TOOL_NAMES, ...ROVO_ACTIONS]));
  for (const name of (modules['rovo:agent'] ?? []).flatMap((i) => i.lists.actions ?? [])) {
    assert.ok(known.has(name), `agent action ${name} has no handler`);
  }
});

test('the Custom UI modules are exactly MODULE_KEYS, each on the resolver function, and call only real resolvers', () => {
  const ui = ['jira:globalPage', 'jira:issuePanel', 'confluence:contentBylineItem', 'confluence:pageBanner'].flatMap((t) => modules[t] ?? []);
  assert.deepEqual(sorted(ui.map((i) => i.key)), sorted(Object.keys(MODULE_KEYS)));
  for (const i of ui) assert.equal(i.resolverFunction, 'resolver', `${i.key} must use the resolver function`);
  for (const [mod, keys] of Object.entries(MODULE_KEYS)) {
    for (const k of keys) assert.ok(Object.hasOwn(RESOLVERS, k), `${mod} may call ${k}, which RESOLVERS lacks`);
  }
});

test('every manifest function handler is exported from src/index.js', () => {
  for (const f of modules.function ?? []) {
    const m = /^index\.(\w+)$/.exec(f.fields.handler ?? '');
    assert.ok(m, `function ${f.key} handler ${f.fields.handler} is not index.<export>`);
    const name = m[1];
    const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`).test(index)
      || new RegExp(`export\\s*\\{[^}]*\\bas\\s+${name}\\b[^}]*\\}`).test(index);
    assert.ok(exported, `index.${name} (function ${f.key}) is not exported from src/index.js`);
  }
});

test('src/index.js defines every core resolver key (KEYS)', () => {
  const m = /const KEYS = ([\s\S]*?);\n/.exec(index);
  assert.ok(m, 'KEYS not found in src/index.js');
  if (/Object\.keys\(RESOLVERS\)/.test(m[1])) return;
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(sorted(listed), sorted(Object.keys(RESOLVERS)), 'KEYS must list every RESOLVERS key; derive it from Object.keys(RESOLVERS)');
});
