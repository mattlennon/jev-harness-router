import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { parseConfig } from './config.js';
import type { RouterConfig, Route } from './config.js';
import { invariant, checkAbort, RouterError } from './domain.js';
import type { TaskState, Decision, Evidence, Judgment } from './domain.js';
import { Store } from './storage.js';
import { candidates, decide, needsEscalation } from './policy.js';
import { costMicros } from './money.js';
import { apiKey, postJson } from './http.js';
import type { Fetcher } from './http.js';
import { JevCircuit, jevUsageSchema, parseJudgment, requestBody, classificationState } from './jev.js';
import { plans } from './planner.js';
import { digest } from './wire.js';
import type { RequestSnapshot } from './wire.js';

const evidenceSchema = z.object({ eventId: z.string().min(1), repairAttemptId: z.string().min(1), goalId: z.string().min(1),
  category: z.enum(['transport', 'auth_or_config', 'environment', 'permission', 'task_validation', 'unknown']),
  outcome: z.enum(['pass', 'fail', 'unknown']), evidenceRef: z.string().min(1) }).strict();

export class RouterEngine {
  readonly config: RouterConfig;
  readonly store: Store;
  readonly fetcher: Fetcher;
  readonly configVersion: string;
  private circuit: JevCircuit;
  private inflight = new Map<string, Promise<Decision>>();
  private selected = new Map<string, Decision>();
  private lifetime = new AbortController();
  private network = new Set<Promise<unknown>>();
  constructor(config: unknown, store: Store, fetcher: Fetcher = fetch, readonly strategy: 'jev' | 'rules' = 'jev') {
    this.config = parseConfig(config); this.store = store; this.fetcher = fetcher;
    this.configVersion = createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    this.circuit = new JevCircuit(this.config.jev.circuitBreaker);
  }
  signal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
  trackOperation(): () => void {
    let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); this.network.add(promise);
    return () => { this.network.delete(promise); done(); };
  }
  async shutdown(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.inflight.values(), ...this.network]);
    this.selected.clear();
  }
  beginTask(sessionId: string, text: string, options: { taskId?: string; language?: string; fixedRouteId?: string } = {}): TaskState {
    invariant(sessionId && text.trim(), 'TASK_INPUT_REQUIRED');
    if (options.fixedRouteId) invariant(this.config.routes.some(r => r.id === options.fixedRouteId), 'UNKNOWN_ROUTE');
    const bytes = Buffer.from(text); const truncated = bytes.length > this.config.jev.maxStateBytes;
    const bounded = truncated ? new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, this.config.jev.maxStateBytes)) : text;
    return this.store.create({ id: options.taskId ?? randomUUID(), sessionId, revision: 0, status: 'active', text: bounded,
      language: options.language ?? (/\p{Script=Han}/u.test(text) ? 'zh-CN' : 'en'), truncated,
      currentRouteId: null, fixedRouteId: options.fixedRouteId ?? null, initialized: false, escalations: 0, steps: [], evidence: [],
      configVersion: this.configVersion }, this.config.budget.limitMicrousd);
  }
  task(sessionId: string): TaskState { const task = this.store.bound(sessionId); invariant(task, 'TASK_NOT_BOUND'); return task; }
  invalidate(sessionId: string): void {
    const task = this.store.bound(sessionId); if (task) this.store.update(task.id, task.revision, () => {});
    this.selected.delete(sessionId);
  }
  updateTask(sessionId: string, input: { text?: string; language?: string; phase?: string; facts?: string[]; reevaluate?: boolean }): TaskState {
    const t = this.task(sessionId); invariant(t.status === 'active', 'TASK_CLOSED');
    invariant(input.text === undefined || input.text.trim(), 'TASK_INPUT_REQUIRED');
    invariant((input.facts?.length ?? 0) <= 32 && (input.facts ?? []).every(f => f.length <= 1000), 'TASK_FACTS_TOO_LARGE');
    const updated = this.store.update(t.id, t.revision, s => {
      if (input.text !== undefined) { const bytes = Buffer.from(input.text); s.text = new TextDecoder().decode(bytes.subarray(0, this.config.jev.maxStateBytes)); s.truncated = bytes.length > this.config.jev.maxStateBytes; }
      if (input.language) s.language = input.language;
      if (input.phase) s.phase = input.phase.slice(0, 200);
      if (input.facts) s.facts = input.facts;
      s.goalVersion = (s.goalVersion ?? 1) + 1;
      if (input.reevaluate !== false) s.initialized = false;
    });
    this.selected.delete(sessionId); this.store.event(t.id, 'task_updated', { goalVersion: updated.goalVersion, reevaluate: input.reevaluate !== false }); return updated;
  }
  fixRoute(sessionId: string, routeId: string | null): void {
    invariant(routeId === null || this.config.routes.some(r => r.id === routeId), 'UNKNOWN_ROUTE');
    const t = this.task(sessionId); this.store.update(t.id, t.revision, s => { s.fixedRouteId = routeId; });
    this.selected.delete(sessionId);
  }
  finish(sessionId: string, outcome: 'success' | 'failure' | 'cancelled'): void {
    const t = this.task(sessionId);
    this.store.update(t.id, t.revision, s => { s.status = outcome === 'cancelled' ? 'cancelled' : 'finished'; });
    this.store.event(t.id, 'outcome', { outcome }); this.selected.delete(sessionId);
  }
  recordEvidence(sessionId: string, value: Evidence): void {
    const evidence = evidenceSchema.parse(value); const t = this.task(sessionId);
    const old = t.evidence.find(e => e.eventId === evidence.eventId);
    if (old) { invariant(JSON.stringify(old) === JSON.stringify(evidence), 'EVIDENCE_CONFLICT'); return; }
    this.store.update(t.id, t.revision, s => { s.evidence.push(evidence); });
    this.selected.delete(sessionId);
  }
  route(id: string): Route { const r = this.config.routes.find(r => r.id === id); invariant(r, 'UNKNOWN_ROUTE'); return r; }
  routeFor(provider: string, model: string): Route {
    const r = this.config.routes.find(r => r.provider === provider && r.model === model); invariant(r, 'UNMANAGED_ROUTE'); return r;
  }
  async request(sessionId: string, originalRouteId: string, turn: number, step: number, signal?: AbortSignal, snapshot?: RequestSnapshot): Promise<Decision> {
    signal = this.signal(signal);
    checkAbort(signal); let task = this.task(sessionId); invariant(task.status === 'active', 'TASK_CLOSED');
    invariant(task.configVersion === this.configVersion, 'TASK_CONFIG_CHANGED');
    const position = `${turn}:${step}`;
    if (!task.steps.includes(position)) {
      invariant(task.steps.length < this.config.routing.maxTaskSteps, 'STEP_LIMIT');
      task = this.store.update(task.id, task.revision, s => { s.steps.push(position); });
    }
    const contextHash = snapshot ? digest(snapshot) : undefined;
    const key = `${task.id}:${task.revision}:${position}:${originalRouteId}:${contextHash ?? ''}`;
    const cached = this.selected.get(sessionId);
    if (cached?.revision === task.revision && cached.turn === turn && cached.step === step && cached.originalRouteId === originalRouteId && cached.contextHash === contextHash) return cached;
    const existing = this.inflight.get(key); if (existing) return existing;
    const operation = this.decideRequest(task, originalRouteId, turn, step, signal, snapshot);
    this.inflight.set(key, operation);
    try { return await operation; } finally { this.inflight.delete(key); }
  }
  private async decideRequest(task: TaskState, originalRouteId: string, turn: number, step: number, signal?: AbortSignal, snapshot?: RequestSnapshot): Promise<Decision> {
    const start = performance.now(), config = this.config; let judgment: Judgment | null = null;
    let fallback = 'jev_unavailable';
    const preflightRejected: { routeId: string; code: string }[] = [];
    const estimates = snapshot ? plans(config, snapshot, this.store, (routeId, code) => preflightRejected.push({ routeId, code })) : undefined;
    const requiresTools = snapshot ? Boolean(snapshot.tools?.length) : true;
    const initial = candidates(config, this.store.budget(task.id), requiresTools, task.currentRouteId, estimates);
    const hasCandidates = initial.length > 0;
    const semanticUseful = initial.some(r => r.tier === 'economy') && initial.some(r => r.tier === 'strong');
    let stateTruncated = task.truncated;
    if (hasCandidates && config.mode !== 'off' && !task.fixedRouteId && !task.initialized && this.strategy === 'rules') {
      const simple = /JSDoc|注释|文档|documentation/i.test(task.text) && !/跨文件|架构|调试|bug|debug/i.test(task.text);
      judgment = { model: 'deterministic-rules-v1', taskKind: simple ? 'documentation' : 'unknown', confidence: 1,
        probabilities: { documentation: simple ? 1 : 0, local_edit: 0, debugging: 0, design: 0, unknown: simple ? 0 : 1 },
        crossFile: simple ? 0 : 1, sufficient: 1 };
    } else if (hasCandidates && semanticUseful && config.mode !== 'off' && !task.fixedRouteId && !task.initialized && config.jev.allowStateTransmission) {
      try {
        judgment = await this.circuit.run(async () => {
          const key = apiKey(config.jev.apiKeyEnv);
          const state = classificationState(task, config.jev.maxStateBytes); stateTruncated = state.truncated;
          const body = requestBody(config.jev.model, state);
          invariant(Buffer.byteLength(JSON.stringify(body)) + 512 <= config.jev.maxInputTokens, 'JEV_INPUT_LIMIT');
          const raw = await this.paidJson(task.id, 'jev', costMicros([{ tokens: config.jev.maxInputTokens, price: config.jev.inputPerMillionUsd }]),
            () => postJson(config.jev.endpoint, body, { Authorization: `Bearer ${key}` }, config.jev.timeoutMs, signal, this.fetcher),
            value => { const usage = jevUsageSchema.parse(value).usage;
              this.store.event(task.id, 'jev_usage', { model: config.jev.model, usage, pricePerMillion: config.jev.inputPerMillionUsd });
              return costMicros([{ tokens: usage.input_tokens, price: config.jev.inputPerMillionUsd }]); }, signal);
          return parseJudgment(raw, config.jev.model);
        }, signal);
      } catch (error) {
        checkAbort(signal);
        if (!(error instanceof RouterError) || ['BUDGET_OVERRUN', 'TASK_CLOSED'].includes(error.code)) throw error;
        this.store.event(task.id, 'jev_fallback', { code: error.code });
      }
    } else if (!config.jev.allowStateTransmission) fallback = 'jev_transmission_disabled';
    checkAbort(signal);
    invariant(this.task(task.sessionId).id === task.id && this.store.task(task.id).revision === task.revision, 'STALE_CONTEXT');
    const eligible = candidates(config, this.store.budget(task.id), requiresTools, task.currentRouteId, estimates);
    if (config.optimization?.costAware && estimates) eligible.sort((a, b) => estimates.get(a.id)!.estimatedMicrousd - estimates.get(b.id)!.estimatedMicrousd);
    const proposal = config.mode === 'off' && !task.fixedRouteId
      ? { routeId: eligible.some(r => r.id === originalRouteId) ? originalRouteId : null, reason: 'off', escalation: false }
      : decide(config, { ...task, truncated: stateTruncated }, eligible, judgment, fallback);
    if (config.optimization?.costAware && estimates && proposal.routeId && task.currentRouteId && !proposal.escalation && !task.fixedRouteId && proposal.routeId !== task.currentRouteId) {
      const stay = estimates.get(task.currentRouteId), target = estimates.get(proposal.routeId);
      if (stay && target && eligible.some(r => r.id === task.currentRouteId) && this.route(proposal.routeId).tier === this.route(task.currentRouteId).tier &&
        (task.steps.length - (task.routeSinceStep ?? 0) < config.optimization.minResidenceSteps || stay.estimatedMicrousd <= target.estimatedMicrousd + config.optimization.switchMarginMicrousd)) {
        proposal.routeId = task.currentRouteId; proposal.reason = 'switch_not_worthwhile';
      }
    }
    if (proposal.routeId && !task.fixedRouteId && config.mode === 'auto' && this.config.routes.find(r => r.id === task.currentRouteId)?.tier === 'economy' && this.route(proposal.routeId).tier === 'strong') {
      if (task.escalations >= config.routing.maxEscalations) { proposal.routeId = null; proposal.reason = 'escalation_limit'; proposal.escalation = false; }
      else proposal.escalation = true;
    }
    const d: Decision = { id: randomUUID(), taskId: task.id, sessionId: task.sessionId, turn, step, revision: task.revision,
      mode: config.mode, policyVersion: config.policyVersion, questionVersion: config.questionVersion, modelRegistryVersion: config.modelRegistryVersion,
      classifier: this.strategy,
      originalRouteId, proposedRouteId: proposal.routeId, appliedRouteId: null, reason: proposal.reason, escalation: proposal.escalation,
      status: proposal.routeId ? (config.mode === 'shadow' ? 'shadow' : 'proposed') : 'held', judgment,
      ...(snapshot ? { contextHash: digest(snapshot), estimates: [...estimates!.values()], preflightRejected } : {}),
      routeLatencyMs: Math.round(performance.now() - start), createdAt: new Date().toISOString() };
    // Fixed choice is an explicit user setting, not an automatic shadow recommendation.
    const actual = task.fixedRouteId ?? (config.mode === 'shadow' ? originalRouteId : proposal.routeId);
    if (d.status === 'held' && config.mode === 'shadow') d.status = 'shadow';
    this.store.saveDecision(d);
    invariant(actual && eligible.some(r => r.id === actual), 'NO_ELIGIBLE_ROUTE');
    this.selected.set(task.sessionId, d); return d;
  }
  selectedRoute(d: Decision): Route {
    const task = this.task(d.sessionId);
    const id = task.fixedRouteId ?? (d.mode === 'shadow' ? d.originalRouteId : d.proposedRouteId);
    invariant(id, 'NO_ELIGIBLE_ROUTE'); return this.route(id);
  }
  planned(sessionId: string): Decision { const d = this.selected.get(sessionId); invariant(d, 'REQUEST_NOT_ROUTED'); return d; }
  async paidJson(taskId: string, kind: string, cap: number, send: () => Promise<unknown>, price: (value: unknown) => number,
    signal?: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    const operation = this.performPaidJson(taskId, kind, cap, send, price, this.signal(signal), beforeSend);
    this.network.add(operation);
    try { return await operation; } finally { this.network.delete(operation); }
  }
  private async performPaidJson(taskId: string, kind: string, cap: number, send: () => Promise<unknown>, price: (value: unknown) => number,
    signal: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    checkAbort(signal); const id = randomUUID(); this.store.reserve(id, taskId, kind, cap);
    let started = false;
    try {
      checkAbort(signal); beforeSend?.(); checkAbort(signal);
      started = true; const raw = await send();
      let amount: number;
      try { amount = price(raw); } catch (error) { if (error instanceof RouterError) throw error; throw new RouterError('INVALID_USAGE'); }
      this.store.settle(id, amount); checkAbort(signal); return raw;
    } catch (error) {
      if (started) this.store.pending(id); else this.store.settle(id, 0);
      throw error;
    }
  }
  dispatchStarted(d: Decision, routeId: string): void {
    const t = this.task(d.sessionId);
    invariant(t.id === d.taskId && t.revision === d.revision, 'STALE_CONTEXT');
    invariant(this.selectedRoute(d).id === routeId, 'ROUTE_CONFLICT');
    const priorAttempts = this.store.events(t.id).filter(e => {
      const row = e as { type: string; data: string }; if (row.type !== 'dispatch') return false;
      const data = JSON.parse(row.data) as { turn: number; step: number }; return data.turn === d.turn && data.step === d.step;
    }).length;
    invariant(priorAttempts < this.config.routing.maxAttemptsPerStep, 'ATTEMPT_LIMIT');
    this.store.markDispatch(d.id, routeId, t.revision, d.mode !== 'off');
    this.store.event(t.id, 'dispatch', { turn: d.turn, step: d.step, routeId, decisionId: d.id });
    this.selected.delete(d.sessionId);
  }
}
