import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { install } from '../src/harness/plugin.js';
import { parseConfig } from '../src/config.js';
import { toWireMessages } from '../src/harness/adapter.js';
import { server, engine, fixtureConfig, options, collect, simpleResponse, chatResponse } from './helpers.js';

for (const mode of ['off', 'shadow', 'auto'] as const) test(`${mode}: real local HTTP and accounted model dispatch`, async t => {
  const http = await server(); t.after(http.close);
  const { router, store, adapter } = engine(http.endpoint, mode); t.after(() => store.close());
  const decision = await router.request('session-1', 'strong', 1, 1);
  const selected = router.selectedRoute(decision).id;
  assert.equal(selected, mode === 'auto' ? 'economy' : 'strong');
  const chunks = await collect(adapter.stream(options(router, selected)));
  assert.equal(chunks.at(-1)?.type, 'finish'); assert.equal(chunks.at(-2)?.type, 'usage');
  assert.equal(http.requests.filter(r => r.url === '/jev').length, mode === 'off' ? 0 : 1);
  assert.equal(http.requests.at(-1)!.headers.authorization, 'Bearer synthetic-fixture-key');
  assert.ok(http.requests.at(-1)!.headers['user-agent']);
  assert.equal(store.decisions('task-1')[0]!.appliedRouteId, selected);
  assert.equal(store.budget('task-1').reserved, 0);
  assert.equal(store.budget('task-1').settled, mode === 'off' ? 1400 : mode === 'auto' ? 174 : 1434);
});

test('fixed model suppresses Jev and applies user choice in shadow mode', async t => {
  const http = await server(); t.after(http.close);
  const { router, store } = engine(http.endpoint, 'shadow'); t.after(() => store.close());
  router.fixRoute('session-1', 'economy');
  const d = await router.request('session-1', 'strong', 1, 1);
  assert.equal(router.selectedRoute(d).id, 'economy'); assert.equal(http.requests.length, 0);
});

test('reentrant requests share one Jev call, ordinary next step reuses the route', async t => {
  const http = await server(); t.after(http.close); const { router, store, adapter } = engine(http.endpoint); t.after(() => store.close());
  const [a, b] = await Promise.all([router.request('session-1', 'strong', 1, 1), router.request('session-1', 'strong', 1, 1)]);
  assert.equal(a.id, b.id); await collect(adapter.stream(options(router, 'economy')));
  const later = await router.request('session-1', 'economy', 1, 2);
  assert.equal(later.reason, 'keep_route'); assert.equal(http.requests.filter(r => r.url === '/jev').length, 1);
});

test('two validation failures escalate once and duplicate evidence does not count twice', async t => {
  const http = await server(); t.after(http.close); const { router, store, adapter } = engine(http.endpoint); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1); await collect(adapter.stream(options(router, 'economy')));
  const e = { eventId: 'ev1', repairAttemptId: 'repair1', goalId: 'goal', category: 'task_validation' as const, outcome: 'fail' as const, evidenceRef: 'test-run-1' };
  router.recordEvidence('session-1', e); router.recordEvidence('session-1', e);
  router.recordEvidence('session-1', { ...e, eventId: 'ev2', repairAttemptId: 'repair2' });
  const d = await router.request('session-1', 'economy', 1, 2); assert.equal(d.reason, 'capability_failure');
  await collect(adapter.stream(options(router, 'strong')));
  assert.equal(router.task('session-1').escalations, 1);
  const later = await router.request('session-1', 'strong', 1, 3); assert.equal(later.reason, 'keep_route');
});

test('Jev malformed judgment settles known usage and falls back', async t => {
  const http = await server((r, res) => res.end(JSON.stringify(r.url === '/jev' ? { usage: simpleResponse.usage } : chatResponse))); t.after(http.close);
  const { router, store } = engine(http.endpoint); t.after(() => store.close());
  const d = await router.request('session-1', 'strong', 1, 1); assert.equal(d.proposedRouteId, 'strong');
  assert.equal(store.budget('task-1').settled, 34); assert.equal(store.budget('task-1').reserved, 0);
});

test('Jev timeout falls back while retaining an unknown fee reservation', async t => {
  const http = await server((_r, _res) => {}); t.after(http.close);
  const config = fixtureConfig(http.endpoint); config.jev.timeoutMs = 30;
  const { router, store } = engine(http.endpoint, 'auto', config); t.after(() => store.close());
  const d = await router.request('session-1', 'strong', 1, 1); assert.equal(d.proposedRouteId, 'strong');
  assert.equal(store.budget('task-1').reserved, 2688); assert.equal(http.requests.length, 1);
});

test('cancellation during Jev never applies a fallback or starts an LLM', async t => {
  const ctrl = new AbortController();
  const http = await server(() => ctrl.abort()); t.after(http.close);
  const { router, store } = engine(http.endpoint); t.after(() => store.close());
  await assert.rejects(router.request('session-1', 'strong', 1, 1, ctrl.signal), /CANCELLED/);
  assert.equal(http.requests.length, 1); assert.equal(store.decisions('task-1').length, 0);
  assert.equal(store.budget('task-1').reserved, 2688);
});

test('steering invalidates an in-flight semantic result', async t => {
  let invalidate = () => {};
  const http = await server((_r, res) => { invalidate(); res.end(JSON.stringify(simpleResponse)); }); t.after(http.close);
  const { router, store } = engine(http.endpoint); t.after(() => store.close()); invalidate = () => router.invalidate('session-1');
  await assert.rejects(router.request('session-1', 'strong', 1, 1), /STALE_CONTEXT/);
  assert.equal(store.decisions('task-1').length, 0); assert.equal(store.budget('task-1').settled, 34);
});

test('budget and final capability recheck prevent network I/O', async t => {
  const http = await server(); t.after(http.close);
  const { router, store, adapter } = engine(http.endpoint, 'off'); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1);
  store.reserve('another-agent', 'task-1', 'llm', 990000);
  await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /BUDGET_DENIED/);
  assert.equal(http.requests.length, 0);
});

test('unknown LLM usage retains reserve and retries are bounded per step', async t => {
  const http = await server((_r, res) => res.end(JSON.stringify({ choices: chatResponse.choices }))); t.after(http.close);
  const { router, store, adapter } = engine(http.endpoint, 'off'); t.after(() => store.close());
  for (let attempt = 0; attempt < 3; attempt++) {
    await router.request('session-1', 'strong', 1, 1);
    await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /INVALID_USAGE/);
  }
  await router.request('session-1', 'strong', 1, 1);
  await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /ATTEMPT_LIMIT/);
  assert.equal(http.requests.length, 3); assert.ok(store.budget('task-1').reserved > 0);
});

test('unsupported reasoning, images and unpaired tools fail before sending', async t => {
  const http = await server(); t.after(http.close); const { router, store, adapter } = engine(http.endpoint, 'off'); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1);
  const request = options(router, 'strong'); request.maxTokens = 9000;
  await assert.rejects(collect(adapter.stream(request)), /UNSUPPORTED_OPTION/);
  assert.throws(() => toWireMessages([createAssistantMessage({ content: [{ type: 'reasoning', text: 'hidden' }],
    source: { provider: 'other', model: 'other' } })]), /UNSUPPORTED_MODALITY/);
  assert.throws(() => toWireMessages([createToolResultMessage({ callId: ToolCallId('missing'), content: [{ type: 'text', text: 'x' }], isError: false })]), /UNPAIRED_TOOL_HISTORY/);
  assert.equal(http.requests.length, 0);
});

test('tool-call IDs and raw JSON survive an economy-to-strong history projection', async t => {
  const http = await server(); t.after(http.close); const { router, store, adapter } = engine(http.endpoint, 'off'); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1);
  const request = options(router, 'strong'); const id = ToolCallId('tool-17');
  request.messages.push(createAssistantMessage({ content: [{ type: 'tool-call', id, name: 'read', arguments: '{"path":"a.ts"}' }],
    source: { provider: 'jev-router-economy', model: 'mock-economy' } }));
  request.messages.push(createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'export const a=1' }], isError: false }));
  await collect(adapter.stream(request));
  const messages = http.requests[0]!.body.messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
  assert.equal(messages[1]!.tool_calls![0]!.id, id); assert.equal(messages[2]!.tool_call_id, id);
});

test('multiple vendors can occupy one tier without selecting an unready route', async () => {
  const config = fixtureConfig('http://127.0.0.1');
  const third = structuredClone(config.routes[0]!); third.id = 'kimi-economy'; third.provider = 'jev-router-kimi'; third.vendor = 'kimi';
  config.routes.unshift(third); config.routes[0]!.ready = false;
  assert.equal(parseConfig(config).routes.length, 3);
});

test('native Cordis plugin mounts, routes through official LlmRuntime, and unmounts cleanly', async t => {
  const http = await server(); t.after(http.close); const { router, store } = engine(http.endpoint); t.after(() => store.close());
  const ctx = new Context(); const runtime = ctx.plugin(LlmRuntime); await runtime.await();
  const fiber = ctx.plugin({ name: 'router-test', inject: ['llm'], apply(c: Context) { install(c, router); } }); await fiber.await();
  const cancellation: unknown[] = [];
  const agent = { id: 'session-1', cancel: (cause: unknown) => cancellation.push(cause) } as unknown as Agent;
  const events = agentEvents(ctx, agent), signal = new AbortController().signal;
  const original = router.route('strong');
  const config = await events.waterfall('agent/request', { turn: 1, step: 1, signal }, async () => ({ provider: original.provider, model: original.model }));
  assert.equal(config.provider, router.route('economy').provider);
  const prepared = await ctx.llm.prepareCall(config, signal);
  const chunks = await collect(prepared.stream({ ...options(router, 'economy'), ...prepared.config }));
  assert.equal(chunks.at(-1)?.type, 'finish'); assert.equal(cancellation.length, 0);
  await fiber.dispose(); assert.equal(ctx.llm.listProviders().length, 0); assert.equal(ctx.get('jevRouter'), undefined);
  await runtime.dispose();
});
