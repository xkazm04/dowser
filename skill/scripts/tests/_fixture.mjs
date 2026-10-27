// @ts-check
// Shared test fixtures (not a test file: node --test runs only *.test.mjs). Every temp dir is made with
// mkdtemp under the OS temp dir and removed by the caller's after() hook.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/** @param {string} prefix @returns {string} */
export const tempDir = (prefix) => mkdtempSync(join(tmpdir(), `dowser-${prefix}-`));

/** @param {string} dir */
export const removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** Kinds for every lens, as a lens pack would declare them. */
export const KINDS = {
  opportunity: ['gap', 'friction'],
  'ux-friction': ['dead-end', 'overload'],
  'doc-drift': ['stale', 'missing'],
  'security-cra': ['secret', 'vuln'],
};

export const BODY = ['## Summary', 's', '## Description', 'd', '## Flow', 'f', '## Expected impact', 'e', '## Evaluation', 'v'].join('\n');

/**
 * A valid candidate, overridable.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, any>}
 */
export function candidate(over = {}) {
  return {
    lens: 'security-cra',
    kind: 'secret',
    topic: 'Plaintext password check',
    anchors: ['src/auth.js#login'],
    title: 'Password compared in plaintext',
    rationale: 'Login compares the raw password.',
    body: BODY,
    evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }],
    effort: { size: 'S', days_low: 1, days_high: 2, basis: ['one function'] },
    confidence: 'high',
    confidence_why: 'direct quote',
    provenance: { lens_version: '1.0.0' },
    ...over,
  };
}

/**
 * Writes files (path -> content) under `root`.
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function writeFiles(root, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
}

/**
 * A git repo with one commit holding `files`.
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function gitRepo(root, files) {
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'false');
  writeFiles(root, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

/**
 * Every file path under `root` (relative, forward slashes), skipping `.git/`.
 * @param {string} root
 * @returns {string[]}
 */
export function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else out.push(relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}
