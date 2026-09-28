import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { invariant, RouterError } from './domain.js';
import type { Budget, TaskState, Decision } from './domain.js';
import type { Attempt, CacheObservation } from './telemetry.js';

export class Store {
  private db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL);
      INSERT INTO metadata SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM metadata);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, state TEXT NOT NULL, budget INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bindings(session TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, cap INTEGER NOT NULL, actual INTEGER, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, time TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reservations_task ON reservations(task);
      CREATE INDEX IF NOT EXISTS decisions_task ON decisions(task);`);
    invariant(this.db.prepare('SELECT version FROM metadata').get()?.version === 1, 'STORAGE_VERSION');
    // Additive migration: preserve every v0.1 task and outstanding reservation.
    this.db.exec(`CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY REFERENCES reservations(id), task TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache_observations(namespace TEXT NOT NULL, prefix TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,prefix));
      CREATE TABLE IF NOT EXISTS context_artifacts(id TEXT PRIMARY KEY, task TEXT NOT NULL, content TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  task(id: string): TaskState {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(id);
    invariant(row, 'TASK_NOT_FOUND'); return JSON.parse(String(row.state)) as TaskState;
  }
  bound(session: string): TaskState | null {
    const row = this.db.prepare('SELECT task FROM bindings WHERE session=?').get(session);
    return row ? this.task(String(row.task)) : null;
  }
  create(state: TaskState, budget: number): TaskState {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(state.id);
      if (row) {
        const old = JSON.parse(String(row.state)) as TaskState;
        invariant(old.sessionId === state.sessionId && old.text === state.text, 'TASK_ID_CONFLICT');
        invariant(old.status === 'active', 'TASK_CLOSED');
      } else {
        this.db.prepare('INSERT INTO tasks(id,state,budget) VALUES(?,?,?)').run(state.id, JSON.stringify(state), budget);
      }
      const bound = this.bound(state.sessionId);
      invariant(!bound || bound.id === state.id || bound.status !== 'active', 'SESSION_HAS_ACTIVE_TASK');
      this.db.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(session) DO UPDATE SET task=excluded.task').run(state.sessionId, state.id);
      return this.task(state.id);
    });
  }
  update(id: string, revision: number, change: (state: TaskState) => void): TaskState {
    return this.transaction(() => this.updateInside(id, revision, change));
  }
  private updateInside(id: string, revision: number, change: (state: TaskState) => void): TaskState {
    const state = this.task(id); invariant(state.revision === revision, 'STALE_CONTEXT');
    change(state); state.revision++;
    this.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(JSON.stringify(state), id);
    return state;
  }
  budget(id: string): Budget {
    const row = this.db.prepare(`SELECT t.budget,t.blocked,
      COALESCE(SUM(CASE WHEN r.actual IS NOT NULL THEN r.actual ELSE 0 END),0) settled,
      COALESCE(SUM(CASE WHEN r.actual IS NULL THEN r.cap ELSE 0 END),0) reserved
      FROM tasks t LEFT JOIN reservations r ON r.task=t.id WHERE t.id=? GROUP BY t.id`).get(id);
    invariant(row, 'TASK_NOT_FOUND');
    const limit = Number(row.budget), settled = Number(row.settled), reserved = Number(row.reserved);
    return { limit, settled, reserved, available: limit - settled - reserved, blocked: Boolean(row.blocked) };
  }
  reserve(id: string, task: string, kind: string, cap: number, floor = 0): void {
    invariant(Number.isSafeInteger(cap) && cap >= 0, 'INVALID_RESERVATION');
    this.transaction(() => {
      invariant(!this.db.prepare('SELECT 1 FROM reservations WHERE id=?').get(id), 'DUPLICATE_ATTEMPT');
      invariant(this.task(task).status === 'active', 'TASK_CLOSED');
      invariant(Number.isSafeInteger(floor) && floor >= 0, 'INVALID_RESERVATION');
      const b = this.budget(task); invariant(!b.blocked && b.available >= cap + floor, 'BUDGET_DENIED');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,NULL,?)').run(id, task, kind, cap, 'reserved');
    });
  }
  settle(id: string, actual: number): void {
    invariant(Number.isSafeInteger(actual) && actual >= 0, 'INVALID_USAGE');
    const overrun = this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      invariant(r, 'RESERVATION_NOT_FOUND');
      if (r.actual !== null) { invariant(Number(r.actual) === actual, 'SETTLEMENT_CONFLICT'); return false; }
      this.db.prepare("UPDATE reservations SET actual=?,status='settled' WHERE id=?").run(actual, id);
      const exceeded = actual > Number(r.cap);
      if (exceeded) this.db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(String(r.task));
      this.event(String(r.task), 'settlement', { id, actual, overrun: exceeded });
      return exceeded;
    });
    invariant(!overrun, 'BUDGET_OVERRUN');
  }
  pending(id: string): void {
    this.db.prepare("UPDATE reservations SET status='pending_reconciliation' WHERE id=? AND actual IS NULL").run(id);
  }
  reservations(task: string): unknown[] { return this.db.prepare('SELECT * FROM reservations WHERE task=? ORDER BY rowid').all(task); }
  saveAttempt(a: Attempt): void { this.db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id, a.taskId, JSON.stringify(a)); }
  attempt(id: string): Attempt { const row = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id); invariant(row, 'ATTEMPT_NOT_FOUND'); return JSON.parse(String(row.data)) as Attempt; }
  attempts(task: string): Attempt[] { return this.db.prepare('SELECT data FROM attempts WHERE task=? ORDER BY rowid').all(task).map(r => JSON.parse(String(r.data)) as Attempt); }
  pendingAttempts(): Attempt[] { return this.db.prepare('SELECT a.data FROM attempts a JOIN reservations r ON r.id=a.id WHERE r.actual IS NULL').all().map(r => JSON.parse(String(r.data)) as Attempt); }
  observeCache(value: CacheObservation): void {
    this.db.prepare('INSERT INTO cache_observations VALUES(?,?,?) ON CONFLICT(namespace,prefix) DO UPDATE SET data=excluded.data').run(value.namespace, value.prefixHash, JSON.stringify(value));
    this.db.prepare('DELETE FROM cache_observations WHERE rowid NOT IN (SELECT rowid FROM cache_observations ORDER BY rowid DESC LIMIT 1000)').run();
  }
  cache(namespace: string): CacheObservation[] { return this.db.prepare('SELECT data FROM cache_observations WHERE namespace=?').all(namespace).map(r => JSON.parse(String(r.data)) as CacheObservation); }
  saveArtifact(id: string, task: string, content: string): void { this.db.prepare('INSERT OR IGNORE INTO context_artifacts VALUES(?,?,?)').run(id, task, content); }
  artifact(id: string, task: string): string { const row = this.db.prepare('SELECT content FROM context_artifacts WHERE id=? AND task=?').get(id, task); invariant(row, 'ARTIFACT_NOT_FOUND'); return String(row.content); }
  reconcile(id: string, actual: number, receiptRef: string, requestId: string): void {
    const a = this.attempt(id); invariant(receiptRef.trim() && requestId.trim(), 'RECEIPT_REQUIRED');
    invariant(!(a.requestId ?? a.responseId) || requestId === (a.requestId ?? a.responseId), 'RECEIPT_REQUEST_MISMATCH');
    invariant(a.status !== 'streaming' && a.status !== 'reserved', 'ATTEMPT_IN_FLIGHT');
    // Settlement is idempotent and refuses a conflicting amount; overrun remains blocked.
    let failure: unknown;
    try { this.settle(id, actual); } catch (e) { if (!(e instanceof RouterError) || e.code !== 'BUDGET_OVERRUN') throw e; failure = e; }
    if (a.status !== 'reconciled') { this.event(a.taskId, 'receipt', { id, receiptRef, requestId, actual }); a.status = 'reconciled'; a.actualMicrousd = actual; a.receiptRef = receiptRef; a.reconciledAt = new Date().toISOString(); this.saveAttempt(a); }
    if (failure) throw failure;
  }
  markAbandoned(id: string, evidenceRef: string): void {
    const a = this.attempt(id); invariant(evidenceRef.trim(), 'RECEIPT_REQUIRED');
    invariant(['reserved', 'streaming'].includes(a.status), 'ATTEMPT_ALREADY_ENDED');
    a.status = 'failed'; a.errorCode = 'OPERATOR_CONFIRMED_ABANDONED'; this.pending(id); this.saveAttempt(a);
    this.event(a.taskId, 'abandoned', { id, evidenceRef });
  }
  saveDecision(d: Decision): void {
    this.db.prepare('INSERT INTO decisions VALUES(?,?,?)').run(d.id, d.taskId, JSON.stringify(d));
  }
  decision(id: string): Decision {
    const r = this.db.prepare('SELECT data FROM decisions WHERE id=?').get(id);
    invariant(r, 'DECISION_NOT_FOUND'); return JSON.parse(String(r.data)) as Decision;
  }
  supersede(id: string): void {
    const d = this.decision(id); d.status = 'superseded';
    this.db.prepare('UPDATE decisions SET data=? WHERE id=?').run(JSON.stringify(d), id);
  }
  decisions(task: string): Decision[] {
    return this.db.prepare('SELECT data FROM decisions WHERE task=? ORDER BY rowid').all(task).map(r => JSON.parse(String(r.data)) as Decision);
  }
  markDispatch(decisionId: string, actualRoute: string, revision: number, consumeSelection: boolean): void {
    this.transaction(() => {
      const d = this.decision(decisionId);
      invariant(d.status !== 'held', 'ROUTE_HELD');
      this.updateInside(d.taskId, revision, s => {
        invariant(s.status === 'active', 'TASK_CLOSED');
        if (consumeSelection && d.escalation && s.currentRouteId !== actualRoute) s.escalations++;
        if (s.currentRouteId !== actualRoute) s.routeSinceStep = s.steps.length;
        s.currentRouteId = actualRoute;
        if (d.judgment) s.taskKind = d.judgment.taskKind;
        if (consumeSelection) s.initialized = true;
      });
      d.appliedRouteId = actualRoute;
      d.status = d.mode === 'shadow' ? 'shadow' : 'applied';
      this.db.prepare('UPDATE decisions SET data=? WHERE id=?').run(JSON.stringify(d), d.id);
    });
  }
  event(task: string, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(task,type,data,time) VALUES(?,?,?,?)').run(task, type, JSON.stringify(data), new Date().toISOString());
  }
  events(task: string): unknown[] { return this.db.prepare('SELECT * FROM events WHERE task=? ORDER BY seq').all(task); }
}
