// @ts-check
// Opens the live project's persistent profile (E2E_LIVE_PROFILE, default ~/.temper/chrome-profile) headed at the
// Dowser inbox, so the operator can sign in to Atlassian once. Close the window when signed in; the session stays in
// the profile for the live specs.   node e2e/live/sign-in.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { APP, PROFILE } from './live.mjs';

mkdirSync(PROFILE, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${APP}/inbox`);
process.stderr.write(`[e2e] sign in in the opened window (profile ${PROFILE}); close it when the Dowser inbox shows.\n`);
await new Promise((done) => context.once('close', done));
