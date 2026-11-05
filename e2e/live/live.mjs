// @ts-check
// The live project's door: the deployed app on the Jira development site, driven in the operator's persistent
// profile. Lessons from the live CDP runs (the idea note's scout digest) are built in:
//   - foreground tab: the page is brought to the front, and focus is emulated, so Jira and the Forge iframe behave
//     as for a person (a background tab throttles timers and skips focus events);
//   - one connection per flow: every spec opens its own persistent context and closes it;
//   - the sidebar's group items react to a DOM click only (domClick), not a synthetic pointer sequence;
//   - hard timeouts on every wait.
// Signed out (the Atlassian login page) or no profile at all ends the spec as `unverifiable`, never `fail`.
import { test as base, chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unverifiable } from '../lib/guard.mjs';

export { expect };

export const PROFILE = process.env.E2E_LIVE_PROFILE || join(homedir(), '.temper', 'chrome-profile');
export const SITE = process.env.E2E_LIVE_SITE || 'https://dowser.atlassian.net';
/** The global page of the development environment (docs/concepts/project-status-and-next-steps.md). */
export const APP = process.env.E2E_LIVE_APP
  || `${SITE}/jira/apps/68371a5c-644f-4311-b1c8-8d9582995796/646b63dc-cbf7-4575-b2ff-dfac59ca68c6`;
/** Test data on the site: an open item and an accepted issue. */
export const OPEN_REF = process.env.E2E_LIVE_REF || 'DW-3';
export const STEP_MS = 45_000;

/** The Forge Custom UI iframe (served from the Forge CDN). @param {import('@playwright/test').Page} page */
export const appFrame = (page) => page.frameLocator('iframe[src*="atlassian-dev.net"], iframe[src*="cdn.prod.atlassian"]').first();

/** A click dispatched in the DOM (`el.click()`), which Jira's sidebar groups need. @param {import('@playwright/test').Locator} loc */
export async function domClick(loc) {
  await loc.waitFor({ state: 'attached', timeout: STEP_MS });
  await loc.evaluate((el) => /** @type {any} */ (el).click());
}

/** True when the page is Atlassian's login (the profile is signed out). @param {import('@playwright/test').Page} page */
export function onLogin(page) {
  const u = new URL(page.url());
  return u.hostname === 'id.atlassian.com' || /\/login\b/.test(u.pathname);
}

/**
 * Opens `url` and waits for the app's iframe or the login page, whichever comes first; the login page ends the spec
 * as unverifiable.
 * @param {import('@playwright/test').Page} page @param {string} url
 */
export async function openLive(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_MS });
  const login = page.waitForURL((u) => u.hostname === 'id.atlassian.com' || /\/login\b/.test(u.pathname), { timeout: STEP_MS }).then(() => 'login');
  const app = page.locator('iframe[src*="atlassian-dev.net"], iframe[src*="cdn.prod.atlassian"]').first().waitFor({ timeout: STEP_MS }).then(() => 'app');
  const first = await Promise.any([login, app]).catch(() => (onLogin(page) ? 'login' : 'none'));
  if (first === 'login' || onLogin(page)) unverifiable(`the profile at ${PROFILE} is signed out of ${SITE}: sign in with node e2e/live/sign-in.mjs`);
  if (first === 'none') throw new Error(`neither the Dowser iframe nor the login page appeared at ${url} within ${STEP_MS} ms`);
}

/** Forge iframe console errors, the only console lines the live specs judge (Jira's own are not the app's). */
const FORGE_ORIGIN = /atlassian-dev\.net|cdn\.prod\.atlassian/;

export const test = base.extend({
  // One persistent context per flow, in the foreground, focus emulated.
  page: async ({}, use) => {
    if (!existsSync(PROFILE)) unverifiable(`no profile at ${PROFILE}: sign in once with node e2e/live/sign-in.mjs`);
    const context = await chromium.launchPersistentContext(PROFILE, {
      headless: process.env.E2E_LIVE_HEADLESS === '1', viewport: { width: 1440, height: 900 }, timeout: STEP_MS,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(STEP_MS);
      await page.bringToFront();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      /** @type {string[]} */
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error' && FORGE_ORIGIN.test(m.location().url ?? '')) errors.push(m.text()); });
      await use(page);
      expect(errors, 'console errors from the Dowser iframe').toEqual([]);
    } finally {
      await context.close();
    }
  },
});
