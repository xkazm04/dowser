// @ts-check
// The success answer of each write the fixture can show on the page: the surface confirms what the resolver
// answered. Verdicts are asserted against the real core in e2e/local/triage.spec.mjs instead, where the decision
// can be read back through MCP. Coverage tags: e2e/README.md.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

// @covers resolver:settings.set
test('settings: saving an accept target says Saved', async ({ page }) => {
  await page.goto(at('settings'));
  const row = page.getByRole('row', { name: /github\.com\/acme\/billing/ });
  await row.getByRole('combobox', { name: /^Jira project/ }).selectOption({ label: 'Shop (SHOP)' });
  await row.getByRole('combobox', { name: /^Issue type/ }).selectOption({ label: 'Story' });
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('Saved.')).toBeVisible();
});

// @covers resolver:direction.set
test('settings: saving a lens direction says Saved and shows it in the summary', async ({ page }) => {
  await page.goto(at('settings'));
  const lens = page.locator('details.dw-dir__lens').nth(1);
  await lens.locator('summary').click();
  await lens.getByLabel('Focus on').fill('checkout\ninvoices');
  await lens.getByRole('button', { name: 'Save' }).click();
  await expect(lens.getByText('Saved.')).toBeVisible();
  await expect(lens.locator('summary')).toContainText('Focus: checkout, invoices');
  await screen(page, 'direction-saved');
});

// @covers resolver:rule.decide
test('learning: accepting an offered rule takes it out of Needs you', async ({ page }) => {
  await page.goto(at('reflect'));
  const offers = page.getByRole('article', { name: /^Offered rule for/ });
  await expect(offers.first()).toBeVisible();
  const before = await offers.count();
  await offers.first().getByRole('button', { name: 'Accept rule' }).click();
  await expect(page.getByText('Rule accepted.')).toBeAttached();
  await expect(offers).toHaveCount(before - 1);
});

// @covers resolver:outcome.record
test('learning: rating an accepted item records it', async ({ page }) => {
  await page.goto(at('reflect'));
  const rate = page.getByRole('article', { name: 'Rate DW-1' });
  await rate.getByRole('radio', { name: 'Right call' }).check();
  await rate.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Recorded DW-1.')).toBeAttached();
  await expect(rate).toHaveCount(0);
});

// @covers resolver:byline.draftFix route:dowser-doc-impact
test('byline: drafting the fix posts a comment', async ({ page }) => {
  await page.goto(at('byline'));
  await page.getByRole('button', { name: 'Draft the fix as a comment' }).click();
  await expect(page.getByText('Comment posted below the page, with the code that disagrees.')).toBeVisible();
});

// @covers resolver:sample.remove fixture:sample
test('inbox: removing the sample says so and leaves the first-run screen', async ({ page }) => {
  await page.goto(at('inbox&empty&sample'));
  await page.getByRole('button', { name: 'Remove sample data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove sample data' }).click();
  await expect(page.getByText(/^Sample removed\./)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start with Dowser', level: 2 })).toBeVisible();
});
