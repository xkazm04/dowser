// @ts-check
// Findings of the /temper simulated UAT on the real core (the e2e seed: one push of six new proposals). Each spec
// asserts the ticket's Expected and is test.fixme until that ticket is fixed: the builder who fixes DOW-n flips
// `test.fixme(` to `test(` here as the red control. Read-only, so it may run beside triage.spec.mjs; each picks
// E2E_INBOX by name, because the triage spec's inboxes come and go in the same picker.
// The functions the browser runs take `document` and friends from globalThis: jsconfig.json has no DOM lib.
import { expect, needEnv, test } from '../lib/guard.mjs';
import { E2E_INBOX } from './seed.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_LOCAL_URL')}#${hash}`;

// The fixture has its own form (uat-states.spec.mjs). The real core answers `forbidden` with its own text, not the
// fixture's `bad-input`, so a fix keyed on the fixture's error alone would still fail here.
test('DOW-11: a deep link to a ref that does not exist says so, with Close and no Retry', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-999'));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('status', { name: 'Loading DW-999' }), 'the answer is in').toHaveCount(0);
  await expect(dialog, 'a plain not-found message').toContainText(/no proposal|not exist|not found|cannot see/i);
  await expect.soft(dialog, 'nothing failed to load: the proposal is not there').not.toContainText(/could not load/i, { timeout: 1000 });
  await expect.soft(dialog.getByRole('button', { name: 'Retry' }), 'retrying cannot help').toHaveCount(0, { timeout: 1000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect.soft(dialog, 'Close closes it').toBeHidden();
});

test('DOW-14: the Scan retro of a push with no repeats says every proposal was new', async ({ page }) => {
  await page.goto(at('reflect'));
  await page.getByRole('combobox', { name: 'Inbox' }).selectOption(E2E_INBOX);
  const retro = page.getByRole('region', { name: 'Scan retro' });
  await expect(retro.getByText('repeat rate'), 'the retro has loaded').toBeVisible();
  await expect(retro.locator('dd').filter({ hasText: /^0%$/ }), 'the seed\'s push has a 0% repeat rate').toBeVisible();
  const reading = await retro.locator('.dwr-reading').innerText();
  expect.soft(reading, 'the retro reading').not.toMatch(/only 0%|almost everything/i);
  expect.soft(reading, 'the retro reading').toMatch(/\b(none|no|nothing)\b[^.]*\b(repeat|known|already)|\b(every|all)\b[^.]*\bnew\b/i);
});

test.describe('a map cell deep link at 1280 x 900', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('DOW-15: the filtered inbox fits the window, with the help button on screen', async ({ page }) => {
    await page.goto(at('map'));
    await page.getByRole('combobox', { name: 'Inbox' }).selectOption(E2E_INBOX);
    await page.getByRole('link', { name: /^Open the \d+ open Opportunity proposals in / }).first().click();
    await expect(page.getByRole('combobox', { name: 'Filter by lens' }), 'the cell applied its lens').toHaveValue('opportunity');
    await expect(page.getByRole('button', { name: /^Clear the area filter / }), 'the cell applied its area').toBeVisible();
    await expect(page.getByRole('region', { name: 'Proposals' }).getByRole('listitem').first()).toBeVisible();
    await expect.soft.poll(() => page.evaluate(() => {
      const { document } = /** @type {any} */ (globalThis);
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth <= clientWidth ? 'fits' : `scrollWidth ${scrollWidth} in a clientWidth of ${clientWidth}`;
    }), { message: 'the page has no horizontal scroll', timeout: 3000 }).toBe('fits');
    await expect.soft.poll(() => page.getByRole('button', { name: 'Keyboard shortcuts' }).evaluate((help) => {
      const { document } = /** @type {any} */ (globalThis);
      const { left, right } = help.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      return left >= 0 && right <= width ? 'on screen' : `? button from ${Math.round(left)} to ${Math.round(right)} in a window ${width} wide`;
    }), { message: 'the ? button is on screen', timeout: 3000 }).toBe('on screen');
  });
});
