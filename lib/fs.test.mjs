import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFs, workspaceId, filePath } from './fs.js';
import { fakeIndexedDB, FakeKeyRange } from '../scripts/fake-idb.mjs';

test('opens the filesystem stores', async () => {
  const fs = openFs({ indexedDB: fakeIndexedDB() });
  const db = await fs.db;
  assert.deepEqual([...db.objectStoreNames], ['blobs', 'versions', 'heads', 'ops', 'workspaces']);
});

const openFake = () => new Promise((resolve, reject) => {
  const request = fakeIndexedDB().open('test', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('items');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = () => reject(tx.error || new Error('aborted'));
});
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

test('fake rolls back all writes on explicit and request-error abort', async () => {
  const db = await openFake();
  let tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').put('original', 'a');
  await done(tx);
  tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').put('changed', 'a');
  tx.abort();
  await assert.rejects(done(tx), /aborted/);
  tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').put('new', 'b');
  tx.objectStore('items').add('duplicate', 'a');
  await assert.rejects(done(tx), { name: 'ConstraintError' });
  tx = db.transaction('items');
  assert.deepEqual(await result(tx.objectStore('items').getAll()), ['original']);
  await done(tx);
  assert.throws(() => tx.objectStore('items'), { name: 'TransactionInactiveError' });
});

test('fake serializes overlapping readwrite transactions', async () => {
  const db = await openFake();
  const first = db.transaction('items', 'readwrite');
  const second = db.transaction('items', 'readwrite');
  const firstDone = done(first), secondDone = done(second);
  first.objectStore('items').put(1, 'counter');
  const store = second.objectStore('items');
  const read = store.get('counter');
  read.onsuccess = () => store.put(read.result + 1, 'counter');
  await Promise.all([firstDone, secondDone]);
  const tx = db.transaction('items');
  assert.equal(await result(tx.objectStore('items').get('counter')), 2);
  await done(tx);
});

test('fake cursor traverses an array key range in reverse', async () => {
  const db = await openFake();
  let tx = db.transaction('items', 'readwrite');
  const store = tx.objectStore('items');
  for (const key of [['a', 1], ['a', 2], ['a', 3], ['b', 1]]) store.put(key[1], key);
  await done(tx);
  tx = db.transaction('items');
  const finished = done(tx), keys = [], values = [];
  const cursor = tx.objectStore('items').openCursor(FakeKeyRange.bound(['a', 1], ['a', 3], true), 'prev');
  cursor.onsuccess = () => {
    if (!cursor.result) return;
    keys.push(cursor.result.key); values.push(cursor.result.value); cursor.result.continue();
  };
  await finished;
  assert.deepEqual(keys, [['a', 3], ['a', 2]]);
  assert.deepEqual(values, [3, 2]);
  assert.equal(cursor.result, null);
});

test('validates workspace IDs and file paths', () => {
  assert.equal(workspaceId('my-workspace'), true);
  assert.equal(workspaceId('../bad'), false);
  assert.equal(filePath('/a/./b'), 'a/b');
  assert.throws(() => filePath('a/../b'), /invalid path/);
  assert.throws(() => filePath('/'), /invalid path/);
});

test('reports storage usage and acquires a nonblocking workspace lock', async () => {
  const fs = openFs({ indexedDB: fakeIndexedDB(),
    storage: { estimate: async () => ({ usage: 2, quota: 10 }), persisted: async () => true },
    locks: { request: async (name, options, fn) => {
      assert.equal(name, 'airis.run:work');
      assert.deepEqual(options, { ifAvailable: true });
      return fn({ name });
    } } });
  assert.deepEqual(await fs.usage(), { usage: 2, quota: 10, persisted: true });
  assert.equal(await fs.runLock('work', () => 42), 42);
});

test('run locks are exclusive across filesystem instances', async () => {
  const held = new Set();
  const locks = { request: async (name, options, cb) => {
    assert.deepEqual(options, { ifAvailable: true });
    if (held.has(name)) return cb(null);
    held.add(name);
    try { return await cb({ name }); } finally { held.delete(name); }
  } };
  const a = openFs({ indexedDB: fakeIndexedDB(), locks, channel: null });
  const b = openFs({ indexedDB: fakeIndexedDB(), locks, channel: null });
  assert.deepEqual(await a.acquireRun('work', 'app'), { ok: true, held: true });
  assert.deepEqual(await a.acquireRun('work', 'app'), { ok: true, held: true });
  assert.deepEqual(await a.acquireRun('work', 'other'), { ok: true, held: false });
  assert.deepEqual(await b.acquireRun('work', 'app'), { ok: true, held: false });
  assert.equal(a.releaseRun('work'), true);
  assert.equal(a.releaseRun('work'), false);
  await Promise.resolve();
  assert.deepEqual(await b.acquireRun('work', 'app'), { ok: true, held: true });
  b.releaseRun('work'); a.close(); b.close();
});

const fixture = async () => {
  let persists = 0;
  const fs = openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange,
    now: () => 123, storage: { persist: async () => { persists++; return true; } } });
  await fs.createWorkspace({ ws: 'work', name: 'Work' });
  return { fs, persists: () => persists };
};
const ctx = { actor: 'human', runId: 'run', callId: 'call' };
const counts = async fs => {
  const tx = (await fs.db).transaction(['blobs', 'versions', 'heads', 'ops']);
  return Promise.all(['blobs', 'versions', 'heads', 'ops'].map(s => result(tx.objectStore(s).count())));
};

test('workspace persistence is requested once and recorded', async () => {
  const { fs, persists } = await fixture();
  await fs.createWorkspace({ ws: 'other', name: 'Other' });
  assert.equal(persists(), 1);
  assert.deepEqual(await fs.listWorkspaces(), [
    { ws: 'other', name: 'Other', createdAt: 123 },
    { ws: 'work', name: 'Work', createdAt: 123, persisted: true }
  ]);
  assert.deepEqual(await fs.list({ ws: 'missing' }), { ok: false, error: 'no such workspace' });
});

test('invalid filesystem arguments are refused before writing', async () => {
  const { fs } = await fixture();
  const before = await counts(fs);
  const calls = [
    () => fs.write({ ws: 'work', path: 'a', content: 42, base: null }, ctx),
    () => fs.write({ ws: 'work', path: 'a', content: 'x', base: 'x' }, ctx),
    () => fs.edit({ ws: 'work', path: 'a', old: '', new: 'x', base: 1 }, ctx),
    () => fs.edit({ ws: 'work', path: 'a', old: 'x', new: 1, base: 1 }, ctx),
    () => fs.delete({ ws: 'work', path: 'a', base: null }, ctx),
    () => fs.move({ ws: 'work', from: 'a', to: 'b', base: 0 }, ctx),
    () => fs.write({ ws: 'work', path: 'a', content: 'x', base: null }, { actor: 'a', runId: 1 }),
    () => fs.revertRun({ ws: 'work', runId: 'r' }, { actor: 'a', callId: null }),
    () => fs.read({ ws: 'work', path: 'a', from: 0 }),
    () => fs.read({ ws: 'work', path: 'a', to: null }),
    () => fs.diff({ ws: 'work', path: 'a', from: 1, to: null }),
    () => fs.diff({ ws: 'work', path: 'a', from: 0 }),
    () => fs.list({ ws: 'work', depth: 21 })
  ];
  for (const call of calls) {
    const res = await call();
    assert.equal(res.error, 'invalid args');
    assert.equal(res.ok, false);
    assert.ok(res.problems.length);
  }
  assert.deepEqual(await counts(fs), before);
  fs.close();
});

test('CAS creation, stale conflicts and concurrent writers are atomic', async () => {
  const { fs } = await fixture();
  assert.deepEqual(await fs.write({ ws: 'work', path: '/a', content: 'one', base: null }, ctx), { ok: true, path: 'a', ver: 1 });
  assert.deepEqual(await fs.write({ ws: 'work', path: 'a', content: 'x', base: null }, ctx),
    { ok: false, error: 'conflict', path: 'a', base: null, current: 1, actor: 'human', diff: '+one' });
  await fs.write({ ws: 'work', path: 'a', content: 'two', base: 1 }, { actor: 'agent' });
  const before = await counts(fs);
  assert.deepEqual(await fs.write({ ws: 'work', path: 'a', content: 'three', base: 1 }, ctx),
    { ok: false, error: 'conflict', path: 'a', base: 1, current: 2, actor: 'agent', diff: '-one\n+two' });
  assert.deepEqual(await counts(fs), before);
  const pair = await Promise.all(['three', 'four'].map(content => fs.write({ ws: 'work', path: 'a', content, base: 2 }, ctx)));
  assert.equal(pair.filter(r => r.ok).length, 1);
  assert.equal(pair.filter(r => r.error === 'conflict').length, 1);
});

test('deduplication, reads, listing and exact edits', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'dir/a', content: 'é\nline\nline', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'dir/b', content: 'é\nline\nline', base: null }, ctx);
  assert.equal((await counts(fs))[0], 1);
  assert.deepEqual(await fs.read({ ws: 'work', path: 'dir/a', from: 2, to: 2 }), { path: 'dir/a', ver: 1, content: 'line', lines: 3 });
  assert.deepEqual(await fs.stat({ ws: 'work', path: 'dir/a' }), { path: 'dir/a', ver: 1, size: 12, actor: 'human', t: 123 });
  assert.equal((await fs.list({ ws: 'work' })).length, 0);
  assert.equal((await fs.list({ ws: 'work', path: 'dir' })).length, 2);
  assert.deepEqual(await fs.edit({ ws: 'work', path: 'dir/a', old: 'absent', new: '', base: 1 }, ctx), { ok: false, error: 'old not found' });
  assert.deepEqual(await fs.edit({ ws: 'work', path: 'dir/a', old: 'line', new: '', base: 1 }, ctx), { ok: false, error: 'old not unique', count: 2 });
  assert.equal((await fs.edit({ ws: 'work', path: 'dir/a', old: 'é', new: '$&', base: 1 }, ctx)).ver, 2);
  assert.equal((await fs.read({ ws: 'work', path: 'dir/a' })).content, '$&\nline\nline');
});

test('chains versions, diffs and filters history', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'a', content: 'one\ntwo', base: null }, ctx);
  await fs.edit({ ws: 'work', path: 'a', old: 'two', new: 'three', base: 1 }, ctx);
  await fs.write({ ws: 'work', path: 'a', content: 'one\nfour', base: 2 }, { actor: 'other' });
  assert.deepEqual((await fs.versions({ ws: 'work', path: 'a' })).map(v => [v.ver, v.parent]), [[3, 2], [2, 1], [1, null]]);
  assert.deepEqual(await fs.diff({ ws: 'work', path: 'a', from: 1, to: 3 }), { ok: true, diff: ' one\n-two\n+four' });
  assert.equal((await fs.diff({ ws: 'work', path: 'a', from: 99 })).error, 'not found');
  assert.equal((await fs.history({ ws: 'work', path: 'a', runId: 'run' })).length, 2);
  assert.equal((await fs.history({ ws: 'work', path: 'other' })).length, 0);
  await fs.delete({ ws: 'work', path: 'a', base: 3 }, ctx);
  assert.equal((await fs.versions({ ws: 'work', path: 'a' }))[0].ver, 3);
  fs.close();
});

test('revert restores pre-run content atomically and refuses later edits', async () => {
  const { fs } = await fixture(), human = { actor: 'human' }, run = { actor: 'agent', runId: 'r' };
  for (const path of ['edit', 'gone', 'source']) await fs.write({ ws: 'work', path, content: path, base: null }, human);
  const tree = async () => Promise.all((await fs.list({ ws: 'work' })).map(async ({ path }) => [path, (await fs.read({ ws: 'work', path })).content]));
  const before = await tree();
  await fs.write({ ws: 'work', path: 'new', content: 'new', base: null }, run);
  await fs.edit({ ws: 'work', path: 'edit', old: 'edit', new: 'changed', base: 1 }, run);
  await fs.delete({ ws: 'work', path: 'gone', base: 1 }, run);
  await fs.move({ ws: 'work', from: 'source', to: 'dest', base: 1 }, run);
  assert.equal((await fs.history({ ws: 'work', path: 'source', runId: 'r' })).length, 1);
  await fs.write({ ws: 'work', path: 'edit', content: 'human', base: 2 }, human);
  const changed = await tree(), countsBefore = await counts(fs);
  const conflict = await fs.revertRun({ ws: 'work', runId: 'r' }, human);
  assert.deepEqual(conflict.conflicts, [{ path: 'edit', expected: 2, current: 3, actor: 'human' }]);
  assert.equal(conflict.error, 'conflict');
  assert.deepEqual(await tree(), changed);
  assert.deepEqual(await counts(fs), countsBefore);
  // Recreate the scenario without the later edit.
  const other = await fixture(), f = other.fs;
  for (const [path, content] of before) await f.write({ ws: 'work', path, content, base: null }, human);
  await f.write({ ws: 'work', path: 'new', content: 'new', base: null }, run);
  await f.edit({ ws: 'work', path: 'edit', old: 'edit', new: 'changed', base: 1 }, run);
  await f.delete({ ws: 'work', path: 'gone', base: 1 }, run);
  await f.move({ ws: 'work', from: 'source', to: 'dest', base: 1 }, run);
  assert.equal((await f.revertRun({ ws: 'work', runId: 'r' }, human)).ok, true);
  const after = await Promise.all((await f.list({ ws: 'work' })).map(async ({ path }) => [path, (await f.read({ ws: 'work', path })).content]));
  assert.deepEqual(after, before);
  assert.deepEqual(await f.revertRun({ ws: 'work', runId: 'none' }, human), { ok: true, restored: [] });
  fs.close(); f.close();
});

test('change listeners and channel receive committed changes', async () => {
  const sent = [], channel = { postMessage: m => sent.push(m), close() { this.closed = true; } };
  const fs = openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange, channel });
  await fs.createWorkspace({ ws: 'work', name: 'Work' });
  const events = [], off = fs.onChange(e => events.push(e));
  await fs.write({ ws: 'work', path: 'a', content: 'x', base: null }, ctx);
  await fs.move({ ws: 'work', from: 'a', to: 'b', base: 1 }, ctx);
  assert.deepEqual(sent, [{ ws: 'work', path: 'a', ver: 1, actor: 'human' },
    { ws: 'work', path: 'a', ver: null, actor: 'human' }, { ws: 'work', path: 'b', ver: 1, actor: 'human' }]);
  channel.onmessage({ data: { ws: 'other', path: 'c', ver: 2, actor: 'agent' } });
  assert.deepEqual(events, [...sent, { ws: 'other', path: 'c', ver: 2, actor: 'agent' }]);
  off(); await fs.delete({ ws: 'work', path: 'b', base: 1 }, ctx);
  assert.equal(events.length, 4);
  fs.close(); assert.equal(channel.closed, true);
});

test('workspace export and import round-trip, remap and validate blobs', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'a', content: 'first', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'a', content: 'second', base: 1 }, ctx);
  await fs.write({ ws: 'work', path: 'b', content: 'b', base: null }, ctx);
  await fs.delete({ ws: 'work', path: 'b', base: 1 }, ctx);
  const record = await fs.exportWorkspace({ ws: 'work' });
  assert.equal((await fs.exportBundle({ ws: 'work' })).schema, 'airis.bundle/1');
  assert.equal((await fs.listWorkspaces())[0].lastExportedAt, record.exportedAt);
  const dest = openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange, channel: null });
  const events = []; dest.onChange(e => events.push(e));
  assert.deepEqual(await dest.importWorkspace(record), { ok: true, ws: 'work' });
  assert.deepEqual(await dest.list({ ws: 'work' }), await fs.list({ ws: 'work' }));
  assert.deepEqual(await dest.read({ ws: 'work', path: 'a' }), await fs.read({ ws: 'work', path: 'a' }));
  assert.deepEqual(await dest.versions({ ws: 'work', path: 'a' }), await fs.versions({ ws: 'work', path: 'a' }));
  assert.deepEqual(await dest.history({ ws: 'work' }), await fs.history({ ws: 'work' }));
  assert.deepEqual(events, [{ ws: 'work', path: 'a', ver: 2, actor: 'human' }]);
  assert.equal((await dest.importWorkspace(record)).error, 'workspace exists');
  assert.equal((await dest.importWorkspace(record, { as: 'copy' })).ok, true);
  assert.equal((await dest.read({ ws: 'copy', path: 'a' })).content, 'second');
  const bad = structuredClone(record), sha = Object.keys(bad.blobs)[0]; bad.blobs[sha] = 'tampered';
  assert.deepEqual(await dest.importWorkspace(bad, { as: 'bad' }), { ok: false, error: 'blob hash mismatch', sha });
  const missing = structuredClone(record); delete missing.blobs[sha];
  assert.deepEqual(await dest.importWorkspace(missing, { as: 'missing' }), { ok: false, error: 'blob hash mismatch', sha });
  const racing = await Promise.all([dest.importWorkspace(record, { as: 'race' }), dest.importWorkspace(record, { as: 'race' })]);
  assert.equal(racing.filter(r => r.ok).length, 1);
  assert.equal(racing.filter(r => r.error === 'workspace exists').length, 1);
  assert.equal((await dest.list({ ws: 'bad' })).error, 'no such workspace');
  fs.close(); dest.close();
});

test('delete retains history and move changes both heads atomically', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'a', content: 'a', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'b', content: 'b', base: null }, ctx);
  assert.deepEqual(await fs.move({ ws: 'work', from: 'a', to: 'b', base: 1 }, ctx),
    { ok: false, error: 'conflict', path: 'b', base: null, current: 1, actor: 'human', diff: '+b' });
  assert.equal((await fs.delete({ ws: 'work', path: 'b', base: 1 }, ctx)).ver, 1);
  assert.equal((await fs.write({ ws: 'work', path: 'b', content: 'c', base: 1 }, ctx)).error, 'conflict');
  assert.equal((await fs.write({ ws: 'work', path: 'b', content: 'c', base: null }, ctx)).ver, 2);
  await fs.delete({ ws: 'work', path: 'b', base: 2 }, ctx);
  assert.deepEqual(await fs.move({ ws: 'work', from: 'a', to: 'b', base: 1 }, ctx), { ok: true, path: 'b', ver: 3 });
  assert.equal((await fs.read({ ws: 'work', path: 'a' })).error, 'not found');
  assert.equal((await fs.read({ ws: 'work', path: 'b' })).content, 'a');
  const tx = (await fs.db).transaction(['versions', 'ops']);
  const versions = await result(tx.objectStore('versions').getAll());
  const ops = await result(tx.objectStore('ops').getAll());
  assert.equal(versions.length, 4);
  assert.equal(ops.at(-1).kind, 'move');
  assert.equal(ops.at(-1).from, 'a');
  assert.equal(ops.at(-1).to, 'b');
});
