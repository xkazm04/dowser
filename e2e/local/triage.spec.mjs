// @ts-check
// Triage in the UI against the real core, asserted on the other two doors: the HTTP server's row counts
// (GET /dev/state) and the skill's MCP pull (dowser_verdicts_pull over a second local-forge on the same db).
// Serial: each step reads what the one before decided. Every run of the group (a retry, a --repeat-each copy)
// pushes the self-scan into an inbox of its own, so a decision never meets a card an earlier run decided.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';
import { withMcp } from '../lib/mcp.mjs';
import { pushInbox } from './seed.mjs';

/** @typedef {import('@playwright/test').Page} Page */

test.describe.configure({ mode: 'serial' });

/** This run's inbox and its cards (in the self-scan's order). */
let inbox = '';
/** @type {{ref: string, title: string}[]} */
let cards = [];

test.beforeAll(async () => {
  inbox = `e2e-triage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  cards = await pushInbox({ db: needEnv('E2E_LOCAL_DB'), forge: needEnv('E2E_LOCAL_FORGE'), key: inbox, run: `r-${inbox}` });
});

/** The inbox at card `i`, as a deep link lands. @param {number} i */
const at = (i) => `${needEnv('E2E_LOCAL_URL')}#inbox&project=${inbox}&ref=${cards[i].ref}`;
const pane = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' });
/** @param {Page} page @param {number} i */
const decide = (page, i) => pane(page).getByRole('group', { name: `Decide ${cards[i].ref}` });
/** @returns {Promise<Record<string, number>>} */
const tables = async () => /** @type {any} */ (await (await fetch(new URL('dev/state', needEnv('E2E_LOCAL_FORGE')))).json()).tables;
/** The verdict of card `i` in the skill's pull, if any. @param {number} i @returns {Promise<any>} */
const pulled = (i) => withMcp(needEnv('E2E_LOCAL_DB'), async (mcp) => ((await mcp.tool('dowser_verdicts_pull', { project_key: inbox })).verdicts ?? [])
  .find((/** @type {any} */ v) => v.external_ref === cards[i].ref));

// @covers resolver:verdict.accept resolver:proposal.get fixture:ref fixture:project
test('accept in the inbox creates the local Jira issue, and the pull carries it', async ({ page }) => {
  await page.goto(at(0));
  await expect(pane(page).getByRole('heading', { level: 2 })).toHaveText(cards[0].title);
  await decide(page, 0).getByRole('button', { name: /^Accept/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create issue' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => pulled(0)).toMatchObject({ status: 'accepted', decided_by: 'forge:local-user', issue_ref: expect.stringMatching(/^DOW-\d+$/) });
  // the issue is in the local Jira: its own row, not a count delta (other runs may accept in parallel)
  const { issue_ref: key } = await pulled(0);
  expect((await fetch(new URL(`browse/${key}`, needEnv('E2E_LOCAL_FORGE')))).status, `local Jira has ${key}`).toBe(200);
  expect((await tables()).local_jira_issues).toBeGreaterThan(0);
  await screen(page, 'triage-accepted');
});

// @covers resolver:verdict.reject
test('reject with a reason is sent after its undo window, and the pull carries the reason', async ({ page }) => {
  await page.goto(at(1));
  await decide(page, 1).getByRole('button', { name: /^Reject/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Already known/ }).check();
  await dialog.getByRole('button', { name: 'Reject' }).click();
  // the call fires when the 6 s undo window ends
  await expect.poll(() => pulled(1), { timeout: 20_000 }).toMatchObject({ status: 'rejected', reason: 'already-known', decided_by: 'forge:local-user' });
});

// @covers resolver:verdict.snooze
test('snooze is sent after its undo window, and the pull carries it', async ({ page }) => {
  await page.goto(at(3));
  await decide(page, 3).getByRole('button', { name: /^Snooze/ }).click();
  await pane(page).getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect.poll(() => pulled(3), { timeout: 20_000 }).toMatchObject({ status: 'snoozed', decided_by: 'forge:local-user' });
});

// @covers resolver:verdict.merge
test('merge into the accepted item, and the pull carries the target', async ({ page }) => {
  await page.goto(at(2));
  await decide(page, 2).getByRole('button', { name: /^Merge/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: new RegExp(`${cards[0].ref}\\b`) }).check();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText(new RegExp(`^${cards[2].ref} merged`))).toBeVisible();
  await expect.poll(() => pulled(2)).toMatchObject({ status: 'merged', decided_by: 'forge:local-user' });
});

// @covers route:dowser-evidence resolver:panel.forIssue
test('the issue panel of the accepted issue shows its proposal', async ({ page }) => {
  const v = await pulled(0);
  expect(v?.issue_ref, 'the accept step ran first').toBeTruthy();
  await page.goto(`${needEnv('E2E_LOCAL_URL')}#panel&issue=${v.issue_ref}`);
  await expect(page.getByRole('heading', { name: cards[0].title, level: 2 })).toBeVisible();
  await screen(page, 'panel-accepted');
});
