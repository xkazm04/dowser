// @ts-check
// Findings of the /temper simulated UAT in the inbox's and the Learning tab's states: what the page says while it
// loads, when a call fails, and when a list is empty. Each spec asserts the ticket's Expected and is test.fixme until
// that ticket is fixed: the builder who fixes DOW-n flips `test.fixme(` to `test(` here as the red control.
// The functions the browser runs take `document` and friends from globalThis: jsconfig.json has no DOM lib.
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
/** A claim about pushes, either way. A neutral "Loading..." or no run line at all is fine. */
const PUSH_CLAIM = /no push|last push/i;

test.fixme('DOW-6: while the inbox loads the toolbar makes no claim about pushes', async ({ page }) => {
  await page.goto(at('inbox&slow'));
  // One read of the skeleton and the toolbar together: a second read could already see the loaded list, whose run
  // line is a true claim, and a retrying assertion would pass the moment the list arrives.
  const during = await page.waitForFunction(() => {
    const { document } = /** @type {any} */ (globalThis);
    const skeleton = document.querySelector('[role="status"][aria-label="Loading the inbox"]');
    return skeleton ? { toolbar: document.querySelector('.dwr-toolbar')?.textContent ?? '' } : null;
  });
  const toolbar = /** @type {{toolbar: string}} */ (await during.jsonValue()).toolbar;
  expect(toolbar, 'the toolbar over the loading skeleton').not.toMatch(PUSH_CLAIM);
});

test.fixme('DOW-6: when the inbox failed to load the toolbar makes no claim about pushes', async ({ page }) => {
  await page.goto(at('inbox&fail=inbox.list'));
  await expect(page.getByRole('alert').filter({ hasText: 'The inbox could not load.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' }), 'the toolbar is on the page').toBeVisible();
  expect(await page.locator('.dwr-toolbar').innerText(), 'the toolbar beside the error').not.toMatch(PUSH_CLAIM);
});

test.fixme('DOW-7: Accept with settings.get failed says the read failed, not that the inbox has no default', async ({ page }) => {
  await page.goto(at('inbox&ref=DW-6&fail=settings.get'));
  await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('heading', { level: 2 })).toBeVisible();
  await page.keyboard.press('a');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Accept DW-6' })).toBeVisible();
  // jira.projects answers, so the project field is there and the hint under it has been chosen
  await expect(dialog.getByLabel('Jira project', { exact: true }), 'the dialog has finished loading').toBeVisible();
  const text = await dialog.innerText();
  expect.soft(text, 'the shop inbox has a default target: only the read failed').not.toMatch(/has no default project/i);
  expect.soft(text, 'the shop inbox has a default target: only the read failed').not.toMatch(/set a default target in settings/i);
  expect.soft(text, 'the settings read failure is what is said').toMatch(/settings(\.get)?\b[^.]*(could not load|unavailable|failed)|default[^.]*(unknown|could not)/i);
});

test.fixme('DOW-11: a deep link to a ref that does not exist says so, with Close and no Retry', async ({ page }) => {
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

test.fixme('DOW-12: an empty status tab has copy that fits the status, and no scan advice', async ({ page }) => {
  await page.goto(at('inbox'));
  await page.getByRole('combobox', { name: 'Inbox' }).selectOption('github.com/acme/billing');
  const status = page.getByRole('group', { name: /^Filter by status/ });
  for (const name of ['Rejected', 'Accepted', 'Snoozed']) {
    await status.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(status.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-pressed', 'true');
    const empty = page.getByRole('status').filter({ hasText: new RegExp(`\\b(no|nothing)\\b.*\\b${name}\\b`, 'i') });
    await expect(empty, `the empty ${name} tab says so`).toBeVisible();
    await expect.soft(page.locator('body'), `the ${name} tab: a scan's pushes land in Open`).not.toContainText(/run a scan/i, { timeout: 1000 });
    await expect.soft(page.locator('body'), `the ${name} tab: a scan's pushes land in Open`).not.toContainText(/pushed here/i, { timeout: 1000 });
  }
});

test.fixme('DOW-13: one failed reflect.data call reads as one failure with one Retry', async ({ page }) => {
  await page.goto(at('reflect&fail=reflect.data'));
  await expect(page.getByRole('heading', { name: 'What Dowser learned', level: 1 })).toBeVisible();
  const message = page.getByText('The reflect.data resolver is unavailable (fixture).');
  await expect(message.first(), 'the failure is on the page').toBeVisible();
  await expect.soft(message, 'one error message for the one call').toHaveCount(1, { timeout: 2000 });
  await expect.soft(page.getByRole('button', { name: 'Retry' }), 'one Retry for the one call').toHaveCount(1, { timeout: 2000 });
});
