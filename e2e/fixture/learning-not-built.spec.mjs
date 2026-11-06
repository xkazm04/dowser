// @ts-check
// DW-150: "Needs you counts only items a person can judge". "After: 0 undelivered items counted as waiting; they show
// apart as not built yet". "Jira statuses can be unreadable (unknown), so such items need a home that does not hide them
// for good." Built reading: Needs you and the digest's "to rate" count only candidates with done true or delivery
// abandoned; the rest show under a collapsed "Not built yet (N)" with the same rate controls inside, not counted.
// The fixture's shop inbox: 2 rule offers; DW-1 done, DW-7 abandoned; DW-4 in progress, DW-8 unknown.
import { expect, needEnv, test } from '../lib/guard.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const needs = (/** @type {Page} */ page) => page.getByRole('heading', { name: /^Needs you/ });
const digest = (/** @type {Page} */ page) => page.getByRole('region', { name: 'Summary' });
const notBuilt = (/** @type {Page} */ page, /** @type {number} */ n) => page.locator('summary').filter({ hasText: `Not built yet (${n})` });
const rate = (/** @type {Page} */ page, /** @type {string} */ ref) => page.getByRole('article', { name: `Rate ${ref}`, exact: true });

/** @param {import('@playwright/test').Locator} article */
async function rateRight(article) {
  await article.getByRole('radio', { name: 'Right call' }).check();
  await article.getByRole('button', { name: 'Record' }).click();
  await expect(article).toHaveCount(0);
}

test('Needs you and the digest count only what can be judged: done or abandoned', async ({ page }) => {
  await page.goto(at('reflect'));
  await expect(needs(page)).toContainText('4'); // 2 rule offers, DW-1, DW-7
  await expect(digest(page)).toContainText('2 rule offers and 2 accepted items to rate are waiting for you.');
  await expect(rate(page, 'DW-1')).toBeVisible();
  await expect(rate(page, 'DW-7')).toBeVisible();
});

test('the rest show apart under a collapsed "Not built yet (N)", with the same rate controls inside', async ({ page }) => {
  await page.goto(at('reflect'));
  const summary = notBuilt(page, 2);
  await expect(summary).toBeVisible();
  await expect(rate(page, 'DW-4')).toBeHidden();
  await expect(rate(page, 'DW-8')).toBeHidden();
  await summary.click();
  await expect(rate(page, 'DW-4')).toBeVisible();
  await expect(rate(page, 'DW-4').getByText('In Progress')).toBeVisible();
  await expect(rate(page, 'DW-4').getByRole('radio', { name: 'Right call' })).toBeVisible();
  await expect(rate(page, 'DW-4').getByRole('button', { name: 'Record' })).toBeVisible();
});

test('an item whose Jira status is unknown is in Not built yet, never hidden for good', async ({ page }) => {
  await page.goto(at('reflect'));
  await notBuilt(page, 2).click();
  await expect(rate(page, 'DW-8')).toBeVisible();
  await expect(rate(page, 'DW-8').getByText('unknown', { exact: true })).toBeVisible();
});

test('a rating inside Not built yet still records, and moves neither count', async ({ page }) => {
  await page.goto(at('reflect'));
  await notBuilt(page, 2).click();
  await rateRight(rate(page, 'DW-4'));
  await expect(page.getByText('Recorded DW-4.')).toBeAttached();
  await expect(notBuilt(page, 1)).toBeVisible();
  await expect(needs(page)).toContainText('4');
});

test('with only not-built items left: Nothing is waiting, the empty text is true, and they stay reachable', async ({ page }) => {
  await page.goto(at('reflect'));
  const offers = page.getByRole('article', { name: /^Offered rule for/ });
  await expect(offers).toHaveCount(2);
  await offers.first().getByRole('button', { name: 'Decline' }).click();
  await expect(offers).toHaveCount(1);
  await offers.first().getByRole('button', { name: 'Decline' }).click();
  await expect(offers).toHaveCount(0);
  await rateRight(rate(page, 'DW-1'));
  await rateRight(rate(page, 'DW-7'));
  await expect(needs(page)).toContainText('0');
  await expect(digest(page)).toContainText('Nothing is waiting for you.');
  const empty = page.getByRole('status').filter({ hasText: 'Nothing to decide.' });
  await expect(empty).toBeVisible();
  // the card: "the empty state promises an item is listed once its Jira issue moves": an issue In Progress has moved, and is not listed
  await expect(empty).not.toContainText('once its Jira issue moves');
  await expect(notBuilt(page, 2)).toBeVisible();
});
