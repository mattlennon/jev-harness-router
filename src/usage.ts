import { z } from 'zod';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Route } from './config.js';
import { invariant } from './domain.js';
import { costMicros } from './money.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const chatUsageSchema = z.object({ usage: z.object({ prompt_tokens: count, completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(), prompt_cache_hit_tokens: count.optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional() }) });
export function normalizeUsage(raw: unknown): TokenUsage {
  const u = chatUsageSchema.parse(raw).usage;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  invariant(cached <= u.prompt_tokens && reasoning <= u.completion_tokens, 'INVALID_USAGE');
  return { inputTokens: u.prompt_tokens - cached, cacheReadTokens: cached, outputTokens: u.completion_tokens,
    reasoningTokens: reasoning, totalTokens: u.prompt_tokens + u.completion_tokens };
}
export function priceUsage(raw: unknown, route: Route): number {
  const u = normalizeUsage(raw);
  return costMicros([{ tokens: u.inputTokens, price: route.pricing.inputPerMillionUsd },
    { tokens: u.cacheReadTokens ?? 0, price: route.pricing.cacheReadPerMillionUsd ?? route.pricing.inputPerMillionUsd },
    { tokens: u.outputTokens, price: route.pricing.outputPerMillionUsd }]);
}
