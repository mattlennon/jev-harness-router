import type { TokenUsage } from '@deepseek-ai/dsh-llm';
export interface Attempt {
  id: string; taskId: string; decisionId: string; routeId: string; provider: string; model: string; vendor: string;
  priceVersion: string; profile: string; requestHash: string; inputEstimate: number; inputBound: number | null;
  capMicrousd: number; status: 'reserved' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'reconciled';
  usageFinal: boolean; usage?: TokenUsage; observedUsage?: TokenUsage; requestId?: string; responseId?: string;
  startedAt: string; durationMs?: number; firstTokenMs?: number; errorCode?: string;
  actualMicrousd?: number; receiptRef?: string; reconciledAt?: string;
}
export interface CacheObservation { namespace: string; prefixHash: string; messages: number; tokens: number; hitRatio: number; at: number }
