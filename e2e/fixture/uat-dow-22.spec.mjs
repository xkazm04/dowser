// @ts-check
// DOW-22, Steps: "#reflect, Trust section, Changes, the 'L1 TO L0 Opportunity size M' entry", "Seen in light, dark and at
// 400 px." Expected: "It says who and which proposal in the words used elsewhere on the page: a person's name, a DW number
// and its title."
// In the fixture forge:712020:7d1c is Priya Natarajan (the Recorded outcomes) and 5a6b7c8d9e0f1a2b is "Add a loyalty points
// ledger" (a predicted_why); the reason the fixture carries is the wording of skill/scripts/lib/trust.mjs.
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const RAW = /forge:|machine:|\b[0-9a-f]{16}\b|reversal:/;

for (const [name, hash, width] of /** @type {const} */ ([['light', 'reflect&mode=light', 1280], ['dark', 'reflect&mode=dark', 1280], ['400 px', 'reflect', 400]])) {
  test(`DOW-22: a Trust drop names the person, the DW number and the title (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(at(hash));
    const entry = page.getByRole('region', { name: 'Trust' }).getByRole('listitem').filter({ hasText: 'L1 to L0' });
    await expect(entry).toBeVisible();
    const text = await entry.innerText();
    expect.soft(text, 'no raw ids').not.toMatch(RAW);
    expect.soft(text, 'who decided').toContain('Priya Natarajan');
    expect.soft(text, 'the DW number of the proposal').toMatch(/\bDW-\d+\b/);
    expect.soft(text, 'the title of the proposal').toMatch(/loyalty points ledger/i);
  });
}
