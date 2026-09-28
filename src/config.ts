import { z } from 'zod';

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = natural.min(1);
const price = z.number().finite().nonnegative().max(1000000);
const endpoint = z.string().url().refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.search && !u.hash &&
    (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
}, 'HTTPS required except for loopback tests; URL credentials/query are forbidden');

export const routeSchema = z.object({
  id: z.string().min(1), tier: z.enum(['economy', 'strong']),
  vendor: z.enum(['deepseek', 'kimi', 'zhipu', 'openai-compatible']).default('openai-compatible'),
  provider: z.string().startsWith('jev-router-'), model: z.string().min(1),
  endpoint, apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  ready: z.boolean(), timeoutMs: positive,
  requestOptions: z.object({ thinking: z.object({ type: z.enum(['disabled', 'enabled']), clear_thinking: z.boolean().optional() }).strict().optional() }).strict().default({}),
  transport: z.enum(['json', 'sse']).optional(),
  reasoning: z.object({ profile: z.enum(['deepseek', 'kimi', 'zhipu']), effort: z.enum(['low', 'high', 'max']).optional(), kimiMode: z.enum(['preserved', 'always', 'k3']).optional() }).strict().optional(),
  tokenBound: z.object({ tokensPerByte: z.number().min(1).max(4), overheadTokens: positive, verificationRef: z.string().min(1) }).strict().optional(),
  performance: z.object({ expectedOutputTokens: positive, remainingCalls: positive, qualityLowerBound: z.number().min(0).max(1), reportId: z.string().min(1) }).strict().optional(),
  cacheTtlMs: positive.optional(),
  capabilities: z.object({
    tools: z.boolean(), inputModalities: z.array(z.literal('text')).min(1),
    contextWindow: positive, maxOutputTokens: positive,
    historyCompatibilityGroup: z.literal('chat-completions-text-tools-v1'),
    compatibleFrom: z.array(z.string()).default([]),
    verifiedAt: z.string().nullable(),
    outputIncludesReasoning: z.boolean(),
  }).strict(),
  pricing: z.object({
    currency: z.literal('USD'), inputPerMillionUsd: price, outputPerMillionUsd: price,
    cacheReadPerMillionUsd: price.optional(), priceVersion: z.string().min(1),
  }).strict(),
}).strict().refine(r => r.capabilities.maxOutputTokens < r.capabilities.contextWindow, 'Output cap must fit context');

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string().min(1), questionVersion: z.literal('routing-questions-v1'),
  modelRegistryVersion: z.string().min(1),
  mode: z.enum(['off', 'shadow', 'auto']), defaultRouteId: z.string(),
  calibrationReportId: z.string().min(1).nullable(),
  supportedLanguages: z.array(z.string().min(1)),
  jev: z.object({
    endpoint, model: z.string().regex(/^jev-\d+\.\d+\.\d+$/), apiKeyEnv: z.string(),
    allowStateTransmission: z.boolean(), timeoutMs: positive, maxAttempts: z.literal(1),
    maxStateBytes: positive.max(16000), maxInputTokens: positive.max(64000),
    inputPerMillionUsd: price,
    circuitBreaker: z.object({ failuresToOpen: positive, openMs: positive }).strict(),
  }).strict(),
  routing: z.object({
    maxEscalations: z.literal(1), allowDowngradeWithinTask: z.literal(false),
    taskKindConfidenceMin: z.number().min(0).max(1),
    crossFileProbabilityMax: z.number().min(0).max(1),
    informationSufficientProbabilityMin: z.number().min(0).max(1),
    capabilityFailureThreshold: positive, maxTaskSteps: positive, maxAttemptsPerStep: positive,
  }).strict(),
  budget: z.object({ currency: z.literal('USD'), limitMicrousd: natural,
    retainUnknownReservations: z.literal(true) }).strict(),
  routes: z.array(routeSchema).min(2),
  optimization: z.object({ costAware: z.boolean(), minimumQuality: z.number().min(0).max(1), switchMarginMicrousd: natural,
    minResidenceSteps: natural, upgradeReserveMicrousd: natural,
    failureThresholds: z.record(z.enum(['documentation', 'local_edit', 'debugging', 'design', 'unknown']), positive).optional(),
    toolResultMaxChars: positive.min(512), retainRecentToolResults: natural,
  }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(c.routes.map(r => r.id)).size !== c.routes.length || new Set(c.routes.map(r => r.provider)).size !== c.routes.length) bad('Route IDs and providers must be distinct');
  if (new Set(c.routes.map(r => r.tier)).size !== 2) bad('At least one economy and one strong route required');
  if (!c.routes.some(r => r.id === c.defaultRouteId && r.tier === 'strong')) bad('Default route must identify a strong model');
  if (c.mode === 'auto' && (!c.calibrationReportId || !c.supportedLanguages.length)) bad('Auto requires calibration evidence and language coverage');
  if (c.routes.some(r => r.ready && (!r.capabilities.verifiedAt || !r.capabilities.outputIncludesReasoning || r.model.includes('REPLACE_')))) bad('Ready routes require verified capabilities, bounded billed output and a real model ID');
  if (c.mode === 'auto' && (!c.routes.some(r => r.ready && r.tier === 'economy') || !c.routes.some(r => r.ready && r.id === c.defaultRouteId))) bad('Auto requires ready economy and default routes');
  for (const r of c.routes) if (r.capabilities.compatibleFrom.some(id => !c.routes.some(v => v.id === id))) bad('Unknown compatibleFrom route');
  for (const r of c.routes) if (r.ready && r.pricing.priceVersion.includes('UNVERIFIED')) bad('Ready route needs verified prices');
  for (const r of c.routes) {
    if (r.reasoning && r.reasoning.profile !== r.vendor) bad('Reasoning profile must match vendor');
    if (r.reasoning?.effort && !['deepseek', 'zhipu'].includes(r.vendor) && r.reasoning.kimiMode !== 'k3') bad('Effort mapping requires DeepSeek, compatible GLM, or Kimi K3');
    if (r.reasoning?.kimiMode && r.vendor !== 'kimi') bad('kimiMode requires Kimi');
    if (['always', 'k3'].includes(r.reasoning?.kimiMode ?? '') && r.requestOptions.thinking) bad('Always-thinking Kimi profiles must omit thinking');
    if (r.requestOptions.thinking?.type === 'enabled' && !r.reasoning) bad('Enabled thinking requires a replay profile');
    if (r.reasoning && r.requestOptions.thinking?.type === 'disabled') bad('Thinking options conflict');
    if (r.requestOptions.thinking?.clear_thinking !== undefined && r.vendor !== 'zhipu') bad('clear_thinking is a GLM option');
    if (r.reasoning && r.requestOptions.thinking?.clear_thinking === true) bad('GLM reasoning profile requires preserved thinking');
  }
});

export type RouterConfig = z.infer<typeof configSchema>;
export type Route = z.infer<typeof routeSchema>;
export function parseConfig(value: unknown): RouterConfig {
  const config = configSchema.parse(value);
  const freeze = (v: object): void => { Object.freeze(v); for (const x of Object.values(v)) if (x && typeof x === 'object') freeze(x); };
  freeze(config);
  return config;
}
