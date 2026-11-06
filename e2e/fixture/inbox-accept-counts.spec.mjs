// @ts-check
// The persona pass of cycle c5: after Accept or Merge the counts follow the decision at once, as they do for Reject and
// Snooze. The card the call answers already holds its new status, so the status it left must come from the list.
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

test('Accept moves the Open and Accepted counts at once', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-6'));
  const status = page.getByRole('group', { name: /^Filter by status/ });
  const count = async (/** @type {string} */ name) => Number(await status.getByRole('button', { name: new RegExp(`^${name}`) }).locator('.dwr-seg__n').innerText());
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('heading', { level: 2 })).toBeVisible();
  const [open, accepted] = [await count('Open'), await count('Accepted')];
  await page.keyboard.press('a');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Create issue' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create issue' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => count('Open'), { message: 'Open less one' }).toBe(open - 1);
  await expect.poll(() => count('Accepted'), { message: 'Accepted plus one' }).toBe(accepted + 1);
});

test('Merge moves the Open and Merged counts at once', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-6'));
  const status = page.getByRole('group', { name: /^Filter by status/ });
  const count = async (/** @type {string} */ name) => Number(await status.getByRole('button', { name: new RegExp(`^${name}`) }).locator('.dwr-seg__n').innerText());
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('heading', { level: 2 })).toBeVisible();
  const [open, merged] = [await count('Open'), await count('Merged')];
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').first().check();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => count('Open'), { message: 'Open less one' }).toBe(open - 1);
  await expect.poll(() => count('Merged'), { message: 'Merged plus one' }).toBe(merged + 1);
});
