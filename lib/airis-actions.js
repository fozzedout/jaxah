const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);

export function validate(schema, value, path = '') {
  const errors = [];
  const add = s => errors.push(`${path || 'value'}: ${s}`);
  if (!object(schema)) return [`${path || 'value'}: invalid schema`];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = t => ({
    object: () => object(value),
    array: () => Array.isArray(value),
    null: () => value === null,
    string: () => typeof value === 'string',
    boolean: () => typeof value === 'boolean',
    number: () => typeof value === 'number' && Number.isFinite(value),
    integer: () => Number.isInteger(value)
  })[t]?.();
  if (types.length && !types.some(matches)) {
    add(`must be ${types.join('|')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) add(`must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) add(`minimum length is ${schema.minLength}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`maximum items is ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, path ? `${path}.${i}` : String(i))));
  }
  if (object(value)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!own(value, k)) errors.push(`${path ? path + '.' : ''}${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (own(props, k)) errors.push(...validate(props[k], v, p));
      else if (object(schema.additionalProperties)) errors.push(...validate(schema.additionalProperties, v, p));
      else if (schema.additionalProperties !== true) errors.push(`${p}: unknown property`);
    }
  }
  return errors;
}

// IndexedDB persistence is a later slice.
export function memoryStore({ now = Date.now } = {}) {
  return { blobs: new Map(), versions: new Map(), heads: new Map(), ops: [], journals: new Map(), counters: new Map(), now };
}

export function normPath(p) {
  if (typeof p !== 'string' || /[\\\0]/.test(p)) return null;
  const parts = p.split('/');
  if (parts.includes('..')) return null;
  return parts.filter(x => x && x !== '.').join('/');
}

export function lineDiff(a, b) {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  if (x.length * y.length > 4e6) return [...x.map(s => '-' + s), ...y.map(s => '+' + s)].join('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(' ' + x[i++]);
      j++;
    } else if (i < x.length && (j === y.length || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push('-' + x[i++]);
    } else {
      out.push('+' + y[j++]);
    }
  }
  return out.join('\n');
}

const str = { type: 'string' };
const integer = { type: 'integer' };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const anyObject = { type: 'object', additionalProperties: true };
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function plausibleSchema(s) {
  if (!object(s)) return false;
  const types = ['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'];
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type.length > 0 && s.type.every(t => types.includes(t)) : types.includes(s.type))) return false;
  if (s.properties !== undefined && (!object(s.properties) || !Object.values(s.properties).every(plausibleSchema))) return false;
  if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every(x => typeof x === 'string'))) return false;
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean' && !plausibleSchema(s.additionalProperties)) return false;
  if (s.items !== undefined && !plausibleSchema(s.items)) return false;
  if (s.enum !== undefined && !Array.isArray(s.enum)) return false;
  return ['minimum', 'maximum', 'minLength', 'maxItems'].every(k => s[k] === undefined || typeof s[k] === 'number' && Number.isFinite(s[k]));
}

export function createRegistry({ store = memoryStore(), now = store.now || Date.now } = {}) {
  const specs = new Map();
  const publications = new Map();
  const listeners = new Set();
  const trail = [];

  function define(address, spec) {
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(address)) throw new Error('invalid address');
    if (specs.has(address)) throw new Error('duplicate action');
    specs.set(address, spec);
  }

  async function call(address, args, ctx = {}) {
    const spec = specs.get(address);
    let result;
    try {
      if (!spec) result = fail('unknown action', { address });
      else if (spec.cap && !(ctx.caps || []).includes(spec.cap) && !(ctx.caps || []).includes('*')) result = fail('capability not granted', { cap: spec.cap });
      else if (ctx.actor?.startsWith('agent:') && spec.agent === false) result = fail('not available to agents');
      else {
        const problems = validate(spec.args, args ?? {});
        if (problems.length) result = fail('invalid args', { problems });
        else {
          const value = await spec.run(args ?? {}, ctx);
          result = value?.ok === false ? value : { ok: true, value };
        }
      }
    } catch (e) {
      result = fail(e?.message || String(e));
    }
    const event = { t: now(), actor: ctx.actor || 'system', address, args, ok: result.ok };
    if (!result.ok) event.error = result.error;
    if (ctx.callId !== undefined) event.callId = ctx.callId;
    if (ctx.runId !== undefined) event.runId = ctx.runId;
    trail.push(event);
    for (const fn of listeners) {
      try { fn(event); } catch (_) {}
    }
    return result;
  }

  function describe(address, args = {}, ctx = {}) {
    const spec = specs.get(address);
    if (!spec) return null;
    const target = address === 'app.act' ? publications.get(args.id)?.actions.find(a => a.name === args.action) : null;
    let touches = [];
    try { touches = spec.touches?.(args, ctx) || []; } catch (_) {}
    return { address, effect: target?.effect || spec.effect, touches, agent: target?.agent ?? spec.agent };
  }

  const list = ({ agent } = {}) => Array.from(specs, ([address, s]) => ({ address, args: s.args, effect: s.effect, agent: s.agent, doc: s.doc })).filter(s => !agent || s.agent);
  const onDispatch = fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const publish = (appId, data, deliver) => call('app.publish', data, { actor: 'app:' + appId, app: appId, deliver, caps: ['*'] });
  const key = (ws, path) => `${ws}\0${path}`;
  const version = (ws, path, ver) => store.versions.get(`${key(ws, path)}\0${ver}`);
  const content = rec => rec ? store.blobs.get(rec.blob) : '';
  const head = (ws, path) => store.heads.get(key(ws, path)) ?? null;
  const resource = (ws, path) => `fs/${ws}` + (path ? `/${path}` : '');
  const pathTouch = a => [resource(a.ws, normPath(a.path ?? '') || '')];
  const grant = (ws, ctx) => (ctx.workspaces || []).includes(ws) || (ctx.workspaces || []).includes('*');
  const conflict = (ws, path, base) => {
    const current = head(ws, path);
    return fail('conflict', { path, base, current, actor: version(ws, path, current)?.actor ?? null, diff: lineDiff(content(version(ws, path, base)), content(version(ws, path, current))) });
  };
  const cas = (ws, path, base) => head(ws, path) !== base ? conflict(ws, path, base) : null;
  const op = (ws, kind, path, ver, ctx, extra = {}) => store.ops.push({ ws, seq: store.ops.length + 1, actor: ctx.actor || 'system', kind, path, ver, callId: ctx.callId, runId: ctx.runId, t: now(), ...extra });

  async function write(ws, path, data, ctx, parent, kind = 'write', extra = {}) {
    const hash = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))), x => x.toString(16).padStart(2, '0')).join('');
    const k = key(ws, path);
    // Counters survive deletion so stale versions cannot match recreated files.
    const ver = (store.counters.get(k) || 0) + 1;
    store.counters.set(k, ver);
    store.blobs.set(hash, data);
    store.versions.set(`${k}\0${ver}`, { blob: hash, actor: ctx.actor || 'system', runId: ctx.runId, callId: ctx.callId, t: now(), parent });
    store.heads.set(k, ver);
    op(ws, kind, path, ver, ctx, extra);
    return { path, ver };
  }

  const fsDocs = {
    list: 'List files under a workspace path with their versions and sizes. Depth defaults to one; omit path for the workspace root.',
    read: 'Read a file and return its content and ver; pass that ver as base to fs_edit, fs_write, fs_delete or fs_move. Optional from and to are 1-based line numbers.',
    stat: 'Get a file’s current version, size, last writer and timestamp without reading its content.',
    search: 'Search file lines under a workspace path for a literal pattern or regular expression. Returns up to 200 matches with paths and 1-based line numbers.',
    write: "Create a file with base null or replace it using the ver last read as base. A conflict returns the current ver, writer and diff; re-read and retry.",
    edit: "Replace exactly one occurrence of old with new, using the ver last read as base; prefer this over fs_write for changes. It can return 'old not unique', 'old not found' or a conflict; re-read on conflict.",
    delete: 'Delete a file using the ver last read as base. On conflict, re-read the file and retry with its current ver.',
    move: 'Move a file from one path to an unoccupied destination, using the source ver last read as base. A changed source or occupied destination causes a conflict.',
    diff: 'Compare two versions of a file as a line diff; from is required and to defaults to the current version.',
    history: 'List workspace file operations, optionally filtered by path or callId, including actors and versions.',
  };
  let writes = Promise.resolve();
  const fs = (name, props, required, effect, run, touches = pathTouch) => define('fs.' + name, {
    args: obj({ ws: str, ...props }, ['ws', ...required]),
    effect,
    cap: 'fs',
    agent: true,
    doc: fsDocs[name],
    touches,
    run: async (a, c) => {
      if (!grant(a.ws, c)) return fail('workspace not granted', { ws: a.ws });
      const b = { ...a };
      for (const field of ['path', ...(name === 'move' ? ['from', 'to'] : [])]) {
        if (field in b || field === 'path' && ['list', 'search', 'history'].includes(name)) {
          b[field] = normPath(b[field] ?? '');
          if (b[field] === null || (required.includes(field) && b[field] === '')) return fail('bad path');
        }
      }
      if (effect !== 'write') return run(b, c);
      // Serialize CAS and writes together, including the asynchronous digest.
      const task = writes.then(() => run(b, c));
      writes = task.catch(() => {});
      return task;
    }
  });
  const path = { path: str };
  const base = { base: integer };
  const entries = (ws, p) => [...store.heads].filter(([k]) => {
    const [w, f] = k.split('\0');
    return w === ws && (!p || f.startsWith(p + '/'));
  });

  fs('list', { ...path, depth: { type: 'integer', minimum: 1, maximum: 20 } }, [], 'read', a => {
    return entries(a.ws, a.path).map(([k, ver]) => {
      const p = k.split('\0')[1];
      return { path: p, ver, size: new TextEncoder().encode(content(version(a.ws, p, ver))).length };
    }).filter(x => x.path.slice(a.path ? a.path.length + 1 : 0).split('/').length <= (a.depth ?? 1));
  });
  fs('read', { ...path, from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } }, ['path'], 'read', a => {
    const ver = head(a.ws, a.path);
    if (ver === null) return fail('not found', { path: a.path });
    const all = content(version(a.ws, a.path, ver)).split('\n');
    const lines = all.slice((a.from ?? 1) - 1, a.to);
    return { path: a.path, ver, content: lines.join('\n'), lines: all.length };
  });
  fs('stat', path, ['path'], 'read', a => {
    const ver = head(a.ws, a.path);
    if (ver === null) return fail('not found', { path: a.path });
    const v = version(a.ws, a.path, ver);
    return { path: a.path, ver, size: new TextEncoder().encode(content(v)).length, actor: v.actor, t: v.t };
  });
  fs('search', { pattern: str, regex: { type: 'boolean' }, ...path }, ['pattern'], 'read', a => {
    const re = a.regex ? new RegExp(a.pattern) : null;
    const out = [];
    for (const [k, ver] of entries(a.ws, a.path)) {
      const p = k.split('\0')[1];
      content(version(a.ws, p, ver)).split('\n').forEach((text, i) => {
        if (out.length < 200 && (re ? re.test(text) : text.includes(a.pattern))) out.push({ path: p, line: i + 1, text });
      });
    }
    return out;
  });
  fs('write', { ...path, content: str, base: { type: ['integer', 'null'] } }, ['path', 'content', 'base'], 'write', async (a, c) => {
    return cas(a.ws, a.path, a.base) || await write(a.ws, a.path, a.content, c, a.base);
  });
  fs('edit', { ...path, old: str, new: str, ...base }, ['path', 'old', 'new', 'base'], 'write', async (a, c) => {
    const bad = cas(a.ws, a.path, a.base);
    if (bad) return bad;
    const s = content(version(a.ws, a.path, a.base));
    const count = a.old ? s.split(a.old).length - 1 : s.length + 1;
    if (!count) return fail('old not found');
    if (count !== 1) return fail('old not unique', { count });
    return write(a.ws, a.path, s.replace(a.old, () => a.new), c, a.base);
  });
  fs('delete', { ...path, ...base }, ['path', 'base'], 'write', (a, c) => {
    const bad = cas(a.ws, a.path, a.base);
    if (bad) return bad;
    store.heads.delete(key(a.ws, a.path));
    op(a.ws, 'delete', a.path, a.base, c);
    return { path: a.path, deleted: true };
  });
  fs('move', { from: str, to: str, ...base }, ['from', 'to', 'base'], 'write', async (a, c) => {
    const bad = cas(a.ws, a.from, a.base);
    if (bad) return bad;
    if (head(a.ws, a.to) !== null) return conflict(a.ws, a.to, null);
    const data = content(version(a.ws, a.from, a.base));
    const result = await write(a.ws, a.to, data, c, null, 'move', { from: a.from, to: a.to });
    store.heads.delete(key(a.ws, a.from));
    return result;
  }, a => [resource(a.ws, normPath(a.from) || ''), resource(a.ws, normPath(a.to) || '')]);
  fs('diff', { ...path, from: integer, to: integer }, ['path', 'from'], 'read', a => {
    const v1 = version(a.ws, a.path, a.from);
    const v2 = version(a.ws, a.path, a.to ?? head(a.ws, a.path));
    if (!v1 || !v2) return fail('not found', { path: a.path });
    return lineDiff(content(v1), content(v2));
  });
  fs('history', { ...path, callId: str }, [], 'read', a => {
    return store.ops.filter(o => o.ws === a.ws && (!a.path || o.path === a.path || o.from === a.path || o.to === a.path) && (a.callId === undefined || o.callId === a.callId));
  });

  const logTouch = (a, c) => [`log/${a.app || c.app || 'system'}/${a.log}`];
  define('log.append', {
    args: obj({ log: str, event: anyObject }, ['log', 'event']), effect: 'write', cap: 'storage', agent: false, doc: 'Append journal event', touches: logTouch,
    run: (a, c) => {
      const k = key(c.app || 'system', a.log);
      const rows = store.journals.get(k) || [];
      const seq = rows.length + 1;
      rows.push({ seq, t: now(), actor: c.actor || 'system', event: a.event });
      store.journals.set(k, rows);
      return { seq };
    }
  });
  define('log.read', {
    args: obj({ log: str, from: { type: 'integer', minimum: 0 }, app: str }, ['log']), effect: 'read', cap: 'storage', agent: true, doc: 'Read journal entries from an optional starting sequence, optionally specifying the owning app. Cross-app access requires the actions capability.', touches: logTouch,
    run: (a, c) => {
      const app = a.app || c.app || 'system';
      if (app !== (c.app || 'system') && !(c.caps || []).includes('actions') && !(c.caps || []).includes('*')) return fail('capability not granted', { cap: 'actions' });
      return (store.journals.get(key(app, a.log)) || []).filter(x => x.seq >= (a.from ?? 0));
    }
  });
  const actionSchema = obj({ name: str, args: anyObject, effect: { type: 'string', enum: ['read', 'write', 'external', 'secret'] }, agent: { type: 'boolean' }, doc: str }, ['name', 'args', 'effect', 'agent']);
  const appTouch = (a, c) => [`app/${a.id || c.app}`];
  define('app.publish', {
    args: obj({ state: { additionalProperties: true }, actions: { type: 'array', items: actionSchema } }, ['state', 'actions']), effect: 'write', cap: null, agent: false, doc: 'Publish app state and actions', touches: appTouch,
    run: (a, c) => {
      if (!c.app) return fail('app required');
      if (typeof c.deliver !== 'function') return fail('deliver required');
      const problems = [];
      a.actions.forEach((x, i) => {
        if (!/^[a-z][a-zA-Z0-9_]*$/.test(x.name)) problems.push(`actions.${i}.name: invalid name`);
        if (x.args.type !== 'object' || !plausibleSchema(x.args)) problems.push(`actions.${i}.args: must be object schema`);
      });
      if (problems.length) return fail('invalid args', { problems });
      const ver = (publications.get(c.app)?.ver || 0) + 1;
      publications.set(c.app, { ver, state: a.state, actions: a.actions, deliver: c.deliver, selection: null });
      return { ver };
    }
  });
  define('app.selection', {
    args: obj({ ref: { additionalProperties: true }, text: str }, ['ref']), effect: 'write', cap: null, agent: false, doc: 'Publish selection', touches: appTouch,
    run: (a, c) => {
      const p = publications.get(c.app);
      if (!p) return fail('not published', { id: c.app });
      p.selection = { ...a };
      return p.selection;
    }
  });
  define('app.state', {
    args: obj({ id: str }, ['id']), effect: 'read', cap: 'actions', agent: true, doc: "Read an open app's published state, its actions and the human's selection.", touches: appTouch,
    run: a => {
      const p = publications.get(a.id);
      return p ? { id: a.id, ver: p.ver, state: p.state, actions: p.actions, selection: p.selection } : fail('not published', { id: a.id });
    }
  });
  define('app.act', {
    args: obj({ id: str, action: str, args: anyObject }, ['id', 'action']), effect: 'write', cap: 'actions', agent: true, doc: 'Invoke an action published by an app; args must match that action’s schema from app_state and the action must be available to agents.', touches: appTouch,
    run: async (a, c) => {
      const p = publications.get(a.id);
      const target = p?.actions.find(x => x.name === a.action);
      if (!target) return fail('unknown action', { id: a.id, action: a.action });
      if (c.actor?.startsWith('agent:') && !target.agent) return fail('not available to agents');
      // The envelope schema cannot validate arguments declared by the target app.
      const problems = validate(target.args, a.args ?? {});
      if (problems.length) return fail('invalid args', { problems });
      return await p.deliver(a.action, a.args ?? {}, { actor: c.actor || 'system' });
    }
  });
  return { define, call, describe, list, trail, onDispatch, publish };
}
