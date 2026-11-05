// @ts-check
// Findings of the /temper simulated UAT in layout, focus and colour: the narrow inbox, the bulk Snooze step's focus,
// and the Effort vs confidence marks' contrast. Each spec asserts the ticket's Expected and is test.fixme until that
// ticket is fixed: the builder who fixes DOW-n flips `test.fixme(` to `test(` here as the red control.
// The functions the browser runs take `document` and friends from globalThis: jsconfig.json has no DOM lib.
import { expect, needEnv, test } from '../lib/guard.mjs';

const at = (/** @type {string} */ hash) => `${needEnv('E2E_FIXTURE_URL')}#${hash}`;
const rows = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('region', { name: 'Proposals' }).getByRole('listitem');

test.describe('narrow inbox (400 x 800)', () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test.fixme('DOW-8: j moves to a card whose title is in view below the sticky toolbar', async ({ page }) => {
    await page.goto(at('inbox'));
    await expect(rows(page).first()).toBeVisible();
    const current = page.locator('.dwr-row__main[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(page.locator('.dwr-inline'), 'the selected card is open inline').toBeVisible();
    const before = await current.locator('.dwr-row__title').innerText();
    await page.keyboard.press('j');
    await expect(current.locator('.dwr-row__title'), 'j moved the selection').not.toHaveText(before);
    // polled: the accordion closes one card and opens the next after the key
    await expect.poll(() => current.locator('.dwr-row__title').evaluate((title) => {
      const { document, window } = /** @type {any} */ (globalThis);
      const t = title.getBoundingClientRect();
      const toolbarBottom = Math.round(document.querySelector('.dwr-toolbar')?.getBoundingClientRect().bottom ?? 0);
      return t.top >= toolbarBottom && t.bottom <= window.innerHeight
        ? 'in view'
        : `title from ${Math.round(t.top)} to ${Math.round(t.bottom)}, toolbar bottom ${toolbarBottom}, viewport height ${window.innerHeight}`;
    }), { message: 'the title of the newly selected card', timeout: 5000 }).toBe('in view');
  });

  test.fixme('DOW-9: the status segments stay inside the window and the page has no sideways scroll', async ({ page }) => {
    await page.goto(at('inbox'));
    await expect(rows(page).first()).toBeVisible();
    const merged = page.getByRole('group', { name: /^Filter by status/ }).getByRole('button', { name: /^Merged/ });
    await expect(merged).toBeAttached();
    await expect.soft.poll(() => page.evaluate(() => {
      const { document } = /** @type {any} */ (globalThis);
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth <= clientWidth ? 'fits' : `scrollWidth ${scrollWidth} in a clientWidth of ${clientWidth}`;
    }), { message: 'the page has no horizontal scroll', timeout: 3000 }).toBe('fits');
    // Merged is inside the window (the control wraps), or the control scrolls inside itself and stays inside the window
    await expect.soft.poll(() => merged.evaluate((button) => {
      const { document, getComputedStyle } = /** @type {any} */ (globalThis);
      const fits = (/** @type {{left: number, right: number}} */ r) => r.left >= 0 && r.right <= document.documentElement.clientWidth;
      const box = button.getBoundingClientRect();
      /** @type {any} */
      let el = button.parentElement;
      let scroller = false;
      for (; el && el !== document.body && !scroller; el = el.parentElement) {
        scroller = /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth && fits(el.getBoundingClientRect());
      }
      return fits(box) || scroller ? 'reachable' : `Merged from ${Math.round(box.left)} to ${Math.round(box.right)} in a window ${document.documentElement.clientWidth} wide`;
    }), { message: 'the Merged segment is inside the window, or scrollable in a control that is', timeout: 3000 }).toBe('reachable');
  });
});

for (const how of /** @type {const} */ (['Escape', 'Cancel'])) {
  test.fixme(`DOW-10: ${how} on the bulk Snooze step returns focus to the selected row or the bulk Snooze button`, async ({ page }) => {
    await page.goto(at('inbox'));
    await expect(rows(page).first()).toBeVisible();
    const current = page.locator('.dwr-row__main[aria-current="true"]');
    await expect(current).toHaveCount(1);
    const bulk = page.getByRole('region', { name: 'Bulk actions' });
    // each key waits for its effect: a key sent before the last one's render lands on the old selection
    await page.keyboard.press('x');
    await expect(bulk.getByText('1 checked')).toBeVisible();
    const first = await current.locator('.dwr-row__title').innerText();
    await page.keyboard.press('j');
    await expect(current.locator('.dwr-row__title')).not.toHaveText(first);
    await page.keyboard.press('x');
    await expect(bulk.getByText('2 checked')).toBeVisible();
    await page.keyboard.press('s');
    const until = bulk.getByLabel(/^Until/);
    await expect(until, 'the bulk Snooze step has the focus').toBeFocused();
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await bulk.getByRole('button', { name: 'Cancel' }).click();
    await expect(until, 'the step closed').toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const { document } = /** @type {any} */ (globalThis);
      const active = document.activeElement;
      const row = Boolean(active?.closest('.dwr-row--current'));
      const button = Boolean(active?.closest('.dwr-bulk') && /^Snooze/.test(active?.textContent ?? ''));
      return row || button ? 'accepted' : `focus is on ${active?.tagName}`;
    }), { message: 'focus after the cancel', timeout: 3000 }).toBe('accepted');
  });
}

/**
 * Each blast radius mark's contrast against the plot's background, from computed colours. A canvas turns any CSS
 * colour form into sRGB. The mark's opacity and any alpha in the backgrounds are composited; a colour the canvas
 * cannot read (`none`, a paint server) or a background image makes the number unknown, and the spec says so rather
 * than guessing. The band behind the cheap, sure corner is left out: it is a tint over the same background.
 * @param {import('@playwright/test').Page} page
 */
const measureMarks = (page) => page.evaluate(() => {
  const { document, getComputedStyle } = /** @type {any} */ (globalThis);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.canvas.width = ctx.canvas.height = 1;
  /** @param {string} css @returns {number[] | null} */
  const rgba = (css) => {
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css;
    if (ctx.fillStyle === '#010203' && css !== 'rgb(1, 2, 3)') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  /** @param {number[]} top @param {number[]} under */
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  /** @param {number[]} c */
  const luminance = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const svg = document.querySelector('.dw-scatter');
  /** @type {number[][]} */
  const layers = [];
  let image = false;
  for (/** @type {any} */ let el = svg; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.backgroundImage !== 'none') image = true;
    const c = rgba(s.backgroundColor);
    if (c && c[3] > 0) layers.push(c);
  }
  // under everything is the browser's white page
  const background = layers.reduceRight((under, top) => over(top, under), [255, 255, 255]);
  /** @type {Record<string, {fill: string, ratio: number | null}>} */
  const marks = {};
  for (const blast of ['low', 'medium', 'high', 'none']) {
    const el = svg.querySelector(`.dw-blast--${blast}`);
    if (!el) continue;
    const s = getComputedStyle(el);
    // a mark with no blast measured is hollow: its stroke is what shows
    const css = blast === 'none' ? s.stroke : s.fill;
    const c = rgba(css);
    if (!c || image) { marks[blast] = { fill: css, ratio: null }; continue; }
    const alpha = c[3] * Number(blast === 'none' ? s.strokeOpacity : s.fillOpacity) * Number(s.opacity);
    const [a, b] = [luminance(over([c[0], c[1], c[2], alpha], background)), luminance(background)];
    marks[blast] = { fill: css, ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
  }
  return { background: background.map(Math.round), backgroundLuminance: luminance(background), image, marks };
});

for (const mode of /** @type {const} */ (['light', 'dark'])) {
  test.fixme(`DOW-16: every blast radius mark has 3:1 contrast against the plot (${mode})`, async ({ page }) => {
    await page.goto(at(`map&mode=${mode}`));
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', mode);
    await expect(page.locator('.dw-scatter .dw-blast--low').first(), 'a low blast dot is on the plot').toBeVisible();
    const m = await measureMarks(page);
    // the design tokens are in force, or the colours below say nothing about this mode
    expect(m.backgroundLuminance > 0.5, `the ${mode} plot background is rgb(${m.background})`).toBe(mode === 'light');
    expect(m.image, 'the plot has a plain background colour, so a contrast number means something').toBe(false);
    for (const [blast, { fill, ratio }] of Object.entries(m.marks)) {
      expect.soft(ratio, `${blast} mark ${fill} on rgb(${m.background})`).not.toBeNull();
      expect.soft(ratio ?? 0, `${blast} mark ${fill} on rgb(${m.background})`).toBeGreaterThanOrEqual(3);
    }
  });
}
