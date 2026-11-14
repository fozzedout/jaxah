// Shell-owned, content-addressed IndexedDB filesystem.
import { normPath, lineDiff } from './airis-actions.js';

export const workspaceId = ws => typeof ws === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(ws);
export const filePath = path => {
  const normalized = normPath(path);
  if (!normalized) throw new Error('invalid path');
  return normalized;
};

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
  const bytes = text => new TextEncoder().encode(text).length;
  const hash = async text => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
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
    const tx = (await db).transaction(['heads', 'versions', 'blobs']);
    const ver = await req(tx.objectStore('heads').get([ws, path]));
    if (ver === undefined) return null;
    const record = await req(tx.objectStore('versions').get([ws, path, ver]));
    const content = await req(tx.objectStore('blobs').get(record.blob));
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
    const lines = data.content.split('\n');
    return { path, ver: data.ver, content: lines.slice((from ?? 1) - 1, to).join('\n'), lines: lines.length };
  };
  const stat = async ({ ws, path }) => {
    path = filePath(path);
    if (!await wsExists(ws)) return fail('no such workspace');
    const data = await snapshot(ws, path);
    if (!data) return fail('not found', { path });
    return { path, ver: data.ver, size: bytes(data.content), actor: data.record.actor, t: data.record.t };
  };
  const list = async ({ ws, path = '', depth = 1 }) => {
    if (!positive(depth) || depth > 20) return invalid(['depth must be an integer from 1 to 20']);
    path = normPath(path);
    if (path === null) throw new Error('invalid path');
    if (!await wsExists(ws)) return fail('no such workspace');
    const tx = (await db).transaction(['heads', 'versions', 'blobs']);
    const heads = tx.objectStore('heads');
    const keys = await req(heads.getAllKeys(IDBKeyRange.bound([ws, ''], [ws, []])));
    const out = [];
    for (const [, p] of keys) {
      if (path && !p.startsWith(path + '/')) continue;
      if (p.slice(path ? path.length + 1 : 0).split('/').length > depth) continue;
      const ver = await req(heads.get([ws, p]));
      const record = await req(tx.objectStore('versions').get([ws, p, ver]));
      const content = await req(tx.objectStore('blobs').get(record.blob));
      out.push({ path: p, ver, size: bytes(content) });
    }
    return out;
  };
  const mutate = async (kind, args, ctx = {}) => {
    const { ws, base } = args;
    const problems = contextProblems(ctx);
    if (!(kind === 'write' && base === null) && !positive(base)) problems.push('base must be a positive safe integer' + (kind === 'write' ? ' or null' : ''));
    if (kind === 'write' && typeof args.content !== 'string') problems.push('content must be a string');
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
      const text = data?.content ?? '';
      const count = args.old ? text.split(args.old).length - 1 : text.length + 1;
      if (!count) preparedError = fail('old not found');
      else if (count !== 1) preparedError = fail('old not unique', { count });
      else content = text.replace(args.old, () => args.new);
    }
    const blob = kind === 'write' || kind === 'edit' && !preparedError ? await hash(content) : null;
    const tx = (await db).transaction(['blobs', 'versions', 'heads', 'ops'], 'readwrite');
    const done = complete(tx);
    const blobs = tx.objectStore('blobs'), versions = tx.objectStore('versions');
    const heads = tx.objectStore('heads'), ops = tx.objectStore('ops');
    const getVersion = async (path, ver) => ver === null ? null : (await req(versions.get([ws, path, ver]))) ?? null;
    const getContent = async record => record ? await req(blobs.get(record.blob)) : '';
    const conflict = async (path, expected, current) => {
      const before = await getVersion(path, expected), after = await getVersion(path, current);
      const a = await getContent(before), b = await getContent(after);
      return fail('conflict', { path, base: expected, current, actor: after?.actor ?? null, diff: lineDiff(a, b) });
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
        let digest = blob;
        if (kind === 'move') digest = (await getVersion(source, current)).blob;
        else if ((await req(blobs.get(digest))) === undefined) blobs.put(content, digest);
        versions.put({ blob: digest, ...meta, parent: kind === 'move' ? null : base }, [ws, dest, ver]);
        heads.put(ver, [ws, dest]);
      }
      if (kind === 'delete' || kind === 'move') heads.delete([ws, source]);
      ops.put({ ...meta, kind: kind === 'edit' ? 'write' : kind, path: dest,
        ...(kind === 'move' && { from: source, to: dest }), ver }, [ws, seq]);
      result = { ok: true, path: dest, ver, ...(kind === 'delete' && { deleted: true }) };
    }
    await done;
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
    const tx = (await db).transaction(['heads', 'versions', 'blobs']);
    const vs = tx.objectStore('versions'), blobs = tx.objectStore('blobs');
    if (to == null) to = await req(tx.objectStore('heads').get([ws, path]));
    const validVer = ver => Number.isSafeInteger(ver) && ver > 0;
    if (!validVer(from) || !validVer(to)) return fail('not found', { path });
    const a = await req(vs.get([ws, path, from]));
    const b = await req(vs.get([ws, path, to]));
    if (!a || !b) return fail('not found', { path });
    const first = await req(blobs.get(a.blob)), second = await req(blobs.get(b.blob));
    return { ok: true, diff: lineDiff(first, second) };
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
        vs.put({ blob: original.blob, ...meta, parent: entry.current }, [ws, path, ver]);
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
  const exportWorkspace = async ({ ws }) => {
    validWs(ws);
    const tx = (await db).transaction(['workspaces', 'heads', 'versions', 'ops', 'blobs'], 'readwrite'), done = complete(tx);
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
    const blobs = {};
    for (const [, , record] of versions) if (!Object.hasOwn(blobs, record.blob))
      blobs[record.blob] = await req(tx.objectStore('blobs').get(record.blob));
    workspaces.put({ ...workspace, lastExportedAt: exportedAt }, ws);
    await done;
    return { schema: 'airis.workspace/1', ws, name: workspace.name, exportedAt, heads, versions, ops, blobs };
  };
  const exportBundle = async ({ ws }) => {
    const record = await exportWorkspace({ ws });
    if (record.ok === false) return record;
    return { schema: 'airis.bundle/1', exportedAt: record.exportedAt, records: [record] };
  };
  const importWorkspace = async (record, { as } = {}) => {
    const invalid = () => fail('invalid workspace record');
    const validPath = path => { try { return typeof path === 'string' && filePath(path) === path; } catch (_) { return false; } };
    const positive = n => Number.isSafeInteger(n) && n > 0;
    const object = o => o && typeof o === 'object' && !Array.isArray(o);
    if (!object(record) || record.schema !== 'airis.workspace/1' || !workspaceId(record.ws) ||
      !workspaceId(as ?? record.ws) || typeof record.name !== 'string' ||
      typeof record.exportedAt !== 'string' || !Number.isFinite(Date.parse(record.exportedAt)) ||
      !Array.isArray(record.heads) || !Array.isArray(record.versions) || !Array.isArray(record.ops) || !object(record.blobs)) return invalid();
    const target = as ?? record.ws, versionMap = new Map(), headSet = new Set(), seqSet = new Set();
    if (await wsExists(target)) return fail('workspace exists');
    for (const row of record.versions) {
      if (!Array.isArray(row) || row.length !== 3 || !validPath(row[0]) || !positive(row[1]) || !object(row[2]) ||
        typeof row[2].blob !== 'string' || !/^[a-f0-9]{64}$/.test(row[2].blob) ||
        typeof row[2].actor !== 'string' || !row[2].actor || !Number.isFinite(row[2].t) ||
        !(row[2].parent === null || positive(row[2].parent)) ||
        (row[2].runId !== undefined && typeof row[2].runId !== 'string') ||
        (row[2].callId !== undefined && typeof row[2].callId !== 'string')) return invalid();
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
    for (const [sha, content] of Object.entries(record.blobs)) {
      if (!/^[a-f0-9]{64}$/.test(sha) || typeof content !== 'string') return invalid();
      if (await hash(content) !== sha) return fail('blob hash mismatch', { sha });
    }
    for (const [, , value] of record.versions)
      if (!Object.hasOwn(record.blobs, value.blob)) return fail('blob hash mismatch', { sha: value.blob });
    const tx = (await db).transaction(['workspaces', 'blobs', 'versions', 'heads', 'ops'], 'readwrite'), done = complete(tx);
    const workspaces = tx.objectStore('workspaces');
    if (await req(workspaces.get(target))) { await done; return fail('workspace exists'); }
    workspaces.add({ name: record.name, createdAt: now() }, target);
    const blobs = tx.objectStore('blobs');
    for (const [sha, content] of Object.entries(record.blobs)) if ((await req(blobs.get(sha))) === undefined) blobs.put(content, sha);
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
