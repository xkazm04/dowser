// @ts-check
// `dowser deps` (lens-quality-plan WP4): runs the dependency auditors present on this machine (npm audit,
// osv-scanner, pip-audit), read-only against the repo, normalises their findings to `dep` source items and caches
// them on the run, so the security-cra lens cites them and `verify` can re-check a cited dep ref. An auditor that
// is absent or fails is reported as skipped, never as "no vulnerabilities".
//
// Read-only. Manifest directories are the root plus every directory up to MAX_DEPTH below it that holds a
// manifest an auditor reads (workspaces, apps/*, services/*); node_modules, dot folders and build output are never
// entered, and test or fixture paths are reported as not audited instead of audited. Each auditor runs with
// cwd = its directory and flags that read the lockfile without installing (`npm audit --package-lock-only`, `pip-audit -r` resolves in its own temp
// venv), with a 60 s timeout. Nothing installs, nothing rewrites a lockfile. The auditors still reach their
// advisory databases over the network; no offline flag is passed, because an offline run without a local
// database would answer "no findings" - skipped spelled as clean.
//
// One cached row per `<manifest>#<package>@<version>` (cards.md's dep ref): when several advisories (or several
// tools) hit the same package version, the most severe names the title and `advisories` lists every id.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import * as store from './store.mjs';

/** Per-auditor wall-clock limit. */
export const AUDIT_TIMEOUT_MS = 60_000;
/** Severities, most severe first; `unknown` when the tool gives none (pip-audit). */
export const SEVERITIES = /** @type {const} */ (['critical', 'high', 'moderate', 'low', 'info', 'unknown']);
/** The root lockfiles osv-scanner reads (osv-scanner docs, "supported languages and lockfiles"). */
export const OSV_LOCKFILES = /** @type {const} */ (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'Cargo.lock', 'go.mod', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock',
  'requirements.txt', 'pom.xml', 'gradle.lockfile', 'buildscript-gradle.lockfile', 'mix.lock', 'pubspec.lock',
  'packages.lock.json', 'conan.lock', 'renv.lock']);
const REQUIREMENTS_RE = /^requirements[\w.-]*\.txt$/;
/** How deep below the root manifest directories are looked for (forge/static/app is 3). */
export const MAX_DEPTH = 3;
/** At most this many directories below the root are audited (each auditor has 60 s per directory); the rest are
 * reported as not audited. */
export const MAX_DIRS = 25;
const NEVER_ENTER = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'coverage']);
const TEST_PATH_RE = /(^|\/)(test|tests|__tests__|spec|fixtures?|__fixtures__|examples?|testdata)(\/|$)/;

/**
 * @typedef {{tool: string, dir?: string, state: 'ran' | 'skipped', reason?: string, found?: number}} AuditorReport
 * @typedef {{manifest: string, package: string, version: string, advisory: string, severity: typeof SEVERITIES[number],
 *   url?: string, fixed_in?: string, tool: string}} Finding
 * @typedef {{status: number | null, stdout: string, stderr: string, error?: Error}} SpawnResult
 * @typedef {{which: (cmd: string) => string | undefined, spawn: (path: string, args: string[], cwd: string) => SpawnResult}} System
 */

/**
 * The executable `cmd` resolves to on PATH (with PATHEXT on Windows), or undefined when it is not installed.
 * @param {string} cmd
 * @returns {string | undefined}
 */
export function which(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), cmd + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return undefined;
}

/** @type {System} */
export const SYSTEM = {
  which,
  spawn(path, args, cwd) {
    // a .cmd/.bat shim (npm on Windows) only runs under a shell; the args are fixed flags and root file names
    // matched by name patterns without spaces or shell characters, so one command line is safe to build
    const shell = /\.(cmd|bat)$/i.test(path);
    /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
    const opts = { cwd, encoding: 'utf8', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const r = shell ? spawnSync(`"${path}" ${args.join(' ')}`, { ...opts, shell: true }) : spawnSync(path, args, opts);
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  },
};

/** @param {unknown} v @returns {string} */
const firstLine = (v) => String(v ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

/**
 * A severity word as one of SEVERITIES (`MODERATE`, `medium` -> moderate), or a CVSS base score bucketed.
 * @param {unknown} v
 * @returns {typeof SEVERITIES[number]}
 */
export function severityOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'medium') return 'moderate';
  if (/** @type {readonly string[]} */ (SEVERITIES).includes(s)) return /** @type {typeof SEVERITIES[number]} */ (s);
  const n = Number(s);
  if (s && Number.isFinite(n)) return n >= 9 ? 'critical' : n >= 7 ? 'high' : n >= 4 ? 'moderate' : n > 0 ? 'low' : 'info';
  return 'unknown';
}

/**
 * Why a run's output is unusable, or undefined when it can be parsed. A tool that could not start, timed out
 * or exited with a status outside `ok` is skipped with the first line of what it said.
 * @param {SpawnResult} r
 * @param {number[]} ok
 * @returns {string | undefined}
 */
function failure(r, ok) {
  if (r.error) return /** @type {NodeJS.ErrnoException} */ (r.error).code === 'ETIMEDOUT' ? `timed out after ${AUDIT_TIMEOUT_MS / 1000} s` : firstLine(r.error.message);
  if (r.status === null || !ok.includes(r.status)) return firstLine(r.stderr) || firstLine(r.stdout) || `exited ${r.status}`;
  return undefined;
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// ------------------------------------------------------------------------------------------------ npm audit

/**
 * The installed version of the package at lockfile node `node` (`node_modules/a/node_modules/b`), from the
 * lockfile's `packages` (v2/v3) or the nested `dependencies` (v1), or undefined.
 * @param {any} lock
 * @param {string} node
 * @returns {string | undefined}
 */
function lockVersion(lock, node) {
  const v = lock?.packages?.[node]?.version;
  if (typeof v === 'string') return v;
  /** @type {any} */
  let deps = lock?.dependencies;
  /** @type {string | undefined} */
  let out;
  for (const name of node.split(/(?:^|\/)node_modules\//).filter(Boolean)) {
    const d = deps?.[name];
    if (!d) return undefined;
    out = typeof d.version === 'string' ? d.version : undefined;
    deps = d.dependencies;
  }
  return out;
}

/**
 * The findings of an `npm audit --json` (auditReportVersion 2) report. Only object `via` entries are advisories;
 * a string `via` points at another vulnerable package, which has its own entry.
 * @param {any} report
 * @param {any} lock the parsed package-lock.json
 * @param {string} [manifest] the lockfile's repo-relative path
 * @returns {Finding[]}
 */
export function npmFindings(report, lock, manifest = 'package-lock.json') {
  /** @type {Finding[]} */
  const out = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities ?? {})) {
    const advisories = (Array.isArray(v?.via) ? v.via : []).filter((/** @type {any} */ a) => a && typeof a === 'object');
    if (!advisories.length) continue;
    const fixed = v.fixAvailable && typeof v.fixAvailable === 'object' && v.fixAvailable.name === name && typeof v.fixAvailable.version === 'string'
      ? v.fixAvailable.version : undefined;
    const versions = new Set((Array.isArray(v.nodes) ? v.nodes : []).map((/** @type {string} */ n) => lockVersion(lock, n)).filter(Boolean));
    for (const version of versions) {
      for (const a of advisories) {
        const url = typeof a.url === 'string' ? a.url : undefined;
        const ghsa = url?.match(/GHSA(-[23456789cfghjmpqrvwx]{4}){3}/)?.[0];
        out.push(/** @type {Finding} */ (store.clean({
          manifest, package: name, version: String(version), advisory: ghsa ?? `npm-${a.source ?? a.name ?? 'advisory'}`,
          severity: severityOf(a.severity ?? v.severity), url, fixed_in: fixed, tool: 'npm-audit',
        })));
      }
    }
  }
  return out;
}

/**
 * @param {string} root the repo root
 * @param {string} dir the manifest directory, repo-relative ('' = the root)
 * @param {System} sys
 * @returns {{report: AuditorReport, findings: Finding[]}}
 */
function npmAudit(root, dir, sys) {
  const tool = 'npm-audit';
  const cwd = join(root, dir);
  const hasLock = existsSync(join(cwd, 'package-lock.json'));
  if (!hasLock) {
    const reason = existsSync(join(cwd, 'package.json')) ? 'package.json without package-lock.json; npm audit needs a lockfile' : 'no package.json or package-lock.json';
    return { report: { tool, state: 'skipped', reason }, findings: [] };
  }
  const exe = sys.which('npm');
  if (!exe) return { report: { tool, state: 'skipped', reason: 'not installed' }, findings: [] };
  // exit 1 means "vulnerabilities found"; an npm error is a JSON {error: {code, summary}}
  const r = sys.spawn(exe, ['audit', '--json', '--package-lock-only'], cwd);
  const why = failure(r, [0, 1]);
  const report = parseJson(r.stdout);
  if (why && !report?.error) return { report: { tool, state: 'skipped', reason: why }, findings: [] };
  if (!report || typeof report !== 'object') return { report: { tool, state: 'skipped', reason: firstLine(r.stderr) || 'output was not JSON' }, findings: [] };
  if (report.error) return { report: { tool, state: 'skipped', reason: firstLine(report.error.summary ?? report.error.code ?? 'npm audit failed') }, findings: [] };
  const lock = parseJson(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  return finish(tool, npmFindings(report, lock, inDir(dir, 'package-lock.json')));
}

// ------------------------------------------------------------------------------------------------ osv-scanner

/** `name` inside the repo-relative `dir` ('' = the root). @param {string} dir @param {string} name */
const inDir = (dir, name) => (dir ? `${dir}/${name}` : name);

/**
 * A repo-relative manifest path with forward slashes (osv-scanner reports absolute source paths; a relative one is
 * relative to the directory it ran in).
 * @param {string} root
 * @param {unknown} p
 * @param {string} [dir]
 * @returns {string}
 */
function manifestRel(root, p, dir = '') {
  const s = String(p ?? '');
  const rel = isAbsolute(s) ? relative(root, s) : inDir(dir, s);
  return rel.split(sep).join('/').replace(/^\.\//, '');
}

/**
 * The fixed version an OSV record names for `pkg`, or undefined.
 * @param {any} vuln
 * @param {string} pkg
 * @returns {string | undefined}
 */
function osvFixed(vuln, pkg) {
  for (const af of Array.isArray(vuln?.affected) ? vuln.affected : []) {
    if (af?.package?.name !== undefined && af.package.name !== pkg) continue;
    for (const range of Array.isArray(af?.ranges) ? af.ranges : []) {
      for (const ev of Array.isArray(range?.events) ? range.events : []) if (typeof ev?.fixed === 'string') return ev.fixed;
    }
  }
  return undefined;
}

/**
 * The findings of an `osv-scanner --format json` report. Aliased records of one package (a GHSA and its CVE)
 * count once: the first id of each `groups[]` entry, else every record whose id no earlier record aliased.
 * @param {any} report
 * @param {string} root
 * @param {string} [dir] the repo-relative directory osv-scanner ran in
 * @returns {Finding[]}
 */
export function osvFindings(report, root, dir = '') {
  /** @type {Finding[]} */
  const out = [];
  for (const res of Array.isArray(report?.results) ? report.results : []) {
    const manifest = manifestRel(root, res?.source?.path, dir);
    for (const p of Array.isArray(res?.packages) ? res.packages : []) {
      const name = p?.package?.name;
      const version = p?.package?.version;
      if (typeof name !== 'string' || typeof version !== 'string') continue;
      /** @type {Map<string, any>} */
      const byId = new Map((Array.isArray(p.vulnerabilities) ? p.vulnerabilities : []).map((/** @type {any} */ v) => [String(v?.id), v]));
      const groups = Array.isArray(p.groups) && p.groups.length
        ? p.groups.map((/** @type {any} */ g) => ({ ids: Array.isArray(g?.ids) ? g.ids.map(String) : [], max: g?.max_severity }))
        : [...byId.keys()].map((id) => ({ ids: [id], max: undefined }));
      /** @type {Set<string>} */
      const seen = new Set();
      for (const g of groups) {
        const id = g.ids.find((/** @type {string} */ i) => byId.has(i)) ?? g.ids[0];
        if (!id || seen.has(id)) continue;
        const v = byId.get(id);
        for (const a of [id, ...(Array.isArray(v?.aliases) ? v.aliases.map(String) : [])]) seen.add(a);
        out.push(/** @type {Finding} */ (store.clean({
          manifest, package: name, version, advisory: id,
          severity: severityOf(v?.database_specific?.severity ?? g.max), url: `https://osv.dev/vulnerability/${id}`,
          fixed_in: osvFixed(v, name), tool: 'osv-scanner',
        })));
      }
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string[]} files the directory's file names
 * @param {System} sys
 * @returns {{report: AuditorReport, findings: Finding[]}}
 */
function osvScanner(root, dir, files, sys) {
  const tool = 'osv-scanner';
  const locks = OSV_LOCKFILES.filter((f) => files.includes(f));
  if (!locks.length) return { report: { tool, state: 'skipped', reason: 'no lockfile osv-scanner reads' }, findings: [] };
  const exe = sys.which('osv-scanner');
  if (!exe) return { report: { tool, state: 'skipped', reason: 'not installed' }, findings: [] };
  // 0 = no vulnerabilities, 1 = vulnerabilities found; 128 = no packages found; anything else is an error
  const r = sys.spawn(exe, ['--format', 'json', ...locks.map((f) => `--lockfile=${f}`)], join(root, dir));
  if (r.status === 128) return finish(tool, []);
  const why = failure(r, [0, 1]);
  if (why) return { report: { tool, state: 'skipped', reason: why }, findings: [] };
  const report = parseJson(r.stdout);
  if (!report || typeof report !== 'object') return { report: { tool, state: 'skipped', reason: firstLine(r.stderr) || 'output was not JSON' }, findings: [] };
  return finish(tool, osvFindings(report, root, dir));
}

// ------------------------------------------------------------------------------------------------ pip-audit

/**
 * The findings of a `pip-audit -f json` report (`{dependencies: [...]}`, or the older top-level array). pip-audit
 * gives no severity: `unknown`.
 * @param {any} report
 * @param {string} manifest
 * @returns {Finding[]}
 */
export function pipFindings(report, manifest) {
  const deps = Array.isArray(report) ? report : Array.isArray(report?.dependencies) ? report.dependencies : [];
  /** @type {Finding[]} */
  const out = [];
  for (const d of deps) {
    if (typeof d?.name !== 'string' || typeof d?.version !== 'string') continue;
    for (const v of Array.isArray(d.vulns) ? d.vulns : []) {
      if (!v?.id) continue;
      const fix = Array.isArray(v.fix_versions) ? v.fix_versions.find((/** @type {unknown} */ f) => typeof f === 'string') : undefined;
      out.push(/** @type {Finding} */ (store.clean({
        manifest, package: d.name, version: d.version, advisory: String(v.id), severity: 'unknown',
        url: `https://osv.dev/vulnerability/${v.id}`, fixed_in: fix, tool: 'pip-audit',
      })));
    }
  }
  return out;
}

/**
 * One pip-audit run per requirements file of the directory, and one over it when it has a pyproject.toml.
 * @param {string} root
 * @param {string} dir
 * @param {string[]} files
 * @param {System} sys
 * @returns {{report: AuditorReport, findings: Finding[]}}
 */
function pipAudit(root, dir, files, sys) {
  const tool = 'pip-audit';
  const reqs = files.filter((f) => REQUIREMENTS_RE.test(f)).sort();
  const targets = [...reqs.map((f) => ({ manifest: inDir(dir, f), args: ['-r', f] })),
    ...(files.includes('pyproject.toml') ? [{ manifest: inDir(dir, 'pyproject.toml'), args: ['.'] }] : [])];
  if (!targets.length) return { report: { tool, state: 'skipped', reason: 'no requirements*.txt or pyproject.toml' }, findings: [] };
  const exe = sys.which('pip-audit');
  if (!exe) return { report: { tool, state: 'skipped', reason: 'not installed' }, findings: [] };
  /** @type {Finding[]} */
  const findings = [];
  for (const t of targets) {
    // exit 1 means "vulnerabilities found"; pip-audit resolves -r in a temp venv and installs nothing here
    const r = sys.spawn(exe, ['-f', 'json', '--progress-spinner', 'off', ...t.args], join(root, dir));
    const why = failure(r, [0, 1]);
    const report = why ? undefined : parseJson(r.stdout);
    if (!report) return { report: { tool, state: 'skipped', reason: `${t.manifest}: ${why ?? (firstLine(r.stderr) || 'output was not JSON')}` }, findings: [] };
    findings.push(...pipFindings(report, t.manifest));
  }
  return finish(tool, findings);
}

// ------------------------------------------------------------------------------------------------ run

/** @param {string} dir @returns {string[]} the file names in `dir` */
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);

/** Whether any auditor reads a manifest among `files`. @param {string[]} files */
const hasManifest = (files) => files.some((f) => f === 'package-lock.json' || f === 'pyproject.toml' || REQUIREMENTS_RE.test(f)
  || /** @type {readonly string[]} */ (OSV_LOCKFILES).includes(f));

/**
 * The directories to audit: the root, then every directory up to MAX_DEPTH below it holding a manifest, sorted,
 * at most MAX_DIRS of them. Test and fixture paths, and directories beyond the cap, are returned as not audited.
 * @param {string} root
 * @returns {{audit: string[], notAudited: {dir: string, reason: string}[]}}
 */
export function manifestDirs(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} rel @param {number} depth */
  const walk = (rel, depth) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || NEVER_ENTER.has(d.name)) continue;
      const sub = inDir(rel, d.name);
      if (hasManifest(filesIn(join(root, sub)))) found.push(sub);
      if (depth < MAX_DEPTH) walk(sub, depth + 1);
    }
  };
  walk('', 1);
  found.sort();
  const tests = found.filter((d) => TEST_PATH_RE.test(d));
  const rest = found.filter((d) => !TEST_PATH_RE.test(d));
  return {
    audit: ['', ...rest.slice(0, MAX_DIRS)],
    notAudited: [...tests.map((dir) => ({ dir, reason: 'test or fixture path' })),
      ...rest.slice(MAX_DIRS).map((dir) => ({ dir, reason: `more than ${MAX_DIRS} manifest directories` }))],
  };
}

/**
 * The auditors for one directory. The root runs all three, so each reports why it ran or not; a directory below
 * it runs only those that read one of its manifests, and its reports carry `dir`.
 * @param {string} root @param {string} dir @param {System} sys
 * @returns {{report: AuditorReport, findings: Finding[]}[]}
 */
function auditDir(root, dir, sys) {
  const files = filesIn(join(root, dir));
  if (!dir) return [npmAudit(root, dir, sys), osvScanner(root, dir, files, sys), pipAudit(root, dir, files, sys)];
  const runs = [
    ...(files.includes('package-lock.json') ? [npmAudit(root, dir, sys)] : []),
    ...(OSV_LOCKFILES.some((f) => files.includes(f)) ? [osvScanner(root, dir, files, sys)] : []),
    ...(files.includes('pyproject.toml') || files.some((f) => REQUIREMENTS_RE.test(f)) ? [pipAudit(root, dir, files, sys)] : []),
  ];
  return runs.map(({ report: { tool, ...rest }, findings }) => ({ report: { tool, dir, ...rest }, findings }));
}

/** A tool that is not installed is reported once, without a directory. @param {AuditorReport[]} reports */
function onceNotInstalled(reports) {
  /** @type {Set<string>} */
  const seen = new Set();
  return reports.flatMap((r) => {
    if (r.reason !== 'not installed') return [r];
    if (seen.has(r.tool)) return [];
    seen.add(r.tool);
    const { dir, ...rest } = r;
    return [rest];
  });
}

/**
 * @param {string} tool
 * @param {Finding[]} findings
 * @returns {{report: AuditorReport, findings: Finding[]}}
 */
const finish = (tool, findings) => ({ report: { tool, state: 'ran', found: new Set(findings.map(depRef)).size }, findings });

/** @param {Finding} f */
export const depRef = (f) => `${f.manifest}#${f.package}@${f.version}`;

/**
 * Runs the auditors and caches one `dep` row per finding ref on the run (a re-run of the same run upserts).
 * @param {import('./store.mjs').Db} db
 * @param {{root: string, runId: string}} o
 * @param {System} [sys] the PATH lookup and spawner (tests inject a fake)
 * @returns {{out: {auditors: AuditorReport[], refs: {type: 'dep', ref: string, title: string, url?: string, fixed_in?: string}[],
 *   not_audited?: {dir: string, reason: string}[]}}}
 */
export function runDeps(db, { root, runId }, sys = SYSTEM) {
  store.requireRunning(db, runId);
  const { audit, notAudited } = manifestDirs(root);
  const runs = audit.flatMap((dir) => auditDir(root, dir, sys));
  /** @type {Map<string, Finding[]>} */
  const byRef = new Map();
  for (const f of runs.flatMap((r) => r.findings)) byRef.set(depRef(f), [...(byRef.get(depRef(f)) ?? []), f]);
  const rank = (/** @type {Finding} */ f) => SEVERITIES.indexOf(f.severity);
  return store.tx(db, () => {
    const ins = db.prepare(`INSERT INTO sources_cache (run_id, type, ref, title, url, body, fetched_at) VALUES (?, 'dep', ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, type, ref) DO UPDATE SET title = excluded.title, url = excluded.url, body = excluded.body, fetched_at = excluded.fetched_at`);
    const at = store.now();
    /** @type {{type: 'dep', ref: string, title: string, url?: string, fixed_in?: string}[]} */
    const refs = [];
    for (const ref of [...byRef.keys()].sort()) {
      const all = /** @type {Finding[]} */ (byRef.get(ref)).slice().sort((a, b) => rank(a) - rank(b) || a.advisory.localeCompare(b.advisory));
      const top = all[0];
      const ids = [...new Set(all.map((f) => f.advisory))];
      const title = `${top.advisory} ${top.severity}`;
      const body = store.clean({
        package: top.package, version: top.version, advisory: top.advisory, severity: top.severity,
        fixed_in: top.fixed_in ?? all.find((f) => f.fixed_in)?.fixed_in, tool: top.tool,
        advisories: ids.length > 1 ? ids : undefined,
      });
      ins.run(runId, ref, title, top.url ?? null, JSON.stringify(body), at);
      const fixedIn = top.fixed_in ?? all.find((f) => f.fixed_in)?.fixed_in;
      refs.push({ type: 'dep', ref, title, ...(top.url ? { url: top.url } : {}), ...(fixedIn ? { fixed_in: fixedIn } : {}) });
    }
    return { out: { auditors: onceNotInstalled(runs.map((r) => r.report)), refs, ...(notAudited.length ? { not_audited: notAudited } : {}) } };
  });
}
