// @ts-check
// DOW-23, Steps: "#inbox&page=4: press r, 1, Ctrl+Enter four times", "Press j", "Tab to Load more and press Enter."
// Expected: "After the last listed card the keyboard leads on: focus lands on Load more or j reaches it, and after loading
// focus is on a row."
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
/** The open rows on the page, reserve rows included (only an open row has the checkbox). @param {Page} page */
const checks = (page) => page.locator('input.dwr-checkbox');
const loadMore = (/** @type {Page} */ page) => page.getByRole('button', { name: 'Load more' });

/** Rejects the four listed cards by keyboard. @param {Page} page */
async function clearThePage(page) {
  await page.goto(at('inbox&page=4'));
  await expect(checks(page)).toHaveCount(4);
  for (let left = 3; left >= 0; left -= 1) {
    // A key press in the same tick as the commit can reach the listener before it knows the selection or the closed dialog.
    await expect(async () => {
      await page.keyboard.press('r');
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 250 });
    }).toPass();
    await page.keyboard.press('1');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(checks(page)).toHaveCount(left);
  }
  await expect(loadMore(page), 'seven are still open').toBeVisible();
}

test('DOW-23: when the page is cleared the keyboard leads on: j reaches Load more', async ({ page }) => {
  await clearThePage(page);
  await page.keyboard.press('j');
  await expect(loadMore(page), 'focus on Load more').toBeFocused({ timeout: 2000 });
});

test('DOW-23: after Load more the focus is on a row', async ({ page }) => {
  await clearThePage(page);
  await loadMore(page).focus(); // the Tab presses of the Steps, however many they are
  await page.keyboard.press('Enter');
  await expect(checks(page).first(), 'the next page has arrived').toBeAttached();
  await expect(page.locator('li.dwr-item :focus'), 'focus on a row').toHaveCount(1, { timeout: 2000 });
});
