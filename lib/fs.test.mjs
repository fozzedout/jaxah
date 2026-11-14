import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as fsModule from './fs.js';
import { openFs, workspaceId, filePath, crc32, zipStream, readZip } from './fs.js';
import { fakeIndexedDB, FakeKeyRange } from '../scripts/fake-idb.mjs';

test('zip export chunks own their buffers and preserve archive bytes', async () => {
  const cap = fsModule.ZIP_CHUNK_BYTES ?? 1024 * 1024;
  const big = new Uint8Array(randomBytes(2 * cap + cap / 2));
  const small = new TextEncoder().encode('small member');
  const members = [big, small].map((bytes, i) => ({ name: i ? 'small' : 'big', method: 0,
    crc: crc32(bytes), usize: bytes.byteLength, data: new Blob([bytes]) }));
  const source = async function* () { yield* members; };
  const date = new Date(2024, 0, 1);
  const reader = zipStream(source(), { date }).getReader(), chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  for (const chunk of chunks) {
    assert.ok(chunk instanceof Uint8Array);
    assert.ok(chunk.byteLength <= cap, `chunk of ${chunk.byteLength} exceeds ${cap}`);
    assert.equal(chunk.byteOffset, 0);
    assert.equal(chunk.buffer.byteLength, chunk.byteLength);
  }
  assert.equal(fsModule.ZIP_CHUNK_BYTES, 1024 * 1024);
  const bigChunks = Math.ceil(big.byteLength / cap);
  assert.equal(chunks.length, 1 + bigChunks + 1 + 1 + 2 + 1);
  assert.deepEqual(chunks[1 + bigChunks + 1], small);
  const archive = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const independentlyRead = new Uint8Array(await new Response(zipStream(source(), { date })).arrayBuffer());
  assert.deepEqual(archive, independentlyRead);
  const zip = await readZip(new Blob([archive]));
  assert.deepEqual(new Uint8Array(await (await zip.read('big')).arrayBuffer()), big);
});

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

const inline = async zipBlob => {
  const zip = await readZip(zipBlob), record = JSON.parse(await (await zip.read('manifest.json')).text());
  const blobs = {};
  for (const sha of Object.keys(record.blobs)) blobs[sha] = await (await zip.read('blobs/' + sha)).text();
  return { ...record, blobs };
};

test('workspace export and import round-trip, remap and validate blobs', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'a', content: 'first', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'a', content: 'second', base: 1 }, ctx);
  await fs.write({ ws: 'work', path: 'b', content: 'b', base: null }, ctx);
  await fs.delete({ ws: 'work', path: 'b', base: 1 }, ctx);
  const exported = await fs.exportWorkspace({ ws: 'work' }), record = await new Response(exported.stream).blob();
  assert.equal((await fs.exportBundle({ ws: 'work' })).schema, 'airis.bundle/1');
  assert.equal((await fs.listWorkspaces())[0].lastExportedAt, exported.exportedAt);
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
  const bad = await inline(record), sha = Object.keys(bad.blobs)[0]; bad.blobs[sha] = 'tampered';
  assert.deepEqual(await dest.importWorkspace(bad, { as: 'bad' }), { ok: false, error: 'blob hash mismatch', sha });
  const missing = await inline(record); delete missing.blobs[sha];
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

test('binary bytes and typed Blobs round-trip with metadata', async () => {
  const { fs } = await fixture();
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  await fs.write({ ws: 'work', path: 'bytes', content: bytes, base: null }, ctx);
  await fs.write({ ws: 'work', path: 'png', content: new Blob([bytes], { type: 'image/png' }), base: null }, ctx);
  for (const path of ['bytes', 'png']) {
    const read = await fs.read({ ws: 'work', path });
    assert.deepEqual(Object.keys(read), ['path', 'ver', 'blob']);
    assert.ok(read.blob instanceof Blob);
    assert.deepEqual(new Uint8Array(await read.blob.arrayBuffer()), bytes);
  }
  assert.equal((await fs.read({ ws: 'work', path: 'png' })).blob.type, 'image/png');
  const stat = await fs.stat({ ws: 'work', path: 'bytes' });
  assert.equal(stat.size, 256); assert.equal(stat.binary, true);
  assert.equal((await fs.list({ ws: 'work' })).find(x => x.path === 'bytes').size, 256);
  assert.deepEqual(await fs.read({ ws: 'work', path: 'bytes', from: 1 }), { ok: false, error: 'binary file', path: 'bytes' });
  assert.deepEqual(await fs.edit({ ws: 'work', path: 'bytes', old: 'a', new: 'b', base: 1 }, ctx),
    { ok: false, error: 'binary file', path: 'bytes' });
  assert.equal((await fs.exportWorkspace({ ws: 'work' })).ok, true);
  fs.close();
});

test('text and binary logical bytes share the same content key', async () => {
  const { fs } = await fixture();
  await fs.write({ ws: 'work', path: 'a', content: 'hello é', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'b', content: new Blob([new TextEncoder().encode('hello é')]), base: null }, ctx);
  assert.equal((await counts(fs))[0], 1);
  assert.equal((await fs.versions({ ws: 'work', path: 'a' }))[0].blob, (await fs.versions({ ws: 'work', path: 'b' }))[0].blob);
  fs.close();
});

test('move and revert preserve binary metadata and bytes', async () => {
  const { fs } = await fixture(), bytes = Uint8Array.of(0, 128, 255);
  await fs.write({ ws: 'work', path: 'a', content: bytes, type: 'image/png', base: null }, { actor: 'human' });
  await fs.move({ ws: 'work', from: 'a', to: 'b', base: 1 }, { actor: 'agent', runId: 'r' });
  let blob = (await fs.read({ ws: 'work', path: 'b' })).blob;
  assert.equal(blob.type, 'image/png'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal((await fs.revertRun({ ws: 'work', runId: 'r' }, { actor: 'human' })).ok, true);
  blob = (await fs.read({ ws: 'work', path: 'a' })).blob;
  assert.equal(blob.type, 'image/png'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  fs.close();
});

test('binary diffs, views and unknown codecs', async () => {
  const { fs } = await fixture();
  const view = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
  await fs.write({ ws: 'work', path: 'a', content: 'text', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'a', content: view, type: 'image/png', base: 1 }, ctx);
  assert.deepEqual(new Uint8Array(await (await fs.read({ ws: 'work', path: 'a' })).blob.arrayBuffer()), Uint8Array.of(1, 2));
  assert.equal((await fs.diff({ ws: 'work', path: 'a', from: 1 })).diff, '-text\n+[binary 2 bytes image/png]');
  assert.equal((await fs.write({ ws: 'work', path: 'a', content: 'stale', base: 1 }, ctx)).diff,
    '-text\n+[binary 2 bytes image/png]');
  const version = (await fs.versions({ ws: 'work', path: 'a' }))[0];
  const tx = (await fs.db).transaction('blobs', 'readwrite'), finished = done(tx);
  tx.objectStore('blobs').put(new Blob([Uint8Array.of(7)]), version.blob);
  await finished;
  await assert.rejects(fs.read({ ws: 'work', path: 'a' }), /unknown codec 7/);
  fs.close();
});

test('legacy string blobs read as text and use UTF-8 size', async () => {
  const { fs } = await fixture();
  const tx = (await fs.db).transaction(['blobs', 'versions', 'heads'], 'readwrite'), finished = done(tx);
  tx.objectStore('blobs').put('héllo', 'legacy');
  tx.objectStore('versions').put({ blob: 'legacy', actor: 'human', t: 123, parent: null }, ['work', 'a', 1]);
  tx.objectStore('heads').put(1, ['work', 'a']);
  await finished;
  assert.deepEqual(await fs.read({ ws: 'work', path: 'a' }), { path: 'a', ver: 1, content: 'héllo', lines: 1 });
  assert.equal((await fs.stat({ ws: 'work', path: 'a' })).size, 6);
  assert.equal((await fs.list({ ws: 'work' }))[0].size, 6);
  fs.close();
});

const storedFor = async (fs, path) => {
  const version = (await fs.versions({ ws: 'work', path }))[0];
  const tx = (await fs.db).transaction('blobs');
  return result(tx.objectStore('blobs').get(version.blob));
};

test('compressible text is stored compressed and reads back exactly', async () => {
  const { fs } = await fixture(), text = 'line of source code\n'.repeat(200);
  await fs.write({ ws: 'work', path: 'text', content: text, base: null }, ctx);
  const stored = await storedFor(fs, 'text');
  assert.equal(new Uint8Array(await stored.slice(0, 1).arrayBuffer())[0], 1);
  assert.ok(stored.size < new TextEncoder().encode(text).length / 2);
  assert.equal((await fs.stat({ ws: 'work', path: 'text' })).size, new TextEncoder().encode(text).length);
  assert.equal((await fs.read({ ws: 'work', path: 'text' })).content, text);
  fs.close();
});

test('short text and incompressible text remain raw', async () => {
  const { fs } = await fixture();
  let seed = 123456789;
  const random = Array.from({ length: 256 }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return String.fromCharCode(32 + (seed >>> 0) % 95);
  }).join('');
  for (const [path, content] of [['short', 'a'.repeat(255)], ['random', random]]) {
    await fs.write({ ws: 'work', path, content, base: null }, ctx);
    assert.equal(new Uint8Array(await (await storedFor(fs, path)).slice(0, 1).arrayBuffer())[0], 0);
    assert.equal((await fs.read({ ws: 'work', path })).content, content);
  }
  fs.close();
});

test('compressible PNG-like binary remains raw', async () => {
  const { fs } = await fixture(), bytes = new Uint8Array(4096);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  await fs.write({ ws: 'work', path: 'png', content: new Blob([bytes], { type: 'image/png' }), base: null }, ctx);
  assert.equal(new Uint8Array(await (await storedFor(fs, 'png')).slice(0, 1).arrayBuffer())[0], 0);
  assert.deepEqual(new Uint8Array(await (await fs.read({ ws: 'work', path: 'png' })).blob.arrayBuffer()), bytes);
  fs.close();
});

test('text and binary share logical key regardless of first codec', async () => {
  const text = 'line of source code\n'.repeat(200), bytes = new TextEncoder().encode(text);
  for (const first of ['text', 'binary']) {
    const { fs } = await fixture();
    for (const path of [first, first === 'text' ? 'binary' : 'text'])
      await fs.write({ ws: 'work', path, content: path === 'text' ? text : new Blob([bytes]), base: null }, ctx);
    assert.equal((await counts(fs))[0], 1);
    assert.equal((await fs.versions({ ws: 'work', path: 'text' }))[0].blob,
      (await fs.versions({ ws: 'work', path: 'binary' }))[0].blob);
    assert.equal(new Uint8Array(await (await storedFor(fs, 'text')).slice(0, 1).arrayBuffer())[0], first === 'text' ? 1 : 0);
    assert.equal((await fs.read({ ws: 'work', path: 'text' })).content, text);
    assert.deepEqual(new Uint8Array(await (await fs.read({ ws: 'work', path: 'binary' })).blob.arrayBuffer()), bytes);
    fs.close();
  }
});

test('unknown codec in directly inserted record is rejected', async () => {
  const { fs } = await fixture();
  const tx = (await fs.db).transaction(['blobs', 'versions', 'heads'], 'readwrite'), finished = done(tx);
  tx.objectStore('blobs').put(new Blob([Uint8Array.of(7, 42)]), 'unknown');
  tx.objectStore('versions').put({ blob: 'unknown', size: 1, actor: 'human', t: 123, parent: null }, ['work', 'bad', 1]);
  tx.objectStore('heads').put(1, ['work', 'bad']);
  await finished;
  await assert.rejects(fs.read({ ws: 'work', path: 'bad' }), /unknown codec 7/);
  fs.close();
});

test('crc32 IEEE known vector and incremental updates', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
  assert.equal(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4))), 0xcbf43926);
});

test('zip stream and random access reader round-trip and detect corruption', async () => {
  const text = new TextEncoder().encode('hello zip'), compressedText = new TextEncoder().encode('compress me '.repeat(100));
  const binary = new Uint8Array(300 * 1024);
  for (let i = 0; i < binary.length; i += 65536) crypto.getRandomValues(binary.subarray(i, i + 65536));
  const compressed = await new Response(new Blob([compressedText]).stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();
  const values = [['text', text, 0, new Blob([text])], ['deflated', compressedText, 8, compressed], ['binary', binary, 0, new Blob([binary])]];
  async function* members() { for (const [name, bytes, method, data] of values) yield { name, method, data, crc: crc32(bytes), usize: bytes.length }; }
  const archive = await new Response(zipStream(members(), { date: new Date(2020, 0, 1) })).blob();
  const zip = await readZip(archive);
  assert.deepEqual(zip.names, values.map(v => v[0]));
  for (const [name, bytes] of values) assert.deepEqual(new Uint8Array(await (await zip.read(name)).arrayBuffer()), bytes);
  const changed = new Uint8Array(await archive.arrayBuffer()); changed[zip.entry('text').dataStart] ^= 1;
  await assert.rejects((await readZip(new Blob([changed]))).read('text'), /crc mismatch/);
});

test('workspace bundle streams zip members and records export time', async () => {
  const { fs } = await fixture(), encoder = new TextEncoder();
  const binary = new Uint8Array(200 * 1024);
  for (let i = 0; i < binary.length; i += 65536) crypto.getRandomValues(binary.subarray(i, i + 65536));
  const contents = { text: encoder.encode('source code\n'.repeat(400)), small: encoder.encode('small'), binary };
  await fs.write({ ws: 'work', path: 'text', content: 'source code\n'.repeat(400), base: null }, ctx);
  await fs.write({ ws: 'work', path: 'small', content: 'small', base: null }, ctx);
  await fs.write({ ws: 'work', path: 'binary', content: new Blob([binary]), base: null }, ctx);
  const largest = Math.max(...await Promise.all(Object.keys(contents).map(async path => (await storedFor(fs, path)).size)));
  const exported = await fs.exportBundle({ ws: 'work' });
  assert.equal(exported.schema, 'airis.bundle/1'); assert.match(exported.filename, /\.zip$/);
  assert.equal((await fs.listWorkspaces())[0].lastExportedAt, exported.exportedAt);
  const reader = exported.stream.getReader(), chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; assert.ok(value.length <= largest + 4096); chunks.push(value); }
  const zip = await readZip(new Blob(chunks)), manifest = JSON.parse(await (await zip.read('manifest.json')).text());
  assert.equal(manifest.schema, 'airis.bundle/1'); assert.equal(manifest.records[0].schema, 'airis.workspace/1');
  for (const [path, , version] of manifest.records[0].versions) {
    const name = 'blobs/' + version.blob;
    assert.ok(zip.names.includes(name));
    if (path === 'text') assert.equal(zip.entry(name).method, 8);
    if (path === 'binary') assert.equal(zip.entry(name).method, 0);
    const bytes = new Uint8Array(await (await zip.read(name)).arrayBuffer());
    assert.deepEqual(bytes, contents[path]);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(sha, version.blob);
  }
  fs.close();
});

const shellSource = readFileSync(new URL('../shell.js', import.meta.url), 'utf8');
const shellFunction = name => {
  const start = shellSource.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing shell function ' + name);
  const open = shellSource.indexOf('{', start);
  assert.notEqual(open, -1, 'missing function body for ' + name);
  let depth = 0;
  for (let i = open; i < shellSource.length; i++) {
    if (shellSource[i] === '{') depth++;
    if (shellSource[i] === '}' && --depth === 0) return shellSource.slice(start, i + 1);
  }
  assert.fail('unbalanced shell function ' + name);
};
const shellExportSource = shellFunction('reply') + '\n' + shellFunction('fsExportStream');
const shellExport = (fs, streams, frameGen) => new Function('streams', 'frameGen', 'fsRequire', 'fsLib',
  shellExportSource + '\nreturn { reply, fsExportStream };')(streams, frameGen,
  ws => { if (ws !== 'work') throw new Error('workspace not granted: ' + ws); }, () => Promise.resolve(fs)).fsExportStream;
const exportWindow = () => ({
  posted: [],
  postMessage(msg, origin) { this.posted.push(structuredClone(msg)); }
});

test('shell export crosses a postMessage boundary as cloned chunks', async () => {
  const { fs } = await fixture(), streams = {}, frameGen = { app: 0 }, win = exportWindow();
  try {
    const encoder = new TextEncoder(), binary = new Uint8Array(200 * 1024);
    for (let i = 0; i < binary.length; i += 65536) crypto.getRandomValues(binary.subarray(i, i + 65536));
    const contents = { text: encoder.encode('source code\n'.repeat(400)), small: encoder.encode('small'), binary };
    await fs.write({ ws: 'work', path: 'text', content: 'source code\n'.repeat(400), base: null }, ctx);
    await fs.write({ ws: 'work', path: 'small', content: 'small', base: null }, ctx);
    await fs.write({ ws: 'work', path: 'binary', content: new Blob([binary]), base: null }, ctx);
    const exported = await shellExport(fs, streams, frameGen)('app', win, 7, { ws: 'work' });
    assert.deepEqual(Object.keys(exported).sort(), ['exportedAt', 'filename', 'ok', 'type']);
    assert.deepEqual(exported, { ok: true, filename: exported.filename, type: 'application/zip', exportedAt: exported.exportedAt });
    assert.match(exported.filename, /\.zip$/);
    assert.equal(exported.exportedAt, (await fs.listWorkspaces())[0].lastExportedAt);
    assert.ok(win.posted.length > 1);
    for (const msg of win.posted) {
      assert.equal(msg.re, 7); assert.equal(msg.airis, 1);
      assert.ok(msg.chunk instanceof Uint8Array);
    }
    const zip = await readZip(new Blob(win.posted.map(msg => msg.chunk)));
    const manifest = JSON.parse(await (await zip.read('manifest.json')).text());
    assert.equal(manifest.schema, 'airis.bundle/1'); assert.equal(manifest.records[0].schema, 'airis.workspace/1');
    assert.equal(manifest.records[0].versions.length, Object.keys(contents).length);
    for (const [path, , version] of manifest.records[0].versions) {
      const name = 'blobs/' + version.blob;
      assert.ok(zip.names.includes(name));
      const bytes = new Uint8Array(await (await zip.read(name)).arrayBuffer());
      assert.deepEqual(bytes, contents[path]);
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      assert.equal(sha, version.blob);
    }
    assert.equal(Object.hasOwn(streams, 'app:7'), false);
  } finally { fs.close(); }
});

test('shell export refuses an ungranted workspace synchronously', async () => {
  const { fs } = await fixture(), streams = {}, frameGen = { app: 0 }, win = exportWindow();
  try {
    const fsExportStream = shellExport(fs, streams, frameGen);
    assert.throws(() => fsExportStream('app', win, 8, { ws: 'other' }), /workspace not granted/);
    assert.deepEqual(win.posted, []);
    assert.equal(Object.hasOwn(streams, 'app:8'), false);
  } finally { fs.close(); }
});

test('shell export can be aborted through its registered stream', async () => {
  const { fs } = await fixture(), streams = {}, frameGen = { app: 0 }, win = exportWindow();
  try {
    await fs.write({ ws: 'work', path: 'text', content: 'source code\n'.repeat(400), base: null }, ctx);
    let wasFs;
    win.postMessage = function (msg, origin) {
      this.posted.push(structuredClone(msg));
      if (this.posted.length === 2) { wasFs = streams['app:9'].fs; streams['app:9'].abort(); }
    };
    await assert.rejects(shellExport(fs, streams, frameGen)('app', win, 9, { ws: 'work' }), /aborted/);
    assert.equal(wasFs, true);
    assert.equal(win.posted.length, 2);
    assert.equal(Object.hasOwn(streams, 'app:9'), false);
  } finally { fs.close(); }
});

test('shell export aborts on frame reload', async () => {
  const { fs } = await fixture(), streams = {}, frameGen = { app: 0 }, win = exportWindow();
  try {
    await fs.write({ ws: 'work', path: 'text', content: 'source code\n'.repeat(400), base: null }, ctx);
    win.postMessage = function (msg, origin) {
      this.posted.push(structuredClone(msg));
      if (this.posted.length === 2) frameGen.app = 1;
    };
    await assert.rejects(shellExport(fs, streams, frameGen)('app', win, 10, { ws: 'work' }), /aborted/);
    assert.equal(win.posted.length, 2);
    assert.equal(Object.hasOwn(streams, 'app:10'), false);
  } finally { fs.close(); }
});

const freshFs = () => openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange, channel: null });
const rezip = async (blob, changeManifest, corrupt = false, reencode = null) => {
  const zip = await readZip(blob), manifest = JSON.parse(await (await zip.read('manifest.json')).text());
  changeManifest(manifest);
  async function* members() {
    for (const name of zip.names) {
      const e = zip.entry(name);
      let data = zip.raw(name), crc = e.crc, usize = e.usize, method = e.method;
      if (name === 'manifest.json') {
        data = new Blob([JSON.stringify(manifest)]); usize = data.size;
        crc = crc32(new Uint8Array(await data.arrayBuffer()));
      } else if (corrupt) {
        const bytes = new Uint8Array(await data.arrayBuffer()); bytes[0] ^= 1; data = new Blob([bytes]);
      } else if (reencode) {
        ({ data, method } = await reencode(name, zip, e));
      }
      yield { name, method, crc, usize, data };
    }
  }
  return new Response(zipStream(members())).blob();
};

test('zip import preserves bytes, metadata, history and codec tags', async () => {
  const { fs } = await fixture(), dest = freshFs(), binary = new Uint8Array(200 * 1024);
  for (let i = 0; i < binary.length; i += 65536) crypto.getRandomValues(binary.subarray(i, i + 65536));
  for (const [path, content] of [['text', 'compress me\n'.repeat(1000)], ['small', 'small'],
    ['binary', new Blob([binary], { type: 'image/png' })], ['deleted', 'gone'], ['moved', 'move']])
    await fs.write({ ws: 'work', path, content, base: null }, ctx);
  await fs.write({ ws: 'work', path: 'small', content: 'small again', base: 1 }, ctx);
  await fs.delete({ ws: 'work', path: 'deleted', base: 1 }, ctx);
  await fs.move({ ws: 'work', from: 'moved', to: 'destination', base: 1 }, ctx);
  const archive = await new Response((await fs.exportWorkspace({ ws: 'work' })).stream).blob();
  assert.deepEqual(await dest.importWorkspace(archive), { ok: true, ws: 'work' });
  assert.deepEqual(await dest.list({ ws: 'work' }), await fs.list({ ws: 'work' }));
  assert.deepEqual(await dest.history({ ws: 'work' }), await fs.history({ ws: 'work' }));
  for (const path of ['text', 'small', 'binary', 'deleted', 'moved', 'destination']) {
    assert.deepEqual(await dest.versions({ ws: 'work', path }), await fs.versions({ ws: 'work', path }));
    assert.deepEqual(await dest.stat({ ws: 'work', path }), await fs.stat({ ws: 'work', path }));
  }
  for (const path of ['text', 'small', 'destination']) assert.deepEqual(await dest.read({ ws: 'work', path }), await fs.read({ ws: 'work', path }));
  const read = await dest.read({ ws: 'work', path: 'binary' });
  assert.equal(read.blob.type, 'image/png'); assert.deepEqual(new Uint8Array(await read.blob.arrayBuffer()), binary);
  assert.equal(new Uint8Array(await (await storedFor(dest, 'text')).slice(0, 1).arrayBuffer())[0], 1);
  assert.equal(new Uint8Array(await (await storedFor(dest, 'binary')).slice(0, 1).arrayBuffer())[0], 0);
  fs.close(); dest.close();
});

test('zip import uses member methods when re-encoded independently of manifest codecs', async () => {
  const { fs } = await fixture(), dest = freshFs();
  const binary = new Uint8Array(4096), text = 'compress me\n'.repeat(1000);
  binary.set([137, 80, 78, 71, 13, 10, 26, 10]);
  await fs.write({ ws: 'work', path: 'binary', content: new Blob([binary]), base: null }, ctx);
  await fs.write({ ws: 'work', path: 'text', content: text, base: null }, ctx);
  const binarySha = (await fs.versions({ ws: 'work', path: 'binary' }))[0].blob;
  const textSha = (await fs.versions({ ws: 'work', path: 'text' }))[0].blob;
  const archive = await new Response((await fs.exportWorkspace({ ws: 'work' })).stream).blob();
  const rebuilt = await rezip(archive, manifest => {
    assert.equal(manifest.blobs[binarySha].codec, 0);
    assert.equal(manifest.blobs[textSha].codec, 1);
  }, false, async (name, zip, entry) => {
    if (name === 'blobs/' + binarySha) {
      assert.equal(entry.method, 0);
      return { method: 8, data: await new Response((await zip.read(name)).stream().pipeThrough(new CompressionStream('deflate-raw'))).blob() };
    }
    if (name === 'blobs/' + textSha) {
      assert.equal(entry.method, 8);
      return { method: 0, data: await zip.read(name) };
    }
    return { method: entry.method, data: zip.raw(name) };
  });
  assert.deepEqual(await dest.importWorkspace(rebuilt), { ok: true, ws: 'work' });
  assert.deepEqual(new Uint8Array(await (await dest.read({ ws: 'work', path: 'binary' })).blob.arrayBuffer()), binary);
  assert.deepEqual(new TextEncoder().encode((await dest.read({ ws: 'work', path: 'text' })).content), new TextEncoder().encode(text));
  assert.equal(new Uint8Array(await (await storedFor(dest, 'binary')).slice(0, 1).arrayBuffer())[0], 1);
  assert.equal(new Uint8Array(await (await storedFor(dest, 'text')).slice(0, 1).arrayBuffer())[0], 0);
  fs.close(); dest.close();
});

test('zip import accepts stream, export object, and byte array', async () => {
  const { fs } = await fixture(), dest = freshFs();
  await fs.write({ ws: 'work', path: 'a', content: 'hello', base: null }, ctx);
  assert.equal((await dest.importWorkspace((await fs.exportWorkspace({ ws: 'work' })).stream)).ok, true);
  assert.equal((await dest.importWorkspace(await fs.exportWorkspace({ ws: 'work' }), { as: 'object' })).ok, true);
  const blob = await new Response((await fs.exportWorkspace({ ws: 'work' })).stream).blob();
  assert.equal((await dest.importWorkspace(new Uint8Array(await blob.arrayBuffer()), { as: 'bytes' })).ok, true);
  assert.equal((await dest.importWorkspace(await blob.arrayBuffer(), { as: 'buffer' })).ok, true);
  fs.close(); dest.close();
});

test('legacy inline workspace and JSON bundle import', async () => {
  const dest = freshFs(), sha = 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4';
  const record = { schema: 'airis.workspace/1', ws: 'old', name: 'Old', exportedAt: '2020-01-01T00:00:00.000Z',
    blobs: { [sha]: 'old' }, heads: [['a', 1]], versions: [['a', 1, { blob: sha, actor: 'human', t: 1, parent: null }]],
    ops: [[1, { kind: 'write', path: 'a', ver: 1, actor: 'human', t: 1 }]] };
  assert.equal((await dest.importWorkspace(record)).ok, true);
  const bundle = new Blob([JSON.stringify({ schema: 'airis.bundle/1', records: [record] })]);
  assert.equal((await dest.importWorkspace(bundle, { as: 'copy' })).ok, true);
  for (const ws of ['old', 'copy']) assert.equal((await dest.read({ ws, path: 'a' })).content, 'old');
  assert.equal((await dest.importWorkspace(new Blob([JSON.stringify({ schema: 'airis.bundle/1', records: [record, record] })]))).error, 'invalid workspace record');
  dest.close();
});

test('zip import refuses unknown codecs', async () => {
  const { fs } = await fixture(), dest = freshFs();
  await fs.write({ ws: 'work', path: 'a', content: 'small', base: null }, ctx);
  const blob = await new Response((await fs.exportWorkspace({ ws: 'work' })).stream).blob();
  let sha;
  const bad = await rezip(blob, manifest => { sha = Object.keys(manifest.blobs)[0]; manifest.blobs[sha].codec = 5; });
  assert.deepEqual(await dest.importWorkspace(bad), { ok: false, error: 'unknown codec', sha, codec: 5 });
  assert.equal((await dest.list({ ws: 'work' })).error, 'no such workspace');
  fs.close(); dest.close();
});

test('zip import refuses corrupt members but checks existing workspace first', async () => {
  const { fs } = await fixture(), dest = freshFs();
  await fs.write({ ws: 'work', path: 'a', content: 'small', base: null }, ctx);
  const blob = await new Response((await fs.exportWorkspace({ ws: 'work' })).stream).blob();
  let sha; const bad = await rezip(blob, manifest => { sha = Object.keys(manifest.blobs)[0]; }, true);
  assert.deepEqual(await dest.importWorkspace(bad), { ok: false, error: 'blob hash mismatch', sha });
  await dest.createWorkspace({ ws: 'work', name: 'existing' });
  assert.deepEqual(await dest.importWorkspace(bad), { ok: false, error: 'workspace exists' });
  fs.close(); dest.close();
});

test('codecOf reports tags and legacy strings', async () => {
  const { codecOf, COMPRESS_MIN_BYTES, COMPRESS_MAX_RATIO } = await import('./fs.js');
  assert.equal(COMPRESS_MIN_BYTES, 256);
  assert.equal(COMPRESS_MAX_RATIO, 0.9);
  assert.equal(await codecOf('legacy'), 0);
  assert.equal(await codecOf(new Blob([Uint8Array.of(1, 42)])), 1);
});

test('nameless workspace round-trips through zip export and import', async () => {
  const fs = openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange, now: () => 123 });
  const dest = openFs({ indexedDB: fakeIndexedDB(), IDBKeyRange: FakeKeyRange, now: () => 123 });
  const bytes = Uint8Array.of(0, 1, 2, 255), actor = { actor: 'human' };
  await fs.createWorkspace({ ws: 'work' });
  await fs.write({ ws: 'work', path: 'notes.txt', content: 'hi', base: null }, actor);
  await fs.write({ ws: 'work', path: 'img.bin', content: bytes, base: null }, actor);
  const exported = await fs.exportWorkspace({ ws: 'work' });
  const archive = await new Response(exported.stream).blob();
  const zip = await readZip(archive), manifest = JSON.parse(await (await zip.read('manifest.json')).text());
  assert.equal(Object.hasOwn(manifest, 'name'), false);
  assert.deepEqual(await dest.importWorkspace(archive, { as: 'restored' }), { ok: true, ws: 'restored' });
  assert.equal((await dest.read({ ws: 'restored', path: 'notes.txt' })).content, 'hi');
  assert.deepEqual(new Uint8Array(await (await dest.read({ ws: 'restored', path: 'img.bin' })).blob.arrayBuffer()), bytes);
  for (const path of ['notes.txt', 'img.bin']) {
    assert.deepEqual(await dest.stat({ ws: 'restored', path }), await fs.stat({ ws: 'work', path }));
    assert.equal((await dest.versions({ ws: 'restored', path })).length, (await fs.versions({ ws: 'work', path })).length);
  }
  assert.equal((await dest.history({ ws: 'restored' })).length, (await fs.history({ ws: 'work' })).length);
  const workspaces = await dest.listWorkspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].ws, 'restored');
  assert.equal(workspaces[0].name, undefined);
  const bad = await rezip(archive, record => { record.name = 5; });
  assert.deepEqual(await dest.importWorkspace(bad, { as: 'badname' }), { ok: false, error: 'invalid workspace record' });
  fs.close(); dest.close();
});
