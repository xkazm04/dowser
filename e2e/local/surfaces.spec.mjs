// @ts-check
// Every surface against the REAL Forge core (tools/local-forge.mjs over node:sqlite, seeded by e2e/local/seed.mjs):
// the same key elements as the fixture smoke, through the app's own resolvers. Read-only, so it may run beside
// triage.spec.mjs. Coverage tags: e2e/README.md.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';
import { E2E_INBOX } from './seed.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_LOCAL_URL')}#${hash}`;

/** @type {{hash: string, name: string, check: (page: import('@playwright/test').Page) => Promise<void>}[]} */
const SURFACES = [
  // @covers route:inbox resolver:inbox.list resolver:proposal.get
  { hash: 'inbox', name: 'inbox', check: async (page) => {
    await expect(page.getByRole('region', { name: 'Proposals' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('heading', { level: 2 })).toBeVisible();
  } },
  // @covers route:map resolver:map.data resolver:settings.get
  { hash: 'map', name: 'map', check: async (page) => {
    await expect(page.getByRole('heading', { name: 'Opportunity map', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Proposals by area and lens' }).getByRole('table')).toBeVisible();
  } },
  // @covers route:reflect resolver:reflect.data
  { hash: 'reflect', name: 'reflect', check: async (page) => {
    await expect(page.getByRole('heading', { name: 'What Dowser learned', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
  } },
  // @covers route:settings resolver:settings.get resolver:jira.projects resolver:direction.get
  { hash: 'settings', name: 'settings', check: async (page) => {
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('combobox', { name: `Jira project for ${E2E_INBOX}` })).toHaveValue('DOW');
  } },
  // @covers route:dowser-evidence resolver:panel.forIssue
  { hash: 'panel&issue=DOW-999', name: 'panel-none', check: async (page) => {
    await expect(page.getByText('No Dowser evidence you can view here.')).toBeVisible();
  } },
  // @covers route:dowser-doc-impact resolver:byline.forPage
  { hash: 'byline&page=1', name: 'byline', check: async (page) => {
    await expect(page.getByText('No Dowser proposals mention this page.')).toBeVisible();
  } },
  // @covers route:dowser-doc-banner
  { hash: 'banner&page=1', name: 'banner', check: async (page) => {
    // no finding names page 1, so the banner renders nothing; the page must still load cleanly
    await expect(page.locator('#root')).toBeAttached();
    await expect(page.getByRole('region', { name: 'Dowser doc drift' })).toHaveCount(0);
  } },
];

for (const s of SURFACES) {
  test(`local core: surface ${s.hash} renders its key element`, async ({ page }) => {
    await page.goto(at(s.hash));
    await s.check(page);
    await screen(page, s.name);
  });
}
