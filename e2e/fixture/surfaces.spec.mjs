// @ts-check
// Every surface of the fixture UI (forge/static/app/src/dev/bridge.js) renders its key element without a console
// or page error, and leaves a primary-viewport screenshot. Coverage tags: e2e/README.md.
import { expect, needEnv, screen, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;

/** @type {{hash: string, name: string, check: (page: import('@playwright/test').Page) => Promise<void>}[]} */
const SURFACES = [
  // @covers route:inbox resolver:inbox.list resolver:proposal.get
  { hash: 'inbox', name: 'inbox', check: async (page) => {
    await expect(page.getByRole('region', { name: 'Proposals' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Selected proposal' }).getByRole('heading', { level: 2 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Triage history' })).toBeVisible();
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
    await expect(page.getByRole('combobox', { name: 'Jira project for github.com/acme/shop' })).toHaveValue(/.+/);
    await expect(page.getByRole('heading', { name: 'Lens direction', level: 2 })).toBeVisible();
  } },
  // @covers route:dowser-evidence resolver:panel.forIssue
  { hash: 'panel', name: 'panel', check: async (page) => {
    await expect(page.getByRole('heading', { name: 'Explain shipping costs before the payment step', level: 2 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SHOP-101' }).first()).toBeVisible();
  } },
  // @covers route:dowser-evidence
  { hash: 'panel-none', name: 'panel-none', check: async (page) => {
    await expect(page.getByText('No Dowser evidence you can view here.')).toBeVisible();
  } },
  // @covers route:dowser-doc-impact resolver:byline.forPage
  { hash: 'byline', name: 'byline', check: async (page) => {
    await expect(page.getByRole('heading', { name: '2 Dowser proposals' })).toBeVisible();
  } },
  // @covers route:dowser-doc-banner resolver:byline.forPage
  { hash: 'banner', name: 'banner', check: async (page) => {
    await expect(page.getByRole('region', { name: 'Dowser doc drift' })).toBeVisible();
  } },
];

for (const s of SURFACES) {
  test(`surface ${s.hash} renders its key element`, async ({ page }) => {
    await page.goto(at(s.hash));
    await s.check(page);
    await screen(page, s.name);
  });
}
