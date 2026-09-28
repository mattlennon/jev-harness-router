import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { invariant } from './domain.js';

export const groups = ['fixed-economy', 'fixed-strong', 'rules', 'jev'] as const;
export type Group = typeof groups[number];
export interface EvaluationTask { id: string; language: string; prompt: string; fixture: unknown; expected: unknown }
export interface ExecutionResult {
  success: boolean; costMicrousd: number; pendingMicrousd: number; elapsedMs: number; evidence: string[];
}
export type TaskExecutor = (task: EvaluationTask, group: Group) => Promise<ExecutionResult>;

/** Each executor must reset the workspace and independently validate the result. */
export async function runEvaluation(tasks: EvaluationTask[], execute: TaskExecutor, options: { synthetic: boolean; seed: number }) {
  invariant(new Set(tasks.map(t => t.id)).size === tasks.length, 'DUPLICATE_EVALUATION_TASK');
  const rows: (ExecutionResult & { taskId: string; language: string; group: Group })[] = [];
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!; const offset = (options.seed + index) % groups.length;
    const order = [...groups.slice(offset), ...groups.slice(0, offset)];
    for (const group of order) {
      const result = await execute(structuredClone(task), group);
      invariant([result.costMicrousd, result.pendingMicrousd].every(v => Number.isSafeInteger(v) && v >= 0), 'INVALID_EVALUATION_COST');
      invariant(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 && typeof result.success === 'boolean', 'INVALID_EVALUATION_RESULT');
      rows.push({ taskId: task.id, language: task.language, group, ...result });
    }
  }
  const summary = groups.map(group => {
    const selected = rows.filter(r => r.group === group); const successes = selected.filter(r => r.success).length;
    const total = selected.reduce((a, r) => a + r.costMicrousd, 0), pending = selected.reduce((a, r) => a + r.pendingMicrousd, 0);
    return { group, tasks: selected.length, successes, successRate: selected.length ? successes / selected.length : null,
      totalCostMicrousd: total, pendingMicrousd: pending,
      costPerSuccessMicrousd: successes ? (total + pending) / successes : null,
      costBasis: pending ? 'settled-plus-conservative-pending-cap' : 'settled' };
  });
  return { schemaVersion: 1, synthetic: options.synthetic, seed: options.seed, createdAt: new Date().toISOString(),
    conclusion: options.synthetic ? 'Protocol exercise only; no model quality or savings claim.' : 'Descriptive results only; calibration and statistical acceptance remain required.',
    rows, summary };
}
const taskSchema = z.object({ id: z.string().min(1), language: z.string(), prompt: z.string(), fixture: z.unknown(), expected: z.unknown() }).strict();
export function readTasks(path: string): EvaluationTask[] { return z.array(taskSchema).min(1).parse(JSON.parse(readFileSync(path, 'utf8'))); }
export function writeReport(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
