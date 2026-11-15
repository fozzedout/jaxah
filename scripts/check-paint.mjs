#!/usr/bin/env node
// Rendered edge-header and status-strip check; playwright-core is supplied externally.
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

async function topAt(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const stack = document.elementsFromPoint(x, y).slice(0, 4).map((e) => {
      const c = getComputedStyle(e), r = e.getBoundingClientRect();
      return { id: e.id, tag: e.tagName, cls: e.getAttribute('class') || '', bg: c.backgroundColor,
        vis: c.visibility, position: c.position, backdrop: c.backdropFilter || c.webkitBackdropFilter,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
    });
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:env(safe-area-inset-top, 0px)';
    document.body.appendChild(probe);
    const inset = probe.getBoundingClientRect().height;
    probe.remove();
    return { stack, vw: window.innerWidth, inset };
  }, { x, y });
}

async function glassTopBand(page, label) {
  const result = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:env(safe-area-inset-top, 0px)';
    document.body.appendChild(probe);
    const inset = probe.getBoundingClientRect().height;
    probe.remove();
    return Array.from(document.querySelectorAll('*')).flatMap((el) => {
      const c = getComputedStyle(el);
      if (![c.backdropFilter, c.webkitBackdropFilter, c.getPropertyValue('-webkit-backdrop-filter')].some((v) => v && v !== 'none')) return [];
      const r = el.getBoundingClientRect(), round = (n) => Math.round(n * 10) / 10;
      const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('class')?.trim() ? '.' + el.getAttribute('class').trim().split(/\s+/).join('.') : '');
      return [{ description: `${name} rect ${round(r.top)}/${round(r.bottom)}/${round(r.left)}/${round(r.right)}`, top: r.top < inset + 8 && r.bottom > 0 && r.width > 0 && r.height > 0 }];
    });
  });
  const top = result.filter((el) => el.top);
  for (const el of top) ok(false, `${label}: backdrop-filter element in top band: ${el.description}`);
  if (!top.length) ok(true, `${label}: no backdrop-filter elements in top band`);
  console.log(`  info: ${label}: glass elements ${result.length}, in top band ${top.length}${result.length ? ': ' + result.map((el) => el.description).join(' | ') : ''}`);
}

function alpha(rgb) {
  if (rgb === 'transparent') return 0;
  const match = /^rgba?\(([^)]+)\)$/.exec(rgb || '');
  if (!match) return NaN;
  const parts = match[1].split(',').map((s) => s.trim());
  return parts.length === 3 ? 1 : parts.length === 4 ? Number(parts[3]) : NaN;
}

async function tintState(page) {
  return page.evaluate(() => {
    const el = document.getElementById('status-tint'), c = getComputedStyle(el), r = el.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:env(safe-area-inset-top, 0px)';
    document.body.appendChild(probe);
    const inset = probe.getBoundingClientRect().height;
    probe.remove();
    return { vis: c.visibility, bg: c.backgroundColor, pe: c.pointerEvents, position: c.position, backdrop: c.backdropFilter || c.webkitBackdropFilter,
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, vw: window.innerWidth, inset };
  });
}

// The strip is pointer-events:none (hit tests pass through), so read it directly rather than via elementsFromPoint.
async function assertOpaqueTop(label, page, expectHeightAtLeast, colour) {
  const t = await tintState(page);
  ok(t.position === 'fixed', label + ': strip is fixed, got ' + t.position);
  ok(t.vis === 'visible', label + ': strip is visible, got ' + t.vis);
  ok(t.pe === 'none', label + ': strip is pointer-events none, got ' + t.pe);
  ok(alpha(t.bg) === 1, label + ': strip background is fully opaque, got ' + t.bg);
  if (colour) ok(t.bg === colour, `${label}: strip is the header colour ${colour}, got ${t.bg}`);
  ok(t.rect.top <= 0 && t.rect.left <= 0 && t.rect.right >= t.vw, label + ': strip spans full width from y=0');
  ok(t.rect.bottom >= Math.max(expectHeightAtLeast, t.inset), label + ': strip covers the inset band (bottom ' + t.rect.bottom + ' >= ' + Math.max(expectHeightAtLeast, t.inset) + ')');
  ok(!t.backdrop || t.backdrop === 'none', label + ': strip has no backdrop-filter');
  console.log(`  info: ${label}: bg ${t.bg}, inset ${t.inset}, strip bottom ${t.rect.bottom}`);
  return t;
}

async function assertPhoneHeader(label, page, y, selector, colour) {
  const t = await topAt(page, 195, y), top = t.stack[0] || {};
  const matches = selector === '#statusbar' ? top.id === 'statusbar' : top.cls?.split(/\s+/).includes('w-title');
  ok(matches, `${label}: topmost element at (195,${y}) is ${selector}, got ${top.id || top.cls || top.tag}`);
  ok(top.position === 'fixed', `${label}: header is fixed, got ${top.position}`);
  ok(top.vis === 'visible' && alpha(top.bg) === 1 && top.bg === colour, `${label}: header is opaque ${colour}, got ${top.bg}`);
  ok(!top.backdrop || top.backdrop === 'none', `${label}: header has no backdrop-filter`);
  ok(top.rect && top.rect.top === 0 && top.rect.left === 0 && top.rect.right >= t.vw, `${label}: header spans the top edge`);
  const styles = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim() }));
  await assertOpaqueTop(label + ' tint', page, 6, colour);
  const rootColour = await page.evaluate((bg) => { const e = document.createElement('div'); e.style.color = bg; document.body.appendChild(e); const colour = getComputedStyle(e).color; e.remove(); return colour; }, styles.bg);
  ok(top.bg === rootColour, `${label}: header matches --bg0 (${rootColour})`);
}

let browser;
try {
  browser = await playwright.default.chromium.launch();
  async function scenario(theme, inset, options, run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    try {
      await context.addInitScript((value) => localStorage.setItem('airis-os.theme', value), theme);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
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
  for (const [theme, colour] of [['dark', 'rgb(7, 13, 18)'], ['light', 'rgb(223, 233, 231)']]) {
    for (const inset of [47, 59]) await scenario(theme, inset, {}, async (page) => {
      const home = `${theme} home @${inset}`, sheetLabel = `${theme} sheet @${inset}`;
      const hit = await page.evaluate(() => document.elementFromPoint(195, 4)?.id || '');
      ok(hit === 'statusbar', `${home}: unmodified hit at (195,4) is #statusbar, got ${hit || '(none)'}`);
      for (const y of [4, 10, 40]) await assertPhoneHeader(home, page, y, '#statusbar', colour);
      await glassTopBand(page, home);
      const grid = await page.evaluate(() => ({ header: document.querySelector('#statusbar').getBoundingClientRect().bottom, icon: document.querySelector('.tile .t-icon').getBoundingClientRect().top }));
      ok(grid.icon >= grid.header, `${home}: first row icons start below header (${grid.icon} >= ${grid.header})`);
      await openTile(page, sheetLabel + ' open');
      const sheetHit = await page.evaluate(() => document.elementFromPoint(195, 4)?.classList.contains('w-title'));
      ok(sheetHit, `${sheetLabel}: unmodified hit at (195,4) is .w-title`);
      for (const y of [4, 10, 40]) await assertPhoneHeader(sheetLabel, page, y, '.w-title', colour);
      await glassTopBand(page, sheetLabel);
      const sheet = await page.evaluate(() => { const w = document.querySelector('.window'), c = getComputedStyle(w); return { title: w.querySelector('.w-title').getBoundingClientRect().bottom, frame: w.querySelector('iframe').getBoundingClientRect().top, backdrop: c.backdropFilter || c.webkitBackdropFilter, transform: c.transform, filter: c.filter }; });
      ok(Math.abs(sheet.title - sheet.frame) < 0.1, `${sheetLabel}: iframe starts at title bottom without gap or overlap (${sheet.frame} vs ${sheet.title})`);
      ok([sheet.backdrop, sheet.transform, sheet.filter].every((v) => !v || v === 'none'), `${sheetLabel}: window has no fixed-child containing-block effects`);
    });
  }
  await scenario('dark', 0, {}, async (page, cdp) => {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47 } });
    await page.waitForTimeout(300);
    await openTile(page, 'stale inset sheet open');
    await assertPhoneHeader('stale inset sheet open', page, 40, '.w-title', 'rgb(7, 13, 18)');
  });
  await scenario('dark', 0, { viewport: { width: 1280, height: 800 } }, async (page) => {
    const vis = await page.evaluate(() => getComputedStyle(document.getElementById('status-tint')).visibility);
    ok(vis === 'hidden', 'desktop: status tint is hidden (no 6px band), got ' + vis);
  });
  await scenario('dark', 0, { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }, async (page) => {
    await assertOpaqueTop('landscape touch', page, 20, 'rgb(7, 13, 18)');
  });
  await scenario('dark', 0, { viewport: { width: 700, height: 390 }, hasTouch: true, isMobile: true }, async (page) => {
    await assertPhoneHeader('phone landscape home', page, 10, '#statusbar', 'rgb(7, 13, 18)');
    await openTile(page, 'phone landscape sheet');
    await assertPhoneHeader('phone landscape sheet', page, 10, '.w-title', 'rgb(7, 13, 18)');
    const sheet = await page.evaluate(() => ({ title: document.querySelector('.window .w-title').getBoundingClientRect().bottom, frame: document.querySelector('.window iframe').getBoundingClientRect().top }));
    ok(Math.abs(sheet.title - sheet.frame) < 0.1, `phone landscape: iframe starts at title bottom (${sheet.frame} vs ${sheet.title})`);
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
