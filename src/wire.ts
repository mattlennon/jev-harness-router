import { createHash } from 'node:crypto';
import { projectToolUpdates } from '@deepseek-ai/dsh-llm';
import type { RequestMessage, GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { Route, RouterConfig } from './config.js';
import { invariant, RouterError } from './domain.js';
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type RequestSnapshot = Omit<GenerateOptions, 'provider' | 'model' | 'sessionId' | 'signal'>;
export const supportsReasoningEffort = (route: Route): boolean => route.reasoning?.profile === 'deepseek' || route.reasoning?.kimiMode === 'k3' || (route.reasoning?.profile === 'zhipu' && route.reasoning.effort !== undefined);
export interface WireMessage { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }

export function toWireMessages(messages: readonly RequestMessage[], target?: Route, routes: readonly Route[] = []): WireMessage[] {
  const output: WireMessage[] = [], pending = new Set<string>(), seen = new Set<string>();
  for (const message of messages) {
    const source = message.source;
    if (source?.kind === 'model' && target) {
      const prior = routes.find(r => r.provider === source.provider && r.model === source.model);
      invariant(prior, 'UNMANAGED_ROUTE');
      invariant(prior.id === target.id || target.capabilities.compatibleFrom.includes(prior.id), 'HISTORY_ROUTE_UNVERIFIED');
      if (source.replayState !== undefined || message.content.some(c => c.type === 'reasoning')) {
        invariant(prior.model === target.model && prior.vendor === target.vendor && prior.reasoning?.profile === target.reasoning?.profile && !!target.reasoning, 'REASONING_HISTORY_INCOMPATIBLE');
        const state = source.replayState as { response?: { protocol?: string; profile?: string; model?: string } } | undefined;
        invariant(state?.response?.protocol === 'jev-chat-v2' && state.response.profile === target.reasoning.profile && state.response.model === target.model, 'REPLAY_UNSUPPORTED');
      }
    } else if (source?.kind === 'model' && source.replayState !== undefined) throw new RouterError('REPLAY_UNSUPPORTED');
    if (message.role === 'tool') {
      invariant(pending.delete(message.toolCallId), 'UNPAIRED_TOOL_HISTORY');
      invariant(message.content.every(c => c.type === 'text'), 'UNSUPPORTED_MODALITY');
      const text = message.content.map(c => c.type === 'text' ? c.text : '').join('');
      output.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.isError ? JSON.stringify({ isError: true, content: text }) : text });
      continue;
    }
    invariant(!pending.size, 'UNPAIRED_TOOL_HISTORY');
    let text = '', reasoning = ''; const calls: NonNullable<WireMessage['tool_calls']> = [];
    for (const c of message.content) {
      if (c.type === 'text') text += c.text;
      else if (c.type === 'reasoning') { invariant(message.role === 'assistant' && target?.reasoning, 'UNSUPPORTED_MODALITY'); reasoning += c.text; }
      else if (c.type === 'tool-call') {
        invariant(message.role === 'assistant' && !seen.has(c.id), 'UNPAIRED_TOOL_HISTORY');
        validateArguments(c.arguments); seen.add(c.id); pending.add(c.id);
        calls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } });
      } else throw new RouterError('UNSUPPORTED_MODALITY');
    }
    if (text || reasoning || calls.length) output.push({ role: message.role, content: text || null,
      ...(target?.reasoning && message.role === 'assistant' ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
  }
  invariant(!pending.size, 'UNPAIRED_TOOL_HISTORY'); return output;
}
export function validateArguments(value: string): void {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new RouterError('INVALID_TOOL_ARGUMENTS'); }
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_TOOL_ARGUMENTS');
}
export function prepareWire(route: Route, input: RequestSnapshot, config: RouterConfig) {
  invariant(!input.purpose, 'AUXILIARY_CALL_REQUIRES_SEPARATE_BUDGET');
  const maxTokens = input.maxTokens ?? route.capabilities.maxOutputTokens;
  invariant(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= route.capabilities.maxOutputTokens, 'UNSUPPORTED_OPTION');
  invariant(!input.tools?.length || route.capabilities.tools, 'UNSUPPORTED_TOOLS');
  const supportsEffort = supportsReasoningEffort(route);
  invariant(!input.reasoningEffort || (supportsEffort && ['low', 'high', 'max'].includes(input.reasoningEffort)), 'UNSUPPORTED_OPTION');
  invariant(!route.reasoning || input.temperature === undefined, 'UNSUPPORTED_REASONING_TEMPERATURE');
  const projected = projectToolUpdates(input.messages, input.tools, undefined, input.toolHistory);
  const messages = toWireMessages(projected.messages, route, config.routes);
  if (input.system) messages.unshift({ role: 'system', content: input.system });
  const tools = projected.tools?.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const stream = route.transport === 'sse';
  const body = { ...route.requestOptions, ...(route.reasoning ? {
    ...(route.vendor === 'kimi' && ['always', 'k3'].includes(route.reasoning.kimiMode ?? '') ? {} : {
      thinking: { type: 'enabled', ...(route.vendor === 'zhipu' ? { clear_thinking: false } : {}), ...(route.vendor === 'kimi' ? { keep: 'all' } : {}) },
    }),
    ...(supportsEffort ? { reasoning_effort: input.reasoningEffort ?? route.reasoning.effort ?? 'high' } : {}),
  } : {}), model: route.model, messages, stream, max_tokens: maxTokens,
    ...(stream && route.vendor !== 'zhipu' ? { stream_options: { include_usage: true } } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}), ...(input.stop ? { stop: input.stop } : {}),
    ...(tools?.length ? { tools } : {}) };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const bound = route.tokenBound ? Math.ceil(bytes * route.tokenBound.tokensPerByte) + route.tokenBound.overheadTokens : null;
  invariant((bound ?? bytes + messages.length * 64) + maxTokens <= route.capabilities.contextWindow, 'CONTEXT_LIMIT');
  return { body, messages, tools, maxTokens, inputBound: bound, estimatedInput: Math.ceil(bytes / 3), hash: digest(body) };
}
