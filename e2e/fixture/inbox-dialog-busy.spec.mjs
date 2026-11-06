// @ts-check
// DW-117: "Cancel means no issue gets created". "Before: Cancel and Escape active during the call. After: both inactive
// during the call; taken from a fixture step with a delayed accept." "Disable Cancel and ignore Escape in the Accept
// dialog while its call runs; do the same in Merge". "A hung call must still leave a way out, so keep the existing
// failure path." `&delay=` holds the call open.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const decide = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ });

/** Opens Accept on the selected card and presses Create issue. @param {Page} page */
async function startAccept(page) {
  await decide(page).getByRole('button', { name: /^Accept/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create issue' }).click();
  return dialog;
}
/** Opens Merge on the selected card, picks the first candidate and presses Merge. @param {Page} page */
async function startMerge(page) {
  await decide(page).getByRole('button', { name: /^Merge/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').first().check();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  return dialog;
}

// @covers fixture:delay
test('Accept: during the call Cancel is disabled and Escape does not close; the answer closes the dialog', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.accept:1500'));
  const dialog = await startAccept(page);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/accepted as SHOP-/)).toBeAttached();
});

// @covers fixture:delay fixture:fail
test('Accept: the call\'s failure gives Cancel and Escape back', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.accept:1000&fail=verdict.accept'));
  const dialog = await startAccept(page);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(dialog.getByText('The verdict.accept resolver is unavailable (fixture).')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// @covers fixture:delay
test('Accept: before the call Cancel works', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.accept:1000'));
  await decide(page).getByRole('button', { name: /^Accept/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Create issue' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

// @covers fixture:delay
test('Merge: during the call Cancel is disabled and Escape does not close; the answer closes the dialog', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.merge:1500'));
  const dialog = await startMerge(page);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/merged into DW-/)).toBeAttached();
});

// @covers fixture:delay fixture:fail
test('Merge: the call\'s failure gives Cancel and Escape back', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.merge:1000&fail=verdict.merge'));
  const dialog = await startMerge(page);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(dialog.getByText('The verdict.merge resolver is unavailable (fixture).')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
