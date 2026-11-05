// @ts-check
// live-mcp - how a tool outside this checkout's own Claude Code project reaches the LIVE `dowser` MCP server (the
// Forge app's MCP endpoint). The server is registered for the main Dowser checkout in ~/.claude.json
// (`projects["<checkout>"].mcpServers.dowser`, an http server signed in by OAuth). A headless `claude -p` in another
// folder (a scan clone, a worktree) does not see it, so this writes the same entry into an `--mcp-config` file: Claude
// Code keys the stored OAuth token by the server's name and config, so an identical entry named `dowser` reuses the
// sign-in. DOWSER_MCP_URL overrides the lookup with an http URL.
//
// A non-production install suffixes every tool name (`dowser_verdicts_pull_development`), so a call names the tool
// by its base name and the prompt matches the suffix, as tools/forge-live-e2e.mjs does.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClaude } from './claude-bin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @typedef {{type: string, url?: string, command?: string, args?: string[], headers?: Record<string, string>}} McpServer */

/** A path as ~/.claude.json keys its projects: forward slashes, no trailing slash, case kept. @param {string} p */
const projectPath = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The main checkout of this repository: the parent of git's common dir, so a worktree finds the checkout the MCP
 * server is registered for.
 * @param {string} [root]
 */
export function mainCheckout(root = ROOT) {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(common);
  } catch { return root; }
}

/**
 * The `dowser` server entry registered for one of `checkouts` in a parsed ~/.claude.json (Windows paths compare
 * case-insensitively), or the user-scope one, or undefined.
 * @param {any} config @param {string[]} checkouts
 * @returns {McpServer | undefined}
 */
export function findDowserServer(config, checkouts) {
  const want = new Set(checkouts.map((c) => projectPath(c).toLowerCase()));
  for (const [p, v] of Object.entries(config?.projects ?? {})) {
    const s = /** @type {any} */ (v)?.mcpServers?.dowser;
    if (s && want.has(projectPath(p).toLowerCase())) return s;
  }
  return config?.mcpServers?.dowser;
}

/**
 * The live dowser server: DOWSER_MCP_URL, else the entry registered for this checkout or its main checkout.
 * Throws when there is none.
 * @param {{env?: NodeJS.ProcessEnv, claudeJson?: string, root?: string}} [o]
 * @returns {McpServer}
 */
export function liveDowserServer(o = {}) {
  const env = o.env ?? process.env;
  if (env.DOWSER_MCP_URL) return { type: 'http', url: env.DOWSER_MCP_URL };
  const file = o.claudeJson ?? join(homedir(), '.claude.json');
  /** @type {any} */
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { config = {}; }
  const root = o.root ?? ROOT;
  const s = findDowserServer(config, [root, mainCheckout(root)]);
  if (!s) throw new Error(`no "dowser" MCP server is registered for ${mainCheckout(root)} (run \`claude mcp add\` there, or set DOWSER_MCP_URL)`);
  return s;
}

/** Writes an `--mcp-config` file holding only the dowser server. @param {string} file @param {McpServer} server */
export function writeMcpConfig(file, server) {
  writeFileSync(file, JSON.stringify({ mcpServers: { dowser: server } }, null, 2));
  return file;
}

/** The prompt that makes headless Claude call one tool verbatim. @param {string} name @param {string} argFile */
export const toolPrompt = (name, argFile) => `Read the JSON object in the file ${argFile.replace(/\\/g, '/')}. Call the MCP tool from the "dowser" server whose name ends with "${name}" or "${name}_development" or "${name}_staging", passing exactly that object's keys and values as the arguments, unedited. Then output ONLY the raw text of the tool result, verbatim, with no commentary and no code fences.`;

/**
 * Calls one live tool through headless Claude Code with `args` unedited and returns the parsed JSON answer.
 * Throws on a failed run or an answer with no JSON object.
 * @param {string} name the tool's base name
 * @param {Record<string, unknown>} args
 * @param {{work: string, mcpConfig: string, timeoutMs?: number}} o
 * @returns {any}
 */
export function callLiveTool(name, args, o) {
  const argFile = join(o.work, `${name}.args.json`);
  writeFileSync(argFile, JSON.stringify(args));
  const r = spawnClaude(['-p', toolPrompt(name, argFile), '--setting-sources', 'project,local', '--mcp-config', o.mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__dowser__*', 'Read', '--output-format', 'text'], { encoding: 'utf8', cwd: o.work, timeout: o.timeoutMs ?? 300000 });
  if (r.status !== 0) throw new Error(`claude -p for ${name} -> ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
  writeFileSync(join(o.work, `${name}.result.txt`), r.stdout);
  const m = r.stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in the ${name} answer (see ${join(o.work, `${name}.result.txt`)})`);
  return JSON.parse(m[0]);
}
