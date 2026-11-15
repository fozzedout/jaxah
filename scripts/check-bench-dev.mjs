#!/usr/bin/env node
// Rendered check: a dev file that already exists in workspace home/dev BEFORE the
// shell boots (never created through Bench) is not an app. It must not become a
// tile, dock entry, taskbar entry, palette entry or install record; Bench must
// still list it and run CAS rename/delete on it. playwright-core is supplied externally.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/check-bench-dev.mjs http://localhost:8788
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
const ok = (cond, what) => { if (cond) { passes++; console.log('ok   ' + what); } else { fails++; console.log('FAIL ' + what); } return cond; };
const info = (what) => console.log('  info: ' + what);
const base = (process.argv[2] || 'http://localhost:8788').replace(/\/$/, '');
const KEY = 'airis.installs.v1';
const DEV_RE = /dev\/|legacy|notes/i;
const LEGACY = '<!doctype html><html><head><meta charset="utf-8"><title>Legacy</title></head><body><h1 id="legacy">legacy dev file</h1></body></html>';
const NOTES = '# notes\n\nwritten before boot\n';

// Wait for boot to finish and the install records to stop changing.
async function settle(page) {
  await page.waitForFunction(() => window.airis && window.airis.contract && window.airis.contract() &&
    window.airis.state().apps.length > 0 && document.querySelectorAll('#icon-grid .tile').length > 0, null, { timeout: 15000 });
  let last = null;
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate((k) => localStorage.getItem(k), KEY);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(250);
  }
  return last;
}

// Page-context fs helper (the same lib/fs.js the shell uses).
const fsCall = (page, method, args, ctx) => page.evaluate(async ({ method, args, ctx }) => {
  const lib = await import('/lib/fs.js');
  window.__checkFs = window.__checkFs || lib.openFs();
  return window.__checkFs[method](args, ctx);
}, { method, args, ctx });

// Install records modulo installedAt, which is regenerated whenever a record is
// rewritten. A plain boot must not rewrite any record at all; that is asserted
// byte-for-byte separately as 'boot idempotence'. Everything else must match exactly.
function norm(json) {
  const o = JSON.parse(json);
  for (const r of Object.values(o.records)) {
    delete r.installedAt;
  }
  return JSON.stringify(o);
}
const SURFACE_RE = /legacy|notes\.md/i;  // a file name, not 'dev' (Bench's own description says home/dev/)

function shellSurfaces(page) {
  return page.evaluate(() => {
    const s = window.airis.state();
    const text = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent + ' ' + (el.title || '') + ' ' + (el.getAttribute('aria-label') || '')).trim());
    return {
      appIds: s.apps.map((a) => a.id),
      appNames: s.apps.map((a) => a.name),
      notInstalled: s.notInstalled,
      windows: s.windows.open,
      grid: text('#icon-grid .tile'),
      dock: text('#dock-apps button'),
      tasks: text('#task-apps button'),
    };
  });
}

async function paletteFor(page, query) {
  await page.evaluate(() => document.getElementById('tb-summon').click());
  await page.waitForSelector('#summon:not([hidden])', { timeout: 5000 });
  await page.fill('#summon-in', query);
  await page.waitForTimeout(150);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#summon-out .sr')).map((el) => el.textContent.trim()));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const s = document.getElementById('summon'); if (!s.hidden) document.getElementById('tb-summon').click(); });
  return rows;
}

let browser;
try {
  browser = await playwright.default.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Runs in every frame; sandboxed app frames have no localStorage, so guard it.
  await context.addInitScript(() => { try { localStorage.setItem('airis-os.theme', 'dark'); } catch {} });
  const page = await context.newPage();
  const dialogs = [];
  let promptAnswer = null;
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'prompt') await d.accept(promptAnswer ?? d.defaultValue());
    else await d.accept();
  });
  page.on('pageerror', (e) => info('pageerror: ' + e.message));

  // ── 1. first boot, record the install records before any dev file exists
  await page.goto(base + '/', { waitUntil: 'load' });
  const before = await settle(page);
  const beforeIds = Object.keys(JSON.parse(before).records);
  info(`installs before seed: ${before.length} bytes, records=[${beforeIds.join(',')}], removed=${JSON.stringify(JSON.parse(before).removed)}`);
  const grantsBefore = await page.evaluate(() => localStorage.getItem('airis.fs.grants.v1'));
  info('fs grants before seed: ' + grantsBefore);

  // ── 2. seed home/dev directly, no Bench, no grant
  const created = await fsCall(page, 'createWorkspace', { ws: 'home', name: 'Home' });
  ok(created.ok === true, 'seed: createWorkspace home -> ' + JSON.stringify(created));
  const wLegacy = await fsCall(page, 'write', { ws: 'home', path: 'dev/legacy.html', content: LEGACY, base: null }, { actor: 'seed' });
  const wNotes = await fsCall(page, 'write', { ws: 'home', path: 'dev/notes.md', content: NOTES, base: null }, { actor: 'seed' });
  ok(wLegacy.ok && wLegacy.ver === 1, 'seed: write dev/legacy.html -> ' + JSON.stringify(wLegacy));
  ok(wNotes.ok && wNotes.ver === 1, 'seed: write dev/notes.md -> ' + JSON.stringify(wNotes));
  const afterSeed = await page.evaluate((k) => localStorage.getItem(k), KEY);
  ok(afterSeed === before, 'seed: writing files did not touch ' + KEY);
  const grantsAfterSeed = await page.evaluate(() => localStorage.getItem('airis.fs.grants.v1'));
  ok(!grantsAfterSeed || !(JSON.parse(grantsAfterSeed).home || []).includes('bench'), 'seed: home not granted to bench (grants=' + grantsAfterSeed + ')');

  // ── 3. fresh boot with the files already present
  await page.evaluate(() => { try { window.__checkFs && window.__checkFs.close(); } catch {} });
  await page.reload({ waitUntil: 'load' });
  const booted = await settle(page);
  const bootedObj = JSON.parse(booted);
  const devRecords = Object.entries(bootedObj.records).filter(([id, r]) => DEV_RE.test(id) || DEV_RE.test((r && r.entry && r.entry.url) || ''));
  info('installs after boot: ids=' + JSON.stringify(Object.keys(bootedObj.records)) + ' urls=' + JSON.stringify(Object.values(bootedObj.records).map((r) => r.entry.url)));
  ok(devRecords.length === 0, `boot: no install record id/entry.url mentions dev/|legacy|notes (found ${devRecords.length}: ${JSON.stringify(devRecords.map(([id]) => id))})`);
  ok(norm(booted) === norm(before), `boot: ${KEY} identical to pre-seed value apart from installedAt`);
  const churned = Object.keys(bootedObj.records).filter((id) => JSON.stringify(bootedObj.records[id]) !== JSON.stringify(JSON.parse(before).records[id]));
  ok(booted === before, `boot idempotence: a plain boot leaves ${KEY} byte-identical (rewritten: ${JSON.stringify(churned)})`);
  const files = await fsCall(page, 'list', { ws: 'home', path: 'dev', depth: 1 });
  info('home/dev after boot (fs.list): ' + JSON.stringify(files));
  ok(Array.isArray(files) && files.length === 2, 'boot: both seeded files still exist in home/dev');

  const surf = await shellSurfaces(page);
  info(`state().apps ids (${surf.appIds.length}): ${surf.appIds.join(',')}`);
  info('state().notInstalled: ' + JSON.stringify(surf.notInstalled));
  info('grid tiles (' + surf.grid.length + '): ' + surf.grid.map((t) => t.split(/\s+/).slice(1, 3).join(' ')).join(' | '));
  info('dock (' + surf.dock.length + '): ' + JSON.stringify(surf.dock));
  info('taskbar (' + surf.tasks.length + '): ' + JSON.stringify(surf.tasks));
  ok(surf.appIds.length === beforeIds.length && surf.appIds.every((id) => beforeIds.includes(id)), `boot: state().apps == install records from before the seed (${surf.appIds.length} == ${beforeIds.length})`);
  ok(!surf.appIds.concat(surf.appNames).some((x) => DEV_RE.test(x)), 'boot: no app id/name in state() mentions legacy/notes/dev');
  ok(!surf.grid.some((t) => SURFACE_RE.test(t)), 'boot: desktop grid has nothing named legacy/notes');
  ok(!surf.dock.some((t) => SURFACE_RE.test(t)), 'boot: dock has nothing named legacy/notes');
  ok(!surf.tasks.some((t) => SURFACE_RE.test(t)), 'boot: taskbar has nothing named legacy/notes');
  for (const q of ['legacy', 'notes', 'dev']) {
    const rows = await paletteFor(page, q);
    info(`palette "${q}": ${JSON.stringify(rows)}`);
    ok(!rows.some((r) => /legacy\.html|notes\.md|legacy|notes/i.test(r) && !/^⌁/.test(r)), `palette "${q}": no app row for a dev file`);
  }
  const openLegacy = await page.evaluate(() => window.airis.do('open', { id: 'legacy' }).then((v) => 'resolved ' + v, (e) => 'rejected ' + e.message));
  ok(/rejected no such installed app/.test(openLegacy), 'boot: open {id:legacy} refused -> ' + openLegacy);

  // ── 4. Bench: is it installed? open it, grant, list
  const openBench = await page.evaluate(() => window.airis.do('open', { id: 'bench' }).then((v) => 'resolved ' + v, (e) => 'rejected ' + e.message));
  info('open bench before install: ' + openBench);
  let installsWithBench = booted;
  if (/rejected/.test(openBench)) {
    const inst = await page.evaluate(() => window.airis.do('install', { id: 'bench' }).then((v) => JSON.stringify(v), (e) => 'error ' + e.message));
    info('install bench: ' + inst);
    installsWithBench = await page.evaluate((k) => localStorage.getItem(k), KEY);
    const added = Object.keys(JSON.parse(installsWithBench).records).filter((id) => !beforeIds.includes(id));
    ok(added.length === 1 && added[0] === 'bench', 'install: the only new record is bench (added=' + JSON.stringify(added) + ')');
    await page.evaluate(() => window.airis.do('open', { id: 'bench' }));
  }
  const frameEl = await page.waitForSelector('.window[data-app-id="bench"] iframe', { timeout: 10000 });
  const bench = await frameEl.contentFrame();
  await bench.waitForSelector('#grant-prompt:not([hidden]), #files li', { timeout: 10000 });
  const grantShown = await bench.evaluate(() => !document.getElementById('grant-prompt').hidden);
  info('bench status before grant: ' + JSON.stringify(await bench.textContent('#status')));
  ok(grantShown, 'bench: grant prompt shown for pre-existing ungranted home');
  if (grantShown) {
    const nd = dialogs.length;
    await bench.click('#grant');
    await bench.waitForSelector('#files li', { timeout: 10000 });
    info('dialogs on grant: ' + JSON.stringify(dialogs.slice(nd)));
    ok(dialogs.slice(nd).some((d) => d.type === 'confirm' && /home workspace/.test(d.message)), 'bench: shell confirm asked before granting');
  }
  const listed = async () => bench.evaluate(() => Array.from(document.querySelectorAll('#files li')).map((li) => ({
    name: li.querySelector('.filename').textContent, meta: li.querySelector('.meta').textContent })));
  let rows = await listed();
  info('bench file list: ' + JSON.stringify(rows));
  ok(rows.some((r) => r.name === 'legacy.html' && /v1$/.test(r.meta)), 'bench: lists legacy.html v1');
  ok(rows.some((r) => r.name === 'notes.md' && /v1$/.test(r.meta)), 'bench: lists notes.md v1');
  const afterGrant = await page.evaluate((k) => localStorage.getItem(k), KEY);
  ok(afterGrant === installsWithBench, 'bench: open + grant did not change ' + KEY);

  const clickRow = async (name, label) => {
    await bench.evaluate(({ name, label }) => {
      const li = Array.from(document.querySelectorAll('#files li')).find((l) => l.querySelector('.filename').textContent === name);
      if (!li) throw new Error('no row ' + name);
      Array.from(li.querySelectorAll('button')).find((b) => b.textContent === label).click();
    }, { name, label });
    await bench.waitForFunction(() => Array.from(document.querySelectorAll('#files button')).every((b) => !b.disabled), null, { timeout: 10000 });
    await page.waitForTimeout(100);
  };
  const benchStatus = () => bench.textContent('#status');
  const head = (p) => fsCall(page, 'stat', { ws: 'home', path: p });

  // ── 5a. rename with the correct base (Bench's listed ver)
  promptAnswer = 'legacy2.html';
  await clickRow('legacy.html', 'Rename');
  rows = await listed();
  info('after rename (correct base): status=' + JSON.stringify(await benchStatus()) + ' list=' + JSON.stringify(rows));
  const sOld = await head('dev/legacy.html'), sNew = await head('dev/legacy2.html');
  info('stat legacy.html=' + JSON.stringify(sOld) + ' legacy2.html=' + JSON.stringify(sNew));
  ok(sOld.ok === false && sOld.error === 'not found' && sNew.ver === 1, 'rename: legacy.html gone, legacy2.html v1');
  ok(rows.some((r) => r.name === 'legacy2.html') && !rows.some((r) => r.name === 'legacy.html'), 'rename: Bench list shows legacy2.html, not legacy.html');

  // ── 5b. rename with a stale base: another writer bumps legacy2.html behind Bench's back
  const bump = await fsCall(page, 'write', { ws: 'home', path: 'dev/legacy2.html', content: LEGACY + '\n<!-- v2 -->', base: 1 }, { actor: 'other-tab' });
  info('external write legacy2.html base 1 -> ' + JSON.stringify(bump));
  promptAnswer = 'legacy3.html';
  await clickRow('legacy2.html', 'Rename');
  const staleRename = await benchStatus();
  info('stale rename status: ' + JSON.stringify(staleRename));
  const sL2 = await head('dev/legacy2.html'), sL3 = await head('dev/legacy3.html');
  info('stat legacy2.html=' + JSON.stringify(sL2) + ' legacy3.html=' + JSON.stringify(sL3));
  ok(/conflict/i.test(staleRename), 'stale rename: Bench reports a conflict');
  ok(sL2.ver === 2 && sL3.ok === false, 'stale rename: nothing moved (legacy2.html still v2, no legacy3.html)');
  const rawMove = await page.evaluate(() => new Promise((resolve) => {
    // The same stale move through the shell's own fs lib, for the exact refusal payload.
    import('/lib/fs.js').then((lib) => lib.openFs().move({ ws: 'home', from: 'dev/legacy2.html', to: 'dev/legacy3.html', base: 1 }, { actor: 'check' })).then(resolve, (e) => resolve({ thrown: e.message }));
  }));
  info('raw stale move payload: ' + JSON.stringify({ ...rawMove, diff: rawMove.diff ? '[' + rawMove.diff.length + ' lines]' : undefined }));
  ok(rawMove.ok === false && rawMove.error === 'conflict' && rawMove.base === 1 && rawMove.current === 2, 'stale rename (fs): conflict base=1 current=2');

  // ── 5c. delete notes.md with a stale base
  const bumpN = await fsCall(page, 'write', { ws: 'home', path: 'dev/notes.md', content: NOTES + 'edited elsewhere\n', base: 1 }, { actor: 'other-tab' });
  info('external write notes.md base 1 -> ' + JSON.stringify(bumpN));
  await clickRow('notes.md', 'Delete');
  const staleDelete = await benchStatus();
  const sN = await head('dev/notes.md');
  info('stale delete status: ' + JSON.stringify(staleDelete) + ' stat notes.md=' + JSON.stringify(sN));
  ok(/conflict/i.test(staleDelete), 'stale delete: Bench reports a conflict');
  ok(sN.ver === 2, 'stale delete: notes.md survives at v2');

  // ── 5d. delete with the correct base: reopen Bench so it re-lists current versions
  await page.evaluate(() => window.airis.do('close', { id: 'bench' }));
  await page.evaluate(() => window.airis.do('open', { id: 'bench' }));
  const frame2 = await (await page.waitForSelector('.window[data-app-id="bench"] iframe', { timeout: 10000 })).contentFrame();
  await frame2.waitForSelector('#files li', { timeout: 10000 });
  const rows2 = await frame2.evaluate(() => Array.from(document.querySelectorAll('#files li')).map((li) => li.querySelector('.filename').textContent + ' ' + li.querySelector('.meta').textContent));
  info('bench list after reopen: ' + JSON.stringify(rows2));
  await frame2.evaluate(() => {
    const li = Array.from(document.querySelectorAll('#files li')).find((l) => l.querySelector('.filename').textContent === 'notes.md');
    Array.from(li.querySelectorAll('button')).find((b) => b.textContent === 'Delete').click();
  });
  await frame2.waitForFunction(() => !Array.from(document.querySelectorAll('#files .filename')).some((n) => n.textContent === 'notes.md') || /conflict|fail/i.test(document.getElementById('status').textContent), null, { timeout: 10000 });
  const goodDelete = await frame2.textContent('#status');
  const sN2 = await head('dev/notes.md');
  const rows3 = await frame2.evaluate(() => Array.from(document.querySelectorAll('#files li')).map((li) => li.querySelector('.filename').textContent + ' ' + li.querySelector('.meta').textContent));
  info('correct delete status=' + JSON.stringify(goodDelete) + ' stat notes.md=' + JSON.stringify(sN2) + ' list=' + JSON.stringify(rows3));
  ok(sN2.ok === false && sN2.error === 'not found', 'delete (correct base v2): notes.md gone');
  ok(!rows3.some((r) => r.startsWith('notes.md')), 'delete: Bench list no longer shows notes.md');

  // ── final: install records and shell surfaces
  const final = await page.evaluate((k) => localStorage.getItem(k), KEY);
  ok(final === installsWithBench, `final: ${KEY} byte-identical to the value right after installing Bench (${final.length} vs ${installsWithBench.length} bytes)`);
  const finalObj = JSON.parse(norm(final)), beforeObj = JSON.parse(norm(before));
  const addedIds = Object.keys(finalObj.records).filter((id) => !(id in beforeObj.records));
  const removedIds = Object.keys(beforeObj.records).filter((id) => !(id in finalObj.records));
  const changedIds = Object.keys(beforeObj.records).filter((id) => id in finalObj.records && JSON.stringify(finalObj.records[id]) !== JSON.stringify(beforeObj.records[id]));
  info(`final vs pre-seed: added=${JSON.stringify(addedIds)} removed=${JSON.stringify(removedIds)} changed(normalised)=${JSON.stringify(changedIds)} removedList ${JSON.stringify(beforeObj.removed)} -> ${JSON.stringify(finalObj.removed)}`);
  ok(removedIds.length === 0 && changedIds.length === 0 && addedIds.every((id) => id === 'bench'), 'final: vs pre-seed, the only difference is the bench record');
  ok(!Object.entries(finalObj.records).some(([id, r]) => DEV_RE.test(id) || DEV_RE.test(r.entry.url || '')), 'final: no record mentions dev/|legacy|notes');
  const surf2 = await shellSurfaces(page);
  info('final grid: ' + surf2.grid.length + ' tiles, dock ' + JSON.stringify(surf2.dock) + ', taskbar ' + JSON.stringify(surf2.tasks) + ', apps ' + surf2.appIds.length);
  const hits2 = [...surf2.appIds, ...surf2.grid, ...surf2.dock, ...surf2.tasks].filter((t) => SURFACE_RE.test(t));
  ok(!hits2.length, 'final: no app/tile/dock/taskbar entry names legacy*/notes.md ' + JSON.stringify(hits2));

  // and once more across a fresh boot after the lifecycle
  await page.reload({ waitUntil: 'load' });
  const reboot = await settle(page);
  ok(norm(reboot) === norm(final), `reboot: ${KEY} unchanged (apart from installedAt) by a boot with legacy2.html present`);
  const surf3 = await shellSurfaces(page);
  const hits3 = [...surf3.appIds, ...surf3.grid, ...surf3.dock, ...surf3.tasks].filter((t) => SURFACE_RE.test(t));
  ok(!hits3.length, 'reboot: nothing named legacy*/notes.md on any surface ' + JSON.stringify(hits3));
  for (const q of ['legacy', 'notes']) {
    const rows = await paletteFor(page, q);
    ok(!rows.some((r) => SURFACE_RE.test(r) && !/^⌁/.test(r)), `reboot: palette "${q}" has no dev-file row ${JSON.stringify(rows)}`);
  }
} catch (error) {
  ok(false, 'browser check error: ' + (error.stack || error));
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) { ok(false, 'browser close error: ' + error); }
  }
}
console.log(`${fails ? 'FAILED' : 'OK'}: ${passes} passed, ${fails} failed`);
if (fails) process.exitCode = 1;
