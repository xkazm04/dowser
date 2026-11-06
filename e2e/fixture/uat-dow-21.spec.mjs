// @ts-check
// DOW-21, Steps: "#reflect: open 'Not built yet (2)', pick a rating on an item, press Record." Expected: "The person stays
// by the section, sees a confirmation, and can rate the next item there, as happens for items rated in the main Needs you
// list."
// The functions the browser runs take `document` and friends from globalThis: jsconfig.json has no DOM lib.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const rate = (/** @type {Page} */ page, /** @type {string} */ ref) => page.getByRole('article', { name: `Rate ${ref}`, exact: true });

/** Rates DW-4 inside the opened section. @param {Page} page */
async function rateFirst(page) {
  await page.goto(at('reflect'));
  await page.locator('summary').filter({ hasText: 'Not built yet (2)' }).click();
  const article = rate(page, 'DW-4');
  await article.getByRole('radio', { name: 'Right call' }).check();
  await article.getByRole('button', { name: 'Record' }).click();
  await expect(article).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Not built yet (1)' })).toBeAttached();
}

/**
 * Text a sighted person can read in the viewport now: not a visually hidden line, not below the fold.
 * @param {Page} page @param {RegExp} words
 */
const readableNow = (page, words) => page.getByText(words).evaluateAll((els) => {
  const { innerHeight, innerWidth } = /** @type {any} */ (globalThis);
  return els.some((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 8 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  });
});

test('DOW-21: after a rating in Not built yet the next item is still in view, with the focus in the section', async ({ page }) => {
  await rateFirst(page);
  await expect.soft(rate(page, 'DW-8'), 'the next item is on screen').toBeInViewport({ timeout: 2000 });
  const inSection = page.locator('details:has(> summary:has-text("Not built yet")) :focus');
  await expect.soft(inSection, 'the focus stays in the section').toHaveCount(1, { timeout: 2000 });
});

test('DOW-21: a rating in Not built yet shows a confirmation a person can see', async ({ page }) => {
  await rateFirst(page);
  await expect.poll(() => readableNow(page, /(recorded|saved|rated).*DW-4|DW-4.*(recorded|saved|rated)/i), { timeout: 2000, message: 'a visible confirmation naming DW-4, in the viewport' }).toBe(true);
});

test('DOW-21: the next item can be rated from there, with its own confirmation', async ({ page }) => {
  await rateFirst(page);
  await expect(rate(page, 'DW-8'), 'the next item is on screen').toBeInViewport({ timeout: 2000 });
  await rate(page, 'DW-8').getByRole('radio', { name: 'Right call' }).check();
  await rate(page, 'DW-8').getByRole('button', { name: 'Record' }).click();
  await expect(rate(page, 'DW-8')).toHaveCount(0);
  await expect.poll(() => readableNow(page, /(recorded|saved|rated).*DW-8|DW-8.*(recorded|saved|rated)/i), { timeout: 2000, message: 'a visible confirmation naming DW-8, in the viewport' }).toBe(true);
});
