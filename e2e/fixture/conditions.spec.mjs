// @ts-check
// The fixture's forced conditions (forge/static/app/src/dev/bridge.js header) other than `&fail=<key>`
// (fail.spec.mjs): one-shot failure and Retry, a status-scoped failure, slow loads, colour modes, page size and
// Load more, deep links, the empty and sample inboxes, the setup checklist's states, and a refused comment.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const rows = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Proposals' }).getByRole('listitem');
const pane = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' });

// @covers fixture:failonce
test('&failonce: the load fails, and Retry succeeds', async ({ page }) => {
  await page.goto(at('inbox&failonce=inbox.list'));
  const alert = page.getByRole('alert').filter({ hasText: 'The inbox could not load.' });
  await expect(alert).toBeVisible();
  await page.waitForTimeout(1200); // the fixture fails only in the page's first second
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page).first()).toBeVisible();
});

// @covers fixture:fail resolver:inbox.list
test('&fail=<key>:<status>: only the Merge dialog\'s accepted list fails', async ({ page }) => {
  await page.goto(at('inbox&fail=inbox.list:accepted'));
  await expect(rows(page).first()).toBeVisible();
  await pane(page).getByRole('button', { name: /^Merge/ }).click();
  await expect(page.getByRole('dialog').getByText('Accepted proposals could not load, so only open ones are listed.')).toBeVisible();
  await screen(page, 'fail-status-scoped');
});

// @covers fixture:slow
test('&slow: the inbox shows its skeleton, then the list', async ({ page }) => {
  await page.goto(at('inbox&slow'));
  await expect(page.getByRole('status', { name: 'Loading the inbox' })).toBeVisible();
  await screen(page, 'slow-inbox');
  await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
});

for (const mode of ['dark', 'light']) {
  // @covers fixture:mode
  test(`&mode=${mode}: the colour mode is set on the page`, async ({ page }) => {
    await page.goto(at(`inbox&mode=${mode}`));
    await expect(rows(page).first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', mode);
    await screen(page, `mode-${mode}`);
  });
}

// @covers fixture:page
test('Load more: the default page of 4 grows', async ({ page }) => {
  await page.goto(at('inbox'));
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(4);
});

// @covers fixture:page
test('&page=<n>: the inbox page size', async ({ page }) => {
  await page.goto(at('inbox&page=2'));
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
});

// @covers fixture:page route:dowser-doc-impact
test('byline &page=<id>: one proposal, and none', async ({ page }) => {
  await page.goto(at('byline&page=48213'));
  await expect(page.getByRole('heading', { name: '1 Dowser proposal' })).toBeVisible();
  await page.goto(at('byline&page=1'));
  await expect(page.getByText('No Dowser proposals mention this page.')).toBeVisible();
});

// @covers fixture:ref
test('&ref=DW-n on the page: the reading pane opens that card', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-17'));
  await expect(pane(page).getByRole('heading', { name: 'Show the delivery date on the order confirmation', level: 2 })).toBeVisible();
});

// @covers fixture:ref resolver:proposal.get
test('&ref=DW-n of a decided card: it opens read-only in a dialog', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-1'));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Explain shipping costs before the payment step' })).toBeVisible();
  await screen(page, 'deeplink-decided');
});

// @covers fixture:project fixture:lens fixture:area
test('&project=&lens=&area=: the inbox opens filtered, as a map heat cell links', async ({ page }) => {
  await page.goto(at(`inbox&project=${encodeURIComponent('github.com/acme/shop')}&lens=opportunity&area=${encodeURIComponent('src/checkout')}`));
  await expect(page.getByRole('combobox', { name: 'Filter by lens' })).toHaveValue('opportunity');
  await expect(rows(page).first()).toBeVisible();
  await screen(page, 'deeplink-filtered');
});

// @covers fixture:empty
test('&empty: the first-run screen and an empty Learning tab', async ({ page }) => {
  await page.goto(at('inbox&empty'));
  await expect(page.getByRole('heading', { name: 'Start with Dowser', level: 2 })).toBeVisible();
  await screen(page, 'empty-inbox');
  await page.goto(at('reflect&empty'));
  await expect(page.getByRole('heading', { name: 'Nothing to learn from yet.' })).toBeVisible();
});

// @covers fixture:sample fixture:empty resolver:sample.load
test('&empty -> Load the sample: the sample inbox appears with its strip', async ({ page }) => {
  await page.goto(at('inbox&empty'));
  await page.getByRole('button', { name: 'Load the sample' }).click();
  await expect(page.getByRole('complementary', { name: 'Sample data' })).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
  await screen(page, 'sample-loaded');
});

// @covers fixture:calls resolver:setup.status
test('&calls=<n>: the setup checklist turns green', async ({ page }) => {
  await page.goto(at('inbox&empty&calls=3'));
  await expect(page.getByText('3 tool calls have reached Dowser')).toBeVisible();
});

// @covers fixture:nomcp
test('&nomcp: the checklist says the MCP address is not known', async ({ page }) => {
  await page.goto(at('inbox&empty&nomcp'));
  await expect(page.getByText('The MCP server address is not known here; see the app listing.')).toBeVisible();
});

// @covers fixture:nocomment resolver:byline.draftFix
test('&nocomment: Confluence refusing the drafted comment is said plainly', async ({ page }) => {
  await page.goto(at('byline&nocomment=1'));
  await page.getByRole('button', { name: 'Draft the fix as a comment' }).click();
  await expect(page.getByText(/Confluence did not take the comment/)).toBeVisible();
  await screen(page, 'byline-nocomment');
});
