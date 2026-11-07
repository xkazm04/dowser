// @ts-check
// DOW-26: "Load more intermittently drops focus". After a load the selected row is right and the focus is on the body.
// The cause: the new page starts with a reserve row, and a reserve row sits in a closed <details> until the commit that
// selects it, so a focus() before that commit does nothing. The old code focused in the next animation frame, which
// came before that commit in 2 of 24 runs (no retries, 2026-11-06). The first test makes the frame win every time, so
// the defect shows on every run and not one in twelve.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const checks = (/** @type {Page} */ page) => page.locator('input.dwr-checkbox');
const loadMore = (/** @type {Page} */ page) => page.getByRole('button', { name: 'Load more' });
const current = (/** @type {Page} */ page) => page.locator('button[aria-current="true"]');

test('DOW-26: when the next page starts in the reserve, the focus still lands on the selected row', async ({ page }) => {
  await page.goto(at('inbox&page=4'));
  await expect(checks(page)).toHaveCount(4);
  await expect(current(page)).toHaveCount(1);
  for (let left = 3; left >= 0; left -= 1) {
    await current(page).focus();
    await expect(async () => {
      await page.keyboard.press('r');
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 250 });
    }).toPass();
    await page.keyboard.press('1');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(checks(page)).toHaveCount(left);
  }
  await loadMore(page).focus();
  // the race, decided against the code: every frame callback runs before React's next commit
  await page.evaluate('window.requestAnimationFrame = (cb) => { queueMicrotask(() => cb(performance.now())); return 0; }');
  await page.keyboard.press('Enter');
  await expect(checks(page).first()).toBeAttached();
  await expect(page.locator('details.dwr-reserve button[aria-current="true"]'), 'the fixture\'s next page starts in the reserve').toHaveCount(1);
  await expect(current(page), 'focus on the selected row').toBeFocused({ timeout: 2000 });
});

test('DOW-26: j into a collapsed reserve puts the focus on the selected row', async ({ page }) => {
  await page.goto(at('inbox&project=github.com/acme/shop&page=20'));
  await expect(current(page)).toHaveCount(1);
  const inReserve = page.locator('details.dwr-reserve button[aria-current="true"]');
  for (let i = 0; i < 20 && await inReserve.count() === 0; i += 1) await page.keyboard.press('j');
  await expect(inReserve, 'j reached a reserve row').toHaveCount(1);
  await expect(current(page), 'focus on the selected row').toBeFocused({ timeout: 2000 });
});
