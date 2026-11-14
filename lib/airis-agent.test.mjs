import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, readSSE, runAgent, toolsFor, toolName, planBatch, httpTransport, bridgeTransport } from './airis-agent.js';
import { createRegistry } from './airis-actions.js';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error('network disabled'); }; });
after(() => { globalThis.fetch = originalFetch; });

test('accumulates both reasoning field names without doubling', () => {
  for (const field of ['reasoning_content', 'reasoning']) {
    const a = accumulate();
    a.push({ choices: [{ delta: { [field]: 'one' } }] });
    a.push({ choices: [{ delta: { reasoning_content: 'two', reasoning: 'two' } }] });
    assert.equal(a.result().message.reasoning, 'onetwo');
    assert.equal(a.result().message.reasoningField, field);
  }
});

test('reads split SSE and JSON messages', async () => {
  const a = accumulate();
  const data = 'data: {"choices":[{"delta":{"reasoning":"hello"}}]}\n\ndata: [DONE]\n';
  const stream = new ReadableStream({ start(c) {
    const bytes = new TextEncoder().encode(data);
    c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17)); c.close();
  } });
  await readSSE(new Response(stream), e => a.push(e));
  assert.equal(a.result().message.reasoning, 'hello');
  await readSSE(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    { headers: { 'content-type': 'application/json' } }), e => a.push(e));
  assert.equal(a.result().message.content, 'ok');
});

test('reads JSON without a reported JSON content type', async () => {
  const events = [];
  const reply = { choices: [{ message: { content: 'plain' } }] };
  await readSSE(new Response(JSON.stringify(reply), { headers: { 'content-type': 'text/event-stream' } }), event => events.push(event));
  assert.deepEqual(events, [reply]);
});

function delta(value) {
  return { choices: [{ delta: value }] };
}

function tool(id, name, args, index = 0) {
  return { index, id, type: 'function', function: { name, arguments: args } };
}

function fake(...turns) {
  const bodies = [];
  const transport = async body => {
    bodies.push(structuredClone(body));
    const events = turns.shift();
    assert.ok(events, 'unexpected model request');
    const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, transport };
}

function options(registry, transport, extra = {}) {
  return {
    model: 'test', registry, transport, messages: [{ role: 'user', content: 'go' }],
    caps: ['*'], workspaces: ['w1'], tools: { bind: { ws: 'w1' } }, ...extra,
  };
}

for (const field of ['reasoning_content', 'reasoning']) {
  test(`agent preserves ${field} across tool turns`, async () => {
    const registry = createRegistry();
    const model = fake(
      [delta({ [field]: 'first ' }), delta({ reasoning: 'both', reasoning_content: 'both' }),
        delta({ content: 'working', tool_calls: [tool('one', 'fs_read', '{"path":"missing"}')] })],
      [delta({ [field]: 'final thought' })],
    );
    const result = await runAgent(options(registry, model.transport, { keepReasoning: true }));
    assert.equal(result.stopped, 'done');
    const first = result.messages.find(m => m.role === 'assistant');
    assert.equal(first.reasoning, 'first both');
    assert.equal(first.reasoningField, field);
    assert.equal(model.bodies[1].messages.find(m => m.role === 'assistant')[field], 'first both');
    assert.equal(result.messages.at(-1).reasoning, 'final thought');
    assert.equal(result.messages.at(-1).content, '');
  });
}

for (const field of ['reasoning_content', 'reasoning']) {
  test(`default omits ${field} but retains the assistant tool turn`, async () => {
    const model = fake(
      [delta({ [field]: 'thinking', content: 'working', tool_calls: [tool('one', 'fs_read', '{"path":"missing"}')] })],
      [delta({ content: 'done' })],
    );
    const result = await runAgent(options(createRegistry(), model.transport));
    assert.equal(result.stopped, 'done');
    const assistant = model.bodies[1].messages.find(m => m.role === 'assistant');
    assert.equal(assistant.content, 'working');
    assert.equal(assistant.tool_calls[0].id, 'one');
    assert.ok(!('reasoning' in assistant));
    assert.ok(!('reasoning_content' in assistant));
  });
}

test('interrupted assistant messages retain content but omit tool calls', async () => {
  const model = fake([delta({ content: 'done' })]);
  const messages = [{ role: 'user', content: 'go' }, {
    role: 'assistant', content: 'partial', interrupted: true, tool_calls: [tool('x', 'fs_read', '{}')],
  }];
  await runAgent(options(createRegistry(), model.transport, { messages }));
  const assistant = model.bodies[0].messages[1];
  assert.equal(assistant.content, 'partial');
  assert.ok(!('tool_calls' in assistant));
});

test('non-stream JSON reasoning is retained', async () => {
  const registry = createRegistry();
  const transport = async () => new Response(JSON.stringify({ choices: [{ message: { reasoning: 'thinking' } }] }), {
    headers: { 'content-type': 'application/json' },
  });
  const result = await runAgent(options(registry, transport));
  assert.equal(result.messages.at(-1).reasoning, 'thinking');
});

test('dependent batch runs write before earlier read; model-order control fails', async () => {
  const setup = async () => {
    const registry = createRegistry();
    await registry.call('fs.write', { ws: 'w1', path: 'other', content: 'other', base: null }, {
      actor: 'human', caps: ['*'], workspaces: ['w1'],
    });
    return registry;
  };
  const args = [
    { path: 'notes.md' },
    { path: 'notes.md', content: 'hello\n', base: null },
    { path: 'other' },
  ];
  const addresses = ['fs.read', 'fs.write', 'fs.read'];
  const control = await setup();
  const direct = [];
  for (let i = 0; i < addresses.length; i++) {
    direct.push(await control.call(addresses[i], { ...args[i], ws: 'w1' }, { caps: ['*'], workspaces: ['w1'] }));
  }
  assert.equal(direct[0].error, 'not found');
  const registry = await setup();
  const original = registry.call;
  const invocations = [];
  registry.call = (address, a, ctx) => {
    invocations.push([address, a.path]);
    return original(address, a, ctx);
  };
  const model = fake([
    delta({ tool_calls: addresses.map((address, i) => tool(`id${i}`, toolName(address), JSON.stringify(args[i]), i)) }),
  ], [delta({ content: 'done' })]);
  const events = [];
  const result = await runAgent(options(registry, model.transport, { onEvent: event => events.push(event) }));
  assert.equal(result.stopped, 'done');
  assert.ok(invocations.findIndex(([a]) => a === 'fs.write') < invocations.findIndex(([a, p]) => a === 'fs.read' && p === 'notes.md'));
  const toolMessages = model.bodies[1].messages.filter(m => m.role === 'tool');
  assert.deepEqual(toolMessages.map(m => m.tool_call_id), ['id0', 'id1', 'id2']);
  const read = JSON.parse(toolMessages[0].content);
  assert.equal(read.ok, true);
  assert.equal(read.value.content, 'hello\n');
  assert.deepEqual(read.ranAfter, ['id1']);
  assert.ok(events.findIndex(e => e.type === 'tool_end' && e.id === 'id1') < events.findIndex(e => e.type === 'tool_start' && e.id === 'id0'));
});

test('empty and repeated tool call ids each execute and match their tool messages', async () => {
  const registry = createRegistry();
  const original = registry.call;
  const invocations = [];
  registry.call = (...args) => {
    invocations.push(args);
    return original(...args);
  };
  const ids = ['', '', 'dup', 'dup', 'call_1_0'];
  const model = fake(
    [delta({ tool_calls: ids.map((id, i) => tool(id, 'fs_read', JSON.stringify({ path: `file${i}` }), i)) })],
    [delta({ content: 'done' })],
  );
  assert.equal((await runAgent(options(registry, model.transport))).stopped, 'done');
  assert.equal(invocations.length, ids.length);
  const messages = model.bodies[1].messages;
  const calls = messages.find(m => m.role === 'assistant').tool_calls;
  const replies = messages.filter(m => m.role === 'tool');
  assert.equal(new Set(calls.map(call => call.id)).size, ids.length);
  assert.equal(calls[2].id, 'dup');
  assert.equal(calls[4].id, 'call_1_0');
  assert.deepEqual(replies.map(reply => reply.tool_call_id), calls.map(call => call.id));
});

test('batch planning respects path boundaries, barriers, ordering, and normalized paths', () => {
  const calls = [
    { id: 'list', effect: 'read', touches: ['fs/w1/dir'] },
    { id: 'write', effect: 'write', touches: ['fs/w1/dir/file'] },
    { id: 'a', effect: 'read', touches: ['fs/w1/a'] },
    { id: 'ab', effect: 'write', touches: ['fs/w1/ab'] },
    { id: 'write2', effect: 'write', touches: ['fs/w1/dir/file'] },
    { id: 'read2', effect: 'read', touches: ['fs/w1/a'] },
  ];
  const plan = planBatch(calls);
  assert.deepEqual(plan[0].after, ['write', 'write2']);
  assert.deepEqual(plan[2].after, []);
  assert.deepEqual(plan[3].after, []);
  assert.deepEqual(plan[4].after, ['write']);
  assert.deepEqual(plan[5].after, []);
  const barrier = planBatch([{ id: 'r', effect: 'read', touches: ['x'] }, { id: 'w', effect: 'write', touches: [] }]);
  assert.deepEqual(barrier[0].after, ['w']);
  const registry = createRegistry();
  const normalized = planBatch([
    { id: 'r', address: 'fs.read', args: { ws: 'w1', path: './notes.md' } },
    { id: 'w', address: 'fs.write', args: { ws: 'w1', path: 'notes.md' } },
  ], registry.describe);
  assert.deepEqual(normalized[0].after, ['w']);
});

test('invalid calls return errors and loop continues', async () => {
  const registry = createRegistry();
  const model = fake([delta({ tool_calls: [
    tool('bad', 'fs_read', '{', 0),
    tool('schema', 'fs_read', '{"path":7}', 1),
    tool('unknown', 'no_such_tool', '{}', 2),
  ] })], [delta({ content: 'continued' })]);
  const result = await runAgent(options(registry, model.transport));
  assert.equal(result.stopped, 'done');
  const replies = model.bodies[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(replies[0].error, 'arguments were not valid JSON');
  assert.equal(replies[1].error, 'invalid args');
  assert.equal(replies[2].error, 'unknown tool no_such_tool');
});

test('tool schemas bind arguments and model is mandatory', async () => {
  const registry = createRegistry();
  const available = toolsFor(registry, { allow: ['fs.read'], bind: { ws: 'w1' } });
  assert.equal(available.tools.length, 1);
  assert.equal(available.resolve('fs_read'), 'fs.read');
  assert.equal(available.resolve('bad'), null);
  assert.ok(!('ws' in available.tools[0].function.parameters.properties));
  assert.ok(!available.tools[0].function.parameters.required.includes('ws'));
  await assert.rejects(runAgent({ ...options(registry, async () => {}), model: '' }), TypeError);
  await assert.rejects(runAgent({ ...options(registry, async () => {}), model: undefined }), TypeError);
});

test('external actions require consent and careful policy gates writes', async () => {
  const registry = createRegistry();
  let deliveries = 0;
  await registry.publish('demo', { state: {}, actions: [{ name: 'send', args: { type: 'object' }, effect: 'external', agent: true }] }, async () => {
    deliveries++;
    return 'sent';
  });
  async function run(consent) {
    const model = fake([delta({ tool_calls: [tool('x', 'app_act', '{"id":"demo","action":"send"}')] })], [delta({ content: 'done' })]);
    await runAgent(options(registry, model.transport, { consent, tools: {} }));
    return JSON.parse(model.bodies[1].messages.find(m => m.role === 'tool').content);
  }
  assert.equal((await run()).error, 'denied by human');
  assert.equal(deliveries, 0);
  assert.equal((await run(async () => 'granted')).ok, true);
  assert.equal(deliveries, 1);
  const model = fake([delta({ tool_calls: [tool('w', 'fs_write', '{"path":"x","content":"x","base":null}')] })], [delta({ content: 'done' })]);
  await runAgent(options(registry, model.transport, { policy: 'careful' }));
  assert.equal(JSON.parse(model.bodies[1].messages.find(m => m.role === 'tool').content).error, 'denied by human');
});

test('budget, abort, steer, journal and usage are respected', async () => {
  const registry = createRegistry();
  const model = fake([delta({ tool_calls: [tool('r', 'fs_read', '{"path":"x"}')] }), { usage: { total_tokens: 4 } }]);
  let n = 0;
  const result = await runAgent(options(registry, model.transport, {
    budget: { steps: 1 }, journal: { log: 'run' }, takeSteer: () => n++ ? ['later'] : [],
  }));
  assert.equal(result.stopped, 'budget');
  assert.equal(result.usage.total_tokens, 4);
  assert.equal(result.messages.at(-1).content, 'later');
  const journal = await registry.call('log.read', { log: 'run', app: 'agent' }, { caps: ['*'] });
  assert.deepEqual(journal.value.map(row => row.event.type), ['assistant', 'tool_start', 'tool_end', 'steer']);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runAgent(options(registry, model.transport, { signal: controller.signal }))).stopped, 'aborted');
  const steerModel = fake([delta({ tool_calls: [tool('r', 'fs_read', '{"path":"x"}')] })], [delta({ content: 'ok' })]);
  let turn = 0;
  await runAgent(options(registry, steerModel.transport, { takeSteer: () => turn++ ? ['adjust'] : [] }));
  assert.equal(steerModel.bodies[1].messages.at(-1).content, 'adjust');
});

test('stream errors and aborts retain partial assistant text and journal interruption', async () => {
  const registry = createRegistry();
  const controller = new AbortController();
  // Deliver the partial event before aborting the stream.
  const partialTransport = async () => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    },
    pull(stream) {
      controller.abort();
      stream.error(new Error('stopped'));
    },
  }));
  const result = await runAgent(options(registry, partialTransport, { signal: controller.signal, journal: { log: 'interrupt' } }));
  assert.equal(result.stopped, 'aborted');
  assert.equal(result.messages.at(-1).content, 'partial');
  assert.equal(result.messages.at(-1).interrupted, true);
  const journal = await registry.call('log.read', { log: 'interrupt', app: 'agent' }, { caps: ['*'] });
  assert.equal(journal.value.at(-1).event.type, 'interrupted');
});

test('token budget stops the next request and HTTP failures return an error', async () => {
  const registry = createRegistry();
  const model = fake([delta({ tool_calls: [tool('r', 'fs_read', '{"path":"x"}')] }), { usage: { total_tokens: 5 } }]);
  const limited = await runAgent(options(registry, model.transport, { budget: { tokens: 5 } }));
  assert.equal(limited.stopped, 'budget');
  assert.equal(model.bodies.length, 1);
  const failed = await runAgent(options(registry, async () => new Response('failed', { status: 503, statusText: 'Unavailable' })));
  assert.equal(failed.stopped, 'error');
  assert.equal(failed.error, 'HTTP 503 Unavailable: failed');
});

test('http transport posts body and substitutes session', async () => {
  let request;
  const transport = httpTransport({ url: '/local', headers: { 'x-session': 'id-{session}' }, fetch: async (...args) => {
    request = args;
    return new Response('ok');
  } });
  await transport({ hello: 1 }, { runId: 'abc' });
  assert.equal(request[0], '/local');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].headers['x-session'], 'id-abc');
  assert.deepEqual(JSON.parse(request[1].body), { hello: 1 });
});

test('bridge transport forwards chunks and metadata', async () => {
  let request;
  const transport = bridgeTransport((op, args, onChunk) => {
    request = { op, args };
    onChunk('data: {"value":');
    onChunk('1}\n\n');
    return Promise.resolve({ status: 200, contentType: 'text/event-stream' });
  }, { url: '/local', headers: {}, secret: 'key' });
  const response = await transport({ hello: 1 }, {});
  const events = [];
  await readSSE(response, event => events.push(event));
  assert.deepEqual(events, [{ value: 1 }]);
  assert.equal(request.op, 'net.stream');
  assert.equal(request.args.auth.scheme, 'Bearer');
});

test('bridge streams the first event before its request resolves', async () => {
  let resolveRequest;
  let sendChunk;
  const transport = bridgeTransport((op, args, onChunk) => {
    sendChunk = onChunk;
    return new Promise(resolve => { resolveRequest = resolve; });
  }, { url: '/local' });
  const response = await transport({});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  sendChunk('data: {"value":1}\n\n');
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: {"value":1}\n\n');
  resolveRequest({ status: 200 });
  assert.equal((await reader.read()).done, true);
});

test('bridge HTTP failure rejects the stream and stops the agent', async () => {
  const transport = bridgeTransport(() => Promise.resolve({ status: 401, statusText: 'Unauthorized', text: 'no' }), { url: '/local' });
  await assert.rejects(readSSE(await transport({}), () => {}), /HTTP 401 Unauthorized: no/);
  const result = await runAgent(options(createRegistry(), transport));
  assert.equal(result.stopped, 'error');
  assert.match(result.error, /HTTP 401/);
});

test('bridge transport aborts the in-flight bridge request', async () => {
  const controller = new AbortController();
  const calls = [];
  let rejectRequest;
  const transport = bridgeTransport((op, args) => {
    calls.push({ op, args });
    if (op === 'net.abort') {
      rejectRequest(new DOMException('Aborted', 'AbortError'));
      return Promise.resolve();
    }
    const request = new Promise((resolve, reject) => { rejectRequest = reject; });
    request.re = 42;
    return request;
  }, { url: '/local' });
  const response = await transport({}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(readSSE(response, () => {}), { name: 'AbortError' });
  assert.deepEqual(calls[1], { op: 'net.abort', args: { re: 42 } });
});
