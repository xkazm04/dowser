#!/usr/bin/env node
// @ts-check
/**
 * Release SBOMs: one CycloneDX JSON file per shipped lockfile, produced by `npm sbom` (built into npm 9.5+,
 * so Dowser takes on no dependency). Zero dependencies, Node >= 22.
 *
 *   node tools/sbom.mjs [--out <dir>] [--root <repo>] [--allow-dirty]      (npm run sbom)
 *
 * Targets, each read from its committed package-lock.json with `--package-lock-only --omit dev` (what
 * ships, not the build tools):
 *   skill     <root>/package-lock.json                 the skill (zero runtime dependencies: an SBOM that
 *                                                      lists the component and nothing else)
 *   forge     <root>/forge/package-lock.json           the Forge app backend deployed to customer sites
 *   forge-ui  <root>/forge/static/app/package-lock.json the inbox UI bundled into the Forge app
 * Files: <out>/dowser-<target>-v<version>.cdx.json, where version is skill/SKILL.md's `version:`, which
 * must equal the root package.json version (one version number per release). Default --out:
 * <OS temp>/dowser-sbom-v<version>; attach the files to the release: `gh release create v<version> ... <out>/*.cdx.json`
 * (SECURITY.md "Cutting a release").
 *
 * A lockfile or package.json with uncommitted changes (or a root that is not a git checkout) is refused:
 * an SBOM from a lockfile nobody committed misstates the release. --allow-dirty overrides it for a trial.
 *
 * npm refuses a tree whose peer ranges do not hold (ESBOMPROBLEMS; the Forge UI's react 19 under @atlaskit
 * packages that ask for react ^18, 2026-10-30). The tool then reruns with --legacy-peer-deps, which still
 * lists what the lockfile installs, and reports npm's problem lines as `tree_problems` and on stderr.
 *
 * Output: {release, out, files: [{target, dir, file, components, tree_problems?}]} on stdout.
 * Exit codes: 0 written; 2 bad arguments; 3 cannot produce (version mismatch, missing or uncommitted
 * lockfile, npm sbom failed or did not return CycloneDX).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = /** @type {const} */ ([
  { target: 'skill', dir: '.' },
  { target: 'forge', dir: 'forge' },
  { target: 'forge-ui', dir: 'forge/static/app' },
]);

/** @param {string} msg @param {number} code @returns {never} */
function fail(msg, code) {
  process.stderr.write(`sbom: ${msg}\n`);
  process.exit(code);
}

/** @param {string[]} argv @returns {{root: string, out?: string, allowDirty: boolean}} */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** @type {string|undefined} */ let out;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out = path.resolve(argv[++i]);
    else if (a === '--allow-dirty') allowDirty = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: node tools/sbom.mjs [--out <dir>] [--root <repo>] [--allow-dirty]\n');
      process.exit(0);
    } else fail(`unknown or incomplete argument: ${a}`, 2);
  }
  return { root, allowDirty, ...(out ? { out } : {}) };
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, 3);
  }
}

/** The release version: SKILL.md's, checked against the root package.json. @param {string} root */
function releaseVersion(root) {
  let skill;
  try {
    skill = fs.readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf8').match(/^version:\s*(\S+)\s*$/m)?.[1];
  } catch {
    skill = undefined;
  }
  if (!skill) fail(`no version: line in ${path.join(root, 'skill', 'SKILL.md')}`, 3);
  const pkg = readJson(path.join(root, 'package.json')).version;
  if (pkg !== skill) fail(`skill/SKILL.md says version ${skill} but package.json says ${pkg}; one release has one version number`, 3);
  return skill;
}

/**
 * The files among `rels` (repo-relative) that git reports as changed or untracked; undefined when the
 * root is not a git checkout.
 * @param {string} root @param {string[]} rels @returns {string[]|undefined}
 */
function uncommitted(root, rels) {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...rels], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  } catch {
    return undefined;
  }
}

/**
 * Run `npm sbom` in `cwd`. npm refuses a tree with invalid peer ranges (ESBOMPROBLEMS) although the lockfile
 * still says exactly what is installed; then it runs again with --legacy-peer-deps and returns the problems
 * it named, so the output reports them instead of hiding them.
 * @param {string} cwd @returns {{text: string, problems?: string[]}}
 */
function npmSbom(cwd) {
  const first = npmRun(cwd, []);
  if (first.status === 0) return { text: first.stdout };
  if (!/ESBOMPROBLEMS/.test(first.stderr)) {
    fail(`npm sbom in ${cwd} exited ${first.status}: ${first.stderr.trim().split('\n')[0]}`, 3);
  }
  const problems = first.stderr.split('\n').map((l) => l.match(/^npm error (invalid|missing|extraneous): (.+)$/))
    .filter((m) => m !== null).map((m) => `${m[1]}: ${m[2].trim()}`);
  const second = npmRun(cwd, ['--legacy-peer-deps']);
  if (second.status !== 0) fail(`npm sbom in ${cwd} exited ${second.status}: ${second.stderr.trim().split('\n')[0]}`, 3);
  return { text: second.stdout, problems };
}

/** @param {string} cwd @param {string[]} extra @returns {{status: number|null, stdout: string, stderr: string}} */
function npmRun(cwd, extra) {
  const args = ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only', '--omit', 'dev', ...extra];
  const opts = /** @type {const} */ ({ cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const execpath = process.env.npm_execpath;
  // under `npm run` the npm CLI script is known: run it with this node, no shell
  const r = execpath && /\.c?js$/.test(execpath)
    ? spawnSync(process.execPath, [execpath, ...args], opts)
    // on Windows npm is a .cmd shim that only runs under a shell; the args are fixed flags
    : process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { ...opts, shell: true })
      : spawnSync('npm', args, opts);
  if (r.error) fail(`npm sbom in ${cwd} failed: ${r.error.message}`, 3);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = releaseVersion(opts.root);
  const release = `v${version}`;
  const out = opts.out ?? path.join(os.tmpdir(), `dowser-sbom-${release}`);

  const inputs = TARGETS.flatMap((t) => ['package.json', 'package-lock.json'].map((f) => path.posix.join(t.dir, f)));
  for (const rel of inputs) {
    if (!fs.existsSync(path.join(opts.root, rel))) fail(`${rel} is missing; npm sbom reads the committed lockfile`, 3);
  }
  if (!opts.allowDirty) {
    const dirty = uncommitted(opts.root, inputs);
    if (!dirty) fail(`${opts.root} is not a git checkout, so the lockfiles cannot be shown committed (--allow-dirty to try anyway)`, 3);
    if (dirty.length) fail(`uncommitted: ${dirty.join(', ')}; commit the lockfiles first (--allow-dirty to try anyway)`, 3);
  }

  fs.mkdirSync(out, { recursive: true });
  const files = TARGETS.map(({ target, dir }) => {
    const cwd = path.join(opts.root, dir);
    const { text, problems } = npmSbom(cwd);
    if (problems?.length) {
      process.stderr.write(`sbom: ${target}: npm reports ${problems.length} dependency tree problem(s); generated with --legacy-peer-deps:\n${problems.map((p) => `  ${p}\n`).join('')}`);
    }
    let bom;
    try {
      bom = JSON.parse(text);
    } catch {
      return fail(`npm sbom in ${cwd} did not print JSON`, 3);
    }
    if (bom?.bomFormat !== 'CycloneDX') fail(`npm sbom in ${cwd} did not return a CycloneDX document`, 3);
    const file = path.join(out, `dowser-${target}-${release}.cdx.json`);
    fs.writeFileSync(file, JSON.stringify(bom, null, 2) + '\n');
    return {
      target, dir, file, components: Array.isArray(bom.components) ? bom.components.length : 0,
      ...(problems ? { tree_problems: problems } : {}),
    };
  });
  process.stdout.write(JSON.stringify({ release, out, files }, null, 2) + '\n');
}

main();
