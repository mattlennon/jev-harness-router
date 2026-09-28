import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { RouterConfig, Route } from './config.js';
import { prepareWire, digest } from './wire.js';
import type { RequestSnapshot } from './wire.js';
import { costMicros, routeReservation } from './money.js';
import type { Store } from './storage.js';
import { RouterError, invariant } from './domain.js';
export interface RoutePlan { routeId: string; estimatedMicrousd: number; reserveMicrousd: number; inputTokens: number; cachedTokens: number; hash: string }
export function namespace(route: Route): string { return digest([route.endpoint, route.model, route.reasoning ?? null, route.apiKeyEnv, digest(process.env[route.apiKeyEnv] ?? '')]); }
export function prefixHash(wire: ReturnType<typeof prepareWire>, count: number): string { return digest([wire.tools ?? [], wire.messages.slice(0, count)]); }
export function planRoute(config: RouterConfig, route: Route, snapshot: RequestSnapshot, store: Store): RoutePlan {
  const wire = prepareWire(route, snapshot, config);
  let cached = 0;
  for (const observation of store.cache(namespace(route))) {
    if (Date.now() - observation.at > (route.cacheTtlMs ?? 300000) || observation.messages > wire.messages.length) continue;
    if (prefixHash(wire, observation.messages) === observation.prefixHash) cached = Math.max(cached, Math.floor(observation.tokens * observation.hitRatio));
  }
  cached = Math.min(cached, wire.estimatedInput);
  const output = Math.min(route.performance?.expectedOutputTokens ?? wire.maxTokens, wire.maxTokens);
  const expected = costMicros([{ tokens: wire.estimatedInput - cached, price: route.pricing.inputPerMillionUsd },
    { tokens: cached, price: route.pricing.cacheReadPerMillionUsd ?? route.pricing.inputPerMillionUsd }, { tokens: output, price: route.pricing.outputPerMillionUsd }]);
  const estimated = expected * (route.performance?.remainingCalls ?? 1);
  invariant(Number.isSafeInteger(estimated), 'INVALID_COST_ESTIMATE');
  return { routeId: route.id, estimatedMicrousd: estimated,
    reserveMicrousd: wire.inputBound === null ? routeReservation(route, wire.maxTokens) : costMicros([
      { tokens: wire.inputBound, price: Math.max(route.pricing.inputPerMillionUsd, route.pricing.cacheReadPerMillionUsd ?? 0) },
      { tokens: wire.maxTokens, price: route.pricing.outputPerMillionUsd }]), inputTokens: wire.estimatedInput, cachedTokens: cached, hash: wire.hash };
}
export function plans(config: RouterConfig, input: RequestSnapshot, store: Store, rejected?: (routeId: string, code: string) => void): Map<string, RoutePlan> {
  const result = new Map<string, RoutePlan>();
  for (const route of config.routes) {
    if (!route.ready) continue;
    try { result.set(route.id, planRoute(config, route, input, store)); }
    catch (e) { if (!(e instanceof RouterError)) throw e; rejected?.(route.id, e.code); }
  }
  return result;
}
export function recordCache(route: Route, wire: ReturnType<typeof prepareWire>, usage: TokenUsage, store: Store): void {
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  if (!input) return;
  store.observeCache({ namespace: namespace(route), prefixHash: prefixHash(wire, wire.messages.length), messages: wire.messages.length,
    tokens: input, hitRatio: Math.min(0.9, (usage.cacheReadTokens ?? 0) / input), at: Date.now() });
}
