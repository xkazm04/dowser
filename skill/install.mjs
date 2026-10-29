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
 * Copies SKILL.md, references/, lenses/, scripts/ (without tests/), schema/.
 * --dev-link makes the target a junction (Windows) or a symlink to this folder instead.
 * --dry-run prints the plan as JSON and changes nothing.
 *
 * Exit codes: 0 ok; 2 bad arguments; 3 cannot install (Node too old, the source is incomplete,
 * the target holds something that is not a Dowser install, or a write failed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'dowser';
const ITEMS = ['SKILL.md', 'references', 'lenses', 'scripts', 'schema'];
const SKIP_DIRS = new Set(['tests', 'node_modules']);

/** @param {string} msg @param {number} code @returns {never} */
function fail(msg, code) {
  process.stderr.write(`install: ${msg}\n`);
  process.exit(code);
}

/**
 * @param {string[]} argv
 * @returns {{harness: 'claude'|'codex', scope: 'user'|'project', devLink: boolean, dryRun: boolean}}
 */
function parseArgs(argv) {
  /** @type {string|undefined} */ let harness;
  let scope = 'user';
  let devLink = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') harness = argv[++i];
    else if (a.startsWith('--harness=')) harness = a.slice(10);
    else if (a === '--scope') scope = argv[++i];
    else if (a.startsWith('--scope=')) scope = a.slice(8);
    else if (a === '--dev-link') devLink = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: node install.mjs --harness claude|codex [--scope user|project] [--dev-link] [--dry-run]\n');
      process.exit(0);
    } else fail(`unknown argument: ${a}`, 2);
  }
  if (harness !== 'claude' && harness !== 'codex') fail('--harness must be claude or codex', 2);
  if (scope !== 'user' && scope !== 'project') fail('--scope must be user or project', 2);
  return { harness, scope, devLink, dryRun };
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
