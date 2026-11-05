// @ts-check
// Live smoke on the Jira development site (e2e/live/live.mjs): the sidebar tabs, the inbox at a deep link, and the
// Accept dialog's issue preview. Read-only: the dialog is cancelled, never submitted. Signed out = unverifiable.
// One file, so one worker holds the profile; each test is its own connection.
import { APP, OPEN_REF, STEP_MS, appFrame, domClick, expect, openLive, test } from './live.mjs';
import { screen } from '../lib/guard.mjs';

const TABS = [
  { title: 'Inbox', heading: 'Dowser inbox' },
  { title: 'Opportunity map', heading: 'Opportunity map' },
  { title: 'Learning', heading: 'What Dowser learned' },
  { title: 'Settings', heading: 'Settings' },
];

// @covers live:sidebar route:inbox route:map route:reflect route:settings
test('live: every sidebar tab shows its page', async ({ page }) => {
  await openLive(page, `${APP}/inbox`);
  for (const tab of TABS) {
    await domClick(page.getByRole('link', { name: tab.title, exact: true }).first());
    await expect(appFrame(page).getByRole('heading', { name: tab.heading, level: 1 })).toBeAttached({ timeout: STEP_MS });
    await screen(page, `live-tab-${tab.title}`);
  }
});

// @covers live:deeplink fixture:ref
test('live: the inbox opens at a deep link', async ({ page }) => {
  await openLive(page, `${APP}/inbox?ref=${OPEN_REF}`);
  const pane = appFrame(page).getByRole('region', { name: 'Selected proposal' });
  await expect(pane.getByText(OPEN_REF, { exact: true }).first()).toBeVisible({ timeout: STEP_MS });
  await screen(page, 'live-deeplink');
});

// @covers live:issue-preview
test('live: the Accept dialog previews the Jira issue with its sections', async ({ page }) => {
  await openLive(page, `${APP}/inbox?ref=${OPEN_REF}`);
  const frame = appFrame(page);
  await frame.getByRole('group', { name: `Decide ${OPEN_REF}` }).getByRole('button', { name: /^Accept/ }).click({ timeout: STEP_MS });
  const dialog = frame.getByRole('dialog');
  const preview = dialog.getByRole('region', { name: 'Preview of the Jira issue' });
  await expect(preview).toBeVisible({ timeout: STEP_MS });
  await expect(preview.getByRole('table', { name: 'Facts' })).toBeVisible();
  await screen(page, 'live-issue-preview');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
