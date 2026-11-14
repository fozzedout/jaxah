#!/usr/bin/env node
// Rendered status-strip check; playwright-core is supplied externally.
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
    const style = document.createElement('style');
    style.textContent = '*{pointer-events:auto !important}';
    document.head.appendChild(style);
    try {
      const stack = document.elementsFromPoint(x, y).slice(0, 4).map((e) => {
        const c = getComputedStyle(e), r = e.getBoundingClientRect();
        return { id: e.id, tag: e.tagName, cls: e.getAttribute('class') || '', bg: c.backgroundColor,
          vis: c.visibility, backdrop: c.backdropFilter || c.webkitBackdropFilter,
          rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
      });
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;height:env(safe-area-inset-top, 0px)';
      document.body.appendChild(probe);
      const inset = probe.getBoundingClientRect().height;
      probe.remove();
      return { stack, vw: window.innerWidth, inset };
    } finally { style.remove(); }
  }, { x, y });
}

function alpha(rgb) {
  if (rgb === 'transparent') return 0;
  const match = /^rgba?\(([^)]+)\)$/.exec(rgb || '');
  if (!match) return NaN;
  const parts = match[1].split(',').map((s) => s.trim());
  return parts.length === 3 ? 1 : parts.length === 4 ? Number(parts[3]) : NaN;
}

async function assertOpaqueTop(label, page, x, y, expectHeightAtLeast) {
  const t = await topAt(page, x, y), top = t.stack[0] || {};
  const desc = top.id ? '#' + top.id : top.tag || '(none)';
  ok(top.id === 'status-tint', `${label}: topmost painted element at (${x},${y}) is #status-tint, got ${desc}`);
  ok(top.vis === 'visible', label + ': strip is visible');
  ok(alpha(top.bg) === 1, label + ': strip background is fully opaque, got ' + top.bg);
  ok(top.rect && top.rect.top <= 0 && top.rect.left <= 0 && top.rect.right >= t.vw, label + ': strip spans full width from y=0');
  ok(top.rect && top.rect.bottom >= expectHeightAtLeast, label + ': strip covers the inset band (bottom ' + top.rect?.bottom + ' >= ' + expectHeightAtLeast + ')');
  ok(!top.backdrop || top.backdrop === 'none', label + ': strip has no backdrop-filter');
  console.log(`  info: ${label}: bg ${top.bg}, inset ${t.inset}, stack ${t.stack.map((e) => (e.id ? '#' + e.id : e.tag) + ' ' + e.bg).join(' | ')}`);
  return { ...top, stack: t.stack };
}

// Under the strip, the first painted (non-transparent) element must be the same opaque colour,
// and nothing in the top-inset stack may carry a backdrop-filter.
function assertSameUnder(label, top, expectCls) {
  const under = top.stack.slice(1).find((e) => alpha(e.bg) > 0) || {};
  const desc = under.id ? '#' + under.id : (under.tag || '(none)') + (under.cls ? '.' + under.cls.split(' ')[0] : '');
  ok(expectCls.test(under.cls || under.id || ''), `${label}: first painted element under the strip is ${expectCls}, got ${desc}`);
  ok(alpha(under.bg) === 1 && under.bg === top.bg, `${label}: element under the strip is the same opaque ${top.bg}, got ${under.bg}`);
  ok(top.stack.every((e) => !e.backdrop || e.backdrop === 'none'), `${label}: no backdrop-filter in the top-inset stack, got ${top.stack.map((e) => e.backdrop).join(',')}`);
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
    await scenario(theme, 47, {}, async (page) => {
      if (theme === 'dark') {
        const hit = await page.evaluate(() => document.elementFromPoint(195, 4)?.id || '');
        ok(hit === 'status-tint', 'dark home: unmodified hit test at (195,4) returns #status-tint, got ' + (hit || '(none)'));
      }
      const top = await assertOpaqueTop(theme, page, 195, 10, 47);
      ok(top.bg === colour, `${theme}: strip colour is ${colour}, got ${top.bg}`);
      assertSameUnder(theme + ' home', top, /statusbar/);
      await openTile(page, theme + ' sheet open');
      const s10 = await assertOpaqueTop(theme + ' sheet open y=10', page, 195, 10, 47);
      assertSameUnder(theme + ' sheet open y=10', s10, /w-title/);
      const s40 = await assertOpaqueTop(theme + ' sheet open y=40', page, 195, 40, 47);
      assertSameUnder(theme + ' sheet open y=40', s40, /w-title/);
    });
  }
  await scenario('dark', 0, {}, async (page, cdp) => {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47 } });
    await page.waitForTimeout(300);
    await openTile(page, 'stale inset sheet open');
    await assertOpaqueTop('stale inset sheet open', page, 195, 40, 47);
  });
  await scenario('dark', 0, { viewport: { width: 1280, height: 800 } }, async (page) => {
    const vis = await page.evaluate(() => getComputedStyle(document.getElementById('status-tint')).visibility);
    ok(vis === 'hidden', 'desktop: status tint is hidden (no 6px band), got ' + vis);
  });
  await scenario('dark', 0, { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }, async (page) => {
    await assertOpaqueTop('landscape touch', page, 195, 10, 20);
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
