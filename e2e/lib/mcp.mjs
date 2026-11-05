// @ts-check
// The skill's side of the local Forge: a short-lived `tools/local-forge.mjs --stdio` on the same SQLite file the HTTP
// server uses (local-forge allows two processes on one file). One process per flow: open, call, close.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { LOCAL_FORGE, REPO, stopTree } from './servers.mjs';

/**
 * @typedef {{tool: (name: string, args: Record<string, unknown>) => Promise<any>, close: () => Promise<void>}} McpSession
 */

/**
 * Opens an MCP session over stdio and completes the initialize handshake.
 * @param {string} db
 * @returns {Promise<McpSession>}
 */
export async function mcpSession(db) {
  const child = spawn(process.execPath, [LOCAL_FORGE, '--stdio', '--db', db], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  /** @param {string} method @param {unknown} [params] @returns {Promise<any>} */
  const rpc = (method, params) => {
    const id = next++;
    return new Promise((done, fail) => {
      const t = setTimeout(() => fail(new Error(`local-forge MCP ${method}: no reply\n${err}`)), 15_000);
      pending.set(id, (msg) => { clearTimeout(t); done(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dowser-e2e', version: '1' } });
  if (!init.result) throw new Error(`local-forge MCP initialize failed: ${JSON.stringify(init)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    async tool(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r.result?.content?.[0]?.text;
      if (!r.result || r.result.isError) throw new Error(`${name} failed: ${text ?? JSON.stringify(r)}`);
      return JSON.parse(text);
    },
    async close() {
      child.stdin.end();
      await Promise.race([new Promise((done) => child.once('exit', done)), new Promise((done) => setTimeout(done, 3000))]);
      await stopTree(child);
    },
  };
}

/**
 * One flow: open a session, run `fn`, always close.
 * @template T
 * @param {string} db @param {(s: McpSession) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMcp(db, fn) {
  const s = await mcpSession(db);
  try { return await fn(s); } finally { await s.close(); }
}
