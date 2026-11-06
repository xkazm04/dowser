// @ts-check
// DW-114: "every open proposal stays reachable through Load more". Flow: "person decides every proposal on the first
// page; they press Load more; the server answers no rows and no next page; the page says Queue cleared and Nothing is
// waiting on you". After: "the empty view appears only at 0 open". The fixture bridge mirrors the server's cursor.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const SHOP = 'project=github.com/acme/shop';
/** The open cards on the page, reserve rows included (only an open row has the checkbox). @param {Page} page */
const checks = (page) => page.locator('input.dwr-checkbox');
const pane = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' });
/** @param {Page} page @returns {Promise<string[]>} */
const listedRefs = (page) => checks(page).evaluateAll((els) => els.map((e) => String(e.getAttribute('aria-label')).replace('Check ', '')));

/** Presses `button`, rejects with the first reason and waits for the undo window to end (the verdict went out). */
async function rejectAndSettle(/** @type {Page} */ page, /** @type {import('@playwright/test').Locator} */ button) {
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').first().check();
  await dialog.getByRole('button', { name: 'Reject' }).click();
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await expect(undo).toHaveCount(0, { timeout: 10_000 });
}

// @covers fixture:page
test('deciding the whole first page, then Load more: the rest shows, never Queue cleared', async ({ page }) => {
  await page.goto(at(`inbox&${SHOP}&page=5`));
  await expect(checks(page)).toHaveCount(5);
  const first = await listedRefs(page);
  // bulk-check them one by one, so the reserve rows of the page count too
  await page.locator('details.dwr-reserve').evaluateAll((els) => els.forEach((d) => d.setAttribute('open', '')));
  for (const ref of first) await page.getByRole('checkbox', { name: `Check ${ref}` }).check();
  const bulk = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bulk.getByText('5 checked')).toBeVisible();
  await rejectAndSettle(page, bulk.getByRole('button', { name: /^Reject/ }));
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(checks(page)).toHaveCount(5);
  await expect(page.getByText('Queue cleared.')).toHaveCount(0);
  await expect(page.getByText(/Nothing is waiting on you/)).toHaveCount(0);
});

// @covers fixture:page
test('deciding part of a page, then Load more: no card is skipped', async ({ page }) => {
  // the full order of this filter: what the walk must reach
  await page.goto(at(`inbox&${SHOP}&lens=opportunity&page=20`));
  await expect(checks(page).first()).toBeAttached();
  const order = await listedRefs(page);
  expect(order.length).toBeGreaterThan(4);
  await page.goto('about:blank');

  await page.goto(at(`inbox&${SHOP}&lens=opportunity&page=2`));
  await expect(checks(page)).toHaveCount(2);
  await rejectAndSettle(page, pane(page).getByRole('group', { name: /^Decide DW-/ }).getByRole('button', { name: /^Reject/ }));
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(checks(page)).toHaveCount(3);
  expect(await listedRefs(page)).toEqual(order.slice(1, 4));
});
