// @ts-check
// DOW-18, Steps: "#inbox&page=4: press m, pick the second proposal (DW-9), type zzzqq in the search field, press Merge."
// Expected: "A pick the list no longer shows is either still shown (for example 'Merging into DW-9') or cleared, with
// Merge disabled."
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

test('DOW-18: a pick the search hid is still shown, or it is cleared and Merge is disabled', async ({ page }) => {
  await page.goto(at('inbox&page=4'));
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ })).toBeVisible();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /DW-9/ }).check();
  await dialog.getByLabel('Find an open or accepted proposal').fill('zzzqq');
  await expect(dialog.getByText('No matching proposal.'), 'the search hides every candidate').toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(0);

  const merge = dialog.getByRole('button', { name: 'Merge', exact: true });
  const enabled = await merge.isEnabled();
  const named = /\bDW-9\b/.test(await dialog.innerText());
  expect(!enabled || named, `Merge is ${enabled ? 'enabled' : 'disabled'} and DW-9 is ${named ? 'named' : 'not on screen'}: a press would merge into a target the person cannot see`).toBe(true);
});
