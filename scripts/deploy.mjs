// This is the only deploy path: the tag is what the Worker reports as its build.
// A plain wrangler deploy honestly shows UNBUILT.
import { execFileSync, spawnSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

try {
  execFileSync('git', ['fetch', 'origin'], { stdio: 'inherit' });
  if (git('status', '--porcelain')) {
    console.error('Refusing to deploy: working tree is not clean.');
    process.exit(1);
  }
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    console.error('Refusing to deploy: HEAD must equal origin/main.');
    process.exit(1);
  }
  const sha = git('rev-parse', '--short=7', 'HEAD');
  const subject = git('log', '-1', '--format=%s').slice(0, 100);
  const result = spawnSync('npx', ['wrangler', 'deploy', '--tag', sha, '--message', `${sha} ${subject}`], { stdio: 'inherit' });
  if (result.error) console.error(`Deploy failed: ${result.error.message}`);
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`Deploy failed: ${error.message}`);
  process.exit(1);
}
