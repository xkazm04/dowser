// @ts-check
// Who may see and decide an inbox. An inbox follows Jira's own permissions, so there is no Dowser user list:
//  - an inbox with a Jira project set (Settings) is open to whoever may browse that project;
//  - an inbox without one is open to its creator (the account whose first push made it) until a project is set;
//  - a Jira admin (global ADMINISTER) may open every inbox, so none is ever orphaned.
// Everything else answers `forbidden`. The dispatch door (app.mjs) builds one Access per call and checks it
// before a handler runs; Jira answers are asked as the user (Perms port) and cached for the call.
import { findProposal, listInboxRows, needInbox } from './store.mjs';
import { AppError } from './util.mjs';
import { deciderOf } from './verdicts.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./store.mjs').InboxRow} InboxRow
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 * @typedef {{
 *   may: (key: string, on?: {projectKey?: string, issueKey?: string}) => Promise<boolean>,
 *   canSee: (inbox: InboxRow) => Promise<boolean>,
 *   inbox: (projectKey: string) => Promise<InboxRow>,
 *   proposal: (ref: string) => Promise<ProposalRow>,
 *   visibleKeys: () => Promise<string[]>,
 * }} Access
 */

/**
 * The `forbidden` answer for an inbox the caller may not open. It names what would open it, never its content.
 * @param {InboxRow} inbox
 */
function denied(inbox) {
  const how = inbox.jira_project_key
    ? `it follows Jira project ${inbox.jira_project_key}: ask for Browse permission there`
    : 'until a Jira project is set for it in Dowser settings, only the person who first pushed to it and Jira admins can open it';
  return new AppError('forbidden', `You cannot open the Dowser inbox ${inbox.project_key}; ${how}`);
}

/**
 * The access of one caller for one call.
 * @param {Deps} deps
 * @param {string} accountId
 * @returns {Access}
 */
export function accessFor(deps, accountId) {
  const me = deciderOf(accountId);
  /** @type {Map<string, Promise<boolean>>} */
  const memo = new Map();

  /** @type {Access['may']} */
  const may = (key, on) => {
    const k = JSON.stringify([key, on?.projectKey ?? null, on?.issueKey ?? null]);
    let hit = memo.get(k);
    if (!hit) {
      const perms = deps.perms;
      if (!perms) throw new AppError('unavailable', 'Dowser cannot check Jira permissions from this module');
      hit = perms.mine([key], on).then((r) => r[key] === true);
      memo.set(k, hit);
      hit.catch(() => memo.delete(k)); // a failed lookup is not remembered as a no
    }
    return hit;
  };

  /** @type {Access['canSee']} */
  const canSee = async (inbox) => {
    if (inbox.jira_project_key) {
      if (await may('BROWSE_PROJECTS', { projectKey: inbox.jira_project_key })) return true;
    } else if (inbox.created_by === me) {
      return true;
    }
    return may('ADMINISTER');
  };

  /** @type {Access['inbox']} */
  const inbox = async (projectKey) => {
    const row = await needInbox(deps.db, projectKey);
    if (!(await canSee(row))) throw denied(row);
    return row;
  };

  return {
    may,
    canSee,
    inbox,
    proposal: async (ref) => {
      const p = await findProposal(deps.db, ref);
      await inbox(p.project_key);
      return p;
    },
    visibleKeys: async () => {
      const rows = await listInboxRows(deps.db);
      const ok = await Promise.all(rows.map((r) => canSee(r)));
      return rows.filter((_, i) => ok[i]).map((r) => r.project_key);
    },
  };
}
