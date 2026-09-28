import type { RouterConfig, Route } from './config.js';
import type { Budget, Judgment, Proposal, TaskState } from './domain.js';
import { routeReservation } from './money.js';
import type { RoutePlan } from './planner.js';

export function candidates(config: RouterConfig, budget: Budget, requiresTools = true, currentRouteId: string | null = null, plans?: Map<string, RoutePlan>): Route[] {
  return config.routes.filter(r => r.ready && r.capabilities.outputIncludesReasoning &&
    (!currentRouteId || currentRouteId === r.id || r.capabilities.compatibleFrom.includes(currentRouteId)) &&
    (!requiresTools || r.capabilities.tools) && !budget.blocked && (!plans || plans.has(r.id)) &&
    (plans?.get(r.id)?.reserveMicrousd ?? routeReservation(r)) + (r.tier === 'economy' ? config.optimization?.upgradeReserveMicrousd ?? 0 : 0) <= budget.available &&
    (!config.optimization?.costAware || r.id === config.defaultRouteId || (r.performance && r.performance.qualityLowerBound >= config.optimization.minimumQuality)));
}
export function needsEscalation(task: TaskState, config: RouterConfig): boolean {
  if (task.escalations >= 1 || config.routes.find(r => r.id === task.currentRouteId)?.tier !== 'economy') return false;
  const goals = new Map<string, Set<string>>();
  for (const e of task.evidence) {
    if (e.category !== 'task_validation') continue;
    if (e.outcome === 'pass') { goals.delete(e.goalId); continue; }
    if (e.outcome !== 'fail') continue;
    const attempts = goals.get(e.goalId) ?? new Set<string>();
    attempts.add(e.repairAttemptId); goals.set(e.goalId, attempts);
  }
  const threshold = config.optimization?.failureThresholds?.[task.taskKind ?? 'unknown'] ?? config.routing.capabilityFailureThreshold;
  return [...goals.values()].some(s => s.size >= threshold);
}
export function decide(config: RouterConfig, task: TaskState, eligible: Route[], judgment: Judgment | null, fallbackReason = 'jev_unavailable'): Proposal {
  const choose = (id: string | null, reason: string, escalation = false): Proposal =>
    id && eligible.some(r => r.id === id) ? { routeId: id, reason, escalation } : { routeId: null, reason: 'no_eligible_route', escalation: false };
  if (task.fixedRouteId) return choose(task.fixedRouteId, 'fixed_model');
  if (needsEscalation(task, config)) return choose(config.defaultRouteId, 'capability_failure', true);
  if (task.initialized) return choose(task.currentRouteId, 'keep_route');
  if (config.routes.find(r => r.id === task.currentRouteId)?.tier === 'strong') return choose(task.currentRouteId, 'no_downgrade');
  if (!judgment) return choose(config.defaultRouteId, fallbackReason);
  if (task.truncated || !config.supportedLanguages.includes(task.language) || judgment.sufficient < config.routing.informationSufficientProbabilityMin)
    return choose(config.defaultRouteId, 'insufficient_context');
  if (judgment.confidence < config.routing.taskKindConfidenceMin || judgment.taskKind === 'unknown')
    return choose(config.defaultRouteId, 'low_confidence');
  const simple = ['documentation', 'local_edit'].includes(judgment.taskKind) && judgment.crossFile <= config.routing.crossFileProbabilityMax;
  if (simple) {
    const economy = eligible.find(r => r.tier === 'economy');
    if (economy) return choose(economy.id, 'simple_task');
  }
  return choose(config.defaultRouteId, 'complex_task');
}
