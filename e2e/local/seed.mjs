// @ts-check
// The local project's data: the bundled self-scan (forge/src/sample/self-scan.json, six real proposals and their
// areas) pushed over MCP into its own inbox E2E_INBOX (the sample key is reserved, so it goes under another key),
// and that inbox's Accept target set to the local Jira project DOW through the resolver door.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../lib/servers.mjs';
import { withMcp } from '../lib/mcp.mjs';

export const E2E_INBOX = 'github-com-xkazm04-dowser-e2e-local';
export const E2E_RUN = 'r-e2e-local-1';

/** @returns {{proposals: Record<string, any>[], areas: Record<string, any>[], lens_kinds_json: string, source: Record<string, any>}} */
export const selfScan = () => JSON.parse(readFileSync(join(REPO, 'forge', 'src', 'sample', 'self-scan.json'), 'utf8'));

/**
 * A resolver call as the local UI makes it (POST /invoke); throws on `{error}`.
 * @param {string} forge  the local-forge base URL, ending in /
 * @param {string} key @param {Record<string, unknown>} [payload] @param {string} [module]
 */
export async function invoke(forge, key, payload = {}, module) {
  const res = await fetch(new URL('invoke', forge), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, payload, ...(module ? { module } : {}) }) });
  const body = /** @type {any} */ (await res.json());
  if (body?.error) throw new Error(`${key}: ${body.error} ${body.message ?? ''}`);
  return body;
}

/**
 * Pushes the self-scan into inbox `key` (with its areas) and sets the inbox's Accept target to DOW.
 * @param {{db: string, forge: string, key: string, run?: string}} o
 * @returns {Promise<{ref: string, title: string}[]>} the inbox refs, in the scan's order
 */
export async function pushInbox({ db, forge, key, run = E2E_RUN }) {
  const scan = selfScan();
  const refs = await withMcp(db, async (mcp) => {
    const pushed = await mcp.tool('dowser_proposals_push', {
      project_key: key, run_id: run, repo_url: scan.source.repo_url, head_sha: scan.source.head_sha,
      proposals_json: JSON.stringify(scan.proposals), lens_kinds_json: scan.lens_kinds_json,
    });
    /** @type {{fp: string, result: string, external_ref?: string}[]} */
    const results = pushed.results ?? [];
    if (results.filter((r) => r.result === 'created').length !== scan.proposals.length) throw new Error(`the push into ${key} did not create every card: ${JSON.stringify(pushed)}`);
    await mcp.tool('dowser_areas_push', { project_key: key, run_id: run, areas_json: JSON.stringify(scan.areas) });
    return scan.proposals.map((p) => ({ ref: String(results.find((r) => r.fp === p.fp)?.external_ref), title: String(p.title) }));
  });
  await invoke(forge, 'settings.set', { project_key: key, jira_project_key: 'DOW', issue_type_id: '10001' });
  return refs;
}

/** The global setup's inbox, read by the surface smoke. @param {{db: string, forge: string}} o */
export async function seedLocal({ db, forge }) {
  await pushInbox({ db, forge, key: E2E_INBOX });
}
