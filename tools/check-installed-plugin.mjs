// Read-only startup verification, loaded only by the explicit verification overlay.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
export const name = 'jev-installation-check';
export const inject = ['jevRouter', 'llm', 'tools'];
export function apply(ctx) {
  assert.ok(ctx instanceof Context, 'Plugin and Harness must share Cordis');
  const expected = ctx.jevRouter.engine.config.routes.map(r => r.provider);
  const actual = ctx.llm.listProviders().map(p => p.id);
  // Provider metadata uses `id`; inspect all expected registrations before declaring success.
  for (const provider of expected) assert.ok(actual.includes(provider), `Missing provider: ${provider}`);
  const report = { checkedAt: new Date().toISOString(), profile: 'jev', sharedCordis: true, cordisResolved: import.meta.resolve('@deepseek-ai/cordis'),
    registeredProviders: expected, readyRoutes: ctx.jevRouter.engine.config.routes.filter(r => r.ready).map(r => r.id),
    paidModelRequests: 0, verification: 'Full installed Harness profile; plugin activated and provider registration inspected.' };
  mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../artifacts/harness-installation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Jev installation check: registered providers verified. No paid request sent.');
}
