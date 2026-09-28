import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationTemplate } from '../src/template.js';
import { parseConfig } from '../src/config.js';
import { runEvaluation } from '../src/evaluation.js';
import { RouterEngine } from '../src/engine.js';
import { fixtureConfig, server, engine, collect, options, chatResponse } from './helpers.js';

test('an active task cannot resume under changed model prices or policy configuration', async t => {
  const http = await server(); t.after(http.close);
  const { store } = engine(http.endpoint); t.after(() => store.close());
  const changed = fixtureConfig(http.endpoint); changed.routes[0]!.pricing.inputPerMillionUsd = 2;
  const restarted = new RouterEngine(changed, store);
  await assert.rejects(restarted.request('session-1', 'strong', 1, 1), /TASK_CONFIG_CHANGED/);
  assert.equal(http.requests.length, 0);
});

test('production template lists DeepSeek, Kimi and ChatGLM without claiming readiness', () => {
  const config = parseConfig(configurationTemplate());
  assert.deepEqual(new Set(config.routes.map(r => r.vendor)), new Set(['deepseek', 'kimi', 'zhipu']));
  assert.ok(config.routes.every(r => !r.ready && r.capabilities.compatibleFrom.length === 0));
  assert.equal(config.mode, 'shadow'); assert.equal(config.jev.allowStateTransmission, false);
  const reasoning = parseConfig(configurationTemplate(true));
  assert.ok(reasoning.routes.filter(r => r.tier === 'strong').every(r => r.reasoning && r.transport === 'sse' && !r.ready));
});

test('vendor-specific non-thinking options reach the wire without leaking environment values', async t => {
  const http = await server(); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.vendor = 'kimi'; cfg.routes[1]!.requestOptions = { thinking: { type: 'disabled' } };
  const { router, adapter, store } = engine(http.endpoint, 'off', cfg); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1); await collect(adapter.stream(options(router, 'strong')));
  assert.deepEqual(http.requests[0]!.body.thinking, { type: 'disabled' });
  assert.ok(!JSON.stringify(http.requests[0]!.body).includes('synthetic-fixture-key'));
});

test('unverified cross-vendor transition is filtered out', async t => {
  const http = await server(); t.after(http.close); const cfg = fixtureConfig(http.endpoint);
  cfg.routes[1]!.capabilities.compatibleFrom = [];
  const { router, adapter, store } = engine(http.endpoint, 'auto', cfg); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1); await collect(adapter.stream(options(router, 'economy')));
  for (const i of [1, 2]) router.recordEvidence('session-1', { eventId: `e${i}`, repairAttemptId: `r${i}`, goalId: 'g',
    category: 'task_validation', outcome: 'fail', evidenceRef: 'assertions' });
  await assert.rejects(router.request('session-1', 'economy', 1, 2), /NO_ELIGIBLE_ROUTE/);
  assert.equal(http.requests.filter(r => r.url === '/strong').length, 0);
});

test('a conflicting route is logged as superseded and never sent', async t => {
  const http = await server(); t.after(http.close); const { router, adapter, store } = engine(http.endpoint); t.after(() => store.close());
  const d = await router.request('session-1', 'strong', 1, 1);
  await assert.rejects(collect(adapter.stream(options(router, 'strong'))), /ROUTE_CONFLICT/);
  assert.equal(store.decision(d.id).status, 'superseded'); assert.equal(http.requests.length, 1);
});

test('shutdown aborts a pending provider request and preserves uncertain accounting', async t => {
  let onRequest!: () => void; const requested = new Promise<void>(r => { onRequest = r; });
  const http = await server(() => onRequest()); t.after(http.close);
  const { router, adapter, store } = engine(http.endpoint, 'off'); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1);
  const running = collect(adapter.stream(options(router, 'strong')));
  const rejected = assert.rejects(running, /CANCELLED/);
  await requested; await router.shutdown(); await rejected;
  assert.ok(store.budget('task-1').reserved > 0);
});

test('cache and reasoning usage are not double-counted', async t => {
  const http = await server((_r, res) => res.end(JSON.stringify({ ...chatResponse,
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } } }))); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.routes[1]!.pricing.cacheReadPerMillionUsd = 1;
  const { router, adapter, store } = engine(http.endpoint, 'off', cfg); t.after(() => store.close());
  await router.request('session-1', 'strong', 1, 1); await collect(adapter.stream(options(router, 'strong')));
  assert.equal(store.budget('task-1').settled, 20 * 10 + 80 * 1 + 20 * 20);
});

test('evaluation includes failed tasks and unresolved fee caps in cost per success', async () => {
  const report = await runEvaluation([
    { id: 'a', language: 'en', prompt: 'a', fixture: {}, expected: true },
    { id: 'b', language: 'en', prompt: 'b', fixture: {}, expected: true },
  ], async task => ({ success: task.id === 'a', costMicrousd: 100, pendingMicrousd: task.id === 'b' ? 50 : 0, elapsedMs: 1, evidence: ['test'] }),
  { synthetic: true, seed: 1 });
  assert.equal(report.rows.length, 8);
  assert.ok(report.summary.every(r => r.costPerSuccessMicrousd === 250 && r.successRate === 0.5));
});
