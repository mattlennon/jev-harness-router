import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { RouterConfig } from '../config.js';
import { Store } from '../storage.js';
import { RouterEngine } from '../engine.js';
import { GuardedChatAdapter } from '../harness/adapter.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

export const simpleResponse = {
  model: 'jev-1.13.0', answers: {
    task_kind: { type: 'choice', choice: 'documentation', confidence: 0.92,
      probabilities: { documentation: 0.95, local_edit: 0.02, debugging: 0.01, design: 0.01, unknown: 0.01 } },
    cross_file_reasoning: { type: 'noul', noul: 0.03 }, information_sufficient: { type: 'noul', noul: 0.95 },
  }, usage: { input_tokens: 800, output_tokens: 60 },
};
export const chatResponse = { model: 'mock-economy', choices: [{ message: { content: '完成了注释修改。' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20 } };
export function fixtureConfig(endpoint: string, mode: RouterConfig['mode'] = 'auto'): RouterConfig {
  return {
    schemaVersion: 1, policyVersion: 'fixture-v1', questionVersion: 'routing-questions-v1', modelRegistryVersion: 'fixture-v1',
    mode, defaultRouteId: 'strong', calibrationReportId: 'synthetic-fixture-not-production', supportedLanguages: ['en', 'zh-CN'],
    jev: { endpoint: `${endpoint}/jev`, model: 'jev-1.13.0', apiKeyEnv: 'JEV_ROUTER_TEST_KEY', allowStateTransmission: true,
      timeoutMs: 1000, maxAttempts: 1, maxStateBytes: 8000, maxInputTokens: 64000, inputPerMillionUsd: 0.042,
      circuitBreaker: { failuresToOpen: 2, openMs: 100 } },
    routing: { maxEscalations: 1, allowDowngradeWithinTask: false, taskKindConfidenceMin: 0.8, crossFileProbabilityMax: 0.2,
      informationSufficientProbabilityMin: 0.8, capabilityFailureThreshold: 2, maxTaskSteps: 20, maxAttemptsPerStep: 3 },
    budget: { currency: 'USD', limitMicrousd: 1000000, retainUnknownReservations: true },
    routes: (['economy', 'strong'] as const).map(tier => ({
      id: tier, tier, provider: `jev-router-${tier}`, model: `mock-${tier}`, endpoint: `${endpoint}/${tier}`,
      vendor: 'openai-compatible', requestOptions: {},
      apiKeyEnv: 'JEV_ROUTER_TEST_KEY', timeoutMs: 1000, ready: true,
      capabilities: { tools: true, inputModalities: ['text'], contextWindow: 8192, maxOutputTokens: 512,
        historyCompatibilityGroup: 'chat-completions-text-tools-v1', compatibleFrom: ['economy', 'strong'], verifiedAt: '2026-09-21', outputIncludesReasoning: true },
      pricing: { currency: 'USD', inputPerMillionUsd: tier === 'economy' ? 1 : 10,
        outputPerMillionUsd: tier === 'economy' ? 2 : 20, priceVersion: 'synthetic-v1' },
    })),
  };
}
export interface RequestRecord { url: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }
export async function server(handler?: (record: RequestRecord, response: ServerResponse) => void) {
  const requests: RequestRecord[] = [];
  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const record = { url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, headers: req.headers };
      requests.push(record);
      if (handler) { handler(record, res); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(record.url === '/jev' ? simpleResponse : chatResponse));
    } catch { res.destroy(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests,
    close: async () => { const closed = once(http, 'close'); http.close(); http.closeAllConnections(); await closed; } };
}
export function engine(endpoint: string, mode: RouterConfig['mode'] = 'auto', config = fixtureConfig(endpoint, mode)) {
  process.env.JEV_ROUTER_TEST_KEY = 'synthetic-fixture-key';
  const store = new Store(':memory:'); const router = new RouterEngine(config, store);
  router.beginTask('session-1', '为已提供的函数添加 JSDoc 注释', { taskId: 'task-1', language: 'zh-CN' });
  return { router, store, adapter: new GuardedChatAdapter(router) };
}
export function options(router: RouterEngine, routeId: string, signal?: AbortSignal): GenerateOptions {
  const route = router.route(routeId);
  return { provider: route.provider, model: route.model, sessionId: 'session-1' as GenerateOptions['sessionId'] & string,
    messages: [createUserMessage({ content: [{ type: 'text', text: '给函数添加注释。' }], source: { kind: 'user' } })],
    ...(signal ? { signal } : {}) };
}
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const v of iterable) result.push(v); return result; }
