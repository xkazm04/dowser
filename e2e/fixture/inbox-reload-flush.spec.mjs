// @ts-check
// DW-116: "a reload never reads the list before pending decisions land". Flow: "person rejects a card; the 6 second
// notice shows; they click the Rejected status to check it; the reject and the list read start together; the list and
// counts can miss the decision until the next reload". After: "the list starts after every pending call settled;
// taken from a delayed-resolver test". `&delay=` holds the verdict back while the list read answers at its own speed.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const decide = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ });
const statuses = (/** @type {Page} */ page) => page.getByRole('group', { name: /^Filter by status/ });

/** Rejects the selected card; returns its ref, its undo notice still showing. @param {Page} page */
async function rejectSelected(page) {
  const group = decide(page);
  await expect(group).toBeVisible();
  const ref = String(await group.getAttribute('aria-label')).replace('Decide ', '');
  await group.getByRole('button', { name: /^Reject/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').first().check();
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  return ref;
}

// @covers fixture:delay
test('rejecting a card, then the Rejected status during the notice: the first read lists it', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.reject:1500'));
  const ref = await rejectSelected(page);
  await statuses(page).getByRole('button', { name: /^Rejected/ }).click();
  await expect(page.getByRole('region', { name: 'Proposals' }).getByText(ref, { exact: true })).toBeVisible();
  await expect(statuses(page).getByRole('button', { name: /^Rejected/ })).toContainText('1');
});

// @covers fixture:delay
test('rejecting a card, then a lens filter during the notice: the first read does not bring it back as open', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.reject:1500'));
  // an Opportunity card, so the filter below would list it; other Opportunity cards show when that list has come
  await page.locator('button.dwr-row__main').filter({ hasText: 'DW-14' }).click();
  await expect(decide(page)).toHaveAttribute('aria-label', 'Decide DW-14');
  const ref = await rejectSelected(page);
  await page.getByRole('combobox', { name: 'Filter by lens' }).selectOption('opportunity');
  await expect(page.locator('input.dwr-checkbox').first()).toBeAttached();
  await expect(page.getByRole('checkbox', { name: `Check ${ref}` })).toHaveCount(0);
});

// @covers fixture:delay fixture:fail
test('a failed call does not block the reload: the list loads and the notice says why', async ({ page }) => {
  await page.goto(at('inbox&delay=verdict.reject:800&fail=verdict.reject'));
  await rejectSelected(page);
  await statuses(page).getByRole('button', { name: /^Snoozed/ }).click();
  await expect(page.getByText('The verdict.reject resolver is unavailable (fixture).').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Loading the inbox' })).toHaveCount(0);
  await expect(statuses(page).getByRole('button', { name: /^Snoozed/ })).toHaveAttribute('aria-pressed', 'true');
});
