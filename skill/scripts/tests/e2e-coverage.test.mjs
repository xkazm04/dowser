// @ts-check
// tools/e2e-coverage.mjs: ids derived from the app's sources, `@covers` tags read from the specs, and the baseline
// ratchet (an uncovered id needs a spec or a baseline line; the baseline may only shrink). Runs on a small tree
// shaped like the repo, and once on the repo itself, so `npm test` holds the real e2e coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, removeDir, tempDir, writeFiles } from './_fixture.mjs';
import { coverage, fixtureConditions, manifestRoutes, resolverKeys, routerModules } from '../../../tools/e2e-coverage.mjs';

const TOOL = fileURLToPath(new URL('../../../tools/e2e-coverage.mjs', import.meta.url));

const SOURCES = {
  'forge/manifest.yml': [
    'modules:', '  jira:globalPage:', '    - key: dowser-inbox', '      pages:', '        - title: Inbox', '          route: inbox',
    '        - title: Map', '          route: map', '  jira:issuePanel:', '    - key: dowser-evidence', '      route: not-a-page', '',
  ].join('\n'),
  'forge/static/app/src/router.jsx': "const MODULES = { 'dowser-evidence': Panel };\nconst PAGES = { inbox: Inbox };\n",
  'forge/src/core/app.mjs': [
    'const x = { \'not.this\': 1 };', 'export const RESOLVERS = {', "  'inbox.list': async () => ({}),", "  'map.data': (d) => d,",
    "  // 'commented.out': no", '};', "const after = { 'also.not': 1 };", '',
  ].join('\n'),
  'forge/static/app/src/dev/bridge.js': "if (params().has('empty')) {}\nconst n = params().get('page');\n",
  'forge/static/app/src/dev/link.js': "export const LINK_KEYS = ['ref', 'area'];\n",
};

/** Every derived id of SOURCES, as the specs below tag them. */
const ALL = 'route:inbox route:map route:dowser-evidence resolver:inbox.list resolver:map.data fail:inbox.list fail:map.data fixture:empty fixture:page fixture:ref fixture:area';

/** @param {string} tags @param {string[]} [uncovered] */
const tree = (tags, uncovered = []) => ({
  ...SOURCES,
  'e2e/fixture/a.spec.mjs': `// @covers ${tags}\ntest('x', () => {});\n`,
  'e2e/live/b.spec.mjs': '// @covers live:sidebar\n',
  'e2e/coverage-baseline.json': `${JSON.stringify({ uncovered })}\n`,
});

/** @param {string} root @param {string[]} [args] */
function run(root, args = []) {
  const r = spawnSync(process.execPath, [TOOL, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : undefined, stderr: r.stderr };
}

test('derives routes, resolver keys and fixture conditions from the sources', () => {
  assert.deepEqual(manifestRoutes(SOURCES['forge/manifest.yml']), ['inbox', 'map']);
  assert.deepEqual(routerModules(SOURCES['forge/static/app/src/router.jsx']), ['dowser-evidence']);
  assert.deepEqual(resolverKeys(SOURCES['forge/src/core/app.mjs']), ['inbox.list', 'map.data']);
  assert.deepEqual(fixtureConditions(SOURCES['forge/static/app/src/dev/bridge.js'], SOURCES['forge/static/app/src/dev/link.js']), ['area', 'empty', 'page', 'ref']);
});

test('everything tagged: ok, with each id mapped to its spec line and free tags listed apart', () => {
  const root = tempDir('cov-ok');
  try {
    writeFiles(root, tree(ALL));
    const r = run(root, ['--against', 'none']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.ok, true);
    assert.deepEqual([r.out.covered, r.out.total], [11, 11]);
    assert.deepEqual(r.out.ids['resolver:map.data'], ['e2e/fixture/a.spec.mjs:1']);
    assert.deepEqual(r.out.free, { 'live:sidebar': ['e2e/live/b.spec.mjs:1'] });
  } finally { removeDir(root); }
});

test('a planted uncovered key fails, until a spec covers it or the baseline lists it', () => {
  const root = tempDir('cov-planted');
  try {
    writeFiles(root, tree(ALL));
    // plant a new resolver key with no spec
    const app = join(root, 'forge/src/core/app.mjs');
    writeFileSync(app, readFileSync(app, 'utf8').replace("  'map.data'", "  'planted.key': async () => ({}),\n  'map.data'"));
    const r = run(root, ['--against', 'none']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.unlisted, ['fail:planted.key', 'resolver:planted.key']);
    writeFiles(root, { 'e2e/coverage-baseline.json': JSON.stringify({ uncovered: ['fail:planted.key', 'resolver:planted.key'] }) });
    assert.equal(run(root, ['--against', 'none']).code, 0);
  } finally { removeDir(root); }
});

test('a typo in a tag of a derived kind fails instead of counting as coverage', () => {
  const root = tempDir('cov-typo');
  try {
    writeFiles(root, tree(`${ALL} resolver:inbox.lst`));
    const r = run(root, ['--against', 'none']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.unknown, ['resolver:inbox.lst']);
  } finally { removeDir(root); }
});

test('the baseline may only shrink: growth against git fails, a stale line fails until --write drops it', () => {
  const root = tempDir('cov-ratchet');
  try {
    const partial = ALL.replace(' fail:map.data', '');
    gitRepo(root, tree(partial, ['fail:map.data']));
    assert.equal(run(root).code, 0);

    // growth: a second id moves into the baseline instead of getting a spec
    writeFiles(root, tree(partial.replace(' fixture:area', ''), ['fail:map.data', 'fixture:area']));
    const grew = run(root);
    assert.equal(grew.code, 1);
    assert.deepEqual(grew.out.grew, ['fixture:area']);
    assert.equal(run(root, ['--against', 'none']).code, 0, 'without the git check the listed ids are allowed');

    // stale: the listed id got a spec, so its baseline line must go
    writeFiles(root, tree(ALL, ['fail:map.data']));
    const stale = run(root);
    assert.equal(stale.code, 1);
    assert.deepEqual(stale.out.stale, ['fail:map.data']);
    const wrote = run(root, ['--write']);
    assert.equal(wrote.code, 0, JSON.stringify(wrote.out));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'e2e/coverage-baseline.json'), 'utf8')), { uncovered: [] });
    execFileSync('git', ['-C', root, 'commit', '-qam', 'shrink'], { stdio: 'ignore' });
    assert.equal(run(root).code, 0);
  } finally { removeDir(root); }
});

test('bad arguments exit 2', () => {
  assert.equal(spawnSync(process.execPath, [TOOL, '--nope'], { encoding: 'utf8' }).status, 2);
});

test('the repository: every route, resolver key and fixture condition is covered or in the baseline', () => {
  const r = coverage({ root: fileURLToPath(new URL('../../../', import.meta.url)), against: 'none' });
  assert.equal(r.ok, true, JSON.stringify({ unlisted: r.unlisted, stale: r.stale, unknown: r.unknown }));
  assert.ok(r.total > 50, `only ${r.total} ids derived: a source moved and the reader no longer finds it`);
});
