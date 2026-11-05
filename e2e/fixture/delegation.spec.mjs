// @ts-check
// Delegated triage in Settings (forge/src/core/delegate.mjs, routes/settings): the fixture's shop inbox is delegated
// until 2099-12-31 and billing is off; `&delegation=ended` ends shop's delegation yesterday.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const section = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('region', { name: 'Delegated triage' }).or(
  page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Delegated triage' }) }).first());

// @covers fixture:delegation
test('Settings: one inbox delegated with its limits, one off; the sample takes none', async ({ page }) => {
  await page.goto(at('settings'));
  await expect(page.getByRole('heading', { name: 'Delegated triage' })).toBeVisible();
  const s = section(page);
  await expect(s.getByText(/Temper may accept and reject in this inbox until/)).toBeVisible();
  await expect(s.getByText('Off. Temper records nothing in this inbox.')).toBeVisible();
  await screen(page, 'settings-delegation');
});

// @covers fixture:delegation
test('&delegation=ended: the ended delegation says so and asks for a new date', async ({ page }) => {
  await page.goto(at('settings&delegation=ended'));
  await expect(page.getByRole('heading', { name: 'Delegated triage' })).toBeVisible();
  await expect(section(page).getByText(/^Ended on .+ Temper records nothing here until you set a new date\.$/)).toBeVisible();
  await screen(page, 'settings-delegation-ended');
});
