# Agents start here

This repo is Airis OS, the whole of Paul's site, served by one Cloudflare Worker.

Every rule lives in **`airis.contract.json`** (machine-readable): how to add, change
or remove an app, the manifest schema, sandbox and CSP rules, the app bridge,
the action registry, install-record and bundle shapes, the Worker route table,
and the test commands. This file holds no rules of its own.

- Serve locally: `node scripts/dev.mjs` (no dependencies) or `npx wrangler dev`
- Check the repo against the contract: `node scripts/check.mjs` (add `--live http://localhost:8788` once a server is running)
