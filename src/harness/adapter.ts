import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, TokenUsage, LlmResolvedModelInfo, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { invariant, checkAbort, RouterError } from '../domain.js';
import { apiKey } from '../http.js';
import { RouterEngine } from '../engine.js';
import { prepareWire, validateArguments, supportsReasoningEffort, digest } from '../wire.js';
import { planRoute, recordCache } from '../planner.js';
import { normalizeUsage, priceUsage } from '../usage.js';
import { providerEvents } from '../sse.js';
import type { Attempt } from '../telemetry.js';
export { toWireMessages } from '../wire.js';
export { normalizeUsage, priceUsage, chatUsageSchema } from '../usage.js';
const toolDelta = z.object({ index: z.number().int().nonnegative().max(1000).optional(), id: z.string().optional(), type: z.literal('function').optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() });
const messageSchema = z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(toolDelta).optional() });
const eventSchema = z.object({ id: z.string().optional(), request_id: z.string().optional(), model: z.string().optional(), usage: z.unknown().optional(), error: z.unknown().optional(),
  choices: z.array(z.object({ index: z.number().optional(), delta: messageSchema.optional(), message: messageSchema.optional(), finish_reason: z.string().nullable().optional() })).max(1).optional() });

export class GuardedChatAdapter extends LlmAdapter {
  constructor(readonly engine: RouterEngine) { super(); }
  override providerRetryPolicy(): ResolvedRetryPolicy { return { mode: 'normal', maxRetries: this.engine.config.routing.maxAttemptsPerStep - 1,
    retryableCodes: ['HTTP_429', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'TIMEOUT'], initialDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0.1 }; }
  override async listModels(provider: string) { return this.engine.config.routes.filter(r => r.provider === provider).map(r => ({ provider, id: r.model, name: r.model, inputModalities: ['text'] as const })); }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = this.engine.routeFor(provider, model), effort = supportsReasoningEffort(route);
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: route.capabilities.contextWindow }, defaultMaxTokens: route.capabilities.maxOutputTokens,
      ...(effort ? { reasoning: { efforts: ['low', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId(route.reasoning?.effort ?? 'high') } } : {}) };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.call(options); } catch (error) {
      if (error instanceof RouterError) throw new LlmError(error.code, error.code);
      throw new LlmError('Invalid provider response or accounting failure', 'ROUTER_FAILURE');
    }
  }
  private async *call(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = this.engine.signal(options.signal); checkAbort(signal);
    invariant(options.sessionId && !options.purpose, 'AUXILIARY_CALL_REQUIRES_SEPARATE_BUDGET');
    const route = this.engine.routeFor(options.provider, options.model);
    invariant(route.ready && route.capabilities.outputIncludesReasoning, 'ROUTE_NOT_READY');
    const wire = prepareWire(route, options, this.engine.config), plan = planRoute(this.engine.config, route, options, this.engine.store);
    const key = apiKey(route.apiKeyEnv), decision = this.engine.planned(options.sessionId);
    if (this.engine.selectedRoute(decision).id !== route.id) { this.engine.store.supersede(decision.id); throw new RouterError('ROUTE_CONFLICT'); }
    const id = randomUUID(), start = performance.now();
    const attempt: Attempt = { id, taskId: decision.taskId, decisionId: decision.id, routeId: route.id, provider: route.provider, model: route.model, vendor: route.vendor,
      priceVersion: route.pricing.priceVersion, profile: route.reasoning?.profile ?? 'text', requestHash: wire.hash, inputEstimate: plan.inputTokens, inputBound: wire.inputBound,
      capMicrousd: plan.reserveMicrousd, status: 'reserved', usageFinal: false, startedAt: new Date().toISOString() };
    this.engine.store.reserve(id, decision.taskId, 'llm', plan.reserveMicrousd, route.tier === 'economy' ? this.engine.config.optimization?.upgradeReserveMicrousd ?? 0 : 0); this.engine.store.saveAttempt(attempt);
    let sent = false, finalized = false, usage: TokenUsage | undefined, terminal: string | undefined, errorCode: string | undefined;
    const release = this.engine.trackOperation();
    const finalize = (status: Attempt['status']) => {
      if (finalized) return; finalized = true;
      attempt.status = status; attempt.durationMs = Math.round(performance.now() - start); if (errorCode) attempt.errorCode = errorCode;
      if (!sent) { this.engine.store.settle(id, 0); attempt.actualMicrousd = 0; } else if (!attempt.usageFinal) this.engine.store.pending(id);
      this.engine.store.saveAttempt(attempt); release();
    };
    const aborted = () => { errorCode = 'CANCELLED'; finalize('cancelled'); };
    signal.addEventListener('abort', aborted, { once: true });
    type Block = { index: number; kind: 'text' | 'reasoning' | 'tool-call'; text: string; id: string; name: string; args: string; emitted: number };
    const blocks: Block[] = [], calls = new Map<number, Block>(); let textBlock: Block | undefined, reasoningBlock: Block | undefined;
    const block = (kind: Block['kind']): Block => { const b = { index: blocks.length, kind, text: '', id: '', name: '', args: '', emitted: 0 }; blocks.push(b); return b; };
    try {
      checkAbort(signal); this.engine.dispatchStarted(decision, route.id); checkAbort(signal);
      sent = true; attempt.status = 'streaming'; this.engine.store.saveAttempt(attempt);
      for await (const item of providerEvents(route.endpoint, wire.body, { ...attributionHeaders(), Authorization: `Bearer ${key}` }, route.timeoutMs, signal, this.engine.fetcher, headers => {
        const requestId = headers.get('x-request-id') ?? headers.get('request-id');
        if (requestId && !finalized) { attempt.requestId = requestId; this.engine.store.saveAttempt(attempt); }
      })) {
        checkAbort(signal); const parsed = eventSchema.safeParse(item.value); invariant(parsed.success, 'BAD_LLM_RESPONSE'); const value = parsed.data;
        invariant(!value.error, 'PROVIDER_STREAM_ERROR');
        if (value.request_id) attempt.requestId = value.request_id; if (value.id) attempt.responseId = value.id;
        const choice = value.choices?.[0];
        invariant(choice?.index === undefined || choice.index === 0, 'BAD_LLM_RESPONSE');
        const incoming = item.json ? choice?.message : choice?.delta;
        invariant(!terminal || !(incoming?.content || incoming?.reasoning_content || incoming?.tool_calls?.length), 'DELTA_AFTER_FINISH');
        if (choice?.finish_reason) { invariant(!terminal || terminal === choice.finish_reason, 'BAD_LLM_RESPONSE'); terminal = choice.finish_reason; }
        if (value.usage) {
          const observed = normalizeUsage(value); attempt.observedUsage = observed;
          if (terminal) {
            const actual = priceUsage(value, route);
            invariant(!attempt.usageFinal || (attempt.actualMicrousd === actual && digest(attempt.usage) === digest(observed)), 'SETTLEMENT_CONFLICT');
            usage = observed; attempt.usage = usage; attempt.usageFinal = true; attempt.actualMicrousd = actual; this.engine.store.settle(id, actual);
          }
        }
        this.engine.store.saveAttempt(attempt);
        const delta = item.json ? choice?.message : choice?.delta; if (!delta) continue;
        if ((delta.content || delta.reasoning_content || delta.tool_calls?.length) && attempt.firstTokenMs === undefined) attempt.firstTokenMs = Math.round(performance.now() - start);
        for (const kind of ['reasoning', 'text'] as const) {
          const text = kind === 'reasoning' ? delta.reasoning_content : delta.content; if (!text) continue;
          invariant(kind !== 'reasoning' || route.reasoning, 'REASONING_REPLAY_UNSUPPORTED');
          let b = kind === 'reasoning' ? reasoningBlock : textBlock;
          if (!b) { b = block(kind); if (kind === 'reasoning') reasoningBlock = b; else textBlock = b; yield { type: 'block-start', index: b.index, blockType: kind }; checkAbort(signal); }
          b.text += text; yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: b.index, text }; checkAbort(signal);
        }
        for (const [position, tool] of (delta.tool_calls ?? []).entries()) {
          const toolIndex = tool.index ?? position; let b = calls.get(toolIndex);
          if (!b) { b = block('tool-call'); calls.set(toolIndex, b); yield { type: 'block-start', index: b.index, blockType: 'tool-call' }; checkAbort(signal); }
          if (tool.id) { invariant(!b.id || b.id === tool.id, 'DUPLICATE_TOOL_ID'); b.id = tool.id; }
          b.name += tool.function?.name ?? ''; b.args += tool.function?.arguments ?? '';
          if (b.id) { yield { type: 'tool-call-delta', index: b.index, id: ToolCallId(b.id), ...(b.name ? { name: b.name } : {}), argumentsDelta: b.args.slice(b.emitted) }; b.emitted = b.args.length; checkAbort(signal); }
        }
      }
      checkAbort(signal); invariant(terminal && ['stop', 'length', 'tool_calls'].includes(terminal), 'BAD_LLM_RESPONSE'); invariant(usage, 'INVALID_USAGE');
      invariant((calls.size > 0) === (terminal === 'tool_calls'), 'BAD_LLM_RESPONSE');
      invariant(new Set([...calls.values()].map(c => c.id)).size === calls.size, 'DUPLICATE_TOOL_ID');
      for (const b of blocks) {
        if (b.kind === 'tool-call') { invariant(b.id && b.name, 'BAD_LLM_RESPONSE'); validateArguments(b.args); yield { type: 'block-end', index: b.index, block: { type: 'tool-call', id: ToolCallId(b.id), name: b.name, arguments: b.args } }; }
        else yield { type: 'block-end', index: b.index, block: { type: b.kind, text: b.text } }; checkAbort(signal);
      }
      recordCache(route, wire, usage, this.engine.store); finalize('completed'); yield { type: 'usage', usage }; checkAbort(signal);
      yield { type: 'finish', reason: { kind: terminal === 'length' ? 'max-tokens' : calls.size ? 'tool-calls' : 'stop' },
        ...(route.reasoning ? { replayState: { response: { protocol: 'jev-chat-v2', profile: route.reasoning.profile, model: route.model }, blocks: blocks.map(b => ({ kind: b.kind })) } } : {}) };
    } catch (error) { errorCode = error instanceof RouterError ? error.code : 'ROUTER_FAILURE'; throw error; }
    finally {
      signal.removeEventListener('abort', aborted);
      if (!finalized && !errorCode) errorCode = 'CONSUMER_CLOSED';
      finalize(signal.aborted || errorCode === 'CONSUMER_CLOSED' ? 'cancelled' : 'failed');
    }
  }
}
