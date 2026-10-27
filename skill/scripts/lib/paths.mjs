// @ts-check
// Where Dowser keeps its memory (D7): ~/.dowser/projects/<project-key>/dowser.db, `DOWSER_HOME` overriding
// ~/.dowser. Nothing is ever written inside the scanned repo: every store path is checked against the repo's
// real path (realpath on both sides, so a junction or symlink cannot smuggle the store into the repo).
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { originUrl, toplevel } from './git.mjs';
import { DowserError } from './model.mjs';

/**
 * Dowser's home directory: `$DOWSER_HOME`, else `~/.dowser`.
 * @returns {string}
 */
export function dowserHome() {
  const env = process.env.DOWSER_HOME;
  return env && env.trim() ? resolve(env) : join(homedir(), '.dowser');
}

/**
 * The real path of `p`, or of its nearest existing ancestor joined with the missing tail.
 * @param {string} p
 * @returns {string}
 */
export function realish(p) {
  let cur = resolve(p);
  /** @type {string[]} */
  const tail = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
  let base = cur;
  try { base = realpathSync.native(cur); } catch { /* keep the resolved path */ }
  return tail.length ? join(base, ...tail) : base;
}

/**
 * The scanned repo's root: the git top level containing `dir` (real path), else `dir`'s real path.
 * @param {string} dir
 * @returns {string}
 */
export function repoRoot(dir) {
  const top = toplevel(resolve(dir));
  return realish(top ?? dir);
}

/**
 * True when `inner` is `outer` or lies inside it (both compared by real path).
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
export function isInside(outer, inner) {
  const rel = relative(realish(outer), realish(inner));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * A remote URL as a project key slug: protocol, credentials and a trailing `.git` stripped, the host
 * lowercased, `/` and every other non-alphanumeric run turned into one `-`.
 * `https://tok@GitHub.com/Org/Repo.git` and `git@github.com:Org/Repo.git` both give `github-com-Org-Repo`.
 * @param {string} url
 * @returns {string}
 */
export function normalizeRemote(url) {
  let s = url.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // protocol
  s = s.replace(/^[^@/]*@/, ''); // credentials / ssh user
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  // scp-like `host:path` (no protocol): the first ':' separates host and path unless it is a port
  const m = s.match(/^([^/:]+)(?::(\d+)(?=\/|$))?[:/]?(.*)$/);
  let host = s, path = '';
  if (m) { host = m[2] ? `${m[1]}:${m[2]}` : m[1]; path = m[3]; }
  const joined = `${host.toLowerCase()}/${path}`;
  return joined.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The project key (D7): the normalized origin URL, else `local-` + the first 12 hex of sha256(realpath(root)).
 * @param {string} root the repo root
 * @returns {string}
 */
export function projectKey(root) {
  const url = originUrl(root);
  const slug = url ? normalizeRemote(url) : '';
  if (slug) return slug;
  return `local-${createHash('sha256').update(realish(root)).digest('hex').slice(0, 12)}`;
}

/**
 * The store file for a repo: `<home>/projects/<key>/dowser.db`. Refuses (exit 3) when that path would land
 * inside the scanned repo.
 * @param {string} root the repo root
 * @returns {string}
 */
export function dbPath(root) {
  const p = join(dowserHome(), 'projects', projectKey(root), 'dowser.db');
  if (isInside(root, p)) {
    throw new DowserError(`the store path ${p} lies inside the scanned repo ${root}; set DOWSER_HOME outside it`, 3);
  }
  return p;
}
