#!/usr/bin/env node
// Contract checker: proves the repo obeys airis.contract.json. No dependencies.
//   node scripts/check.mjs                         offline checks
//   node scripts/check.mjs --live http://localhost:8788   + live URL/API checks
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } };
let fails = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { fails++; console.log('FAIL ' + what); } return cond; };

const C = JSON.parse(read('airis.contract.json'));
const M = JSON.parse(read('manifest.json'));

// ── manifest entries vs contract.appEntry (same rules shell.js validateEntry applies)
const isLocal = (u) => typeof u === 'string' && u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && u[0] !== '/' && !u.split(/[/?#]/).includes('..');
function validate(e) {
  const spec = C.appEntry, errs = [];
  for (const k of spec.required) if (e[k] === undefined || e[k] === '') errs.push('missing ' + k);
  for (const [k, f] of Object.entries(spec.fields)) {
    const v = e[k]; if (v === undefined) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    if (t !== f.type) { errs.push(`${k} must be ${f.type}`); continue; }
    if (f.enum && !f.enum.includes(v)) errs.push(`${k} not in ${f.enum}`);
    if (f.pattern && !new RegExp(f.pattern).test(v)) errs.push(`${k} !~ ${f.pattern}`);
    if (f.items?.enum) for (const x of v) if (!f.items.enum.includes(x)) errs.push(`${k}: unknown ${x}`);
  }
  for (const k of Object.keys(e)) if (!spec.fields[k]) errs.push('unknown field ' + k);
  if (typeof e.url === 'string' && !isLocal(e.url) && !/^https:\/\//.test(e.url)) errs.push('url must be root-relative or https');
  if (e.install === 'code' && (!isLocal(e.url) || !/\.html$/.test(e.url) || e.launch === 'standalone')) errs.push("install:'code' needs local .html + launch auto");
  return errs;
}
ok(Array.isArray(M.apps) && M.apps.length > 0, 'manifest.apps is a non-empty array');
const ids = new Set();
for (const e of M.apps) {
  const errs = validate(e);
  ok(!errs.length, `manifest ${e.id}: ${errs.join('; ')}`);
  ok(!ids.has(e.id), `manifest ${e.id}: duplicate id`); ids.add(e.id);
  if (isLocal(e.url)) ok(exists(e.url.split(/[?#]/)[0]), `manifest ${e.id}: file ${e.url} exists`);
  if (e.install === 'code' && exists(e.url)) {
    const html = read(e.url);
    ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+rel=["']?stylesheet/i.test(html), `${e.url}: code app is self-contained (no external script/style)`);
  }
}
const session = M.apps.find((a) => a.id === 'session');
ok(session && Array.isArray(session.settings?.presets) && session.settings.presets.length >= 2, 'session has data presets');
for (const p of session?.settings?.presets || []) {
  for (const k of ['id', 'label', 'baseUrl']) ok(typeof p[k] === 'string', `preset ${p.id}: ${k}`);
  ok(!('model' in p), `preset ${p.id}: carries no model (there is no default model)`);
  ok(!Object.keys(p.headers || {}).some((h) => /^authorization$/i.test(h)), `preset ${p.id}: no Authorization in headers`);
  // contract.sessionPreset.hint: shown in the strip, so it must not leak a URL, host or path
  ok(!('hint' in p) || (typeof p.hint === 'string' && !/:\/\/|\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(p.hint)), `preset ${p.id}: hint has no URL/host/path`);
  // contract.sessionPreset.transport (+ .why: opencode answers no CORS preflight, OpenRouter does)
  if (!ok(p.transport === 'proxy' || p.transport === 'direct', `preset ${p.id}: transport is proxy|direct`)) continue;
  if (p.transport === 'proxy') {
    const name = (/^\/api\/([a-z0-9-]+)$/.exec(p.baseUrl) || [])[1];
    const up = name && Object.prototype.hasOwnProperty.call(C.worker.upstreams, name) ? C.worker.upstreams[name] : null;
    ok(up, `preset ${p.id}: proxy baseUrl ${p.baseUrl} is /api/<a worker.upstreams key>`);
    ok(p.editable === false, `preset ${p.id}: proxy is not editable`);
    ok(up && p.upstream === up.base, `preset ${p.id}: upstream ${p.upstream} equals worker.upstreams.${name}.base`);
  } else {
    ok(/^https?:\/\/[^/]/.test(p.baseUrl), `preset ${p.id}: direct baseUrl is an absolute http(s) URL`);
    ok(typeof p.editable === 'boolean', `preset ${p.id}: direct editable is a boolean`);
    ok(!('upstream' in p), `preset ${p.id}: direct has no upstream field`);
  }
}
{ // the strip renders no provider URL: only p.hint, and the Base URL box only for the editable custom preset
  const src = read('apps/session.html');
  ok(!/p\.upstream|p\.note|via\.title/.test(src), 'session.html strip never renders upstream/note/title URLs');
}
for (const id of Object.keys(C.sessionPreset.why).filter((k) => k !== 'doc')) ok(session?.settings?.presets?.some((p) => p.id === id), `contract sessionPreset.why.${id} names a real preset`);

// ── offline URL resolution (file or redirect -> file), as the Worker would
function redirect(p) {
  for (const r of C.worker.redirects) {
    if (r.from === p) return r.to;
    if (r.fromPrefix && p.startsWith(r.fromPrefix)) return r.toPrefix + p.slice(r.fromPrefix.length);
  }
  return null;
}
function resolvesOffline(u) {
  let p = new URL(u, 'http://x').pathname;
  for (let hop = 0; hop < 3; hop++) {
    const f = p.endsWith('/') ? p.slice(1) + 'index.html' : p.slice(1);
    if (exists(f || 'index.html')) return true;
    const to = redirect(p); if (!to) return false; p = to;
  }
  return false;
}
for (const u of C.tests.legacyUrls) ok(resolvesOffline(u), `legacy URL ${u} resolves (offline)`);
for (const e of M.apps) for (const u of e.legacyUrls || []) ok(C.tests.legacyUrls.includes(u), `${e.id}: legacy URL ${u} is listed in contract tests.legacyUrls`);

// ── CSP, sandbox, worker config, code obeys registry
const idx = read('index.html');
const csp = (idx.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];
ok(csp === C.csp.shell, 'index.html CSP equals contract.csp.shell');
for (const bad of C.sandbox.never) ok(!C.sandbox.iframe.split(/\s+/).includes(bad), `sandbox does not grant ${bad}`);
const shell = read('shell.js');
ok(/setAttribute\('sandbox', CONTRACT\.sandbox\.iframe\)/.test(shell), 'shell.js takes the sandbox attribute from the contract');
ok(!/allow-same-origin['"]/.test(shell), 'shell.js never sets allow-same-origin');
for (const op of Object.keys(C.bridge.ops)) ok(shell.includes(`'${op}'`), `bridge op ${op} implemented in shell.js`);
for (const a of Object.keys(C.actions.list)) ok(new RegExp(`(^|\\s|')${a}'?: function`, 'm').test(shell), `action ${a} implemented in shell.js`);
const wr = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
ok(wr.main === C.worker.entry, 'wrangler main = contract.worker.entry');
ok(wr.assets?.directory === '.', 'wrangler assets.directory is the repo root');
ok(JSON.stringify(wr.assets?.run_worker_first) === JSON.stringify(C.worker.runWorkerFirst), 'run_worker_first matches contract');
ok(!['kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects'].some((k) => k in wr), 'worker has no storage bindings');
ok(/import contract from '\.\/airis\.contract\.json'/.test(read('worker.js')), 'worker.js reads the contract');
ok(exists('terminal.js') && !/fetch\(|manifest\.json|airis\.contract/.test(read('terminal.js')), 'terminal.js has no network/manifest/contract dependency');

// ── Workers asset limit (25 MiB per file)
const ignore = read('.assetsignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
(function walk(dir) {
  for (const n of fs.readdirSync(path.join(root, dir))) {
    const rel = dir ? dir + '/' + n : n;
    if (ignore.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
    const st = fs.statSync(path.join(root, rel));
    if (st.isDirectory()) walk(rel);
    else ok(st.size <= 25 * 1024 * 1024, `${rel} is under the 25 MiB asset limit (${st.size})`);
  }
})('');

// ── live checks
const live = process.argv.indexOf('--live');
if (live !== -1) {
  const base = (process.argv[live + 1] || 'http://localhost:8788').replace(/\/$/, '');
  for (const u of C.tests.legacyUrls) {
    let res, url = base + u, hops = 0;
    for (; hops < 4; hops++) {
      res = await fetch(url, { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
      break;
    }
    ok(res.status === 200, `live ${u} -> ${res.status} (after ${hops} redirect(s), at ${url.replace(base, '')})`);
    await res.arrayBuffer().catch(() => {});
  }
  for (const t of C.tests.apiMustRefuse) {
    const headers = { 'content-type': 'application/json' };
    if (t.origin) headers.origin = t.origin;
    // raw path (no client-side normalisation) via http module would be stricter; fetch normalises ../
    const res = await fetch(base + t.path, { method: t.method, headers, body: t.method === 'GET' ? undefined : '{}', redirect: 'manual' });
    ok(res.status === t.status, `live ${t.method} ${t.path}${t.origin ? ' (Origin ' + t.origin + ')' : ''} -> ${res.status}, want ${t.status}`);
    await res.arrayBuffer().catch(() => {});
  }
  const r = await fetch(base + '/airis.contract.json'); ok(r.ok, 'live contract is served at /airis.contract.json');
  for (const hidden of ['/worker.js', '/lib/router.js', '/wrangler.jsonc', '/.git/HEAD', '/scripts/dev.mjs']) {
    const h = await fetch(base + hidden, { redirect: 'manual' }); ok(h.status === 404, `live ${hidden} is not served (${h.status})`);
  }
}

console.log(`${fails ? 'FAILED' : 'OK'}: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
