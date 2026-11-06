// @ts-check
// DOW-19, Steps: "#inbox&page=4&delay=verdict.reject:2000: press r, 1, Ctrl+Enter (toast 'Rejected DW-6 .. Undo u', counts
// Open 10, Rejected 1)", "Click Rejected", "Press u during the wait." Expected: "The decision stays visibly counted while
// it lands, and the person is told it is now final or can still undo it."
// The delay here is 4000 so that the reads at 500 ms are well inside the wait on a loaded machine.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const statusBtn = (/** @type {Page} */ page, /** @type {string} */ name) => page.getByRole('group', { name: /^Filter by status/ }).getByRole('button', { name: new RegExp(`^${name}`) });
/** Whatever tells the person where the undo stands: an Undo still offered, or words that it is final. */
const told = (/** @type {Page} */ page) => page.getByRole('button', { name: 'Undo' })
  .or(page.getByText(/\bfinal\b|can(not|'t| no longer)( be)? undo|no longer (be )?undo|cannot be undone|too late to undo/i));

/** @param {Page} page */
async function rejectThenChangeFilter(page) {
  await page.goto(at('inbox&page=4&delay=verdict.reject:4000'));
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ })).toBeVisible();
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(statusBtn(page, 'Open'), 'the undo window counts the reject').toHaveText(/^Open\s*10$/);
  await expect(statusBtn(page, 'Rejected')).toHaveText(/^Rejected\s*1$/);
  await statusBtn(page, 'Rejected').click();
  await page.waitForTimeout(500); // inside the 4 s wait
}

test('DOW-19: after a filter change during the undo notice the reject stays counted while it lands', async ({ page }) => {
  await rejectThenChangeFilter(page);
  expect.soft(await statusBtn(page, 'Rejected').innerText(), 'the reject is still counted under Rejected').toMatch(/^Rejected\s*1$/);
  expect.soft(await statusBtn(page, 'Open').innerText(), 'the rejected card is not counted as open').toMatch(/^Open\s*10$/);
});

test('DOW-19: after a filter change during the undo notice the person is told it is final or can still be undone', async ({ page }) => {
  await rejectThenChangeFilter(page);
  expect(await told(page).filter({ visible: true }).count(), 'an Undo still offered, or a line that the reject is now final').toBeGreaterThan(0);
});

test('DOW-19: pressing u during the wait says what happened', async ({ page }) => {
  await rejectThenChangeFilter(page);
  const offered = await page.getByRole('button', { name: 'Undo' }).filter({ visible: true }).count() > 0;
  await page.keyboard.press('u');
  await page.waitForTimeout(300); // still inside the wait
  if (offered) {
    // the Undo was still on offer, so u takes the reject back and the counts say so
    expect.soft(await statusBtn(page, 'Open').innerText(), 'the undone card is open again').toMatch(/^Open\s*11$/);
    expect.soft(await statusBtn(page, 'Rejected').innerText(), 'nothing is rejected any more').toMatch(/^Rejected\s*0$/);
  } else {
    expect(await told(page).filter({ visible: true }).count(), 'with no Undo on offer, u answers that the reject is final').toBeGreaterThan(0);
  }
});
