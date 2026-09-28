import type { RouterConfig, Route } from './config.js';
import { providers } from './providers.js';

export function configurationTemplate(reasoning = false): RouterConfig {
  const entries: { vendor: keyof typeof providers; tier: 'economy' | 'strong' }[] = [
    { vendor: 'deepseek', tier: 'economy' }, { vendor: 'deepseek', tier: 'strong' },
    { vendor: 'kimi', tier: 'strong' }, { vendor: 'zhipu', tier: 'strong' },
  ];
  const routes: Route[] = entries.map(({ vendor, tier }) => ({
    id: `${vendor}-${tier}`, vendor, tier, provider: `jev-router-${vendor}-${tier}`,
    model: `REPLACE_WITH_${vendor.toUpperCase()}_MODEL_ID`, endpoint: providers[vendor].endpoint,
    apiKeyEnv: providers[vendor].keyEnv, ready: false, timeoutMs: 120000, transport: 'sse',
    requestOptions: reasoning && tier === 'strong' ? {} : providers[vendor].requestOptions,
    ...(reasoning && tier === 'strong' ? { reasoning: { profile: vendor, ...(vendor === 'kimi' ? { kimiMode: 'preserved' as const } : {}) } } : {}),
    capabilities: { tools: true, inputModalities: ['text'], contextWindow: 8192, maxOutputTokens: 512,
      historyCompatibilityGroup: 'chat-completions-text-tools-v1', compatibleFrom: [], verifiedAt: null, outputIncludesReasoning: false },
    pricing: { currency: 'USD', inputPerMillionUsd: 0, outputPerMillionUsd: 0, priceVersion: 'UNVERIFIED-FILL-REAL-USD-PRICES' },
  }));
  return {
    schemaVersion: 1, policyVersion: 'router-policy-v0.2', questionVersion: 'routing-questions-v1', modelRegistryVersion: 'unconfigured-v2',
    mode: 'shadow', defaultRouteId: 'deepseek-strong', calibrationReportId: null, supportedLanguages: [],
    jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY',
      allowStateTransmission: false, timeoutMs: 800, maxAttempts: 1, maxStateBytes: 8000, maxInputTokens: 64000,
      inputPerMillionUsd: 0.042, circuitBreaker: { failuresToOpen: 5, openMs: 30000 } },
    routing: { maxEscalations: 1, allowDowngradeWithinTask: false, taskKindConfidenceMin: 0.8,
      crossFileProbabilityMax: 0.2, informationSufficientProbabilityMin: 0.8, capabilityFailureThreshold: 2,
      maxTaskSteps: 20, maxAttemptsPerStep: 3 },
    budget: { currency: 'USD', limitMicrousd: 2000000, retainUnknownReservations: true }, routes,
    optimization: { costAware: false, minimumQuality: 0.9, switchMarginMicrousd: 1000, minResidenceSteps: 3,
      upgradeReserveMicrousd: 0, toolResultMaxChars: 8000, retainRecentToolResults: 2 },
  };
}
