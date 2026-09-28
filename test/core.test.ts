import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/storage.js';
import { parseConfig } from '../src/config.js';
import { costMicros } from '../src/money.js';
import { parseJudgment, JevCircuit } from '../src/jev.js';
import { RouterError } from '../src/domain.js';
import { decide, candidates, needsEscalation } from '../src/policy.js';
import { fixtureConfig, engine, simpleResponse } from './helpers.js';

test('configuration rejects unsafe auto, placeholder routes and unbounded output', () => {
  const cfg = fixtureConfig('http://127.0.0.1');
  cfg.calibrationReportId = null; assert.throws(() => parseConfig(cfg));
  cfg.mode = 'shadow'; cfg.routes[0]!.ready = false; assert.doesNotThrow(() => parseConfig(cfg));
  cfg.routes[1]!.capabilities.outputIncludesReasoning = false; assert.throws(() => parseConfig(cfg));
});
test('money rounds totals upwards and includes zero correctly', () => {
  assert.equal(costMicros([{ tokens: 1200, price: 0.042 }]), 51);
  assert.equal(costMicros([{ tokens: 3, price: 0.1 }, { tokens: 7, price: 0.1 }]), 1);
  assert.throws(() => costMicros([{ tokens: -1, price: 1 }]));
});
test('Jev rejects mismatched probabilities, model versions and illegal Noul confidence', () => {
  assert.equal(parseJudgment(simpleResponse, 'jev-1.13.0').taskKind, 'documentation');
  const wrong = structuredClone(simpleResponse); wrong.answers.task_kind.probabilities.unknown = 0.5;
  assert.throws(() => parseJudgment(wrong, 'jev-1.13.0'));
  assert.throws(() => parseJudgment(simpleResponse, 'jev-2.0.0'));
  assert.throws(() => parseJudgment({ ...simpleResponse, answers: { ...simpleResponse.answers,
    cross_file_reasoning: { type: 'noul', noul: 0.1, confidence: 1 } } }, 'jev-1.13.0'));
});
test('policy keeps fixed route, respects missing candidate, language and incomplete context', () => {
  const { router, store } = engine('http://127.0.0.1');
  const task = router.task('session-1'), cfg = router.config, all = candidates(cfg, store.budget(task.id));
  const j = parseJudgment(simpleResponse, cfg.jev.model);
  assert.equal(decide(cfg, task, all, j).routeId, 'economy');
  task.fixedRouteId = 'strong'; assert.equal(decide(cfg, task, all, j).routeId, 'strong');
  assert.equal(decide(cfg, task, all.filter(r => r.id !== 'strong'), j).routeId, null);
  task.fixedRouteId = null; task.language = 'unverified'; assert.equal(decide(cfg, task, all, j).routeId, 'strong');
  task.language = 'zh-CN'; task.truncated = true; assert.equal(decide(cfg, task, all, j).routeId, 'strong');
  store.close();
});
test('only two distinct failed repairs of the same goal qualify for one escalation', () => {
  const { router, store } = engine('http://127.0.0.1'); const task = router.task('session-1'); task.currentRouteId = 'economy';
  const e = { eventId: '1', repairAttemptId: 'repair1', goalId: 'goal', category: 'task_validation' as const, outcome: 'fail' as const, evidenceRef: 'test-log' };
  task.evidence = [e, { ...e, eventId: '2' }]; assert.equal(needsEscalation(task, router.config), false);
  task.evidence.push({ ...e, eventId: '3', repairAttemptId: 'repair2', category: 'transport' }); assert.equal(needsEscalation(task, router.config), false);
  task.evidence.push({ ...e, eventId: '4', repairAttemptId: 'repair2' }); assert.equal(needsEscalation(task, router.config), true);
  task.escalations = 1; assert.equal(needsEscalation(task, router.config), false);
  store.close();
});
test('ledger survives restart, retains uncertain fees and settles idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ledger-')); const path = join(dir, 'state.sqlite');
  const fixture = engine('http://127.0.0.1'); const state = fixture.router.task('session-1'); fixture.store.close();
  let db = new Store(path); db.create(state, 100); db.reserve('a', state.id, 'llm', 60); db.pending('a'); db.close();
  db = new Store(path); assert.equal(db.budget(state.id).available, 40);
  assert.throws(() => db.reserve('b', state.id, 'llm', 41), /BUDGET_DENIED/);
  db.settle('a', 25); db.settle('a', 25); assert.equal(db.budget(state.id).available, 75);
  assert.throws(() => db.settle('a', 26), /SETTLEMENT_CONFLICT/);
  db.reserve('b', state.id, 'llm', 40); assert.throws(() => db.settle('b', 60), /BUDGET_OVERRUN/);
  assert.equal(db.budget(state.id).blocked, true); assert.equal(db.budget(state.id).settled, 85);
  db.close(); rmSync(dir, { recursive: true });
});
test('two OS processes cannot reserve the same remaining money twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-race-')), path = join(dir, 'state.sqlite');
  const fixture = engine('http://127.0.0.1'); const state = fixture.router.task('session-1'); fixture.store.close();
  const db = new Store(path); db.create(state, 100);
  const module = new URL('../src/storage.js', import.meta.url).href;
  const script = `import {Store} from ${JSON.stringify(module)}; const s=new Store(process.argv[1]); try{s.reserve(process.argv[2],'task-1','llm',60);console.log('ok')}catch(e){console.log(e.code)}finally{s.close()}`;
  const run = promisify(execFile);
  const results = await Promise.all(['a', 'b'].map(id => run(process.execPath, ['--input-type=module', '-e', script, path, id])));
  assert.deepEqual(results.map(r => r.stdout.trim()).sort(), ['BUDGET_DENIED', 'ok']);
  assert.equal(db.budget(state.id).reserved, 60); db.close(); rmSync(dir, { recursive: true });
});
test('circuit allows one half-open probe and does not count cancellation', async () => {
  let now = 0; const circuit = new JevCircuit({ failuresToOpen: 2, openMs: 100 }, () => now);
  const fail = () => Promise.reject(new RouterError('HTTP_503'));
  await assert.rejects(circuit.run(fail)); await assert.rejects(circuit.run(fail));
  await assert.rejects(circuit.run(async () => 1), /JEV_CIRCUIT_OPEN/);
  now = 101; let done!: () => void; const probe = circuit.run(() => new Promise<void>(r => { done = r; }));
  await assert.rejects(circuit.run(async () => 1), /JEV_CIRCUIT_OPEN/); done(); await probe;
  assert.equal(await circuit.run(async () => 5), 5);
});
