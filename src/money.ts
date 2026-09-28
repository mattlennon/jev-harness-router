import { invariant } from './domain.js';
import type { Route } from './config.js';

/** USD per million tokens equals micro-USD per token. Round once, upwards. */
export function costMicros(items: { tokens: number; price: number }[]): number {
  let scaled = 0n;
  for (const { tokens, price } of items) {
    invariant(Number.isSafeInteger(tokens) && tokens >= 0 && Number.isFinite(price) && price >= 0 && price <= 1e6, 'INVALID_USAGE');
    const units = BigInt(price.toFixed(9).replace('.', ''));
    scaled += BigInt(tokens) * units;
  }
  const result = Number((scaled + 999999999n) / 1000000000n);
  invariant(Number.isSafeInteger(result), 'COST_OVERFLOW');
  return result;
}
export function routeReservation(route: Route, output = route.capabilities.maxOutputTokens): number {
  // Full context capacity is reserved, not an optimistic prompt-token estimate.
  return costMicros([
    { tokens: route.capabilities.contextWindow, price: Math.max(route.pricing.inputPerMillionUsd, route.pricing.cacheReadPerMillionUsd ?? 0) },
    { tokens: output, price: route.pricing.outputPerMillionUsd },
  ]);
}
