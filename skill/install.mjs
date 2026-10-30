#!/usr/bin/env node
// @ts-check
/**
 * Dowser skill installer. Zero dependencies, Node >= 22.
 *
 *   node skill/install.mjs --harness claude|codex [--scope user|project] [--dev-link] [--dry-run]
 *
 * Targets (skill folder name: dowser):
 *   claude user     $CLAUDE_CONFIG_DIR/skills/dowser, else ~/.claude/skills/dowser
 *   claude project  <cwd>/.claude/skills/dowser
 *   codex  user     $CODEX_HOME/skills/dowser, else ~/.codex/skills/dowser
 *   codex  project  <cwd>/.agents/skills/dowser
 * Codex locations were verified against codex-cli 0.164.0 with `codex debug prompt-input`:
 * a skill under $CODEX_HOME/skills/<name> and one under <repo>/.agents/skills/<name> both
 * appear in the model-visible skill list, including through a directory junction.
 *
 * Copies SKILL.md, references/, lenses/, scripts/ (without tests/ and fixtures/), schema/, and writes
 * install.json into the copy: {name, version (SKILL.md frontmatter), harness, scope, installed_at,
 * source: {commit?, dirty?, repo_url?}} (repo_url is the checkout's `origin` with any credentials removed).
 * --dev-link makes the target a junction (Windows) or a symlink to this folder instead (no install.json:
 * a link tracks the checkout).
 * --dry-run prints the plan as JSON and changes nothing.
 *
 *   node skill/install.mjs --check --harness claude|codex [--scope user|project] [--from <git url or path>]
 *
 * --check compares the installed version with the newest release tag (vMAJOR.MINOR.PATCH) of its source
 * (install.json's repo_url, or --from) and prints a notice when a newer release exists. It is the only
 * network call the installer makes (`git ls-remote --tags`), and it runs only when asked for.
 *
 * Exit codes: 0 ok (for --check: checked, whether behind or not; see `behind`); 2 bad arguments;
 * 3 cannot install (Node too old, the source is incomplete, the target holds something that is not a
 * Dowser install, or a write failed) or, for --check, nothing installed / no source to compare with;
 * 4 --check could not list the release tags.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'dowser';
const ITEMS = ['SKILL.md', 'references', 'lenses', 'scripts', 'schema'];
const SKIP_DIRS = new Set(['tests', 'fixtures', 'node_modules']);
const STAMP_FILE = 'install.json';
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** @param {string} msg @param {number} code @returns {never} */
function fail(msg, code) {
  process.stderr.write(`install: ${msg}\n`);
  process.exit(code);
}

/**
 * @typedef {{harness: 'claude'|'codex', scope: 'user'|'project', devLink: boolean, dryRun: boolean,
 *   check: boolean, from?: string}} Options
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {string|undefined} */ let harness;
  let scope = 'user';
  let devLink = false;
  let dryRun = false;
  let check = false;
  /** @type {string|undefined} */ let from;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') harness = argv[++i];
    else if (a.startsWith('--harness=')) harness = a.slice(10);
    else if (a === '--scope') scope = argv[++i];
    else if (a.startsWith('--scope=')) scope = a.slice(8);
    else if (a === '--dev-link') devLink = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--check') check = true;
    else if (a === '--from') from = argv[++i];
    else if (a.startsWith('--from=')) from = a.slice(7);
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: node install.mjs --harness claude|codex [--scope user|project] [--dev-link] [--dry-run]\n'
        + '       node install.mjs --check --harness claude|codex [--scope user|project] [--from <git url or path>]\n');
      process.exit(0);
    } else fail(`unknown argument: ${a}`, 2);
  }
  if (harness !== 'claude' && harness !== 'codex') fail('--harness must be claude or codex', 2);
  if (scope !== 'user' && scope !== 'project') fail('--scope must be user or project', 2);
  if (from !== undefined && !from) fail('--from needs a git url or path', 2);
  if (from !== undefined && !check) fail('--from goes with --check', 2);
  if (check && (devLink || dryRun)) fail('--check takes no --dev-link or --dry-run', 2);
  return { harness, scope, devLink, dryRun, check, ...(from ? { from } : {}) };
}

/** The `version:` line of a SKILL.md frontmatter, if any. @param {string} dir @returns {string|undefined} */
function skillVersion(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^version:\s*(\S+)\s*$/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A git url without the credentials it may carry (`https://user:token@host/...` -> `https://host/...`).
 * @param {string} url @returns {string}
 */
function redactUrl(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** @param {string} cwd @param {string[]} args @returns {string|undefined} */
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Where this source folder came from: commit, whether the skill folder has uncommitted changes, and the
 * `origin` url (credentials removed). Each key is omitted when git cannot tell.
 * @param {string} source
 * @returns {{commit?: string, dirty?: boolean, repo_url?: string}}
 */
function sourceInfo(source) {
  const commit = git(source, ['rev-parse', 'HEAD']);
  if (!commit) return {};
  const status = git(source, ['status', '--porcelain', '--', '.']);
  const url = git(source, ['remote', 'get-url', 'origin']);
  return {
    commit,
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
    ...(url ? { repo_url: redactUrl(url) } : {}),
  };
}

/** @param {string} v @returns {number[]|undefined} */
function parseRelease(v) {
  const m = v.match(RELEASE_TAG);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** @param {number[]} a @param {number[]} b @returns {number} */
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The newest release tag among `git ls-remote --tags --refs` lines; other tags are ignored.
 * @param {string} lsRemote
 * @returns {string|undefined}
 */
function latestRelease(lsRemote) {
  /** @type {{tag: string, v: number[]}|undefined} */ let best;
  for (const line of lsRemote.split('\n')) {
    const tag = line.split('\t')[1]?.trim().replace(/^refs\/tags\//, '');
    const v = tag ? parseRelease(tag) : undefined;
    if (tag && v && (!best || cmp(v, best.v) > 0)) best = { tag, v };
  }
  return best?.tag;
}

/**
 * `--check`: read the installed copy's version and source, list the source's release tags, and say
 * whether a newer release exists and how to update.
 * @param {Options} opts
 */
function check(opts) {
  const target = targetDir(opts.harness, opts.scope);
  if (!(fs.existsSync(target) || isSymlink(target)) || !isDowserInstall(target)) {
    fail(`no Dowser install at ${target}; install it first: node skill/install.mjs --harness ${opts.harness}`, 3);
  }
  const linked = isSymlink(target);
  /** @type {{version?: string, source?: {commit?: string, repo_url?: string}}} */
  let stamp = {};
  if (linked) {
    const real = realOrSelf(target);
    stamp = { version: skillVersion(real), source: sourceInfo(real) };
  } else {
    try {
      stamp = JSON.parse(fs.readFileSync(path.join(target, STAMP_FILE), 'utf8'));
    } catch {
      stamp = { version: skillVersion(target) };
    }
  }
  const from = opts.from ?? stamp.source?.repo_url;
  if (!from) fail(`the install at ${target} records no source repository; pass --from <git url or path of the Dowser repo>`, 3);
  const installed = stamp.version;
  let listing;
  try {
    listing = execFileSync('git', ['ls-remote', '--tags', '--refs', from], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
  } catch (e) {
    const why = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr).trim().split('\n')[0] : String(e);
    fail(`could not list release tags at ${redactUrl(from)}: ${why || 'git failed'}`, 4);
  }
  const latest = latestRelease(listing);
  const cur = installed ? parseRelease(installed) : undefined;
  const lv = latest ? parseRelease(latest) : undefined;
  const behind = Boolean(lv && (!cur || cmp(cur, lv) < 0));
  const scopeArg = opts.scope === 'project' ? ' --scope project' : '';
  const update = linked
    ? `run git pull in ${realOrSelf(target)} (this install is linked to that checkout)`
    : `run git pull in your Dowser checkout, then node skill/install.mjs --harness ${opts.harness}${scopeArg}`;
  const notice = !latest
    ? `no release tags at ${redactUrl(from)} yet; only the latest commit on master receives security fixes (SECURITY.md)`
    : behind
      ? `Dowser ${installed ?? '(unknown version)'} is installed; release ${latest} is available and may carry security fixes. To update, ${update}.`
      : `Dowser ${installed} is installed; it is the newest release (${latest}).`;
  const result = {
    check: true,
    target,
    method: linked ? 'link' : 'copy',
    ...(installed ? { installed_version: installed } : {}),
    ...(stamp.source?.commit ? { installed_commit: stamp.source.commit } : {}),
    source: redactUrl(from),
    ...(latest ? { latest_release: latest } : {}),
    behind,
    notice,
  };
  if (behind) process.stderr.write(`dowser: ${notice}\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/**
 * @param {'claude'|'codex'} harness
 * @param {'user'|'project'} scope
 * @returns {string}
 */
function targetDir(harness, scope) {
  const home = os.homedir();
  if (harness === 'claude') {
    if (scope === 'project') return path.join(process.cwd(), '.claude', 'skills', SKILL_NAME);
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    return path.join(base, 'skills', SKILL_NAME);
  }
  if (scope === 'project') return path.join(process.cwd(), '.agents', 'skills', SKILL_NAME);
  const base = process.env.CODEX_HOME || path.join(home, '.codex');
  return path.join(base, 'skills', SKILL_NAME);
}

/** @param {string} p @returns {boolean} */
function isDowserInstall(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return true; // unlinking a link never deletes what it points to
    const head = fs.readFileSync(path.join(p, 'SKILL.md'), 'utf8').slice(0, 400);
    return /^name:\s*dowser\s*$/m.test(head);
  } catch {
    return false;
  }
}

/** @param {string} src @param {string} dst */
function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) || s === src,
  });
}

function main() {
  // node:sqlite (the store) is unflagged from 22.13; an earlier 22 installs fine and fails on the first scan.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail(`Node ${process.versions.node} found; Dowser needs Node 22.13 or newer, the first version with node:sqlite built in (Dowser's local memory)`, 3);

  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) return check(opts);
  const source = path.dirname(fileURLToPath(import.meta.url));
  const target = targetDir(opts.harness, opts.scope);
  const present = ITEMS.filter((i) => fs.existsSync(path.join(source, i)));
  const missing = ITEMS.filter((i) => !present.includes(i));
  const exists = fs.existsSync(target) || isSymlink(target);
  const replaceable = exists ? isDowserInstall(target) : true;

  /** @type {string[]} */
  const notes = [];
  if (opts.scope === 'project') {
    notes.push('project scope writes into the current folder; commit it or add it to .gitignore yourself');
  }
  const sameAsSource = !isSymlink(target) && realOrSelf(target) === realOrSelf(source);
  if (sameAsSource) notes.push('target is this source folder; nothing to do');

  const plan = {
    harness: opts.harness,
    scope: opts.scope,
    source,
    target,
    method: opts.devLink ? (process.platform === 'win32' ? 'junction' : 'symlink') : 'copy',
    items: present,
    missing,
    target_exists: exists,
    will_replace: exists && replaceable,
    notes,
  };
  const version = skillVersion(source);
  // a link tracks the checkout, so only a copy records where it came from
  const stamp = opts.devLink ? undefined : {
    name: SKILL_NAME,
    ...(version ? { version } : {}),
    harness: opts.harness,
    scope: opts.scope,
    installed_at: new Date().toISOString(),
    source: sourceInfo(source),
  };
  if (stamp) Object.assign(plan, { stamp });

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify({ dry_run: true, ...plan }, null, 2) + '\n');
    process.exit(0);
  }

  if (missing.length) fail(`source incomplete, missing: ${missing.join(', ')} (in ${source})`, 3);
  if (exists && !replaceable) fail(`${target} exists and is not a Dowser install; move it away first`, 3);
  if (sameAsSource) {
    process.stdout.write(JSON.stringify({ installed: false, ...plan }, null, 2) + '\n');
    process.exit(0);
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (exists) removeInstall(target);
    if (opts.devLink) {
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      fs.mkdirSync(target);
      for (const item of present) copyTree(path.join(source, item), path.join(target, item));
      fs.writeFileSync(path.join(target, STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n');
    }
  } catch (e) {
    fail(`write failed: ${e instanceof Error ? e.message : String(e)}`, 3);
  }
  process.stdout.write(JSON.stringify({ installed: true, ...plan }, null, 2) + '\n');
}

/** @param {string} p @returns {boolean} */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {string} */
function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Remove a previous install. A link is unlinked, never followed. @param {string} p */
function removeInstall(p) {
  if (isSymlink(p)) {
    // On Windows a junction is removed with rmdir semantics; unlink works for symlinks.
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p);
    }
    return;
  }
  fs.rmSync(p, { recursive: true, force: true });
}


main();
