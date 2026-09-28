import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { server, fixtureConfig, collect, options, simpleResponse, chatResponse } from './testing/fixtures.js';
import { Store } from './storage.js';
import { RouterEngine } from './engine.js';
import { nativeRuntime } from './testing/native-runtime.js';
import { GuardedChatAdapter } from './harness/adapter.js';
import { runEvaluation } from './evaluation.js';

export async function demo() {
  let calls = 0;
  const http = await server((request, response) => {
    if (request.url === '/jev') { response.end(JSON.stringify(simpleResponse)); return; }
    calls++;
    const value = calls <= 2 ? {
      choices: [{ message: { content: null, tool_calls: [{ id: `call-${calls}`, type: 'function',
        function: { name: 'validate_fixture', arguments: JSON.stringify({ repair: String(calls) }) } }] }, finish_reason: 'tool_calls' }],
      usage: chatResponse.usage,
    } : chatResponse;
    response.setHeader('Content-Type', 'text/event-stream'); response.setHeader('x-request-id', `demo-${calls}`);
    const choice = value.choices[0]!;
    response.write(`data: ${JSON.stringify({ id: `demo-response-${calls}`, choices: [{ delta: choice.message, finish_reason: choice.finish_reason }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: value.usage })}\n\n`); response.end('data: [DONE]\n\n');
  });
  const db = new Store(':memory:');
  process.env.JEV_ROUTER_TEST_KEY = 'synthetic-fixture-key';
  const config = fixtureConfig(http.endpoint); config.routes.forEach(r => { r.transport = 'sse'; });
  const engine = new RouterEngine(config, db);
  const runtime = await nativeRuntime(engine); const { ctx } = runtime;
  try {
    ctx.tools.register(defineTool({ name: 'validate_fixture', description: 'Run a deterministic synthetic validation fixture',
      parameters: { repair: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        // The host validator owns outcomes; the model only requests a check.
        engine.recordEvidence('session-1', { eventId: `failure-${args.repair}`, repairAttemptId: `repair-${args.repair}`,
          goalId: 'demo-validator', category: 'task_validation', outcome: 'fail', evidenceRef: `synthetic-check-${args.repair}` });
        return 'Synthetic validation failed';
      },
    }));
    const original = engine.route('strong');
    const agent = await ctx.agentLoop.create(SessionId('session-1'), { provider: original.provider, model: original.model });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '为函数添加 JSDoc 注释' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const state = engine.task('session-1');
    return { synthetic: true, runtime: 'official Cordis, AgentLoop, session projection, ToolRuntime and LlmRuntime; local mock HTTP providers',
      transport: 'sse', decisions: db.decisions(state.id), attempts: db.attempts(state.id), budget: db.budget(state.id), escalationCount: engine.task('session-1').escalations,
      providerRequests: http.requests.map(r => ({ endpoint: r.url, model: r.body.model, messages: r.body.messages })),
      sessionEvents: agent.session.snapshotEvents(),
      note: '模拟响应与价格，仅证明请求链路、升级与预算行为；不代表真实模型质量或降本。' };
  } finally { await runtime.close(); await engine.shutdown(); db.close(); await http.close(); }
}

export async function demoEvaluation() {
  const http = await server(); process.env.JEV_ROUTER_TEST_KEY = 'synthetic-fixture-key';
  try {
    return await runEvaluation([
      { id: 'doc-zh', language: 'zh-CN', prompt: '为函数补充 JSDoc 注释', fixture: {}, expected: '完成了注释修改。' },
      { id: 'doc-en', language: 'en', prompt: 'Add JSDoc documentation', fixture: {}, expected: '完成了注释修改。' },
    ], async (task, group) => {
      const store = new Store(':memory:'); const cfg = fixtureConfig(http.endpoint, group.startsWith('fixed') ? 'off' : 'auto');
      const engine = new RouterEngine(cfg, store, fetch, group === 'rules' ? 'rules' : 'jev');
      const state = engine.beginTask('session-1', task.prompt, { taskId: task.id, language: task.language,
        ...(group.startsWith('fixed') ? { fixedRouteId: group === 'fixed-economy' ? 'economy' : 'strong' } : {}) });
      const start = performance.now();
      try {
        const d = await engine.request('session-1', 'strong', 1, 1);
        const chunks = await collect(new GuardedChatAdapter(engine).stream(options(engine, engine.selectedRoute(d).id)));
        const text = chunks.filter(c => c.type === 'text-delta').map(c => c.type === 'text-delta' ? c.text : '').join('');
        const budget = store.budget(state.id);
        return { success: text === task.expected, costMicrousd: budget.settled, pendingMicrousd: budget.reserved,
          elapsedMs: Math.round(performance.now() - start), evidence: ['exact-match-local-fixture', d.id] };
      } finally { await engine.shutdown(); store.close(); }
    }, { synthetic: true, seed: 1729 });
  } finally { await http.close(); }
}
