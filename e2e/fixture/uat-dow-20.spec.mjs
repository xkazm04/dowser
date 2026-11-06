// @ts-check
// DOW-20, Steps: "#inbox&page=4&delay=verdict.reject:1000&fail=verdict.reject: press r, 1, Ctrl+Enter, then click Rejected
// and wait." Expected: "The notice names where the card is: back in Open."
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

test('DOW-20: a reject that fails after a filter change says the card is back in Open', async ({ page }) => {
  await page.goto(at('inbox&page=4&delay=verdict.reject:1000&fail=verdict.reject'));
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ })).toBeVisible();
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await page.getByRole('group', { name: /^Filter by status/ }).getByRole('button', { name: /^Rejected/ }).click();
  const notice = page.getByText(/Could not reject DW-6/).filter({ visible: true });
  await expect(notice, 'the failure is on the page').toBeVisible();
  await expect.soft(notice, 'it names where the card is').toContainText(/\b(in|to|under|on) (the )?Open\b/);
  await expect.soft(notice, 'the list on screen does not hold it').not.toContainText('back in the list', { timeout: 1000 });
});
