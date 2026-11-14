// Shell-owned, content-addressed IndexedDB filesystem.
import { normPath, lineDiff } from './airis-actions.js';

export const workspaceId = ws => typeof ws === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(ws);
export const filePath = path => {
  const normalized = normPath(path);
  if (!normalized) throw new Error('invalid path');
  return normalized;
};

export const COMPRESS_MIN_BYTES = 256;
export const COMPRESS_MAX_RATIO = 0.9;
const CODECS = { raw: 0, deflateRaw: 1 };
export const codecOf = async stored => typeof stored === 'string' ? CODECS.raw :
  new Uint8Array(await stored.slice(0, 1).arrayBuffer())[0];
const isContent = c => typeof c === 'string' || c instanceof Blob || c instanceof ArrayBuffer || ArrayBuffer.isView(c);
async function prepare(content, type) {
  const binary = typeof content !== 'string';
  let bytes;
  if (!binary) bytes = new TextEncoder().encode(content);
  else if (content instanceof Blob) bytes = new Uint8Array(await content.arrayBuffer());
  else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content.slice(0));
  else bytes = new Uint8Array(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  type = binary ? (type || (content instanceof Blob && content.type) || undefined) : undefined;
  const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')).join('');
  let tag = CODECS.raw, payload = bytes;
  if (!binary && bytes.byteLength >= COMPRESS_MIN_BYTES) {
    const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();
    if (compressed.size <= COMPRESS_MAX_RATIO * bytes.byteLength) {
      tag = CODECS.deflateRaw;
      payload = compressed;
    }
  }
  return { digest, stored: new Blob([Uint8Array.of(tag), payload], { type }), size: bytes.byteLength, binary, type };
}
async function decode(stored) {
  if (typeof stored === 'string') return new Blob([stored]);
  const tag = await codecOf(stored);
  if (tag === CODECS.raw) return stored.slice(1);
  if (tag === CODECS.deflateRaw)
    return new Response(stored.slice(1).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  throw new Error('unknown codec ' + tag);
}
const versionContent = async (record, stored) => {
  if (!record) return '';
  const blob = await decode(stored);
  return record.binary ? `[binary ${record.size ?? blob.size} bytes ${record.type || 'application/octet-stream'}]` : blob.text();
};
const contentFields = record => ({ blob: record.blob,
  ...(record.size !== undefined && { size: record.size }), ...(record.binary && { binary: true }),
  ...(record.type && { type: record.type }) });

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes, crc = 0) {
  crc = (crc ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStream(members, { date = new Date() } = {}) {
  const iterator = members[Symbol.asyncIterator](), entries = [];
  const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((Math.min(d.getFullYear(), 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  const limit = n => { if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('zip64 required'); return n; };
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (!next.done) {
        const { name, method, crc, usize, data } = next.value, nameBytes = new TextEncoder().encode(name);
        if (entries.length >= 0xffff || nameBytes.length > 0xffff) throw new Error('zip64 required');
        limit(usize); limit(data.size); limit(offset + 30 + nameBytes.length + data.size);
        const header = new Uint8Array(30 + nameBytes.length), v = new DataView(header.buffer);
        v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
        v.setUint16(8, method, true); v.setUint16(10, time, true); v.setUint16(12, day, true);
        v.setUint32(14, crc, true); v.setUint32(18, data.size, true); v.setUint32(22, usize, true);
        v.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30);
        entries.push({ nameBytes, method, crc, usize, csize: data.size, offset });
        offset += header.length + data.size;
        controller.enqueue(header);
        controller.enqueue(new Uint8Array(await data.arrayBuffer()));
      } else {
        const cdOffset = offset;
        for (const e of entries) {
          const header = new Uint8Array(46 + e.nameBytes.length), v = new DataView(header.buffer);
          v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
          v.setUint16(8, 0x0800, true); v.setUint16(10, e.method, true); v.setUint16(12, time, true);
          v.setUint16(14, day, true); v.setUint32(16, e.crc, true); v.setUint32(20, e.csize, true);
          v.setUint32(24, e.usize, true); v.setUint16(28, e.nameBytes.length, true);
          v.setUint32(42, e.offset, true); header.set(e.nameBytes, 46);
          offset = limit(offset + header.length); controller.enqueue(header);
        }
        limit(offset + 22);
        const end = new Uint8Array(22), v = new DataView(end.buffer);
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
        v.setUint32(12, offset - cdOffset, true); v.setUint32(16, cdOffset, true);
        controller.enqueue(end); controller.close();
      }
    },
    async cancel() { await iterator.return?.(); }
  }, { highWaterMark: 0 });
}

export async function readZip(blob) {
  const bad = () => { throw new Error('not a zip archive'); };
  const bytesAt = async (start, length) => {
    if (start < 0 || length < 0 || start + length > blob.size) bad();
    return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
  };
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const start = Math.max(0, blob.size - 65557), tail = await bytesAt(start, blob.size - start), tv = view(tail);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50 && i + 22 + tv.getUint16(i + 20, true) === tail.length) { end = i; break; }
  }
  if (end < 0 || tv.getUint16(end + 4, true) || tv.getUint16(end + 6, true) ||
      tv.getUint16(end + 8, true) !== tv.getUint16(end + 10, true)) bad();
  const count = tv.getUint16(end + 10, true), cdSize = tv.getUint32(end + 12, true), cdOffset = tv.getUint32(end + 16, true);
  if (cdOffset + cdSize > start + end) bad();
  const cd = await bytesAt(cdOffset, cdSize), cv = view(cd), entries = new Map(), names = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cv.getUint32(pos, true) !== 0x02014b50) bad();
    const nameLength = cv.getUint16(pos + 28, true), extra = cv.getUint16(pos + 30, true), comment = cv.getUint16(pos + 32, true);
    if (pos + 46 + nameLength + extra + comment > cd.length || cv.getUint16(pos + 34, true)) bad();
    const name = new TextDecoder().decode(cd.subarray(pos + 46, pos + 46 + nameLength));
    const method = cv.getUint16(pos + 10, true), crc = cv.getUint32(pos + 16, true), csize = cv.getUint32(pos + 20, true);
    const usize = cv.getUint32(pos + 24, true), offset = cv.getUint32(pos + 42, true);
    const local = view(await bytesAt(offset, 30));
    if (local.getUint32(0, true) !== 0x04034b50) bad();
    const dataStart = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (dataStart + csize > blob.size || dataStart + csize > cdOffset) bad();
    entries.set(name, { name, method, crc, csize, usize, offset, dataStart }); names.push(name);
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== cd.length) bad();
  const entry = name => entries.get(name);
  const raw = name => { const e = entry(name); return e && blob.slice(e.dataStart, e.dataStart + e.csize); };
  return { names, entry, raw, async read(name) {
    const e = entry(name); if (!e) return undefined;
    let data = raw(name);
    if (e.method === 8) data = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    else if (e.method !== 0) throw new Error('unsupported zip method ' + e.method);
    if (data.size !== e.usize) throw new Error('zip size mismatch: ' + name);
    if (crc32(new Uint8Array(await data.arrayBuffer())) !== e.crc) throw new Error('zip crc mismatch: ' + name);
    return data;
  } };
}

export function openFs({ indexedDB = globalThis.indexedDB, name = 'airis.fs',
  locks = globalThis.navigator?.locks, storage = globalThis.navigator?.storage,
  IDBKeyRange = globalThis.IDBKeyRange, now = Date.now,
  channel = globalThis.BroadcastChannel ? new globalThis.BroadcastChannel('airis.fs') : null } = {}) {
  if (!indexedDB) throw new Error('IndexedDB unavailable');
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of ['blobs', 'versions', 'heads', 'ops', 'workspaces']) {
        request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  channel?.unref?.();
  const listeners = new Set();
  const deliver = event => { for (const fn of listeners) { try { fn(event); } catch (_) { /* listener isolation */ } } };
  const incoming = event => deliver(event.data);
  if (channel?.addEventListener) channel.addEventListener('message', incoming);
  else if (channel) channel.onmessage = incoming;
  const emit = event => { deliver(event); try { channel?.postMessage(event); } catch (_) { /* channel unavailable */ } };
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const heldRuns = new Map();
  const releaseRun = ws => {
    const held = heldRuns.get(ws);
    if (!held) return false;
    heldRuns.delete(ws);
    if (held.release) held.release();
    else held.cancelled = true;
    return true;
  };
  const close = () => { for (const ws of heldRuns.keys()) releaseRun(ws); channel?.close?.(); db.then(database => database.close?.()); };
  const usage = async () => {
    const estimate = await storage?.estimate?.() || {};
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null,
      persisted: await storage?.persisted?.() ?? false };
  };
  const runLock = async (ws, fn) => {
    if (!workspaceId(ws)) throw new Error('invalid workspace');
    if (!locks) throw new Error('Web Locks unavailable');
    return locks.request('airis.run:' + ws, { ifAvailable: true }, lock => {
      if (!lock) throw new Error('run locked');
      return fn();
    });
  };
  const acquireRun = (ws, owner) => {
    validWs(ws);
    if (!locks) throw new Error('Web Locks unavailable');
    const existing = heldRuns.get(ws);
    if (existing) return existing.owner === owner ? existing.result : Promise.resolve({ ok: true, held: false });
    const entry = { owner };
    heldRuns.set(ws, entry);
    entry.result = new Promise((resolve, reject) => {
      Promise.resolve().then(() => locks.request('airis.run:' + ws, { ifAvailable: true }, lock => {
        if (!lock || entry.cancelled) {
          if (heldRuns.get(ws) === entry) heldRuns.delete(ws);
          resolve({ ok: true, held: false });
          return null;
        }
        return new Promise(release => {
          entry.release = release;
          resolve({ ok: true, held: true });
        });
      })).catch(error => { if (heldRuns.get(ws) === entry) heldRuns.delete(ws); reject(error); });
    });
    return entry.result;
  };
  const req = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const complete = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
  const validWs = ws => { if (!workspaceId(ws)) throw new Error('invalid workspace'); };
  const positive = n => Number.isSafeInteger(n) && n > 0;
  const invalid = problems => problems.length ? fail('invalid args', { problems }) : null;
  const contextProblems = ctx => ['runId', 'callId'].filter(key => ctx[key] !== undefined && typeof ctx[key] !== 'string')
    .map(key => key + ' must be a string');
  const wsExists = async ws => {
    validWs(ws);
    const tx = (await db).transaction('workspaces');
    return (await req(tx.objectStore('workspaces').get(ws))) !== undefined;
  };
  const createWorkspace = async ({ ws, name }) => {
    validWs(ws);
    const tx = (await db).transaction('workspaces', 'readwrite'), done = complete(tx);
    const store = tx.objectStore('workspaces');
    const count = await req(store.count());
    const existing = await req(store.get(ws));
    if (!existing) store.add({ name, createdAt: now() }, ws);
    await done;
    if (existing) return fail('workspace exists');
    if (!count) {
      let persisted = false;
      try { persisted = await storage?.persist?.() ?? false; } catch (_) { /* unavailable */ }
      const update = (await db).transaction('workspaces', 'readwrite'), finished = complete(update);
      const workspaces = update.objectStore('workspaces');
      const record = await req(workspaces.get(ws));
      workspaces.put({ ...record, persisted }, ws);
      await finished;
    }
    return { ok: true, ws };
  };
  const listWorkspaces = async () => {
    const tx = (await db).transaction('workspaces'), s = tx.objectStore('workspaces');
    const keys = await req(s.getAllKeys()), values = await req(s.getAll());
    return keys.map((ws, i) => ({ ws, ...values[i] }));
  };
  // All awaits in these transactions are IndexedDB request promises only.
  const snapshot = async (ws, path) => {
    const tx = (await db).transaction(['heads', 'versions', 'blobs']), done = complete(tx);
    const ver = await req(tx.objectStore('heads').get([ws, path]));
    if (ver === undefined) { await done; return null; }
    const record = await req(tx.objectStore('versions').get([ws, path, ver]));
    const content = await req(tx.objectStore('blobs').get(record.blob));
    await done;
    return { ver, record, content };
  };
  const read = async ({ ws, path, from, to }) => {
    const problems = ['from', 'to'].filter(key => ({ from, to })[key] !== undefined && !positive(({ from, to })[key]))
      .map(key => key + ' must be a positive integer');
    if (problems.length) return invalid(problems);
    path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const data = await snapshot(ws, path);
    if (!data) return fail('not found', { path });
    if (data.record.binary && (from !== undefined || to !== undefined)) return fail('binary file', { path });
    const decoded = await decode(data.content);
    if (data.record.binary) return { path, ver: data.ver, blob: decoded.slice(0, decoded.size, data.record.type || '') };
    const lines = (await decoded.text()).split('\n');
    return { path, ver: data.ver, content: lines.slice((from ?? 1) - 1, to).join('\n'), lines: lines.length };
  };
  const stat = async ({ ws, path }) => {
    path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const data = await snapshot(ws, path);
    if (!data) return fail('not found', { path });
    return { path, ver: data.ver, size: data.record.size ?? (await decode(data.content)).size,
      actor: data.record.actor, t: data.record.t,
      ...(data.record.binary && { binary: true, type: data.record.type }) };
  };
  const list = async ({ ws, path = '', depth = 1 }) => {
    if (!positive(depth) || depth > 20) return invalid(['depth must be an integer from 1 to 20']);
    path = normPath(path);
    if (path === null) throw new Error('invalid path');
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction(['heads', 'versions', 'blobs']), done = complete(tx);
    const heads = tx.objectStore('heads');
    const keys = await req(heads.getAllKeys(IDBKeyRange.bound([ws, ''], [ws, []])));
    const out = [];
    for (const [, p] of keys) {
      if (path && !p.startsWith(path + '/')) continue;
      if (p.slice(path ? path.length + 1 : 0).split('/').length > depth) continue;
      const ver = await req(heads.get([ws, p]));
      const record = await req(tx.objectStore('versions').get([ws, p, ver]));
      const content = record.size === undefined ? await req(tx.objectStore('blobs').get(record.blob)) : null;
      out.push({ path: p, ver, record, content });
    }
    await done;
    return Promise.all(out.map(async ({ path, ver, record, content }) => ({ path, ver,
      size: record.size ?? (await decode(content)).size, ...(record.binary && { binary: true }) })) );
  };
  const mutate = async (kind, args, ctx = {}) => {
    const { ws, base } = args;
    const problems = contextProblems(ctx);
    if (!(kind === 'write' && base === null) && !positive(base)) problems.push('base must be a positive safe integer' + (kind === 'write' ? ' or null' : ''));
    if (kind === 'write' && !isContent(args.content)) problems.push('content must be a string, Blob or bytes');
    if (kind === 'write' && args.type !== undefined && typeof args.type !== 'string') problems.push('type must be a string');
    if (kind === 'edit' && (typeof args.old !== 'string' || !args.old)) problems.push('old must be a nonempty string');
    if (kind === 'edit' && typeof args.new !== 'string') problems.push('new must be a string');
    if (problems.length) return invalid(problems);
    const source = filePath(kind === 'move' ? args.from : args.path);
    const dest = kind === 'move' ? filePath(args.to) : source;
    if (typeof ctx.actor !== 'string' || !ctx.actor) throw new Error('actor required');
    if (!await wsExists(ws)) return fail('no such workspace');
    let content = args.content, preparedError, editVersion;
    if (kind === 'edit') {
      const data = await snapshot(ws, source);
      editVersion = data?.ver ?? null;
      if (data?.record.binary) preparedError = fail('binary file', { path: source });
      else {
        const text = data ? await (await decode(data.content)).text() : '';
        const count = args.old ? text.split(args.old).length - 1 : text.length + 1;
        if (!count) preparedError = fail('old not found');
        else if (count !== 1) preparedError = fail('old not unique', { count });
        else content = text.replace(args.old, () => args.new);
      }
    }
    const prepared = kind === 'write' || kind === 'edit' && !preparedError ? await prepare(content, args.type) : null;
    const tx = (await db).transaction(['blobs', 'versions', 'heads', 'ops'], 'readwrite');
    const done = complete(tx);
    const blobs = tx.objectStore('blobs'), versions = tx.objectStore('versions');
    const heads = tx.objectStore('heads'), ops = tx.objectStore('ops');
    const getVersion = async (path, ver) => ver === null ? null : (await req(versions.get([ws, path, ver]))) ?? null;
    const getContent = async record => record ? await req(blobs.get(record.blob)) : '';
    let conflictData;
    const conflict = async (path, expected, current) => {
      const before = await getVersion(path, expected), after = await getVersion(path, current);
      const a = await getContent(before), b = await getContent(after);
      conflictData = { path, expected, current, before, after, a, b };
    };
    const current = (await req(heads.get([ws, source]))) ?? null;
    let result;
    if (current !== base) result = await conflict(source, base, current);
    else if (kind !== 'write' && current === null) result = fail('not found', { path: source });
    else if (kind === 'move' && (await req(heads.get([ws, dest]))) !== undefined) {
      const occupied = await req(heads.get([ws, dest]));
      result = await conflict(dest, null, occupied);
    } else if (kind === 'edit' && editVersion !== current) {
      // A head may have appeared between the snapshot and CAS. Prepare again
      // outside the transaction rather than hashing or editing the wrong version.
      result = null;
    } else if (preparedError) result = preparedError;
    else {
      const seqCursor = await req(ops.openCursor(IDBKeyRange.bound([ws, 0], [ws, Infinity]), 'prev'));
      const seq = (seqCursor?.key[1] ?? 0) + 1;
      const t = now();
      const meta = { actor: ctx.actor, ...(ctx.runId !== undefined && { runId: ctx.runId }),
        ...(ctx.callId !== undefined && { callId: ctx.callId }), t };
      let ver = current;
      if (kind !== 'delete') {
        const cursor = await req(versions.openCursor(IDBKeyRange.bound([ws, dest, 0], [ws, dest, Infinity]), 'prev'));
        ver = (cursor?.key[2] ?? 0) + 1;
        let fields;
        if (kind === 'move') fields = contentFields(await getVersion(source, current));
        else {
          if ((await req(blobs.get(prepared.digest))) === undefined) blobs.put(prepared.stored, prepared.digest);
          fields = { blob: prepared.digest, size: prepared.size, ...(prepared.binary && { binary: true }),
            ...(prepared.type && { type: prepared.type }) };
        }
        versions.put({ ...fields, ...meta, parent: kind === 'move' ? null : base }, [ws, dest, ver]);
        heads.put(ver, [ws, dest]);
      }
      if (kind === 'delete' || kind === 'move') heads.delete([ws, source]);
      ops.put({ ...meta, kind: kind === 'edit' ? 'write' : kind, path: dest,
        ...(kind === 'move' && { from: source, to: dest }), ver }, [ws, seq]);
      result = { ok: true, path: dest, ver, ...(kind === 'delete' && { deleted: true }) };
    }
    await done;
    if (conflictData) {
      const { path, expected, current, before, after, a, b } = conflictData;
      return fail('conflict', { path, base: expected, current, actor: after?.actor ?? null,
        diff: lineDiff(await versionContent(before, a), await versionContent(after, b)) });
    }
    if (result?.ok) {
      if (kind === 'move') emit({ ws, path: source, ver: null, actor: ctx.actor });
      emit({ ws, path: dest, ver: kind === 'delete' ? null : result.ver, actor: ctx.actor });
    }
    return result ?? mutate(kind, args, ctx);
  };
  const history = async ({ ws, path, callId, runId }) => {
    if (path !== undefined) path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction('ops'), store = tx.objectStore('ops');
    const range = IDBKeyRange.bound([ws, 0], [ws, Infinity]);
    const keys = await req(store.getAllKeys(range)), values = await req(store.getAll(range));
    return values.map((op, i) => ({ seq: keys[i][1], ...op })).filter(op =>
      (path === undefined || [op.path, op.from, op.to].includes(path)) &&
      (callId === undefined || op.callId === callId) && (runId === undefined || op.runId === runId));
  };
  const versions = async ({ ws, path }) => {
    path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction(['heads', 'versions']), store = tx.objectStore('versions');
    let ver = await req(tx.objectStore('heads').get([ws, path]));
    if (ver === undefined) {
      const cursor = await req(store.openCursor(IDBKeyRange.bound([ws, path, 0], [ws, path, Infinity]), 'prev'));
      ver = cursor?.key[2];
    }
    const chain = [];
    while (ver != null) {
      const record = await req(store.get([ws, path, ver]));
      if (!record) break;
      chain.push({ ver, ...record });
      ver = record.parent;
    }
    return chain;
  };
  const diff = async ({ ws, path, from, to }) => {
    const problems = [];
    if (!positive(from)) problems.push('from must be a positive integer');
    if (to !== undefined && !positive(to)) problems.push('to must be a positive integer');
    if (problems.length) return invalid(problems);
    path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction(['heads', 'versions', 'blobs']), done = complete(tx);
    const vs = tx.objectStore('versions'), blobs = tx.objectStore('blobs');
    if (to == null) to = await req(tx.objectStore('heads').get([ws, path]));
    const validVer = ver => Number.isSafeInteger(ver) && ver > 0;
    if (!validVer(from) || !validVer(to)) return fail('not found', { path });
    const a = await req(vs.get([ws, path, from]));
    const b = await req(vs.get([ws, path, to]));
    if (!a || !b) return fail('not found', { path });
    const first = await req(blobs.get(a.blob)), second = await req(blobs.get(b.blob));
    await done;
    return { ok: true, diff: lineDiff(await versionContent(a, first), await versionContent(b, second)) };
  };
  const revertRun = async ({ ws, runId }, ctx = {}) => {
    const problems = contextProblems(ctx);
    if (problems.length) return invalid(problems);
    if (typeof ctx.actor !== 'string' || !ctx.actor) throw new Error('actor required');
    if (typeof runId !== 'string' || !runId) throw new Error('runId required');
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction(['heads', 'versions', 'ops'], 'readwrite'), done = complete(tx);
    const heads = tx.objectStore('heads'), vs = tx.objectStore('versions'), ops = tx.objectStore('ops');
    const all = await req(ops.getAll(IDBKeyRange.bound([ws, 0], [ws, Infinity])));
    const state = new Map(), touched = new Map();
    for (const op of all) {
      const changes = op.kind === 'move' ? [[op.from, null], [op.to, op.ver]] :
        [[op.path, op.kind === 'delete' ? null : op.ver]];
      for (const [path, next] of changes) {
        if (op.runId === runId) {
          if (!touched.has(path)) touched.set(path, { before: state.get(path) ?? null });
          touched.get(path).after = next;
        }
        state.set(path, next);
      }
    }
    const conflicts = [];
    for (const [path, entry] of touched) {
      const current = (await req(heads.get([ws, path]))) ?? null;
      entry.current = current;
      if (current !== entry.after) {
        const record = current === null ? null : await req(vs.get([ws, path, current]));
        conflicts.push({ path, expected: entry.after, current, actor: record?.actor ?? null });
      }
    }
    if (conflicts.length) { await done; return fail('conflict', { conflicts }); }
    let cursor = await req(ops.openCursor(IDBKeyRange.bound([ws, 0], [ws, Infinity]), 'prev'));
    let seq = cursor?.key[1] ?? 0;
    const restored = [], events = [];
    for (const [path, entry] of touched) {
      const meta = { actor: ctx.actor, ...(ctx.runId !== undefined && { runId: ctx.runId }),
        ...(ctx.callId !== undefined && { callId: ctx.callId }), t: now() };
      let ver = null;
      if (entry.before !== null) {
        const original = await req(vs.get([ws, path, entry.before]));
        cursor = await req(vs.openCursor(IDBKeyRange.bound([ws, path, 0], [ws, path, Infinity]), 'prev'));
        ver = (cursor?.key[2] ?? 0) + 1;
        vs.put({ ...contentFields(original), ...meta, parent: entry.current }, [ws, path, ver]);
        heads.put(ver, [ws, path]);
      } else heads.delete([ws, path]);
      ops.put({ ...meta, kind: ver === null ? 'delete' : 'write', path,
        ver: ver === null ? entry.current : ver }, [ws, ++seq]);
      restored.push({ path, ver });
      events.push({ ws, path, ver, actor: ctx.actor });
    }
    await done;
    for (const event of events) emit(event);
    return { ok: true, restored };
  };
  const exportArchive = async ({ ws }, bundle) => {
    validWs(ws);
    const tx = (await db).transaction(['workspaces', 'heads', 'versions', 'ops'], 'readwrite'), done = complete(tx);
    const workspaces = tx.objectStore('workspaces'), workspace = await req(workspaces.get(ws));
    if (!workspace) { await done; return fail('no such workspace'); }
    const exportedAt = new Date(now()).toISOString();
    const collect = async (name, range) => {
      const store = tx.objectStore(name), keys = await req(store.getAllKeys(range)), values = await req(store.getAll(range));
      return keys.map((key, i) => [...key.slice(1), values[i]]);
    };
    const heads = await collect('heads', IDBKeyRange.bound([ws, ''], [ws, []]));
    const versions = await collect('versions', IDBKeyRange.bound([ws, ''], [ws, []]));
    const ops = await collect('ops', IDBKeyRange.bound([ws, 0], [ws, Infinity]));
    workspaces.put({ ...workspace, lastExportedAt: exportedAt }, ws);
    await done;
    const shas = [...new Set(versions.map(([, , record]) => record.blob))], blobs = {};
    const getStored = async sha => {
      const tx = (await db).transaction('blobs');
      return req(tx.objectStore('blobs').get(sha));
    };
    for (const sha of shas) {
      const stored = await getStored(sha), codec = await codecOf(stored);
      const row = versions.find(([, , value]) => value.blob === sha && value.size !== undefined);
      blobs[sha] = { codec, size: row ? row[2].size : (await decode(stored)).size };
    }
    const record = { schema: 'airis.workspace/1', ws, name: workspace.name, exportedAt, heads, versions, ops, blobs };
    const manifest = bundle ? { schema: 'airis.bundle/1', exportedAt, records: [record] } : record;
    async function* members() {
      const data = new Blob([JSON.stringify(manifest, null, 2)]);
      yield { name: 'manifest.json', method: 0, crc: crc32(new Uint8Array(await data.arrayBuffer())), usize: data.size, data };
      for (const sha of shas) {
        const stored = await getStored(sha), logical = await decode(stored);
        const crc = crc32(new Uint8Array(await logical.arrayBuffer()));
        yield { name: 'blobs/' + sha, method: blobs[sha].codec === 1 ? 8 : 0, crc, usize: logical.size,
          data: typeof stored === 'string' ? new Blob([stored]) : stored.slice(1) };
      }
    }
    return { ok: true, ws, name: workspace.name, exportedAt, filename: 'airis-' + ws + '-' + exportedAt.slice(0, 10) + '.zip',
      type: 'application/zip', ...(bundle && { schema: 'airis.bundle/1' }), stream: zipStream(members(), { date: new Date(exportedAt) }) };
  };
  const exportWorkspace = args => exportArchive(args, false);
  const exportBundle = args => exportArchive(args, true);
  const importWorkspace = async (source, { as } = {}) => {
    const invalid = () => fail('invalid workspace record');
    let record = source, zip;
    if (source instanceof Blob || source instanceof ArrayBuffer || source instanceof Uint8Array ||
        source instanceof ReadableStream || source?.stream instanceof ReadableStream) {
      const blob = source instanceof Blob ? source : source instanceof ReadableStream ? await new Response(source).blob() :
        source?.stream instanceof ReadableStream ? await new Response(source.stream).blob() : new Blob([source]);
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (signature.length === 4 && signature[0] === 80 && signature[1] === 75 && signature[2] === 3 && signature[3] === 4) {
        try { zip = await readZip(blob); record = JSON.parse(await (await zip.read('manifest.json')).text()); }
        catch (err) { return fail('invalid archive', { detail: err.message }); }
      } else {
        try { record = JSON.parse(await blob.text()); } catch (_) { return invalid(); }
      }
      if (record?.schema === 'airis.bundle/1') {
        if (!Array.isArray(record.records) || record.records.length !== 1 || record.records[0]?.schema !== 'airis.workspace/1') return invalid();
        record = record.records[0];
      }
    }
    const validPath = path => { try { return typeof path === 'string' && filePath(path) === path; } catch (_) { return false; } };
    const positive = n => Number.isSafeInteger(n) && n > 0;
    const object = o => o && typeof o === 'object' && !Array.isArray(o);
    if (!object(record) || record.schema !== 'airis.workspace/1' || !workspaceId(record.ws) ||
      !workspaceId(as ?? record.ws) || typeof record.name !== 'string' ||
      typeof record.exportedAt !== 'string' || !Number.isFinite(Date.parse(record.exportedAt)) ||
      !Array.isArray(record.heads) || !Array.isArray(record.versions) || !Array.isArray(record.ops) || !object(record.blobs)) return invalid();
    const target = as ?? record.ws;
    if (await wsExists(target)) return fail('workspace exists');
    const validateRows = () => {
      const versionMap = new Map(), headSet = new Set(), seqSet = new Set();
      for (const row of record.versions) {
        if (!Array.isArray(row) || row.length !== 3 || !validPath(row[0]) || !positive(row[1]) || !object(row[2]) ||
          typeof row[2].blob !== 'string' || !/^[a-f0-9]{64}$/.test(row[2].blob) ||
          typeof row[2].actor !== 'string' || !row[2].actor || !Number.isFinite(row[2].t) ||
          !(row[2].parent === null || positive(row[2].parent)) ||
          (row[2].runId !== undefined && typeof row[2].runId !== 'string') ||
          (row[2].callId !== undefined && typeof row[2].callId !== 'string') ||
          (Object.hasOwn(row[2], 'size') && (!Number.isSafeInteger(row[2].size) || row[2].size < 0)) ||
          (Object.hasOwn(row[2], 'binary') && row[2].binary !== true) ||
          (Object.hasOwn(row[2], 'type') && (typeof row[2].type !== 'string' || row[2].type.length > 255))) return invalid();
        const key = JSON.stringify(row.slice(0, 2));
        if (versionMap.has(key)) return invalid();
        versionMap.set(key, row[2]);
      }
      for (const [path, ver, value] of record.versions)
        if (value.parent !== null && (value.parent >= ver || !versionMap.has(JSON.stringify([path, value.parent])))) return invalid();
      for (const row of record.heads) {
        if (!Array.isArray(row) || row.length !== 2 || !validPath(row[0]) || !positive(row[1]) ||
          headSet.has(row[0]) || !versionMap.has(JSON.stringify(row))) return invalid();
        headSet.add(row[0]);
      }
      for (const row of record.ops) {
        if (!Array.isArray(row) || row.length !== 2 || !positive(row[0]) || seqSet.has(row[0]) || !object(row[1])) return invalid();
        const op = row[1];
        if (!['write', 'delete', 'move'].includes(op.kind) || !validPath(op.path) ||
          !(positive(op.ver) || op.kind === 'delete' && op.ver === null) ||
          typeof op.actor !== 'string' || !op.actor || !Number.isFinite(op.t) ||
          (op.runId !== undefined && typeof op.runId !== 'string') || (op.callId !== undefined && typeof op.callId !== 'string') ||
          (op.kind === 'move' && (!validPath(op.from) || !validPath(op.to) || op.path !== op.to || op.from === op.to)) ||
          (op.ver !== null && !versionMap.has(JSON.stringify([op.path, op.ver])))) return invalid();
        seqSet.add(row[0]);
      }
      return versionMap;
    };
    const versionMap = validateRows();
    if (!(versionMap instanceof Map)) return versionMap;
    const preparedBlobs = {};
    for (const [sha, content] of Object.entries(record.blobs)) {
      if (!/^[a-f0-9]{64}$/.test(sha)) return invalid();
      if (zip) {
        if (!object(content) || !Number.isSafeInteger(content.size) || content.size < 0) return invalid();
        const { codec, size } = content, name = 'blobs/' + sha, entry = zip.entry(name);
        if (codec !== 0 && codec !== 1) return fail('unknown codec', { sha, codec });
        if (!entry) return fail('blob hash mismatch', { sha });
        if (entry.method !== 0 && entry.method !== 8) return fail('unknown codec', { sha, codec, method: entry.method });
        try {
          const data = await zip.read(name), bytes = await data.arrayBuffer();
          const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
            b => b.toString(16).padStart(2, '0')).join('');
          if (data.size !== size || digest !== sha) return fail('blob hash mismatch', { sha });
        } catch (_) { return fail('blob hash mismatch', { sha }); }
        preparedBlobs[sha] = new Blob([Uint8Array.of(entry.method === 0 ? 0 : 1), zip.raw(name)]);
      } else {
        if (typeof content !== 'string') return invalid();
        const prepared = await prepare(content);
        if (prepared.digest !== sha) return fail('blob hash mismatch', { sha });
        preparedBlobs[sha] = prepared.stored;
      }
    }
    for (const [, , value] of record.versions)
      if (!Object.hasOwn(record.blobs, value.blob)) return fail('blob hash mismatch', { sha: value.blob });
    const tx = (await db).transaction(['workspaces', 'blobs', 'versions', 'heads', 'ops'], 'readwrite'), done = complete(tx);
    const workspaces = tx.objectStore('workspaces');
    if (await req(workspaces.get(target))) { await done; return fail('workspace exists'); }
    workspaces.add({ name: record.name, createdAt: now() }, target);
    const blobs = tx.objectStore('blobs');
    for (const [sha, stored] of Object.entries(preparedBlobs)) if ((await req(blobs.get(sha))) === undefined) blobs.put(stored, sha);
    for (const [path, ver, value] of record.versions) tx.objectStore('versions').put(value, [target, path, ver]);
    for (const [path, ver] of record.heads) tx.objectStore('heads').put(ver, [target, path]);
    for (const [seq, op] of record.ops) tx.objectStore('ops').put(op, [target, seq]);
    await done;
    for (const [path, ver] of record.heads) emit({ ws: target, path, ver, actor: versionMap.get(JSON.stringify([path, ver])).actor });
    return { ok: true, ws: target };
  };
  return { db, usage, runLock, acquireRun, releaseRun, createWorkspace, listWorkspaces, list, read, stat,
    history, versions, diff, revertRun, onChange, close, exportWorkspace, exportBundle, importWorkspace,
    write: (a, c) => mutate('write', a, c), edit: (a, c) => mutate('edit', a, c),
    delete: (a, c) => mutate('delete', a, c), move: (a, c) => mutate('move', a, c) };
}
