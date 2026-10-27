// @ts-check
// Read-only git queries. Every call is execFileSync with an argument array (never a shell string), runs with
// `-C <root>`, and never writes to the repo. A query git cannot answer returns undefined (or an empty list),
// never a placeholder value.
import { execFileSync } from 'node:child_process';

/**
 * Runs git and returns trimmed stdout, or undefined when git fails (not a repo, no commits, no remote).
 * @param {string} root
 * @param {string[]} args
 * @returns {string | undefined}
 */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The work tree's top-level directory, or undefined when `dir` is not inside a git work tree.
 * @param {string} dir
 * @returns {string | undefined}
 */
export function toplevel(dir) {
  return git(dir, ['rev-parse', '--show-toplevel']) || undefined;
}

/**
 * HEAD's commit sha, or undefined (not a repo, or no commit yet).
 * @param {string} root
 * @returns {string | undefined}
 */
export function headSha(root) {
  return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) || undefined;
}

/**
 * `git remote get-url origin`, or undefined when there is no origin.
 * @param {string} root
 * @returns {string | undefined}
 */
export function originUrl(root) {
  return git(root, ['remote', 'get-url', 'origin']) || undefined;
}

/**
 * Paths changed between two commits (`git diff --name-only base head`), repo-relative with forward slashes.
 * Returns undefined when git cannot diff them (e.g. an unknown sha) - never an empty list in that case.
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @returns {string[] | undefined}
 */
export function diffNames(root, base, head) {
  const out = git(root, ['diff', '--name-only', '--no-renames', base, head]);
  if (out === undefined) return undefined;
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Distinct author e-mail count per path over the path's whole history (`git log --format=%ae -- <path>`).
 * A path git knows no commit for is omitted (unmeasured), never reported as 0.
 * @param {string} root
 * @param {string[]} paths
 * @returns {Record<string, number>}
 */
export function authorsOf(root, paths) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const p of paths) {
    const log = git(root, ['log', '--format=%ae', '--', p]);
    if (!log) continue;
    const n = new Set(log.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
    if (n > 0) out[p] = n;
  }
  return out;
}
