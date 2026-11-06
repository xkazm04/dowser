// @ts-check
// DOW-17, Steps: "#inbox&page=4&delay=verdict.accept:3000: press a, Create issue, then during the wait pick Billing (BILL)
// and type a note"; "Same with &delay=verdict.merge:4000: press m, pick DW-14, Merge, then during the wait type SHOP-5 in
// the Jira field." Expected: "While the call runs the fields are locked or a line says what is being done (Creating the
// issue in SHOP...), so the person knows the choice is already sent."
// The functions the browser runs take `document` and friends from globalThis: jsconfig.json has no DOM lib.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const decide = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Selected proposal' }).getByRole('group', { name: /^Decide DW-/ });

/** The fields of the dialog that still take input, by their label. @param {Locator} dialog @returns {Promise<string[]>} */
const fieldsStillOpen = (dialog) => dialog.locator('input, select, textarea').evaluateAll((els) => els
  .filter((el) => !el.matches(':disabled') && !(/** @type {any} */ (el).readOnly))
  .map((el) => el.getAttribute('aria-label') ?? /** @type {any} */ (el).labels?.[0]?.textContent ?? el.id));

/**
 * Locked, or a line in words says the choice has gone out.
 * @param {Locator} dialog @param {RegExp} line
 */
async function expectChoiceReadsAsSent(dialog, line) {
  await expect(dialog.getByRole('button', { name: 'Cancel' }), 'the call is running').toBeDisabled();
  await expect(dialog, 'the call is still running').toBeVisible();
  const open = await fieldsStillOpen(dialog);
  const text = await dialog.innerText();
  expect(open.length === 0 || line.test(text), `fields still editable during the call, with no line saying what is being done: ${open.join(', ')}`).toBe(true);
}

test('DOW-17: while Create issue runs the fields are locked or a line says what is being done', async ({ page }) => {
  await page.goto(at('inbox&page=4&delay=verdict.accept:3000'));
  await expect(decide(page)).toBeVisible();
  await page.keyboard.press('a');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Jira project', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create issue' }).click();
  await expectChoiceReadsAsSent(dialog, /creating (the |an |your )?issue|issue is being created|sending/i);
});

test('DOW-17: while Merge runs the fields are locked or a line says what is being done', async ({ page }) => {
  await page.goto(at('inbox&page=4&delay=verdict.merge:4000'));
  await expect(decide(page)).toBeVisible();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /DW-14/ }).check();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expectChoiceReadsAsSent(dialog, /merging|being merged|sending/i);
});
