import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { RouterConfig } from '../src/config.js';
import { planRoute, recordCache, namespace } from '../src/planner.js';
import { prepareWire } from '../src/wire.js';
import { routeReservation } from '../src/money.js';
import { candidates, needsEscalation } from '../src/policy.js';
import { checkpoint } from '../src/harness/context.js';
import { nativeRuntime } from '../src/testing/native-runtime.js';
import { server, fixtureConfig, engine, options, collect, chatResponse } from './helpers.js';

const optimization: NonNullable<RouterConfig['optimization']> = { costAware: false, minimumQuality: 0.9, switchMarginMicrousd: 100,
  minResidenceSteps: 2, upgradeReserveMicrousd: 0, toolResultMaxChars: 1024, retainRecentToolResults: 0 };

test('whole-request preflight rejects context before Jev and reservation and records causes', async t => {
  const http = await server(); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint); cfg.routes.forEach(r => { r.capabilities.contextWindow = 600; });
  const { router, store } = engine(http.endpoint, 'auto', cfg); t.after(() => store.close());
  await assert.rejects(router.request('session-1', 'strong', 1, 1, undefined, { ...options(router, 'strong'), system: 'x'.repeat(800) }), /NO_ELIGIBLE_ROUTE/);
  assert.equal(http.requests.length, 0); assert.equal(store.budget('task-1').reserved, 0);
  assert.equal(store.decisions('task-1')[0]!.status, 'held');
  assert.ok(store.decisions('task-1')[0]!.preflightRejected?.every(r => r.code === 'CONTEXT_LIMIT'));
});

test('cost planning chooses cheaper qualified economy and switch hysteresis prevents a small cold change', async t => {
  const http = await server(); t.after(http.close); const cfg = fixtureConfig(http.endpoint);
  cfg.optimization = { ...optimization, costAware: true, switchMarginMicrousd: 10000 };
  const cheaper = structuredClone(cfg.routes[0]!); cheaper.id = 'cheap'; cheaper.provider = 'jev-router-cheap'; cheaper.model = 'mock-cheap';
  cheaper.pricing.inputPerMillionUsd = 0.5; cheaper.pricing.outputPerMillionUsd = 1; cfg.routes.push(cheaper);
  cfg.routes.forEach(r => { r.performance = { expectedOutputTokens: 40, remainingCalls: 3, qualityLowerBound: 0.95, reportId: 'synthetic-quality' }; r.capabilities.compatibleFrom = cfg.routes.map(x => x.id); });
  const { router, store, adapter } = engine(http.endpoint, 'auto', cfg); t.after(async () => { await router.shutdown(); store.close(); });
  const request = options(router, 'strong');
  let d = await router.request('session-1', 'strong', 1, 1, undefined, request);
  assert.equal(d.proposedRouteId, 'cheap'); assert.equal(d.estimates?.length, 3); assert.ok(d.contextHash);
  // Establish a different route via the explicit host override, then return to auto.
  router.fixRoute('session-1', 'economy'); await router.request('session-1', 'strong', 1, 1, undefined, request);
  await collect(adapter.stream(options(router, 'economy'))); router.fixRoute('session-1', null);
  router.updateTask('session-1', { phase: 'documentation' });
  d = await router.request('session-1', 'strong', 1, 2, undefined, request);
  assert.equal(d.proposedRouteId, 'economy'); assert.equal(d.reason, 'switch_not_worthwhile');
  const lowQuality = structuredClone(cfg); lowQuality.routes[2]!.performance!.qualityLowerBound = 0.5;
  assert.ok(!candidates(lowQuality, store.budget('task-1')).some(r => r.id === 'cheap'));
});

test('cache estimates require observed exact prefix and are isolated by model, key, tools and TTL', t => {
  const { router, store } = engine('http://localhost'); t.after(() => store.close());
  const cfg = structuredClone(router.config), route = cfg.routes[0]!; route.pricing.cacheReadPerMillionUsd = 0.1;
  const input = options(router, 'economy'), wire = prepareWire(route, input, cfg);
  assert.equal(planRoute(cfg, route, input, store).cachedTokens, 0);
  recordCache(route, wire, { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10 }, store);
  const warm = planRoute(cfg, route, input, store); assert.ok(warm.cachedTokens > 0);
  const extended = { ...input, messages: [...input.messages, createUserMessage({ content: [{ type: 'text', text: 'Next' }], source: { kind: 'user' } })] };
  assert.ok(planRoute(cfg, route, extended, store).cachedTokens > 0);
  assert.equal(planRoute(cfg, { ...route, model: 'different' }, input, store).cachedTokens, 0);
  assert.equal(planRoute(cfg, route, { ...input, tools: [{ name: 'new_tool', description: 'new', parameters: { type: 'object' } }] }, store).cachedTokens, 0);
  const oldKey = process.env.JEV_ROUTER_TEST_KEY; process.env.JEV_ROUTER_TEST_KEY = 'rotated';
  assert.equal(planRoute(cfg, route, input, store).cachedTokens, 0); process.env.JEV_ROUTER_TEST_KEY = oldKey;
  const prior = store.cache(namespace(route))[0]!; store.observeCache({ ...prior, at: Date.now() - 600000 });
  assert.equal(planRoute(cfg, route, input, store).cachedTokens, 0);
});

test('verified request bound reduces reservation; fallback remains full-window and upgrade floor is atomic', t => {
  const cfg = fixtureConfig('http://localhost', 'off'); cfg.optimization = { ...optimization, upgradeReserveMicrousd: 800 };
  const { router, store } = engine('http://localhost', 'off', cfg); t.after(() => store.close());
  const route = structuredClone(router.route('economy')), input = options(router, 'economy');
  assert.equal(planRoute(cfg, route, input, store).reserveMicrousd, routeReservation(route));
  route.tokenBound = { tokensPerByte: 1, overheadTokens: 128, verificationRef: 'synthetic-bound' };
  assert.ok(planRoute(cfg, route, input, store).reserveMicrousd < routeReservation(route));
  const remaining = store.budget('task-1').available;
  assert.throws(() => store.reserve('denied', 'task-1', 'llm', remaining - 799, 800), /BUDGET_DENIED/);
  assert.equal(store.budget('task-1').reserved, 0);
  store.reserve('ok', 'task-1', 'llm', remaining - 800, 800); assert.equal(store.budget('task-1').available, 800);
});

test('goal updates preserve liability and escalation; whole classification state remains bounded', async t => {
  const http = await server(); t.after(http.close);
  const { router, store, adapter } = engine(http.endpoint); t.after(async () => { await router.shutdown(); store.close(); });
  await router.request('session-1', 'strong', 1, 1); await collect(adapter.stream(options(router, 'economy')));
  const before = store.budget('task-1'); const old = router.task('session-1');
  store.update(old.id, old.revision, s => { s.escalations = 1; });
  router.updateTask('session-1', { text: '新的文档目标', phase: 'review', facts: Array.from({ length: 32 }, () => '中'.repeat(1000)) });
  assert.equal(router.task('session-1').escalations, 1); assert.deepEqual(store.budget('task-1'), before);
  await assert.rejects(router.request('session-1', 'strong', 2, 1), /NO_ELIGIBLE_ROUTE/);
  const d = store.decisions('task-1').at(-1)!;
  const state = http.requests.filter(r => r.url === '/jev').at(-1)!.body.state as { task: string; truncated: boolean };
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= router.config.jev.maxStateBytes);
  assert.equal(state.task, '新的文档目标'); assert.equal(state.truncated, true); assert.equal(d.reason, 'escalation_limit');
  assert.equal(router.task('session-1').escalations, 1); assert.throws(() => router.updateTask('session-1', { text: '' }), /TASK_INPUT_REQUIRED/);
});

test('escalation threshold can be calibrated per task kind and still ignores transport failures', t => {
  const cfg = fixtureConfig('http://localhost'); cfg.optimization = { ...optimization, failureThresholds: { documentation: 3, local_edit: 2, debugging: 1, design: 1, unknown: 2 } };
  const { router, store } = engine('http://localhost', 'auto', cfg); t.after(() => store.close()); const task = router.task('session-1');
  task.currentRouteId = 'economy'; task.taskKind = 'debugging';
  task.evidence = [{ eventId: '1', repairAttemptId: '1', goalId: 'goal', outcome: 'fail', category: 'transport', evidenceRef: 'test' }];
  assert.equal(needsEscalation(task, cfg), false); task.evidence[0]!.category = 'task_validation'; assert.equal(needsEscalation(task, cfg), true);
  task.taskKind = 'documentation'; assert.equal(needsEscalation(task, cfg), false);
});

test('native compaction preserves paired tool history and originals; checkpoint enables a reasoning-safe switch', { timeout: 10000 }, async t => {
  let calls = 0; const originalText = 'HEADER\n' + 'x'.repeat(10000) + '\nTAIL';
  const http = await server((_req, res) => {
    calls++;
    res.end(JSON.stringify(calls === 1 ? { choices: [{ message: { reasoning_content: '原始思考', content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'large_fixture', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: chatResponse.usage }
      : { ...chatResponse, choices: [{ message: { reasoning_content: '确认工具结果', content: '完成' }, finish_reason: 'stop' }] }));
  }); t.after(http.close);
  const cfg = fixtureConfig(http.endpoint, 'off'); cfg.optimization = { ...optimization };
  const route = cfg.routes[1]!; route.vendor = 'deepseek'; route.reasoning = { profile: 'deepseek' };
  const { router, store } = engine(http.endpoint, 'off', cfg), runtime = await nativeRuntime(router);
  t.after(async () => { await runtime.close(); await router.shutdown(); store.close(); });
  runtime.ctx.tools.register(defineTool({ name: 'large_fixture', description: 'Large log', parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, async execute() { return originalText; } }));
  const agent = await runtime.ctx.agentLoop.create(SessionId('session-1'), { provider: route.provider, model: route.model });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read log' }], source: { kind: 'user' } })); await agent.whenIdle();
  assert.equal(calls, 2);
  const last = http.requests[1]!.body.messages as { role: string; content: string; tool_call_id?: string }[];
  const tool = last.find(m => m.role === 'tool')!; assert.equal(tool.tool_call_id, 'call-1'); assert.ok(tool.content.length <= 1024);
  const id = /\[jev-context:([a-f0-9]+)/.exec(tool.content)![1]!;
  assert.equal(store.artifact(id, 'task-1'), originalText); assert.throws(() => store.artifact(id, 'other-task'), /ARTIFACT_NOT_FOUND/);
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'tool/result' && JSON.stringify(e.data).includes('x'.repeat(10000))));
  const input = { messages: agent.session.deriveMessages() };
  assert.throws(() => prepareWire(router.route('economy'), input, router.config), /REASONING_HISTORY_INCOMPATIBLE/);
  const nodes = [...agent.session.surface.nodes];
  const covered = nodes.filter(seq => { const e = agent.session.snapshotEvents().find(e => e.seq === seq)!; return e.type !== 'system/message' && e.type !== 'developer/message'; });
  const value = { goal: 'Review log', facts: ['Log inspected'], changes: [], tests: ['fixture passed'], unresolved: [], evidenceRef: 'test-report' };
  const before = agent.session.snapshotEvents().length;
  assert.throws(() => checkpoint(agent, router, covered, { ...value, facts: ['x'.repeat(1001)] }), /TASK_FACTS_TOO_LARGE/);
  assert.equal(agent.session.snapshotEvents().length, before);
  const toolSeq = covered.find(seq => agent.session.snapshotEvents().find(e => e.seq === seq)?.type === 'tool/result')!;
  assert.throws(() => checkpoint(agent, router, [toolSeq], value), /CHECKPOINT_UNPAIRED_TOOLS/);
  runtime.ctx.jevRouter.checkpoint(agent, covered, value);
  assert.doesNotThrow(() => prepareWire(router.route('economy'), { messages: agent.session.deriveMessages() }, router.config));
  assert.ok(agent.session.snapshotEvents().some(e => JSON.stringify(e.data).includes('原始思考')));
  assert.equal(router.task('session-1').text, 'Review log'); assert.equal(store.budget('task-1').reserved, 0);
});
