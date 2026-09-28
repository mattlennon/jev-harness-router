import { readFileSync } from 'node:fs';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { Checkpoint } from './context.js';
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactToolResults, checkpoint } from './context.js';
import { invariant } from '../domain.js';
import { z } from 'zod';
import { RouterEngine } from '../engine.js';
import { Store } from '../storage.js';
import { GuardedChatAdapter } from './adapter.js';
import { checkAbort, RouterError } from '../domain.js';

declare module '@deepseek-ai/cordis' { interface Context { jevRouter: RouterService } }
export class RouterService extends Service {
  constructor(ctx: Context, readonly engine: RouterEngine) { super(ctx, 'jevRouter'); }
  checkpoint(agent: Agent, covered: SessionSeq[], value: Checkpoint): void { checkpoint(agent, this.engine, covered, value); }
}
export const name = 'jev-harness-router';
export const inject = ['llm', 'tools'];
const pluginConfig = z.object({ routerConfigFile: z.string().min(1), databaseFile: z.string().min(1) }).strict();
export const Config = pluginConfig;
export type PluginConfig = z.infer<typeof pluginConfig>;

export function install(ctx: Context, engine: RouterEngine): void {
  new RouterService(ctx, engine);
  ctx.llm.registerAdapter(engine.config.routes.map(r => r.provider), new GuardedChatAdapter(engine));
  const assemblies = new WeakMap<object, PromptAssembly>(), pending = new WeakMap<object, UserMessage[]>();
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next(); if (context.scope) assemblies.set(context.scope, result); return result;
  }, { prepend: true });
  const tools = ctx.get('tools');
  if (tools && engine.config.optimization) tools.register(defineTool({ name: 'router_read_context', description: 'Read an original tool-result excerpt retained by the router. Offset and length are character counts.',
    parameters: { id: { type: 'string', required: true }, offset: { type: 'integer', required: true }, length: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      invariant(execution.agent, 'TASK_NOT_BOUND');
      invariant(args.offset >= 0 && args.length > 0 && args.length <= 8000, 'INVALID_ARTIFACT_RANGE');
      return engine.store.artifact(args.id, engine.task(execution.agent.id).id).slice(args.offset, args.offset + args.length);
    },
  }));
  ctx.on('agent/pre-step', async (payload, next) => {
    const accepted = await next(); checkAbort(payload.signal);
    if (accepted.kind === 'reject') return accepted;
    const task = engine.store.bound(payload.agent.id);
    if (!task && !engine.config.routes.some(r => r.provider === payload.agent.options.provider)) return accepted;
    if (!task) {
      const text = accepted.messages.filter(m => m.source.kind === 'user')
        .flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '')).join('\n');
      if (!text.trim()) throw new RouterError('TASK_INPUT_REQUIRED');
      engine.beginTask(payload.agent.id, text, { taskId: `session:${payload.agent.id}` });
    } else {
      const latest = accepted.messages.filter(m => m.source.kind === 'user').flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '')).join('\n');
      if (latest.trim()) engine.updateTask(payload.agent.id, { facts: [...(task.facts ?? []).filter(f => !f.startsWith('最新用户输入：')).slice(-30), `最新用户输入：${latest.slice(0, 980)}`] });
    }
    pending.set(payload.agent, accepted.messages);
    if (tools && engine.config.optimization) compactToolResults(payload.agent, engine);
    return accepted;
  }, { prepend: true });
  ctx.on('agent/inbox/inserted', ({ agent }) => engine.invalidate(agent.id));
  ctx.on('agent/request', async (payload, next) => {
    const original = await next(); checkAbort(payload.signal);
    if (!engine.store.bound(payload.agent.id) && !engine.config.routes.some(r => r.provider === original.provider)) return original;
    try {
      const source = engine.routeFor(original.provider, original.model);
      const assembly = assemblies.get(payload.agent);
      const history = payload.agent.session?.deriveMessages();
      const added = (pending.get(payload.agent) ?? []).filter(m => !history?.some(h => h.id === m.id));
      const snapshot = history ? { ...original, messages: [...(assembly ? history.filter(m => m.role !== 'system') : history), ...added],
        ...(assembly ? { system: renderPrompt(assembly), tools: assembly.tools } : {}) } : undefined;
      const decision = await engine.request(payload.agent.id, source.id, payload.turn, payload.step, payload.signal, snapshot);
      const target = engine.selectedRoute(decision);
      // Explicit unsupported settings are rejected by the adapter; never silently stripped.
      const result: LlmCallConfig = { ...original, provider: target.provider, model: target.model };
      return result;
    } catch (error) {
      if (error instanceof RouterError) payload.agent.cancel({ kind: 'hook', reason: error.code }, { keepInbox: true });
      throw error;
    }
  }, { prepend: true });
  ctx.on('agent/request-error', async (payload, next) => {
    if (!engine.store.bound(payload.agent.id) && !engine.config.routes.some(r => r.provider === payload.agent.options.provider)) return next();
    const terminal = new Set(['BUDGET_DENIED', 'BUDGET_OVERRUN', 'INVALID_USAGE', 'ATTEMPT_LIMIT', 'STALE_CONTEXT', 'ROUTE_CONFLICT', 'CONTEXT_LIMIT', 'ROUTER_FAILURE']);
    if (terminal.has(payload.failure.code)) {
      payload.agent.cancel({ kind: 'hook', reason: payload.failure.code }, { keepInbox: true });
      return undefined;
    }
    return next();
  });
  ctx.on('agent/disposed', ({ agent }) => engine.invalidate(agent.id));
}

export function apply(ctx: Context, value: PluginConfig): void {
  const config = pluginConfig.parse(value);
  const store = new Store(config.databaseFile);
  try {
    const engine = new RouterEngine(JSON.parse(readFileSync(config.routerConfigFile, 'utf8')), store);
    ctx.effect(() => async () => { await engine.shutdown(); store.close(); });
    install(ctx, engine);
  } catch (error) { store.close(); throw error; }
}
