// @ts-check
// DW-115: "the advertised keys work after ticking a row". Flow: "person ticks two rows with the mouse; the bulk bar
// shows Reject with the r key; they press r; the handler reads the checkbox as typing and returns". "Done means a focused
// checkbox or radio does not block the keys, and an e2e step ticks a row with a click and then presses r." "A space on a
// focused checkbox must keep toggling it." A text field still blocks them.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
/** An open row's checkbox. @param {Page} page @param {number} n */
const box = (page, n) => page.getByRole('region', { name: 'Proposals' }).locator('input.dwr-checkbox').nth(n);
const current = (/** @type {Page} */ page) => page.locator('button.dwr-row__main[aria-current="true"]');

test('ticking two rows with the mouse, then r: the Reject dialog opens for the checked', async ({ page }) => {
  await page.goto(at('inbox'));
  await box(page, 0).click();
  await box(page, 1).click();
  await expect(page.getByRole('region', { name: 'Bulk actions' }).getByText('2 checked')).toBeVisible();
  await expect(box(page, 1)).toBeFocused();
  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Reject 2 proposals' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('ticking a row, then s: the bulk snooze step opens', async ({ page }) => {
  await page.goto(at('inbox'));
  await box(page, 0).click();
  await expect(box(page, 0)).toBeFocused();
  await page.keyboard.press('s');
  await expect(page.getByRole('region', { name: 'Bulk actions' }).getByLabel('Until (optional)')).toBeVisible();
});

test('with a row checkbox focused, j moves the selection', async ({ page }) => {
  await page.goto(at('inbox'));
  await expect(current(page)).toHaveCount(1);
  const before = String(await current(page).textContent());
  await box(page, 2).click();
  await expect(box(page, 2)).toBeFocused();
  await page.keyboard.press('j');
  await expect(current(page)).not.toHaveText(before);
});

test('space on a focused row checkbox still toggles it, and only it', async ({ page }) => {
  await page.goto(at('inbox'));
  await box(page, 0).click();
  await expect(box(page, 0)).toBeChecked();
  await page.keyboard.press('Space');
  await expect(box(page, 0)).not.toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a text field still blocks the keys: r and j in the snooze note are typed', async ({ page }) => {
  await page.goto(at('inbox'));
  await page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ }).getByRole('button', { name: /^Snooze/ }).click();
  const note = page.getByLabel('Revisit when / why not now? (optional)');
  await note.focus();
  await page.keyboard.press('r');
  await page.keyboard.press('j');
  await expect(note).toHaveValue('rj');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a select keeps its own keys: r on the lens filter opens no dialog', async ({ page }) => {
  await page.goto(at('inbox'));
  await page.getByRole('combobox', { name: 'Filter by lens' }).focus();
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
