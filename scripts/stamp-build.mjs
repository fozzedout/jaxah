// Wrangler's build step stamps the shell HTML that actually carries the marker.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{7,}$/.test(sha)) throw new Error('Cannot determine build git SHA');
const path = new URL('../index.html', import.meta.url);
const html = readFileSync(path, 'utf8');
const stamped = html.replace(/(<span id="build-stamp" aria-label="Build">)[^<]*(<\/span>)/, `$1${sha}$2`);
if (stamped === html && !html.includes(`>${sha}</span>`)) throw new Error('Build marker missing');
writeFileSync(path, stamped);
