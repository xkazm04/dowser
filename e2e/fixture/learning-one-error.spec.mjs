// @ts-check
// DW-148: "one failure reads as one failure". "Before: 6 banners, 6 Retry buttons, 6 alerts for 1 failed call. After:
// 1 banner, 1 Retry, 1 alert". "Done means one error with one Retry, and no section headings over nothing." "The e2e
// spec fail:reflect.data must still see the failure on the surface."
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const SECTIONS = ['Supporting detail', 'Lens yield', 'Why we say no', 'Scan retro', 'Decided rules and recorded outcomes', 'Trust'];

// @covers fail:reflect.data
test('one failed reflect.data: one error, one Retry, one alert, the page heading stays', async ({ page }) => {
  await page.goto(at('reflect&fail=reflect.data'));
  await expect(page.getByRole('heading', { name: 'What Dowser learned', level: 1 })).toBeVisible();
  await expect(page.getByText('The reflect.data resolver is unavailable (fixture).').first()).toBeVisible();
  await expect(page.getByText('The reflect.data resolver is unavailable (fixture).')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(1);
});

// @covers fail:reflect.data
test('one failed reflect.data: no section headings over nothing', async ({ page }) => {
  await page.goto(at('reflect&fail=reflect.data'));
  await expect(page.getByRole('alert').first()).toBeVisible();
  for (const name of SECTIONS) await expect(page.getByRole('heading', { name, exact: true }), name).toHaveCount(0);
});

// @covers fixture:failonce
test('Retry brings the whole page back: the sections and Needs you', async ({ page }) => {
  await page.goto(at('reflect&failonce=reflect.data'));
  await expect(page.getByRole('alert').first()).toBeVisible();
  // the fixture fails only in the page's first second: a Retry after that succeeds
  await expect(async () => {
    await page.getByRole('button', { name: 'Retry' }).click({ timeout: 500 });
    await expect(page.getByRole('heading', { name: /^Needs you/ })).toBeVisible({ timeout: 800 }); // only once the data came
  }).toPass();
  await expect(page.getByRole('heading', { name: 'Lens yield', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
