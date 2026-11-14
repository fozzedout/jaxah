// Airis OS - the one Worker. Serves the repo root as static assets
// (wrangler.jsonc -> assets.directory ".") and routes /api/*.
// All routing rules are data in airis.contract.json -> worker.
// Static assets are served by the platform before this Worker runs; site.webmanifest's
// Content-Type comes from Cloudflare's extension table. Verify after deploy with curl -I; don't assume it.
import contract from './airis.contract.json';
import { handleApi, redirectFor } from './lib/router.js';

function buildLabel(env) {
  const tag = env.CF_VERSION_METADATA?.tag;
  return typeof tag === 'string' && /^[0-9a-f]{7,40}$/.test(tag) ? tag : 'UNBUILT';
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/' || pathname === '/diagnostic') {
      const assetUrl = new URL('/', request.url);
      // Unconditional fetch: the asset ETag never changes with the tag, so a 304 would keep a stale stamp.
      const response = await env.ASSETS.fetch(new Request(assetUrl));
      if (!response.ok || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') || '')) return response;
      const label = buildLabel(env);
      const rewritten = new HTMLRewriter().on('#build-stamp', {
        element(element) { element.setInnerContent(label); },
      }).transform(response);
      const headers = new Headers(rewritten.headers);
      headers.delete('ETag');
      headers.delete('Last-Modified');
      headers.set('Cache-Control', pathname === '/diagnostic' ? 'no-store' : 'no-cache');
      headers.set('X-Airis-Build', `${label}; version=${env.CF_VERSION_METADATA?.id || 'none'}`);
      return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
    }
    const api = await handleApi(contract.worker, request, env);
    if (api) return api;
    // Reached only when no static asset matched (or for /api/*, handled above).
    const url = new URL(request.url);
    const to = redirectFor(contract.worker, url.pathname);
    if (to) return Response.redirect(new URL(to + url.search, url).toString(), 301);
    return env.ASSETS.fetch(request);
  },
};
