// @ts-check
// claude-bin - how the eval tools (lens-eval, dogfood, forge-live-e2e) start the Claude Code CLI. CLAUDE_BIN, or
// `claude` on PATH, is resolved once. On Windows Node refuses to spawn a .cmd/.bat without a shell (ENOENT for a bare
// name, EINVAL for an explicit .cmd), and an `npm i -g @anthropic-ai/claude-code` install is exactly that: an npm
// cmd-shim. A shell is no way out either: cmd.exe cuts a multi-line prompt at its first newline and reads `&`, `|`,
// `<` and `>` in it. So a .cmd shim is read for the target it launches (`"%dp0%\node_modules\...\cli.js" %*`) and
// that target runs directly: a script under this Node, an .exe as it is. A native install (`claude.exe`) and every
// other platform spawn the binary as before. Only a .cmd whose target cannot be read falls back to the shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

/** @typedef {{command: string, args: string[], shell: boolean, resolved: string}} ClaudeCommand */

/**
 * The target an npm cmd-shim launches, as an absolute path, or undefined when the text is not one.
 * @param {string} text the .cmd file's content
 * @param {string} dir the folder the .cmd sits in (`%dp0%` / `%~dp0`)
 * @returns {string | undefined}
 */
export function cmdShimTarget(text, dir) {
  const hits = [...String(text).matchAll(/"%~?dp0%?\\?([^"%]+)"\s*%\*/gi)];
  const rel = hits.at(-1)?.[1];
  return rel ? join(dir, rel.replace(/^[\\/]+/, '')) : undefined;
}

/**
 * The first file `name` resolves to on `path` (with PATHEXT on Windows), or undefined.
 * @param {string} name
 * @param {{platform?: string, path?: string, pathext?: string}} [env]
 * @returns {string | undefined}
 */
export function which(name, { platform = process.platform, path = process.env.PATH ?? '', pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' } = {}) {
  const win = platform === 'win32';
  const exts = win && !extname(name) ? ['', ...pathext.split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const dirs = isAbsolute(name) || /[\\/]/.test(name) ? [''] : path.split(win ? ';' : delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      // on Windows a bare name with no extension is not runnable (npm also drops an extensionless sh script there)
      if (win && !extname(name) && e === '') continue;
      const p = d ? join(d.replace(/^"|"$/g, ''), name + e) : name + e;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * How to run `bin` (default CLAUDE_BIN, else `claude`) so that `spawnSync(command, [...args, ...yours], {shell})`
 * works on this platform.
 * @param {string} [bin]
 * @param {{platform?: string, path?: string, pathext?: string}} [env]
 * @returns {ClaudeCommand}
 */
export function resolveClaude(bin = process.env.CLAUDE_BIN ?? 'claude', env = {}) {
  const platform = env.platform ?? process.platform;
  if (platform !== 'win32') return { command: bin, args: [], shell: false, resolved: bin };
  const found = which(bin, env) ?? bin;
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [], shell: false, resolved: found };
  let target;
  try { target = cmdShimTarget(readFileSync(found, 'utf8'), dirname(found)); } catch { /* unreadable: the shell below */ }
  if (target && existsSync(target)) {
    return /\.(c|m)?js$/i.test(target)
      ? { command: process.execPath, args: [target], shell: false, resolved: found }
      : { command: target, args: [], shell: false, resolved: found };
  }
  return { command: found, args: [], shell: true, resolved: found };
}

/** Quotes one argument for cmd.exe (the last resort; a newline still ends the command there). @param {string} a */
const cmdQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;

/**
 * spawnSync of the Claude Code CLI with `args`, resolved as resolveClaude does.
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} opts
 * @param {ClaudeCommand} [c]
 */
export function spawnClaude(args, opts, c = resolveClaude()) {
  if (c.shell) return spawnSync([c.command, ...c.args, ...args].map(cmdQuote).join(' '), { ...opts, shell: true });
  return spawnSync(c.command, [...c.args, ...args], opts);
}
