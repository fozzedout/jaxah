import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const shell = readFileSync(new URL('../shell.js', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../airis.contract.json', import.meta.url), 'utf8'));
const start = '/* ── test harness: workspace files run here, never as apps ── */';
const end = '/* ── end test harness ── */';
const marked = shell.split(start)[1]?.split(end)[0];
const section = (name, next) => shell.slice(shell.indexOf('function ' + name + '('), shell.indexOf('function ' + next + '('));

test('harness is isolated from app and install registries', () => {
  assert.equal(shell.split(start).length, 2);
  assert.equal(shell.split(end).length, 2);
  assert.ok(marked);
  for (const name of ['APPS', 'byId', 'installs', 'CATALOGUE', 'catById', 'focusOrder', 'savedWins', 'frameIds', 'rebuildApps', 'renderGrid', 'renderDock', 'renderSummon', 'makeRecord', 'installFromCatalogue', 'saveInstalls', 'saveWins']) {
    assert.ok(!marked.includes(name), name);
  }
  assert.doesNotMatch(marked, /openWins\[[^\]]*\]\s*=(?!=)/);
});

test('only rebuildApps assigns APPS from install records', () => {
  const begin = shell.indexOf('function rebuildApps(');
  const finish = shell.indexOf('function storeList(', begin);
  const assignments = [...shell.matchAll(/(?<!var )\bAPPS\s*=(?!=)/g)];
  assert.equal(assignments.length, 1);
  assert.ok(assignments.every(m => m.index > begin && m.index < finish));
  assert.match(shell.slice(begin, finish), /APPS\s*=\s*Object\.keys\(installs\.records\)/);
});

test('app and harness share the contract sandbox frame', () => {
  assert.match(section('openApp', 'closeApp'), /sandboxFrame\(/);
  assert.match(marked.slice(marked.indexOf('function harnessRun(')), /sandboxFrame\(/);
  assert.match(section('sandboxFrame', 'openApp'), /CONTRACT\.sandbox\.iframe/);
  const withoutComments = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /allow-same-origin/);
});

test('contract defines the dev environment and bridge operations', () => {
  const dev = contract.devEnvironment;
  assert.equal(dev.workspace, 'home');
  assert.equal(dev.dir, 'dev');
  assert.ok(dev.runExtensions.includes('html'));
  assert.match(dev.rules.join(' '), /file in a workspace is never an app/i);
  assert.equal(contract.bridge.ops['harness.run'].cap, 'fs');
  assert.ok(contract.bridge.ops['harness.close']);
});

test('actual path validator accepts only flat runnable dev files', () => {
  const source = marked.match(/function harnessPathOk\(ws, path\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const validate = runInNewContext('(' + source + ')', { harnessRules: () => contract.devEnvironment });
  for (const path of ['dev/index.html', 'dev/a.htm', 'dev/a.HTML']) assert.equal(validate('home', path), true, path);
  for (const path of ['dev/../x.html', 'dev/a..html', 'dev/a/b.html', 'dev/.x.html', 'dev/a.js', 'dev/' + 'a'.repeat(65) + '.html', null]) assert.equal(validate('home', path), false, String(path));
  assert.equal(validate('other', 'dev/index.html'), false);
});
