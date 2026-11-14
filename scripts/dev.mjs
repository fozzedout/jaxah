#!/usr/bin/env node
// Dependency-free local server for Airis OS: static files from the repo root
// plus the exact route table the Worker uses (lib/router.js + the contract).
//   node scripts/dev.mjs [port]          default port 8788
//   UPSTREAM_GO=http://127.0.0.1:9999 node scripts/dev.mjs   (stub upstream)
// Never logs request headers or bodies (the Authorization key passes through).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { handleApi, redirectFor } from '../lib/router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'airis.contract.json'), 'utf8'));
const port = Number(process.argv[2] || process.env.PORT || 8788);

// Same exclusions as the deployed asset set.
const ignored = fs.readFileSync(path.join(root, '.assetsignore'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
ignored.push('.assetsignore');
const isIgnored = (rel) => ignored.some((p) => rel === p || rel.startsWith(p + '/'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.woff2': 'font/woff2',
};

function fileFor(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return null; }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const relNorm = path.relative(root, abs).split(path.sep).join('/');
  if (relNorm && isIgnored(relNorm)) return null;
  const tries = [abs, path.join(abs, 'index.html'), abs + '.html'];
  for (const f of tries) {
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) return res.end();
  // Pipe chunk by chunk with no buffering so SSE streams stay token-by-token.
  Readable.fromWeb(response.body).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:' + port}`);
  const done = (status) => console.log(`${status} ${req.method} ${url.pathname} ${Date.now() - t0}ms`);
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = Readable.toWeb(req); init.duplex = 'half'; }
      const response = await handleApi(contract.worker, new Request(url, init), process.env);
      done(response.status);
      return sendResponse(res, response);
    }
    const file = fileFor(url.pathname === '/diagnostic' ? '/' : url.pathname);
    if (file) {
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') { done(200); return res.end(); }
      fs.createReadStream(file).pipe(res);
      return done(200);
    }
    const to = redirectFor(contract.worker, url.pathname);
    if (to) { res.writeHead(301, { location: to + url.search }); res.end(); return done(301); }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
    done(404);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dev server error');
    console.error('500', req.method, url.pathname, e && e.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  const ups = Object.entries(contract.worker.upstreams)
    .map(([k, u]) => `  /api/${k} -> ${(u.envOverride && process.env[u.envOverride]) || u.base}`).join('\n');
  console.log(`Airis OS dev server: http://localhost:${port}\n${ups}`);
});
