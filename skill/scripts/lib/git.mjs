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
 * Whether `sha` names a commit in this repository (false after a force-push, a rebase or in a shallow clone).
 * @param {string} root
 * @param {string} sha
 * @returns {boolean}
 */
export function hasCommit(root, sha) {
  return git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== undefined;
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

/**
 * A remote URL as the repo's web URL (`https://host/owner/repo`): credentials, a port on an ssh remote and a
 * trailing `.git` stripped; `git@host:owner/repo`, `ssh://` and `git://` remotes become `https://`. An `http(s)`
 * remote keeps its scheme and port. Returns undefined for a remote with no web form (a local path, `file://`).
 * @param {string} remote
 * @returns {string | undefined}
 */
export function webUrl(remote) {
  const s = remote.trim();
  /** @type {string} */ let scheme;
  /** @type {string} */ let host;
  /** @type {string} */ let path;
  const proto = s.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i);
  if (proto) {
    const p = proto[1].toLowerCase();
    if (!['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(p)) return undefined;
    const authority = proto[2].replace(/^[^@]*@/, ''); // credentials / ssh user
    scheme = p === 'http' ? 'http' : 'https';
    host = scheme === 'https' && p !== 'https' ? authority.replace(/:\d+$/, '') : authority; // an ssh port is not the web port
    path = proto[3] ?? '';
  } else {
    const scp = s.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/); // scp-like `user@host:owner/repo`
    if (!scp || /^[a-z]$/i.test(scp[1])) return undefined; // `C:\...` is a Windows path, not a host
    scheme = 'https';
    host = scp[1];
    path = `/${scp[2]}`;
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '/');
  if (!host || path.length < 2) return undefined;
  return `${scheme}://${host.toLowerCase()}${path}`;
}

/**
 * The committer date of `rev` as an ISO 8601 UTC string, or undefined when git does not know the rev.
 * @param {string} root
 * @param {string} rev
 * @returns {string | undefined}
 */
export function commitDate(root, rev) {
  const out = git(root, ['show', '-s', '--format=%cI', rev, '--']);
  if (!out) return undefined;
  const t = Date.parse(out);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Every file tracked in the tree of `rev` (`git ls-tree -r --name-only -z`), repo-relative with forward
 * slashes. Undefined when git cannot read the tree.
 * @param {string} root
 * @param {string} rev
 * @returns {string[] | undefined}
 */
export function treeFiles(root, rev) {
  const out = git(root, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', rev]);
  if (out === undefined) return undefined;
  return out.split('\0').filter(Boolean);
}

/**
 * The non-merge commits reachable from `rev` whose committer date is at or after `since`, newest first, each
 * with its author e-mail (lowercased), committer date (ISO UTC) and the paths it touched. One `git log` pass.
 * Undefined when git cannot walk the history.
 * @param {string} root
 * @param {string} rev
 * @param {string} since ISO timestamp
 * @returns {{email: string, at: string, paths: string[]}[] | undefined}
 */
export function commitsSince(root, rev, since) {
  const out = git(root, ['-c', 'core.quotePath=false', 'log', rev, `--since=${since}`, '--no-merges', '--no-renames',
    '--format=%x1e%ae%x1f%cI', '--name-only', '-z', '--']);
  if (out === undefined) return undefined;
  /** @type {{email: string, at: string, paths: string[]}[]} */
  const commits = [];
  for (const rec of out.split('\x1e').slice(1)) {
    // one record: `<email>\x1f<date>\0`, a newline, then the NUL-terminated paths the commit touched
    const sep = rec.indexOf('\x1f');
    if (sep < 0) continue;
    const [date, ...paths] = rec.slice(sep + 1).split('\0');
    const t = Date.parse(date.trim());
    if (Number.isNaN(t)) continue;
    commits.push({
      email: rec.slice(0, sep).trim().toLowerCase(),
      at: new Date(t).toISOString(),
      paths: paths.map((p) => p.replace(/^\n+/, '')).filter(Boolean),
    });
  }
  return commits;
}

/**
 * The committer date (ISO UTC) of the newest commit reachable from `rev` that touched `path`, or undefined.
 * @param {string} root
 * @param {string} rev
 * @param {string} path
 * @returns {string | undefined}
 */
export function lastChange(root, rev, path) {
  const sha = git(root, ['log', '-1', '--format=%H', rev, '--', path]);
  return sha ? commitDate(root, sha) : undefined;
}
