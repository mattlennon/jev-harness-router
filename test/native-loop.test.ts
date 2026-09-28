import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { demo } from '../src/demo.js';
import { nativeRuntime } from '../src/testing/native-runtime.js';
import { server, engine, fixtureConfig } from './helpers.js';

test('runnable host example loads file-configured plugin and completes an official Agent turn', { timeout: 10000 }, async t => {
  const http = await server(); t.after(http.close);
  const dir = mkdtempSync(join(tmpdir(), 'jev-example-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true }); });
  const path = join(dir, 'router.json'); writeFileSync(path, JSON.stringify(fixtureConfig(http.endpoint)));
  const example = fileURLToPath(new URL('../../examples/agent.mjs', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [example, '--config', path, '--db', join(dir, 'ledger.sqlite'), '--prompt', 'Add JSDoc'],
    { env: { ...process.env, JEV_ROUTER_TEST_KEY: 'synthetic-fixture-key' } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.decisions[0].appliedRouteId, 'economy');
  assert.equal(report.budget.settled, 174);
  assert.ok(report.sessionEvents.some((e: { type: string }) => e.type === 'assistant/message'));
});

test('full official AgentLoop executes tools, preserves history, and escalates after two validated failures', { timeout: 10000 }, async () => {
  const result = await demo();
  assert.deepEqual(result.decisions.map(d => d.appliedRouteId), ['economy', 'economy', 'strong']);
  assert.deepEqual(result.decisions.map(d => d.reason), ['simple_task', 'keep_route', 'capability_failure']);
  assert.equal(result.escalationCount, 1);
  assert.equal(result.sessionEvents.filter(e => e.type === 'tool/result').length, 2);
  assert.equal(result.sessionEvents.filter(e => e.type === 'assistant/message').length, 3);
  const last = result.providerRequests.at(-1)!;
  const messages = last.messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['call-1', 'call-2']);
  assert.deepEqual(messages.filter(m => m.tool_calls).flatMap(m => m.tool_calls!.map(c => c.id)), ['call-1', 'call-2']);
  assert.equal(result.budget.reserved, 0);
  assert.equal(result.budget.settled, 1714);
});

test('full official AgentLoop stops on budget refusal without sending a model request', { timeout: 10000 }, async t => {
  const http = await server(); t.after(http.close);
  const config = fixtureConfig(http.endpoint, 'off'); config.budget.limitMicrousd = 1;
  const { router, store } = engine(http.endpoint, 'off', config);
  const runtime = await nativeRuntime(router);
  t.after(async () => { await runtime.close(); await router.shutdown(); store.close(); });
  const route = router.route('strong');
  const agent = await runtime.ctx.agentLoop.create(SessionId('session-1'), { provider: route.provider, model: route.model });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Add JSDoc' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(http.requests.length, 0);
  assert.equal(store.decisions('task-1')[0]?.status, 'held');
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1);
});
