// A deliberately small, in-memory subset of IndexedDB for Node tests.
const error = name => new DOMException(name, name);
const clone = value => structuredClone(value);
const compare = (a, b) => {
  const rank = v => typeof v === 'number' && !Number.isNaN(v) ? 0 :
    typeof v === 'string' ? 1 : Array.isArray(v) ? 2 : -1;
  const x = rank(a), y = rank(b);
  if (x < 0 || y < 0) throw error('DataError');
  if (x !== y) return x - y;
  if (x !== 2) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compare(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
};
const keyCopy = key => { compare(key, key); return clone(key); };

export class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = keyCopy(lower); this.upper = keyCopy(upper);
    this.lowerOpen = lowerOpen; this.upperOpen = upperOpen;
    if (compare(lower, upper) > 0 || (compare(lower, upper) === 0 && (lowerOpen || upperOpen))) throw error('DataError');
  }
  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
  static only(value) { return new FakeKeyRange(value, value, false, false); }
  includes(key) {
    const l = compare(key, this.lower), u = compare(key, this.upper);
    return (l > 0 || (l === 0 && !this.lowerOpen)) && (u < 0 || (u === 0 && !this.upperOpen));
  }
}
const matches = (key, range) => range === undefined ||
  (range instanceof FakeKeyRange ? range.includes(key) : compare(key, range) === 0);

export const fakeIndexedDB = () => {
  const databases = new Map();
  const makeDb = name => {
    const data = new Map(), waiting = [], active = [];
    const overlaps = (a, b) => a.names.some(n => b.names.includes(n));
    const pump = () => {
      for (let i = 0; i < waiting.length;) {
        const tx = waiting[i];
        const conflict = other => overlaps(tx, other) && (tx.mode !== 'readonly' || other.mode !== 'readonly');
        if (active.some(conflict) || waiting.slice(0, i).some(conflict)) { i++; continue; }
        waiting.splice(i, 1); active.push(tx); tx.start();
      }
    };
    const release = tx => {
      const a = active.indexOf(tx), w = waiting.indexOf(tx);
      if (a >= 0) active.splice(a, 1);
      if (w >= 0) waiting.splice(w, 1);
      pump();
    };
    const transaction = (storeNames, mode = 'readonly', upgrade = false) => {
      const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
      if (!upgrade && names.some(n => !data.has(n))) throw error('NotFoundError');
      let state = 'waiting', pending = 0, working, running = false;
      const tasks = [];
      const tx = { names, mode, error: null };
      const check = () => setTimeout(() => {
        if (state !== 'active' || pending) return;
        if (mode !== 'readonly') for (const [n, entries] of working) data.set(n, entries);
        state = 'finished'; release(tx); tx.oncomplete?.({ target: tx });
      }, 0);
      const abort = reason => {
        if (state === 'finished') throw error('TransactionInactiveError');
        state = 'finished'; tx.error = reason || null; release(tx);
        setTimeout(() => tx.onabort?.({ target: tx }), 0);
      };
      const run = () => {
        if (state !== 'active' || running || !tasks.length) return;
        running = true;
        queueMicrotask(() => {
          if (state !== 'active') { running = false; return; }
          const { request, operation } = tasks.shift();
          try {
            request.result = operation(); request.error = null;
            request.onsuccess?.({ target: request });
          } catch (e) {
            request.error = e;
            let prevented = false;
            const event = { target: request, preventDefault: () => { prevented = true; } };
            try { request.onerror?.(event); tx.onerror?.(event); }
            finally { if (!prevented && state !== 'finished') abort(e); }
          } finally {
            pending--; running = false;
            if (state === 'active') { run(); check(); }
          }
        });
      };
      const enqueue = (operation, request = {}) => {
        if (state === 'finished') throw error('TransactionInactiveError');
        pending++; tasks.push({ request, operation }); run(); return request;
      };
      const store = name => {
        if (state === 'finished') throw error('TransactionInactiveError');
        if (!names.includes(name)) throw error('NotFoundError');
        const entries = () => working.get(name);
        const find = key => entries().findIndex(row => compare(row[0], key) === 0);
        const selected = range => entries().filter(row => matches(row[0], range)).sort((a, b) => compare(a[0], b[0]));
        const writable = () => { if (mode === 'readonly') throw error('ReadOnlyError'); };
        const put = (value, key, add) => {
          writable(); key = keyCopy(key); value = clone(value);
          return enqueue(() => {
            const i = find(key);
            if (add && i >= 0) throw error('ConstraintError');
            if (i >= 0) entries()[i] = [key, value]; else entries().push([key, value]);
            return clone(key);
          });
        };
        return {
          get: key => { key = keyCopy(key); return enqueue(() => { const i = find(key); return i < 0 ? undefined : clone(entries()[i][1]); }); },
          put: (value, key) => put(value, key, false),
          add: (value, key) => put(value, key, true),
          delete: range => { writable(); if (!(range instanceof FakeKeyRange)) range = keyCopy(range); return enqueue(() => {
            const rows = entries(); for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i][0], range)) rows.splice(i, 1);
          }); },
          getAll: range => enqueue(() => selected(range).map(row => clone(row[1]))),
          getAllKeys: range => enqueue(() => selected(range).map(row => clone(row[0]))),
          count: range => enqueue(() => selected(range).length),
          openCursor: (range, direction = 'next') => {
            if (!['next', 'prev'].includes(direction)) throw new TypeError('Invalid cursor direction');
            const request = {}; let last, started = false;
            const advance = () => enqueue(() => {
              let rows = selected(range);
              if (direction === 'prev') rows.reverse();
              const row = rows.find(r => !started || (direction === 'next' ? compare(r[0], last) > 0 : compare(r[0], last) < 0));
              if (!row) return null;
              last = clone(row[0]); started = true;
              let continued = false;
              return { key: clone(row[0]), value: clone(row[1]), continue: () => {
                if (continued) throw error('InvalidStateError');
                continued = true; advance();
              } };
            }, request);
            return advance();
          }
        };
      };
      tx.objectStore = store;
      tx.abort = () => abort(null);
      tx.start = () => {
        state = 'active';
        working = new Map(names.map(n => [n, data.get(n).map(row => clone(row))]));
        run(); check();
      };
      tx.addStore = n => { names.push(n); working.set(n, []); };
      if (upgrade) { active.push(tx); tx.start(); }
      else { waiting.push(tx); pump(); }
      return tx;
    };
    const db = {
      name, version: 0,
      objectStoreNames: { contains: n => data.has(n), [Symbol.iterator]: () => data.keys() },
      createObjectStore: n => {
        if (!db.upgrade) throw error('InvalidStateError');
        if (data.has(n)) throw error('ConstraintError');
        data.set(n, []); db.upgrade.addStore(n); return db.upgrade.objectStore(n);
      },
      transaction: (names, mode) => transaction(names, mode),
      close: () => {}
    };
    db.beginUpgrade = () => transaction([...data.keys()], 'versionchange', true);
    db.rollbackStores = names => { for (const n of data.keys()) if (!names.includes(n)) data.delete(n); };
    return db;
  };
  return { open: (name, version) => {
    const request = {};
    setTimeout(() => {
      let db = databases.get(name);
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        request.error = new TypeError('Invalid version'); request.onerror?.({ target: request }); return;
      }
      if (!db) { db = makeDb(name); databases.set(name, db); }
      const target = version ?? (db.version || 1);
      if (target < db.version) { request.error = error('VersionError'); request.onerror?.({ target: request }); return; }
      request.result = db;
      if (target === db.version) { request.onsuccess?.({ target: request }); return; }
      const oldVersion = db.version, oldStores = [...db.objectStoreNames], tx = db.beginUpgrade();
      request.transaction = db.upgrade = tx;
      tx.oncomplete = () => {
        db.version = target; db.upgrade = null; request.transaction = null;
        request.onsuccess?.({ target: request });
      };
      tx.onabort = () => {
        db.upgrade = null; request.transaction = null; request.error = tx.error || error('AbortError');
        if (!oldVersion) databases.delete(name);
        else db.rollbackStores(oldStores);
        request.onerror?.({ target: request });
      };
      try { request.onupgradeneeded?.({ target: request, oldVersion, newVersion: target }); }
      catch (e) { tx.abort(); }
    }, 0);
    return request;
  } };
};
