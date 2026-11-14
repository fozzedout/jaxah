import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { validate, memoryStore, normPath, lineDiff, createRegistry } from './airis-actions.js';

before(() => {
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
});
const schema = { type: 'object', properties: { value: { type: 'string', enum: ['dark', 'light'] }, base: { type: ['integer', 'null'] } }, required: ['value', 'base'] };
const ctx = { actor: 'agent:test', caps: ['fs', 'actions', 'storage'], workspaces: ['w'] };
const todo = [{ name: 'add', args: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, effect: 'write', agent: true }];
const os = [
  { name: 'theme', args: { type: 'object', properties: { value: { type: 'string', enum: ['dark', 'light'] } }, required: ['value'] }, effect: 'write', agent: true },
  { name: 'uninstall', args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, effect: 'write', agent: false }
];

test('all action descriptions are useful and not filesystem placeholders', () => {
  const actions = createRegistry().list();
  for (const action of actions) {
    assert.doesNotMatch(action.doc, /^Filesystem \w+$/, action.address);
    if (action.agent) assert.ok(action.doc.length >= 40, action.address);
  }
});

test('validator subset and paths', () => {
  assert.deepEqual(validate(schema, { value: 'dark', base: null }), []);
  assert.deepEqual(validate(schema, { value: 'light', base: 3 }), []);
  assert.match(validate(schema, { value: 'bad', base: 1.5, extra: 1 }).join('|'), /one of dark, light.*integer\|null.*unknown property/);
  assert.match(validate(schema, { value: 4 }).join('|'), /base: required.*value: must be string/);
  assert.deepEqual(validate({ type: 'number' }, 1.5), []);
  assert.notDeepEqual(validate({ type: 'integer' }, 1.5), []);
  assert.notDeepEqual(validate({ type: 'number' }, Infinity), []);
  assert.deepEqual(validate({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 1 }), []);
  assert.equal(normPath('/./a//b/'), 'a/b');
  assert.equal(normPath('a/../b'), null);
  assert.equal(normPath('a\\b'), null);
  assert.match(lineDiff('a\nb', 'a\nc'), /-b\n\+c/);
});

test('validation, capabilities, workspace and app gating', async () => {
  const store = memoryStore({ now: () => 0 });
  const r = createRegistry({ store });
  let calls = 0;
  for (const args of [
    { ws: 'w', path: 'f', content: 'x' },
    { ws: 'w', path: 'f', content: 'x', base: '1' },
    { ws: 'w', path: 'f', content: 'x', base: null, mode: 'x' }
  ]) {
    assert.equal((await r.call('fs.write', args, ctx)).error, 'invalid args');
  }
  assert.equal(store.heads.size, 0);
  assert.equal(store.ops.length, 0);
  await r.publish('todo', { state: {}, actions: todo }, () => { calls++; });
  await r.publish('os', { state: {}, actions: os }, () => { calls++; });
  for (const args of [{ text: 5 }, { text: 'x', extra: 1 }]) {
    assert.equal((await r.call('app.act', { id: 'todo', action: 'add', args }, ctx)).error, 'invalid args');
  }
  assert.equal(calls, 0);
  assert.equal((await r.call('wrong.action', {}, ctx)).error, 'unknown action');
  assert.equal((await r.call('app.act', { id: 'os', action: 'uninstall', args: { id: 'x' } }, ctx)).error, 'not available to agents');
  assert.equal((await r.call('fs.read', { ws: 'w', path: 'x' }, {})).error, 'capability not granted');
  assert.equal((await r.call('fs.read', { ws: 'other', path: 'x' }, ctx)).error, 'workspace not granted');
});

test('CAS conflicts, history, and monotonically increasing versions', async () => {
  const r = createRegistry({ store: memoryStore({ now: () => 0 }) });
  const invoke = (action, args, c = ctx) => r.call(action, { ws: 'w', path: 'f', ...args }, c);
  assert.equal((await invoke('fs.write', { content: 'one', base: null }, { ...ctx, callId: 'first' })).value.ver, 1);
  assert.equal((await invoke('fs.write', { content: 'one\nhuman', base: 1 }, { ...ctx, actor: 'human' })).value.ver, 2);
  for (const [action, args] of [['fs.write', { content: 'lost', base: 1 }], ['fs.edit', { old: 'one', new: 'lost', base: 1 }]]) {
    const x = await invoke(action, args);
    assert.equal(x.error, 'conflict');
    assert.equal(x.current, 2);
    assert.equal(x.actor, 'human');
    assert.match(x.diff, /\+human/);
  }
  assert.equal((await invoke('fs.read', {})).value.content, 'one\nhuman');
  assert.equal((await invoke('fs.write', { content: 'x', base: null })).error, 'conflict');
  assert.equal((await r.call('fs.history', { ws: 'w', callId: 'first' }, ctx)).value[0].ver, 1);
  await invoke('fs.delete', { base: 2 });
  assert.equal((await invoke('fs.write', { content: 'new', base: null })).value.ver, 3);
  assert.equal((await invoke('fs.write', { content: 'stale', base: 1 })).error, 'conflict');
  assert.equal(r.trail.find(x => x.callId === 'first').actor, 'agent:test');
  assert.ok(r.trail.some(x => x.actor === 'human'));
});

test('edit requires exactly one occurrence', async () => {
  const r = createRegistry();
  const run = a => r.call('fs.edit', { ws: 'w', path: 'f', base: 1, ...a }, ctx);
  await r.call('fs.write', { ws: 'w', path: 'f', content: 'x x', base: null }, ctx);
  assert.equal((await run({ old: 'z', new: 'a' })).error, 'old not found');
  const res = await run({ old: 'x', new: 'a' });
  assert.equal(res.error, 'old not unique');
  assert.equal(res.count, 2);
  assert.equal((await run({ old: 'x x', new: 'y' })).value.ver, 2);
});

test('OS and apps use the same publication, state and action path', async () => {
  const r = createRegistry();
  const deliveries = [];
  for (const [id, actions] of [['os', os], ['todo', todo]]) {
    const out = await r.call('app.publish', { state: { id }, actions }, {
      actor: 'app:' + id,
      app: id,
      deliver: (action, args, c) => {
        deliveries.push([id, action, args, c.actor]);
        return 'ok';
      }
    });
    assert.equal(out.value.ver, 1);
    assert.equal((await r.call('app.state', { id }, ctx)).value.state.id, id);
  }
  assert.equal(r.describe('app.act', { id: 'os', action: 'theme' }, ctx).effect, 'write');
  assert.equal(r.describe('app.act', { id: 'os', action: 'uninstall' }, ctx).agent, false);
  assert.equal((await r.call('app.act', { id: 'os', action: 'theme', args: { value: 'dark' } }, ctx)).value, 'ok');
  assert.equal((await r.call('app.act', { id: 'todo', action: 'add', args: { text: 'hello' } }, ctx)).value, 'ok');
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(x => x[3] === 'agent:test'));
});

test('remaining fs and log operations, dispatch listeners', async () => {
  const r = createRegistry();
  const seen = [];
  const off = r.onDispatch(e => seen.push(e));
  const call = (name, args) => r.call(name, args, ctx);
  await call('fs.write', { ws: 'w', path: 'dir/a', content: 'hello\nworld', base: null });
  assert.equal((await call('fs.list', { ws: 'w', path: 'dir' })).value[0].path, 'dir/a');
  assert.equal((await call('fs.stat', { ws: 'w', path: 'dir/a' })).value.size, 11);
  assert.equal((await call('fs.search', { ws: 'w', pattern: 'world' })).value[0].line, 2);
  await call('fs.edit', { ws: 'w', path: 'dir/a', base: 1, old: 'world', new: 'earth' });
  assert.match((await call('fs.diff', { ws: 'w', path: 'dir/a', from: 1 })).value, /\+earth/);
  assert.equal((await call('fs.move', { ws: 'w', from: 'dir/a', to: 'dir/b', base: 2 })).ok, true);
  assert.equal((await call('fs.read', { ws: 'w', path: 'dir/a' })).error, 'not found');
  const app = { actor: 'app:todo', app: 'todo', caps: ['storage'] };
  assert.equal((await r.call('log.append', { log: 'events', event: { x: 1 } }, app)).value.seq, 1);
  assert.equal((await r.call('log.read', { log: 'events' }, app)).value.length, 1);
  assert.equal((await r.call('log.read', { log: 'events', app: 'todo' }, { caps: ['storage'] })).error, 'capability not granted');
  assert.ok(seen.length);
  off();
  const n = seen.length;
  await call('fs.list', { ws: 'w' });
  assert.equal(seen.length, n);
});

test('read reports total lines independently of the requested range', async () => {
  const r = createRegistry();
  await r.call('fs.write', { ws: 'w', path: 'f', content: 'one\ntwo\nthree\n', base: null }, ctx);
  assert.deepEqual((await r.call('fs.read', { ws: 'w', path: 'f', from: 2, to: 3 }, ctx)).value, {
    path: 'f', ver: 1, content: 'two\nthree', lines: 4
  });
  assert.equal((await r.call('fs.read', { ws: 'w', path: 'f' }, ctx)).value.lines, 4);
  await r.call('fs.write', { ws: 'w', path: 'empty', content: '', base: null }, ctx);
  assert.equal((await r.call('fs.read', { ws: 'w', path: 'empty' }, ctx)).value.lines, 1);
});

test('required file paths cannot normalize to the workspace root', async () => {
  const store = memoryStore();
  const r = createRegistry({ store });
  const actions = [
    ['fs.read', {}], ['fs.stat', {}], ['fs.write', { content: 'x', base: null }],
    ['fs.edit', { old: 'x', new: 'y', base: 1 }], ['fs.delete', { base: 1 }], ['fs.diff', { from: 1 }]
  ];
  for (const path of ['', '/', './']) {
    for (const [action, args] of actions) {
      assert.deepEqual(await r.call(action, { ws: 'w', path, ...args }, ctx), { ok: false, error: 'bad path' });
    }
    for (const field of ['from', 'to']) {
      assert.deepEqual(await r.call('fs.move', { ws: 'w', from: 'a', to: 'b', base: 1, [field]: path }, ctx), { ok: false, error: 'bad path' });
    }
    for (const action of ['fs.list', 'fs.search', 'fs.history']) {
      assert.equal((await r.call(action, { ws: 'w', path, ...(action === 'fs.search' ? { pattern: 'x' } : {}) }, ctx)).ok, true);
    }
  }
  assert.equal(store.heads.size, 0);
  assert.equal(store.ops.length, 0);
});

test('publication requires a delivery function and leaves existing publication intact', async () => {
  const r = createRegistry();
  const data = { state: {}, actions: todo };
  for (const deliver of [undefined, null, 'not a function', {}]) {
    assert.deepEqual(await r.call('app.publish', data, { app: 'todo', deliver }), { ok: false, error: 'deliver required' });
  }
  assert.deepEqual(await r.publish('todo', data), { ok: false, error: 'deliver required' });
  assert.equal((await r.call('app.state', { id: 'todo' }, ctx)).error, 'not published');
  assert.equal((await r.publish('todo', data, () => 'delivered')).value.ver, 1);
  assert.deepEqual(await r.publish('todo', { state: { changed: true }, actions: todo }, null), { ok: false, error: 'deliver required' });
  assert.equal((await r.call('app.state', { id: 'todo' }, ctx)).value.ver, 1);
  assert.equal((await r.call('app.act', { id: 'todo', action: 'add', args: { text: 'x' } }, ctx)).value, 'delivered');
});
