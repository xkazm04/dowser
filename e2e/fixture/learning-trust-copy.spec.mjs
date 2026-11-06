// @ts-check
// DW-145: "the Trust copy matches the ladder". "Correct the two Trust sentences on Learning, so they say technical slices
// start at level 1 and that a reject or a snooze of a pre-triaged card lowers the level." Built reading: the Trust hint
// says technical slices start at level 1 and a product slice at level 0, and a reject or snooze of a pre-triaged proposal
// drops the slice a level; the Changes note says a product slice earns level 1 after 20 decisions with at least 90%
// agreement. The note shows only when no slice changed level (`&noevents`).
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

test('the Trust hint states the start per category and that a reject or a snooze lowers the level', async ({ page }) => {
  await page.goto(at('reflect'));
  const trust = page.getByRole('region', { name: 'Trust' });
  await expect(trust.getByRole('table').first()).toBeVisible();
  const hint = trust.locator('.dwr-sec__hint');
  await expect(hint).toContainText(/technical slices? starts? at level 1/i);
  await expect(hint).toContainText(/product slice starts? at level 0|product slices? at level 0/i);
  await expect(hint).toContainText(/reject or (a )?snooze of a pre-triaged proposal drops the slice (by )?a level/i);
  await expect(hint).not.toContainText('One reject of a pre-triaged proposal drops the slice back to level 0');
});

// @covers fixture:noevents
test('the Changes note says who earns level 1, and how', async ({ page }) => {
  await page.goto(at('reflect&noevents'));
  const trust = page.getByRole('region', { name: 'Trust' });
  await expect(trust.getByText('No slice has changed level yet.')).toBeVisible();
  await expect(trust).toContainText('A product slice earns level 1 after 20 decisions with at least 90% agreement.');
  await expect(trust).not.toContainText('A slice reaches level 1 after 20 decisions');
});
