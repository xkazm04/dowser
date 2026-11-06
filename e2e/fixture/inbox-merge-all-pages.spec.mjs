// @ts-check
// DW-118: "Merge finds any open proposal of the inbox". Flow: "person filters to Doc drift and presses m on a card; they
// search for its duplicate, an open UX friction card; the dialog says No matching proposal". "Done means open candidates
// come from allPages for the card's inbox, unfiltered, with the same cut-short and failure messages." Built reading: a
// card hidden on this page (in its undo window) is not offered. DW-9 is the shop inbox's Doc drift card.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const FIND = 'Find an open or accepted proposal';
const decide = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ });

/** Opens Merge with the m key on the only row of the Doc drift filter (DW-9). @param {Page} page @param {string} [extra] */
async function mergeUnderLens(page, extra = '') {
  await page.goto(at(`inbox&lens=doc-drift${extra}`));
  await expect(decide(page)).toHaveAttribute('aria-label', 'Decide DW-9');
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Merge DW-9' })).toBeVisible();
  return dialog;
}

test('under a lens filter, m then a title of an open card of another lens: found, and the merge goes through', async ({ page }) => {
  const dialog = await mergeUnderLens(page);
  await dialog.getByLabel(FIND).fill('Keep the cart');
  const hit = dialog.getByRole('radio', { name: /DW-11 · open/ });
  await expect(hit).toBeVisible();
  await expect(dialog.getByText('No matching proposal.')).toHaveCount(0);
  await hit.check();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('DW-9 merged into DW-11.')).toBeAttached();
});

// @covers fixture:page
test('an open card past the loaded page is found', async ({ page }) => {
  await page.goto(at('inbox&page=1'));
  await expect(page.getByRole('region', { name: 'Proposals' }).locator('input.dwr-checkbox')).toHaveCount(1);
  await decide(page).getByRole('button', { name: /^Merge/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(FIND).fill('Let shops schedule');
  await expect(dialog.getByRole('radio', { name: /DW-2 · open/ })).toBeVisible();
});

test('an open card of another inbox is not offered, and a real miss says so', async ({ page }) => {
  const dialog = await mergeUnderLens(page);
  await expect(dialog.getByRole('radio').first()).toBeVisible();
  await dialog.getByLabel(FIND).fill('webhook deliveries');
  await expect(dialog.getByText('No matching proposal.')).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
});

test('the card itself is not offered, whatever the search', async ({ page }) => {
  const dialog = await mergeUnderLens(page);
  await expect(dialog.getByRole('radio').first()).toBeVisible();
  await dialog.getByLabel(FIND).fill('DW-9');
  await expect(dialog.getByRole('radio', { name: /DW-9 · / })).toHaveCount(0);
});

test('a card in its undo window is not offered, though the server still lists it as open', async ({ page }) => {
  await page.goto(at('inbox&project=github.com/acme/shop&page=20'));
  const group = decide(page);
  await expect(group).toBeVisible();
  const ref = String(await group.getAttribute('aria-label')).replace('Decide ', '');
  await group.getByRole('button', { name: /^Reject/ }).click();
  const reject = page.getByRole('dialog');
  await reject.getByRole('radio').first().check();
  await reject.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(decide(page)).not.toHaveAttribute('aria-label', `Decide ${ref}`);
  await decide(page).getByRole('button', { name: /^Merge/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /DW-2 · open/ })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: new RegExp(`${ref} · `) })).toHaveCount(0);
});

// @covers fixture:fail resolver:inbox.list
test('a failed list says what could not load, keeps what did, and offers Retry', async ({ page }) => {
  const dialog = await mergeUnderLens(page, '&fail=inbox.list:accepted');
  const message = dialog.getByRole('alert').filter({ hasText: 'Some proposals could not load, so the list may be short.' });
  await expect(message).toBeVisible();
  await expect(message.getByRole('button', { name: 'Retry' })).toBeVisible();
  await dialog.getByLabel(FIND).fill('Keep the cart');
  await expect(dialog.getByRole('radio', { name: /DW-11 · open/ })).toBeVisible();
});
