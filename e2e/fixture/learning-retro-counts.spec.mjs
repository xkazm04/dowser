// @ts-check
// DW-149: "the retro does not contradict itself on a rescan". The card's three cases: "0 created and 5 updated, 3
// created and 5 updated, 0 and 0, where the text is true". "After: 0 false empty texts". Built reading: for 0 created and
// updated > 0 the text under the bar is "All N were found by earlier pushes; their decisions count there."; with both
// above 0 a note under the heading "Counts the N items this push found first; the M it re-found count on their first
// push."; 0 and 0 keep "No items in this push."
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const retro = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Scan retro' });
const EMPTY = 'No items in this push.';

// @covers fixture:latest
test('0 created and 5 updated: says where the decisions count, not that the push had no items', async ({ page }) => {
  await page.goto(at('reflect&latest=0:5'));
  await expect(retro(page).getByText('Decisions so far on this push')).toBeVisible();
  await expect(retro(page)).toContainText('All 5 were found by earlier pushes; their decisions count there.');
  await expect(retro(page).getByText(EMPTY)).toHaveCount(0);
});

// @covers fixture:latest
test('3 created and 5 updated: a note says what the bar counts', async ({ page }) => {
  await page.goto(at('reflect&latest=3:5'));
  await expect(retro(page).getByText('Decisions so far on this push')).toBeVisible();
  await expect(retro(page)).toContainText('Counts the 3 items this push found first; the 5 it re-found count on their first push.');
  await expect(retro(page).getByRole('img', { name: /^Decisions on the items of the latest push/ })).toBeVisible();
  await expect(retro(page).getByText(EMPTY)).toHaveCount(0);
});

// @covers fixture:latest
test('0 and 0: the old text stays true', async ({ page }) => {
  await page.goto(at('reflect&latest=0:0'));
  await expect(retro(page).getByText(EMPTY)).toBeVisible();
  await expect(retro(page)).not.toContainText('found by earlier pushes');
  await expect(retro(page)).not.toContainText('re-found');
});

// @covers fixture:latest
test('3 created and 0 updated: the bar is the whole push, so no note', async ({ page }) => {
  await page.goto(at('reflect&latest=3:0'));
  await expect(retro(page).getByRole('img', { name: /^Decisions on the items of the latest push/ })).toBeVisible();
  await expect(retro(page)).not.toContainText('re-found');
  await expect(retro(page)).not.toContainText('found by earlier pushes');
});
