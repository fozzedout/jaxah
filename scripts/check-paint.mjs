#!/usr/bin/env node
// Rendered wallpaper, transparent home edge and phone-sheet paint check.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let playwright;
if (process.env.PLAYWRIGHT_CORE) {
  try { playwright = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, 'index.js')).href); } catch {}
}
if (!playwright) {
  try { playwright = await import('playwright-core'); } catch {}
}
if (!playwright) {
  console.log('SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core)');
  process.exit(2);
}

let fails = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { fails++; console.log('FAIL ' + what); } return cond; };
const base = (process.argv[2] || 'http://localhost:8788').replace(/\/$/, '');

async function homeTop(page, label, phone) {
  const result = await page.evaluate(() => {
    const xs = [4, Math.floor(innerWidth * .25), Math.floor(innerWidth * .5), Math.floor(innerWidth * .75), innerWidth - 5];
    return xs.flatMap((x) => [1, 4, 10].flatMap((y) => document.elementsFromPoint(x, y)
      .filter((e) => e !== document.documentElement && e !== document.body)
      .map((e) => { const c = getComputedStyle(e); return { x, y, name: e.tagName + '#' + e.id,
        bg: c.backgroundColor, image: c.backgroundImage, backdrop: c.backdropFilter, webkit: c.webkitBackdropFilter }; })));
  });
  const bad = result.filter((e) => e.bg !== 'rgba(0, 0, 0, 0)' || e.image !== 'none' ||
    (e.backdrop && e.backdrop !== 'none') || (e.webkit && e.webkit !== 'none'));
  ok(!bad.length, `${label}: full hit stacks have no background or backdrop-filter: ${JSON.stringify(bad)}`);
  if (phone) {
    const header = await page.evaluate(() => {
      const e = document.elementFromPoint(195, 4), c = getComputedStyle(document.querySelector('#statusbar'));
      return { id: e?.id, bg: c.backgroundColor, image: c.backgroundImage, backdrop: c.backdropFilter, position: c.position };
    });
    ok(header.id === 'statusbar', `${label}: #statusbar is topmost at (195,4), got ${header.id}`);
    ok(header.bg === 'rgba(0, 0, 0, 0)' && header.image === 'none' && (!header.backdrop || header.backdrop === 'none') && header.position === 'fixed', `${label}: fixed statusbar is transparent: ${JSON.stringify(header)}`);
  }
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: await page.evaluate(() => innerWidth), height: 10 } })).toString('base64');
  const visibility = await page.evaluate(() => {
    const style = document.getElementById('status-tint').style;
    const previous = { value: style.getPropertyValue('visibility'), priority: style.getPropertyPriority('visibility') };
    style.setProperty('visibility', 'hidden');
    return previous;
  });
  let hiddenPng;
  try {
    hiddenPng = (await page.screenshot({ clip: { x: 0, y: 0, width: await page.evaluate(() => innerWidth), height: 10 } })).toString('base64');
  } finally {
    await page.evaluate(({ value, priority }) => {
      document.getElementById('status-tint').style.setProperty('visibility', value, priority);
    }, visibility);
  }
  const { rows, meanDiff } = await page.evaluate(async ([src, hiddenSrc]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const hidden = new Image(); hidden.src = 'data:image/png;base64,' + hiddenSrc; await hidden.decode();
    ctx.drawImage(hidden, 0, 0);
    const hiddenData = ctx.getImageData(0, 0, img.width, img.height).data;
    let diff = 0;
    for (let i = 0; i < img.width * 6 * 4; i += 4) {
      for (let c = 0; c < 3; c++) diff += Math.abs(data[i + c] - hiddenData[i + c]);
    }
    const meanDiff = diff / (img.width * 6 * 3);
    const rows = Array.from({ length: img.height }, (_, y) => {
      let sum = 0, sum2 = 0; const colors = new Set();
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, l = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
        sum += l; sum2 += l * l; colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { sd: Math.sqrt(Math.max(0, sum2 / img.width - (sum / img.width) ** 2)), colors: colors.size, rgb: [...colors][0] };
    });
    return { rows, meanDiff };
  }, [png, hiddenPng]);
  // Rows 0-5 paint the same wallpaper pixels as the root beneath the strip.
  ok(rows.length === 10 && meanDiff <= 2, `${label}: rows 0-5 match the wallpaper with status-tint hidden (mean channel difference ${meanDiff})`);
  ok(rows.slice(6).every((r) => r.sd > 5 && r.colors > 1), `${label}: rows 6-9 have image detail: ${JSON.stringify(rows.slice(6))}`);
  console.log(`  info: ${label}: top row luminance std-dev ${rows.map((r) => r.sd.toFixed(1)).join(', ')}`);
}

async function sheetHeader(page, label, colour, y = 4) {
  const result = await page.evaluate(({ y }) => {
    const e = document.elementFromPoint(195, y), w = document.querySelector('.window'), title = w.querySelector('.w-title');
    const c = getComputedStyle(title), wc = getComputedStyle(w), r = title.getBoundingClientRect();
    return { hit: e?.classList.contains('w-title'), bg: c.backgroundColor, position: c.position, backdrop: c.backdropFilter,
      top: r.top, left: r.left, right: r.right, width: innerWidth, title: r.bottom,
      frame: w.querySelector('iframe').getBoundingClientRect().top, windowBackdrop: wc.backdropFilter, transform: wc.transform, filter: wc.filter };
  }, { y });
  ok(result.hit && result.position === 'fixed' && result.bg === colour && (!result.backdrop || result.backdrop === 'none'), `${label}: topmost fixed title is opaque --band: ${JSON.stringify(result)}`);
  ok(result.top === 0 && result.left === 0 && result.right >= result.width, `${label}: title spans top edge`);
  ok(Math.abs(result.title - result.frame) < .1, `${label}: iframe starts at title bottom (${result.frame} vs ${result.title})`);
  ok([result.windowBackdrop, result.transform, result.filter].every((v) => !v || v === 'none'), `${label}: no fixed-child containing-block effects`);
}

let browser;
try {
  browser = await playwright.default.chromium.launch();
  async function scenario(theme, inset, options, run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    try {
      await context.addInitScript((value) => localStorage.setItem('airis-os.theme', value), theme);
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset } });
      await page.goto(base + '/', { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      await run(page, cdp);
    } finally { await context.close(); }
  }
  async function openTile(page, label) {
    await page.locator('.tile').first().click({ force: true });
    await page.waitForTimeout(800);
    ok(await page.locator('.window').count() > 0, label + ': window exists');
  }
  for (const [theme, colour] of [['dark', 'rgb(14, 31, 38)'], ['light', 'rgb(223, 233, 231)']]) {
    for (const inset of [0, 47, 59]) await scenario(theme, inset, {}, async (page) => {
      const home = `${theme} home @${inset}`, sheet = `${theme} sheet @${inset}`;
      await homeTop(page, home, true);
      const grid = await page.evaluate(() => ({ header: document.querySelector('#statusbar').getBoundingClientRect().bottom, icon: document.querySelector('.tile .t-icon').getBoundingClientRect().top }));
      ok(grid.icon >= grid.header, `${home}: icons start below header (${grid.icon} >= ${grid.header})`);
      await openTile(page, sheet);
      await sheetHeader(page, sheet, colour);
    });
  }
  await scenario('dark', 0, {}, async (page, cdp) => {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47 } });
    await page.waitForTimeout(300);
    await openTile(page, 'stale inset sheet');
    await sheetHeader(page, 'stale inset sheet', 'rgb(14, 31, 38)', 40);
  });
  await scenario('dark', 0, { viewport: { width: 1280, height: 800 } }, (page) => homeTop(page, 'desktop', false));
  await scenario('dark', 0, { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }, (page) => homeTop(page, 'landscape touch', false));
  await scenario('dark', 0, { viewport: { width: 700, height: 390 }, hasTouch: true, isMobile: true }, async (page) => {
    await homeTop(page, 'phone landscape home', true);
    await openTile(page, 'phone landscape sheet');
    await sheetHeader(page, 'phone landscape sheet', 'rgb(14, 31, 38)', 10);
  });
} catch (error) {
  ok(false, 'browser check error: ' + (error.stack || error));
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) { ok(false, 'browser close error: ' + error); }
  }
}
console.log(`${fails ? 'FAILED' : 'OK'}: ${passes} passed, ${fails} failed`);
if (fails) process.exitCode = 1;
