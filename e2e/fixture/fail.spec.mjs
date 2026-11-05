// @ts-check
// `&fail=<resolver key>` for every key the UI calls: the surface that calls it shows the resolver's message (the
// fixture answers `The <key> resolver is unavailable (fixture).`), keeps the page alive (no console or page
// error), and leaves a screenshot of the error state. Coverage tags: e2e/README.md.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const failed = (/** @type {Page} */ page, /** @type {string} */ key) => page.getByText(`The ${key} resolver is unavailable (fixture).`).first();
/** The reading pane's decision bar of the selected card. @param {Page} page */
const decide = (page) => page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ });

/** @type {{key: string, hash: string, act?: (page: Page) => Promise<void>, message?: string}[]} */
const CASES = [
  // @covers fail:inbox.list fixture:fail
  { key: 'inbox.list', hash: 'inbox' },
  // @covers fail:proposal.get
  // the reading pane's history is the one caller that words its own message
  { key: 'proposal.get', hash: 'inbox', message: 'The history could not load.' },
  // @covers fail:verdict.accept
  { key: 'verdict.accept', hash: 'inbox', act: async (page) => {
    await decide(page).getByRole('button', { name: /^Accept/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create issue' }).click();
  } },
  // @covers fail:verdict.reject
  { key: 'verdict.reject', hash: 'inbox', act: async (page) => {
    await decide(page).getByRole('button', { name: /^Reject/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: 'Reject' }).click();
  } },
  // @covers fail:verdict.snooze
  { key: 'verdict.snooze', hash: 'inbox', act: async (page) => {
    await decide(page).getByRole('button', { name: /^Snooze/ }).click();
    await page.getByRole('region', { name: 'Selected proposal' }).getByRole('button', { name: 'Snooze', exact: true }).click();
  } },
  // @covers fail:verdict.merge
  { key: 'verdict.merge', hash: 'inbox', act: async (page) => {
    await decide(page).getByRole('button', { name: /^Merge/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  } },
  // @covers fail:settings.get
  { key: 'settings.get', hash: 'settings' },
  // @covers fail:jira.projects
  { key: 'jira.projects', hash: 'settings' },
  // @covers fail:settings.set
  { key: 'settings.set', hash: 'settings', act: async (page) => {
    const row = page.getByRole('row', { name: /github\.com\/acme\/billing/ });
    await row.getByRole('combobox', { name: /^Jira project/ }).selectOption({ label: 'Shop (SHOP)' });
    await row.getByRole('combobox', { name: /^Issue type/ }).selectOption({ label: 'Story' });
    await row.getByRole('button', { name: 'Save' }).click();
  } },
  // @covers fail:direction.get
  { key: 'direction.get', hash: 'settings' },
  // @covers fail:direction.set
  { key: 'direction.set', hash: 'settings', act: async (page) => {
    const lens = page.locator('details.dw-dir__lens').first();
    await lens.locator('summary').click();
    await lens.getByLabel('Focus on').fill('checkout\ninvoices');
    await lens.getByRole('button', { name: 'Save' }).click();
  } },
  // @covers fail:panel.forIssue
  { key: 'panel.forIssue', hash: 'panel' },
  // @covers fail:map.data
  { key: 'map.data', hash: 'map' },
  // @covers fail:byline.forPage
  { key: 'byline.forPage', hash: 'byline' },
  // @covers fail:byline.draftFix
  { key: 'byline.draftFix', hash: 'byline', act: async (page) => {
    await page.getByRole('button', { name: 'Draft the fix as a comment' }).click();
  } },
  // @covers fail:reflect.data
  { key: 'reflect.data', hash: 'reflect' },
  // @covers fail:rule.decide
  { key: 'rule.decide', hash: 'reflect', act: async (page) => {
    await page.getByRole('button', { name: 'Accept rule' }).first().click();
  } },
  // @covers fail:outcome.record
  { key: 'outcome.record', hash: 'reflect', act: async (page) => {
    const rate = page.getByRole('article', { name: /^Rate DW-/ }).first();
    await rate.getByRole('radio', { name: 'Right call' }).check();
    await rate.getByRole('button', { name: 'Record' }).click();
  } },
  // @covers fail:sample.load fixture:empty
  { key: 'sample.load', hash: 'inbox&empty', act: async (page) => {
    await page.getByRole('button', { name: 'Load the sample' }).click();
  } },
  // @covers fail:sample.remove fixture:sample
  { key: 'sample.remove', hash: 'inbox&empty&sample', act: async (page) => {
    await page.getByRole('button', { name: 'Remove sample data' }).click();
    await page.getByRole('button', { name: 'Remove sample data' }).last().click();
  } },
  // @covers fail:setup.status
  { key: 'setup.status', hash: 'inbox&empty' },
];

for (const c of CASES) {
  test(`&fail=${c.key} shows the resolver's message on ${c.hash}`, async ({ page }) => {
    await page.goto(at(`${c.hash}&fail=${c.key}`));
    if (c.act) await c.act(page);
    // a reject or snooze is sent when its 6 s undo window ends
    await expect(c.message ? page.getByText(c.message) : failed(page, c.key)).toBeVisible({ timeout: 15_000 });
    await screen(page, `fail-${c.key}`);
  });
}
