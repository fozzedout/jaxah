import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps/bench.html', import.meta.url), 'utf8');
const match = source.match(/<script id="dev-rules">([\s\S]*?)<\/script>/);
assert.ok(match, 'rules script exists');
const context = vm.createContext({});
vm.runInContext(match[1], context);
const { checkName, isDevPath, isRunnable, viewFor, HELLO_PATH, HELLO_TEXT } = context.DevRules;

test('DevRules.DEV agrees with the dev environment contract', () => {
  const dev = JSON.parse(readFileSync(new URL('../airis.contract.json', import.meta.url), 'utf8')).devEnvironment;
  const rules = context.DevRules.DEV;
  assert.equal(rules.ws, dev.workspace);
  assert.equal(rules.dir, dev.dir);
  assert.deepEqual(Array.from(rules.textExt), dev.textExtensions);
  assert.deepEqual(Array.from(rules.runExt), dev.runExtensions);
});

test('checkName accepts only supported flat file names', () => {
  for (const name of ['hello.html', 'a.js', 'notes.md', 'x.txt']) {
    const result = checkName(name);
    assert.equal(result.ok, true, name);
    assert.equal(result.path, 'dev/' + name);
  }
  for (const name of ['', '../x.html', 'a/b.html', '.hidden', 'noext', 'x.exe', 'a..b.html', 'a'.repeat(70)]) {
    const result = checkName(name);
    assert.equal(result.ok, false, name);
    assert.equal(typeof result.error, 'string');
  }
});

test('isDevPath restricts paths to valid flat dev files', () => {
  assert.equal(isDevPath('dev/hello.html'), true);
  for (const path of ['hello.html', 'dev/a/b.html', 'apps/x.html', 'dev/../x.html', 'dev/x.exe', null]) assert.equal(isDevPath(path), false, String(path));
});

test('only HTML files are runnable', () => {
  assert.equal(isRunnable('dev/a.html'), true);
  assert.equal(isRunnable('dev/a.htm'), true);
  assert.equal(isRunnable('dev/a.js'), false);
});

test('viewFor distinguishes errors, empty lists and files', () => {
  for (const value of [null, {ok:false}]) assert.equal(viewFor(value), 'error');
  for (const value of [[], [{path:'other/x.html'}]]) assert.equal(viewFor(value), 'empty');
  assert.equal(viewFor([{path:'dev/a.txt'}]), 'files');
});

test('hello example is a runnable HTML document', () => {
  assert.equal(HELLO_PATH, 'dev/hello.html');
  assert.equal(isRunnable(HELLO_PATH), true);
  assert.match(HELLO_TEXT, /^<!doctype html/i);
});

test('Bench only names allowed bridge operations and no app installation machinery', () => {
  for (const banned of ['store.install', 'store.import', 'os.do', "'os.state'", 'manifest', 'APPS', 'installs']) assert.equal(source.includes(banned), false, banned);
  const allowed = new Set(['hello', 'fs.workspaces', 'fs.create', 'fs.list', 'fs.read', 'fs.write', 'fs.move', 'fs.delete', 'harness.run', 'harness.close']);
  const ops = [...source.matchAll(/\bcall\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(ops.length);
  for (const op of ops) assert.ok(allowed.has(op), op);
});

test('catalogue has only the Bench app, not dev files', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const bench = catalogue.apps.find(app => app.id === 'bench');
  assert.ok(bench);
  assert.equal(bench.install, 'code');
  assert.deepEqual(bench.capabilities, ['fs']);
  assert.notEqual(bench.preinstalled, true);
  for (const app of catalogue.apps) assert.doesNotMatch(app.url, /(?:^|\/)dev\//);
});
