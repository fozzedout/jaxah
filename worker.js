// Airis OS - the one Worker. Serves the repo root as static assets
// (wrangler.jsonc -> assets.directory ".") and routes /api/*.
// All routing rules are data in airis.contract.json -> worker.
import contract from './airis.contract.json';
import { handleApi, redirectFor } from './lib/router.js';

export default {
  async fetch(request, env) {
    const api = await handleApi(contract.worker, request, env);
    if (api) return api;
    // Reached only when no static asset matched (or for /api/*, handled above).
    const url = new URL(request.url);
    const to = redirectFor(contract.worker, url.pathname);
    if (to) return Response.redirect(new URL(to + url.search, url).toString(), 301);
    return env.ASSETS.fetch(request);
  },
};
