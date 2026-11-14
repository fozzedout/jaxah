// Airis OS - the one Worker. Serves the repo root as static assets
// (wrangler.jsonc -> assets.directory ".") and routes /api/*.
// All routing rules are data in airis.contract.json -> worker.
// Static assets are served by the platform before this Worker runs; site.webmanifest's
// Content-Type comes from Cloudflare's extension table. Verify after deploy with curl -I; don't assume it.
import contract from './airis.contract.json';
import { handleApi, redirectFor } from './lib/router.js';

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/diagnostic') {
      const assetUrl = new URL('/', request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
