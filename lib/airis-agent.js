// Airis agent loop (docs/bench-design.md §5): drives a caller-supplied model through
// tool calls against the addressed-action registry (lib/airis-actions.js). There is no
// default model: the caller names it, and the transport carries the caller's key.
import { validate } from './airis-actions.js';

// Stream decoding and accumulation for OpenAI-compatible replies.
// REQUIREMENT (measured against the live router, 2026-11-14): the reasoning field is
// `reasoning_content` on deepseek-*, glm-* and beam-free, and `reasoning` on kimi-*.
// Read whichever is present, never assume one name, and never drop a message whose
// only content is reasoning. Reasoning is echoed back under the name it arrived in.
export const REASONING_FIELDS = ['reasoning_content', 'reasoning'];

export function accumulate() {
  let content = '', reasoning = '', reasoningField, finish = null, usage = null;
  const calls = [];
  return {
    push(j) {
      if (j.error) throw new Error((j.error.type ? j.error.type + ': ' : '') + (j.error.message || JSON.stringify(j.error)));
      if (j.usage != null) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason != null) finish = choice.finish_reason;
      const d = choice.delta || choice.message || {};
      if (typeof d.content === 'string' && d.content) content += d.content;
      if (!reasoningField) reasoningField = REASONING_FIELDS.find(k => typeof d[k] === 'string' && d[k]);
      if (reasoningField) {
        const field = [reasoningField, ...REASONING_FIELDS.filter(k => k !== reasoningField)]
          .find(k => typeof d[k] === 'string' && d[k]);
        if (field) reasoning += d[field];
      }
      (d.tool_calls || []).forEach((t, index) => {
        const i = t.index ?? (choice.message ? index : 0);
        const call = calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) call.id = t.id;
        if (t.function?.name) call.function.name += t.function.name;
        if (t.function?.arguments) call.function.arguments += t.function.arguments;
      });
    },
    result() {
      const message = { role: 'assistant', content };
      if (reasoning) Object.assign(message, { reasoning, reasoningField });
      const toolCalls = calls.filter(Boolean);
      if (toolCalls.length) message.tool_calls = toolCalls.map(c => ({ ...c, function: { ...c.function } }));
      return { message, finish, usage };
    },
  };
}

export async function readSSE(response, onEvent) {
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    onEvent(await response.json());
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let tooLarge = false;
  let hasData = false;
  function line(s) {
    if (!s.startsWith('data:')) return;
    hasData = true;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let value;
    try { value = JSON.parse(data); } catch { return; }
    onEvent(value);
  }
  for (;;) {
    const { value, done } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    if (!hasData && !tooLarge) {
      if (text.length + chunk.length <= 2 * 1024 * 1024) text += chunk;
      else { text = ''; tooLarge = true; }
    }
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(line);
    if (done) break;
  }
  if (buffer) line(buffer);
  if (!hasData && !tooLarge) {
    let value;
    try { value = JSON.parse(text); } catch { return; }
    onEvent(value);
  }
}

export function toolName(address) {
  return address.replace(/\./g, '_');
}

export function toolsFor(registry, { allow, bind = {} } = {}) {
  const names = new Map();
  const tools = registry.list({ agent: true })
    .filter(spec => !allow || allow.includes(spec.address))
    .map(spec => {
      const name = toolName(spec.address);
      names.set(name, spec.address);
      const properties = { ...spec.args.properties };
      for (const key of Object.keys(bind)) delete properties[key];
      const parameters = { ...spec.args, properties };
      if (parameters.required) parameters.required = parameters.required.filter(key => !(key in bind));
      return {
        type: 'function',
        function: { name, description: `${spec.doc} [effect: ${spec.effect}]`, parameters },
      };
    });
  return { tools, resolve: name => names.get(name) || null, bind };
}

// REQUIREMENT (measured against the live router, 2026-11-14): models emit parallel tool
// calls that are actually dependent. beam-free put read_file on a path in the same batch
// as, and before, the write_file that creates it. So the model's order is not trusted:
// a call that reads a resource another call in the batch writes runs after that write's
// result has landed; writes to the same resource keep model order; reads don't block reads.
// Resource keys come from each action's `touches` and overlap on a '/' prefix boundary.
export function planBatch(calls, describe) {
  const planned = calls.map(call => {
    const info = describe ? describe(call.address, call.args) : null;
    return { ...call, ...(info || {}), after: [] };
  });
  const touches = call => call.touches?.length ? call.touches : ['*'];
  const overlap = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i];
      const b = planned[j];
      // Invalid calls have no effect and must not introduce artificial barriers.
      if (a.error || b.error || a.invalid || b.invalid) continue;
      if (!touches(a).some(x => touches(b).some(y => overlap(x, y)))) continue;
      if (a.effect === 'read' && b.effect !== 'read') a.after.push(b.id);
      else if (a.effect !== 'read') b.after.push(a.id);
    }
  }
  return planned;
}

export function httpTransport({ url, headers = {}, fetch = globalThis.fetch }) {
  if (!url) throw new TypeError('url is required');
  return (body, { signal, runId } = {}) => {
    const requestHeaders = { 'content-type': 'application/json', accept: 'text/event-stream' };
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders[key] = String(value).replace(/\{session\}/g, runId ?? '');
    }
    return fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal });
  };
}

export function bridgeTransport(call, { url, headers = {}, secret, scheme = 'Bearer' }) {
  return async (body, { signal, runId } = {}) => {
    const requestHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders[key] = String(value).replace(/\{session\}/g, runId ?? '');
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let received = false;
        const req = call('net.stream', {
          url,
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          auth: { secret, scheme },
        }, chunk => {
          received = true;
          controller.enqueue(encoder.encode(chunk));
        });
        const abort = () => {
          if (req.re != null) call('net.abort', { re: req.re });
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        Promise.resolve(req).then(reply => {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (reply?.ok === false) throw new Error(reply.error);
          const meta = reply?.value ?? reply ?? {};
          const status = meta.status ?? 200;
          if (status < 200 || status >= 300) throw new Error(`HTTP ${status} ${meta.statusText || ''}: ${(meta.text || '').slice(0, 500)}`);
          if (!received && meta.text) controller.enqueue(encoder.encode(meta.text));
          controller.close();
        }).catch(error => controller.error(error)).finally(() => signal?.removeEventListener('abort', abort));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function apiMessages(messages, keepReasoning) {
  return messages.filter(message => ['user', 'assistant', 'tool', 'system'].includes(message.role)).map(message => {
    const result = { role: message.role, content: typeof message.content === 'string' ? message.content : '' };
    if (message.tool_calls && !message.interrupted) result.tool_calls = message.tool_calls;
    if (message.tool_call_id) result.tool_call_id = message.tool_call_id;
    if (keepReasoning && message.reasoning && REASONING_FIELDS.includes(message.reasoningField)) {
      result[message.reasoningField] = message.reasoning;
    }
    return result;
  });
}

export async function runAgent(opts) {
  const { model, transport, registry, signal, runId } = opts;
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model is required');
  if (typeof transport !== 'function') throw new TypeError('transport is required');
  if (!registry) throw new TypeError('registry is required');
  if (!Array.isArray(opts.messages) || !opts.messages.length) throw new TypeError('messages are required');
  const messages = [...opts.messages];
  const available = toolsFor(registry, opts.tools);
  const schemas = new Map(registry.list({ agent: true }).map(spec => [spec.address, spec.args]));
  const actor = opts.actor || 'agent:bench';
  const ctx = { actor, caps: opts.caps, workspaces: opts.workspaces, runId };
  const budget = { steps: 24, tokens: Infinity, ...opts.budget };
  const usage = { total_tokens: 0 };
  let steps = 0;

  async function emit(event) {
    opts.onEvent?.(event);
    if (opts.journal) {
      await registry.call('log.append', { log: opts.journal.log, event }, {
        actor: 'system', app: 'agent', caps: ['*'],
      });
    }
  }
  function result(stopped, error) {
    return { messages, stopped, steps, usage, ...(error ? { error } : {}) };
  }
  while (true) {
    if (signal?.aborted) return result('aborted');
    const steer = await opts.takeSteer?.();
    for (const text of steer || []) {
      messages.push({ role: 'user', content: text });
      await emit({ type: 'steer', text });
    }
    if (steps >= budget.steps || usage.total_tokens >= budget.tokens) return result('budget');
    const body = {
      model,
      messages: apiMessages(messages, opts.keepReasoning),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (available.tools.length) body.tools = available.tools;
    const accumulator = accumulate();
    try {
      const response = await transport(body, { signal, runId });
      await readSSE(response, event => {
        accumulator.push(event);
        opts.onDelta?.(accumulator.result());
      });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    } catch (error) {
      const partial = accumulator.result().message;
      if (partial.content || partial.reasoning || partial.tool_calls) {
        partial.interrupted = true;
        messages.push(partial);
      }
      await emit({ type: 'interrupted', message: partial });
      if (signal?.aborted || error?.name === 'AbortError') return result('aborted');
      return result('error', error?.message || String(error));
    }
    const turn = accumulator.result();
    // Give every call a unique id before the message is recorded, so the transcript,
    // journal and tool results all agree (providers may send empty or repeated ids).
    const used = new Set();
    const reserved = new Set((turn.message.tool_calls || []).map(tc => tc.id).filter(id => typeof id === 'string' && id));
    (turn.message.tool_calls || []).forEach((tc, index) => {
      if (typeof tc.id !== 'string' || !tc.id || used.has(tc.id)) {
        const base = `call_${steps + 1}_${index}`;
        let id = base;
        let suffix = 0;
        while (used.has(id) || reserved.has(id)) id = `${base}_${++suffix}`;
        tc.id = id;
      }
      used.add(tc.id);
    });
    messages.push(turn.message);
    await emit({ type: 'assistant', message: turn.message });
    if (turn.usage) {
      for (const [key, value] of Object.entries(turn.usage)) {
        if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
      }
    }
    steps++;
    if (!turn.message.tool_calls?.length) return result('done');
    const calls = turn.message.tool_calls.map(tc => {
      const address = available.resolve(tc.function.name);
      const call = { id: tc.id, address, args: {}, touches: [] };
      if (!address) {
        call.error = `unknown tool ${tc.function.name}`;
        return call;
      }
      try {
        const raw = tc.function.arguments?.trim();
        const parsed = raw ? JSON.parse(raw) : {};
        call.args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed, ...available.bind } : parsed;
      } catch (_) {
        call.error = 'arguments were not valid JSON';
        return call;
      }
      if (validate(schemas.get(address), call.args ?? {}).length) {
        call.invalid = true;
        return call;
      }
      Object.assign(call, registry.describe(address, call.args, ctx) || {});
      return call;
    });
    const planned = planBatch(calls);
    const promises = new Map();
    function execute(call) {
      if (promises.has(call.id)) return promises.get(call.id);
      const promise = (async () => {
        await Promise.all(call.after.map(id => execute(planned.find(item => item.id === id))));
        await emit({ type: 'tool_start', id: call.id, address: call.address, args: call.args, after: call.after });
        let reply;
        try {
          const needsConsent = ['external', 'secret'].includes(call.effect) || (opts.policy === 'careful' && call.effect === 'write');
          if (call.error) reply = { ok: false, error: call.error };
          else if (!call.invalid && needsConsent && await opts.consent?.({ id: call.id, address: call.address, args: call.args, effect: call.effect }) !== 'granted') {
            reply = { ok: false, error: 'denied by human' };
          } else {
            reply = await registry.call(call.address, call.args, { ...ctx, callId: call.id });
          }
        } catch (error) {
          reply = { ok: false, error: error?.message || String(error) };
        }
        const index = planned.indexOf(call);
        if (call.after.some(id => planned.findIndex(item => item.id === id) > index)) {
          reply = { ...reply, ranAfter: call.after };
        }
        await emit({ type: 'tool_end', id: call.id, address: call.address, ok: reply.ok, result: reply });
        return reply;
      })();
      promises.set(call.id, promise);
      return promise;
    }
    const replies = await Promise.all(planned.map(execute));
    replies.forEach((reply, index) => {
      messages.push({ role: 'tool', tool_call_id: planned[index].id, content: JSON.stringify(reply) });
    });
  }
}
