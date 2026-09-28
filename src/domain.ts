export const taskKinds = ['documentation', 'local_edit', 'debugging', 'design', 'unknown'] as const;
export type TaskKind = typeof taskKinds[number];
export interface Judgment {
  model: string; taskKind: TaskKind; confidence: number;
  probabilities: Record<TaskKind, number>; crossFile: number; sufficient: number;
}
export interface Evidence {
  eventId: string; repairAttemptId: string; goalId: string;
  category: 'transport' | 'auth_or_config' | 'environment' | 'permission' | 'task_validation' | 'unknown';
  outcome: 'pass' | 'fail' | 'unknown'; evidenceRef: string;
}
export interface TaskState {
  id: string; sessionId: string; revision: number; status: 'active' | 'finished' | 'cancelled';
  text: string; language: string; truncated: boolean;
  currentRouteId: string | null; fixedRouteId: string | null;
  initialized: boolean; escalations: number; steps: string[];
  evidence: Evidence[]; configVersion: string;
  goalVersion?: number; phase?: string; facts?: string[]; taskKind?: TaskKind; routeSinceStep?: number;
}
export interface Proposal { routeId: string | null; reason: string; escalation: boolean }
export interface Decision {
  id: string; taskId: string; sessionId: string; turn: number; step: number; revision: number;
  mode: 'off' | 'shadow' | 'auto'; policyVersion: string; questionVersion: string; modelRegistryVersion: string;
  classifier: 'jev' | 'rules';
  originalRouteId: string; proposedRouteId: string | null; appliedRouteId: string | null;
  reason: string; status: 'proposed' | 'shadow' | 'applied' | 'held' | 'superseded';
  escalation: boolean; judgment: Judgment | null; routeLatencyMs: number; createdAt: string;
  contextHash?: string; estimates?: { routeId: string; estimatedMicrousd: number; reserveMicrousd: number; inputTokens: number; cachedTokens: number }[];
  preflightRejected?: { routeId: string; code: string }[];
}
export interface Budget { limit: number; settled: number; reserved: number; available: number; blocked: boolean }
export class RouterError extends Error {
  constructor(public readonly code: string, message: string = code) { super(message); this.name = 'RouterError'; }
}
export function invariant(ok: unknown, code: string): asserts ok { if (!ok) throw new RouterError(code); }
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RouterError('CANCELLED');
}
