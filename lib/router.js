// Airis OS route table, implemented once for both runtimes.
// Pure fetch API (Request/Response/Headers/fetch) - runs unchanged in a
// Cloudflare Worker (worker.js) and in Node 18+ (scripts/dev.mjs).
// Every rule here is data from airis.contract.json -> worker.
//
// Key handling: the caller's Authorization header is copied onto the upstream
// request and nowhere else. The tape token is a Worker secret used only for its relay.

const json = (status, body, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}),
  });

const tapeRates = new Map();

async function handleTape(tape, request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { allow: 'POST' });

  const origin = request.headers.get('origin');
  if (origin !== null && origin !== 'null' && origin !== url.origin) return json(403, { error: 'cross-origin requests are refused' });
  const source = url.searchParams.get('source');
  if (!tape.sources.includes(source)) return json(400, { error: 'unknown source' });
  const token = env && env[tape.secretEnv];
  if (!token) return json(503, { error: 'tape not configured' });

  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now(), windowMs = tape.rate.windowSeconds * 1000;
  let rate = tapeRates.get(ip);
  if (!rate || now - rate.start >= windowMs) rate = { n: 0, start: now };
  if (rate.n >= tape.rate.max) return json(429, { error: 'rate limited' }, { 'retry-after': String(Math.ceil((rate.start + windowMs - now) / 1000)) });
  rate.n++;
  tapeRates.set(ip, rate);
  if (tapeRates.size > 1000) tapeRates.clear();

  if (Number(request.headers.get('content-length')) > tape.maxBytes) return json(413, { error: 'too large' });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > tape.maxBytes) return json(413, { error: 'too large' });
  if (!text.trim()) return json(400, { error: 'empty body' });

  const base = ((env && env[tape.envOverride]) || tape.upstream).replace(/\/+$/, '');
  let upstream;
  try {
    upstream = await fetch(base + '/' + encodeURIComponent(token) + '?source=' + encodeURIComponent(source), {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text, redirect: 'manual',
    });
  } catch (e) {
    return json(502, { error: 'tape unreachable' });
  }
  if (upstream.ok) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-airis-tape': 'ok' } });
  return json(502, { error: 'tape refused', status: upstream.status });
}

function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

/** Redirect for a path, or null. Only consulted when no static asset matched. */
export function redirectFor(worker, pathname) {
  for (const r of worker.redirects || []) {
    if (r.from && r.from === pathname) return r.to;
    if (r.fromPrefix && pathname.startsWith(r.fromPrefix)) return r.toPrefix + pathname.slice(r.fromPrefix.length);
  }
  return null;
}

/**
 * Handle /api/*. Returns a Response, or null when the path is not under /api/.
 * env: { UPSTREAM_GO: 'http://...' } style overrides (Worker vars or process.env).
 */
export async function handleApi(worker, request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;

  // Raw path segments; refuse anything that tries to climb or encode its way out.
  const raw = url.pathname.slice('/api/'.length);
  if (!raw || /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(raw)) return json(404, { error: 'not found' });
  const slash = raw.indexOf('/');
  const name = slash === -1 ? raw : raw.slice(0, slash);
  const path = slash === -1 ? '' : raw.slice(slash + 1);
  if (name === 'tape' && path === '' && worker.tape) return handleTape(worker.tape, request, env, url);
  const up = Object.prototype.hasOwnProperty.call(worker.upstreams || {}, name) ? worker.upstreams[name] : null;
  if (!up) return json(404, { error: 'no such upstream' });

  const allowed = (up.allow || []).filter((a) => a.path === path);
  if (!allowed.length) return json(404, { error: 'path not allowed', upstream: name });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: allowed.map((a) => a.method).join(', ') } });
  if (!allowed.some((a) => a.method === request.method)) {
    return json(405, { error: 'method not allowed' }, { allow: allowed.map((a) => a.method).join(', ') });
  }

  // Same-origin only: browsers send Origin on cross-origin and on POST; it must be ours.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json(403, { error: 'cross-origin requests are refused' });

  const base = ((env && up.envOverride && env[up.envOverride]) || up.base).replace(/\/+$/, '');
  const target = base + '/' + path;

  const headers = new Headers();
  for (const h of up.forwardRequestHeaders || []) {
    const v = request.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  for (const [k, v] of Object.entries(up.setRequestHeaders || {})) headers.set(k, v);
  if (up.requireHeader && !headers.get(up.requireHeader.name)) headers.set(up.requireHeader.name, uuid());

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half'; // Node needs this for streamed bodies; Workers ignore it.
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return json(502, { error: 'upstream unreachable', upstream: name });
  }

  // Stream straight back: no buffering, so SSE tokens arrive as they are made.
  const out = new Headers({ 'cache-control': 'no-store', 'x-airis-upstream': name });
  for (const h of up.forwardResponseHeaders || []) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
