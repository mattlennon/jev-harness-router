import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { decodeSse } from '../src/sse.js';
import { nativeRuntime } from '../src/testing/native-runtime.js';
import { server, engine, fixtureConfig, options, collect } from './helpers.js';
import { prepareWire } from '../src/wire.js';
import { parseConfig } from '../src/config.js';

const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } };
function emit(res: ServerResponse, value: unknown) { res.write(`data: ${JSON.stringify(value)}\n\n`); }
function start(res: ServerResponse) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('x-request-id', 'request-123'); }
function end(res: ServerResponse) { res.end('data: [DONE]\n\n'); }

test('SSE parser handles split UTF-8, CRLF, comments and multiline data; rejects missing DONE', async () => {
  const bytes = Buffer.from(': comment\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.deepEqual(await collect(decodeSse(stream, new AbortController().signal)), [{ text: '中文' }]);
  const missing = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('data: {}\n\n')); c.close(); } });
  await assert.rejects(collect(decodeSse(missing, new AbortController().signal)), /STREAM_TRUNCATED/);
});

test('SSE yields content before server completion and settles final usage once', { timeout: 10000 }, async t => {
  let response!: ServerResponse;
  const http = await server((_req, res) => { response = res; start(res); emit(res, { id: 'response-1', choices: [{ delta: { content: 'first' } }] }); });
  t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.transport = 'sse'; cfg.routes[1]!.pricing.cacheReadPerMillionUsd = 1;
  const { router, store, adapter } = engine(http.endpoint, 'off', cfg); t.after(async () => { await router.shutdown(); store.close(); });
  await router.request('session-1', 'strong', 1, 1);
  const iter = adapter.stream(options(router, 'strong'))[Symbol.asyncIterator]();
  assert.equal((await iter.next()).value?.type, 'block-start');
  assert.deepEqual((await iter.next()).value, { type: 'text-delta', index: 0, text: 'first' });
  assert.equal(store.budget('task-1').settled, 0); assert.ok(store.budget('task-1').reserved > 0);
  emit(response, { choices: [{ delta: { content: ' second' }, finish_reason: 'stop' }] });
  emit(response, { choices: [], usage }); end(response);
  const rest = []; for (let v = await iter.next(); !v.done; v = await iter.next()) rest.push(v.value);
  assert.equal(rest.at(-1)?.type, 'finish'); assert.equal(store.budget('task-1').settled, 1040);
  const a = store.attempts('task-1')[0]!; assert.equal(a.status, 'completed'); assert.equal(a.usageFinal, true);
  assert.equal(a.usage?.outputTokens, 20); assert.equal(a.usage?.reasoningTokens, 10); assert.equal(a.requestId, 'request-123');
  assert.equal(a.responseId, 'response-1'); assert.ok(a.firstTokenMs !== undefined); assert.equal(store.pendingAttempts().length, 0);
});

for (const finalUsage of [false, true]) test(`cancel suspended stream with finalUsage=${finalUsage} keeps correct liability`, { timeout: 10000 }, async t => {
  const http = await server((_req, res) => { start(res); emit(res, { id: 'response-cancel', choices: [{ delta: { content: 'partial' }, ...(finalUsage ? { finish_reason: 'stop' } : {}) }], usage }); });
  t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.transport = 'sse';
  const { router, store, adapter } = engine(http.endpoint, 'off', cfg); t.after(async () => { await router.shutdown(); store.close(); });
  await router.request('session-1', 'strong', 1, 1); const abort = new AbortController();
  const iter = adapter.stream(options(router, 'strong', abort.signal))[Symbol.asyncIterator]();
  await iter.next(); await iter.next(); abort.abort();
  const a = store.attempts('task-1')[0]!;
  assert.equal(a.status, 'cancelled'); assert.equal(a.usageFinal, finalUsage);
  assert.equal(store.budget('task-1').settled, finalUsage ? 1400 : 0);
  if (!finalUsage) {
    assert.ok(store.budget('task-1').reserved > 0); assert.equal(store.pendingAttempts().length, 1);
    assert.throws(() => store.reconcile(a.id, 700, 'invoice-line-1', 'wrong'), /RECEIPT_REQUEST_MISMATCH/);
    store.reconcile(a.id, 700, 'invoice-line-1', 'request-123'); store.reconcile(a.id, 700, 'invoice-line-1', 'request-123');
    assert.throws(() => store.reconcile(a.id, 701, 'invoice-line-1', 'request-123'), /SETTLEMENT_CONFLICT/);
    assert.equal(store.budget('task-1').settled, 700); assert.equal(store.pendingAttempts().length, 0);
  }
  await assert.rejects(iter.next(), /CANCELLED/); assert.equal(http.requests.length, 1);
});

for (const finalUsage of [false, true]) test(`truncated stream with finalUsage=${finalUsage} never reports successful completion`, async t => {
  const http = await server((_req, res) => { start(res); emit(res, { choices: [{ delta: { content: 'partial' }, ...(finalUsage ? { finish_reason: 'stop' } : {}) }], usage }); res.end(); });
  t.after(http.close); const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.transport = 'sse';
  const { router, store, adapter } = engine(http.endpoint, 'off', cfg); t.after(async () => { await router.shutdown(); store.close(); });
  await router.request('session-1', 'strong', 1, 1); await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /STREAM_TRUNCATED/);
  assert.equal(store.attempts('task-1')[0]!.status, 'failed');
  assert.equal(store.budget('task-1').settled, finalUsage ? 1400 : 0);
  assert.equal(store.pendingAttempts().length, finalUsage ? 0 : 1);
});

test('shutdown finalizes a suspended stream before closing its database', { timeout: 10000 }, async t => {
  const http = await server((_req, res) => { start(res); emit(res, { choices: [{ delta: { content: 'partial' } }] }); }); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.transport = 'sse';
  const { router, store, adapter } = engine(http.endpoint, 'off', cfg);
  await router.request('session-1', 'strong', 1, 1); const iter = adapter.stream(options(router, 'strong'))[Symbol.asyncIterator]();
  await iter.next(); await router.shutdown(); assert.equal(store.attempts('task-1')[0]!.status, 'cancelled');
  store.close(); await assert.rejects(iter.next(), /CANCELLED/);
});

for (const profile of ['deepseek', 'kimi', 'zhipu'] as const) test(`${profile}: official AgentLoop streams reasoning, executes fragmented tools, and replays reasoning exactly`, { timeout: 10000 }, async t => {
  let count = 0, executed = 0;
  const http = await server((_req, res) => {
    start(res); count++;
    emit(res, { choices: [{ delta: { reasoning_content: '检查输入。' } }] });
    if (count === 1) {
      emit(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo_', arguments: '{"value":' } }] } }] });
      emit(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'fixture', arguments: '"ok"}' } }] }, finish_reason: 'tool_calls' }] });
    } else emit(res, { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] });
    emit(res, { choices: [], usage }); end(res);
  }); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'), route = cfg.routes[1]!;
  route.transport = 'sse'; route.vendor = profile; route.reasoning = { profile };
  const { router, store } = engine(http.endpoint, 'off', cfg); const runtime = await nativeRuntime(router);
  t.after(async () => { await runtime.close(); await router.shutdown(); store.close(); });
  runtime.ctx.tools.register(defineTool({ name: 'echo_fixture', description: 'Echo', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] }, async execute(args) { executed++; return args.value; } }));
  const agent = await runtime.ctx.agentLoop.create(SessionId('session-1'), { provider: route.provider, model: route.model });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Echo ok' }], source: { kind: 'user' } })); await agent.whenIdle();
  assert.equal(count, 2); assert.equal(executed, 1);
  const body = http.requests[1]!.body;
  const messages = body.messages as { role: string; reasoning_content?: string; tool_call_id?: string }[];
  assert.equal(messages.find(m => m.role === 'assistant')?.reasoning_content, '检查输入。');
  assert.equal(messages.find(m => m.role === 'tool')?.tool_call_id, 'call-1');
  assert.deepEqual(body.thinking, { type: 'enabled', ...(profile === 'zhipu' ? { clear_thinking: false } : profile === 'kimi' ? { keep: 'all' } : {}) });
  assert.equal(store.budget('task-1').settled, 2800); assert.equal(store.pendingAttempts().length, 0);
  assert.equal(store.attempts('task-1').filter(a => a.status === 'completed').length, 2);
});

test('Kimi always-thinking and K3 profiles omit thinking; K3 maps effort explicitly', () => {
  for (const mode of ['always', 'k3'] as const) {
    const cfg = fixtureConfig('http://localhost', 'off'), route = cfg.routes[1]!;
    route.vendor = 'kimi'; route.reasoning = { profile: 'kimi', kimiMode: mode };
    const body = prepareWire(route, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, cfg).body;
    assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, mode === 'k3' ? 'high' : undefined);
    route.requestOptions.thinking = { type: 'enabled' }; assert.throws(() => parseConfig(cfg));
  }
});

test('GLM reasoning effort is opt-in per verified model, without changing preserved thinking', () => {
  const cfg = fixtureConfig('http://localhost', 'off'), route = cfg.routes[1]!;
  route.vendor = 'zhipu'; route.reasoning = { profile: 'zhipu', effort: 'low' };
  const body = prepareWire(route, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, parseConfig(cfg)).body;
  assert.equal(body.reasoning_effort, 'low'); assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false });
});

test('conflicting final usage fails without overwriting the settled telemetry', async t => {
  const http = await server((_req, res) => { start(res);
    emit(res, { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage });
    emit(res, { choices: [], usage: { ...usage, completion_tokens: 21 } }); end(res);
  }); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.transport = 'sse';
  const { router, store, adapter } = engine(http.endpoint, 'off', cfg); t.after(async () => { await router.shutdown(); store.close(); });
  await router.request('session-1', 'strong', 1, 1);
  await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /SETTLEMENT_CONFLICT/);
  assert.equal(store.budget('task-1').settled, 1400); const a = store.attempts('task-1')[0]!;
  assert.equal(a.actualMicrousd, 1400); assert.equal(a.usage?.outputTokens, 20); assert.equal(a.status, 'failed');
});
