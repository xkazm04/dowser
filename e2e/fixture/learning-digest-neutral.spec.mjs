// @ts-check
// DW-144: "the digest never credits a delegate's accept to a person". "Before: 1 digest sentence says You over a count
// that includes delegate accepts. After: 0 such sentences." Built reading: the line reads "<strong>N of M</strong>
// proposals accepted so far", with no "You have accepted". The fixture's shop inbox holds a delegate accept.
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

test('the digest line is neutral, and keeps its count and the lens that converts best', async ({ page }) => {
  await page.goto(at('reflect'));
  const digest = page.getByRole('region', { name: 'Summary' });
  await expect(digest.getByText('Temper (delegate)')).toBeVisible();
  await expect(digest).toContainText('6 of 26 proposals accepted so far');
  await expect(digest.locator('strong').filter({ hasText: /^6 of 26$/ })).toBeVisible();
  await expect(digest).toContainText('converts best');
  await expect(digest).not.toContainText('You have accepted');
});
