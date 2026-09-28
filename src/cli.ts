import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './config.js';
import { configurationTemplate } from './template.js';
import { demo, demoEvaluation } from './demo.js';
import { readTasks, runEvaluation, writeReport } from './evaluation.js';
import type { TaskExecutor } from './evaluation.js';
import { Store } from './storage.js';
import { RouterEngine } from './engine.js';
import { GuardedChatAdapter } from './harness/adapter.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { collect } from './testing/fixtures.js';
import { invariant, RouterError } from './domain.js';

const args = process.argv.slice(2), command = args[0] ?? 'help';
function arg(name: string, fallback?: string): string | undefined { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function save(path: string, value: unknown): void { mkdirSync(dirname(resolve(path)), { recursive: true }); writeReport(path, value); }
async function main(): Promise<void> {
  if (['pending', 'reconcile', 'abandon'].includes(command)) {
    const store = new Store(arg('--db', 'data/router.sqlite')!);
    try {
      if (command === 'pending') { console.log(JSON.stringify(store.pendingAttempts(), null, 2)); return; }
      if (command === 'abandon') {
        const id = arg('--attempt'), evidence = arg('--evidence'); invariant(id && evidence, 'ATTEMPT_AND_EVIDENCE_REQUIRED');
        store.markAbandoned(id, evidence); console.log('已标记操作员确认终止；预算预留仍保留。'); return;
      }
      const receipt = arg('--receipt'); invariant(receipt, 'RECEIPT_REQUIRED');
      const value = JSON.parse(readFileSync(receipt, 'utf8')) as Record<string, unknown>;
      invariant(typeof value.attemptId === 'string' && typeof value.requestId === 'string' && typeof value.receiptRef === 'string' && typeof value.actualMicrousd === 'number', 'INVALID_RECEIPT');
      store.reconcile(value.attemptId, value.actualMicrousd, value.receiptRef, value.requestId);
      console.log(JSON.stringify(store.attempt(value.attemptId), null, 2)); return;
    } finally { store.close(); }
  }
  if (command === 'init') {
    const path = arg('--config', 'config/router.local.json')!; invariant(!existsSync(path), 'CONFIG_ALREADY_EXISTS');
    save(path, configurationTemplate(args.includes('--reasoning'))); console.log(`配置模板已创建：${resolve(path)}`); return;
  }
  if (command === 'demo') {
    const result = await demo(), path = arg('--out', 'artifacts/demo.json')!; save(path, result);
    console.log(JSON.stringify({ synthetic: true, routes: result.decisions.map(d => d.appliedRouteId), budget: result.budget, report: resolve(path) }, null, 2)); return;
  }
  if (command === 'eval') {
    const path = arg('--out', 'artifacts/evaluation.synthetic.json')!;
    const executorPath = arg('--executor');
    if (!executorPath) { const report = await demoEvaluation(); save(path, report); console.log(JSON.stringify({ synthetic: true, summary: report.summary, report: resolve(path) }, null, 2)); return; }
    const tasksPath = arg('--tasks'); invariant(tasksPath, 'TASK_MANIFEST_REQUIRED');
    const module = await import(pathToFileURL(resolve(executorPath)).href) as { execute?: TaskExecutor };
    invariant(typeof module.execute === 'function', 'EXECUTOR_EXPORT_REQUIRED');
    const report = await runEvaluation(readTasks(tasksPath), module.execute, { synthetic: false, seed: 1729 }); save(path, report);
    console.log(`评测报告：${resolve(path)}`); return;
  }
  if (command === 'doctor' || command === 'smoke') {
    const path = arg('--config', 'config/router.example.json')!; const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
    if (command === 'doctor') {
      const result = { configurationValid: true, mode: config.mode, jevKeyPresent: Boolean(process.env[config.jev.apiKeyEnv]),
        jevTransmissionEnabled: config.jev.allowStateTransmission,
        routes: config.routes.map(r => ({ id: r.id, vendor: r.vendor, model: r.model, ready: r.ready, keyPresent: Boolean(process.env[r.apiKeyEnv]),
          transport: r.transport ?? 'json', reasoning: r.reasoning ?? null, compatibleFrom: r.capabilities.compatibleFrom })), calibrationReportId: config.calibrationReportId };
      console.log(JSON.stringify(result, null, 2)); return;
    }
    const routeId = arg('--route', config.defaultRouteId)!;
    invariant(config.routes.some(r => r.id === routeId && r.ready), 'ROUTE_NOT_READY');
    const store = new Store(arg('--db', 'data/router.sqlite')!), engine = new RouterEngine(config, store);
    try {
      const session = `smoke-${Date.now()}`; const state = engine.beginTask(session, '请只回复 OK。', { fixedRouteId: routeId });
      const decision = await engine.request(session, routeId, 1, 1), route = engine.selectedRoute(decision);
      const request: GenerateOptions = { provider: route.provider, model: route.model, sessionId: session as GenerateOptions['sessionId'] & string,
        maxTokens: Math.min(route.capabilities.maxOutputTokens, 128), messages: [createUserMessage({ content: [{ type: 'text', text: '请只回复 OK。' }], source: { kind: 'user' } })] };
      const chunks = await collect(new GuardedChatAdapter(engine).stream(request));
      const result = { synthetic: false, route: route.id, chunks, attempts: store.attempts(state.id), budget: store.budget(state.id) };
      save(arg('--out', 'artifacts/live-smoke.json')!, result); console.log(JSON.stringify(result, null, 2));
    } finally { await engine.shutdown(); store.close(); }
    return;
  }
  console.log('Commands: init | doctor | demo | eval | smoke | pending --db PATH | reconcile --db PATH --receipt JSON | abandon --db PATH --attempt ID --evidence REF');
}
main().catch(error => {
  console.error(error instanceof RouterError ? error.code : error instanceof Error && error.name === 'ZodError' ? error.message : '命令失败，请检查配置文件、工作目录和运行条件。');
  process.exitCode = 1;
});
