import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage.js';
import type { Attempt } from '../src/telemetry.js';
import { engine } from './helpers.js';

function attempt(): Attempt { return { id: 'a', taskId: 'task-1', decisionId: 'd', routeId: 'strong', provider: 'jev-router-strong', model: 'mock',
  vendor: 'deepseek', priceVersion: 'synthetic', profile: 'deepseek', requestHash: 'hash', inputEstimate: 100, inputBound: null,
  capMicrousd: 100, status: 'streaming', usageFinal: false, requestId: 'request-1', startedAt: new Date().toISOString() }; }

test('CLI reconciles a crash-persisted request after explicit abandonment and records invoice metadata', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-reconcile-')), db = join(dir, 'state.sqlite'), receipt = join(dir, 'receipt.json');
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true }); });
  const f = engine('http://localhost'), state = f.router.task('session-1'); f.store.close();
  let store = new Store(db); store.create(state, 1000); store.reserve('a', 'task-1', 'llm', 100); store.saveAttempt(attempt()); store.close();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url)), run = promisify(execFile);
  writeFileSync(receipt, JSON.stringify({ attemptId: 'a', requestId: 'request-1', receiptRef: 'invoice-001/line-7', actualMicrousd: 40 }));
  await assert.rejects(run(process.execPath, [cli, 'reconcile', '--db', db, '--receipt', receipt]), /ATTEMPT_IN_FLIGHT/);
  const pending = await run(process.execPath, [cli, 'pending', '--db', db]); assert.equal(JSON.parse(pending.stdout).length, 1);
  await run(process.execPath, [cli, 'abandon', '--db', db, '--attempt', 'a', '--evidence', 'terminated-process-log']);
  store = new Store(db); assert.equal(store.budget('task-1').reserved, 100); store.close();
  const result = await run(process.execPath, [cli, 'reconcile', '--db', db, '--receipt', receipt]);
  const a = JSON.parse(result.stdout) as Attempt; assert.equal(a.status, 'reconciled'); assert.equal(a.actualMicrousd, 40); assert.equal(a.receiptRef, 'invoice-001/line-7'); assert.ok(a.reconciledAt);
  await run(process.execPath, [cli, 'reconcile', '--db', db, '--receipt', receipt]);
  store = new Store(db); assert.equal(store.budget('task-1').settled, 40); assert.equal(store.budget('task-1').reserved, 0); store.close();
});

test('invoice overrun preserves actual amount and receipt and blocks further paid calls', t => {
  const { store } = engine('http://localhost'); t.after(() => store.close());
  store.reserve('a', 'task-1', 'llm', 100); store.saveAttempt({ ...attempt(), status: 'cancelled' }); store.pending('a');
  assert.throws(() => store.reconcile('a', 150, 'invoice-overrun', 'request-1'), /BUDGET_OVERRUN/);
  assert.equal(store.budget('task-1').settled, 150); assert.equal(store.budget('task-1').blocked, true);
  assert.equal(store.attempt('a').receiptRef, 'invoice-overrun'); assert.equal(store.attempt('a').actualMicrousd, 150);
  assert.throws(() => store.reserve('b', 'task-1', 'llm', 1), /BUDGET_DENIED/);
});
