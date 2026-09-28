import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { RouterEngine } from '../engine.js';
import { digest } from '../wire.js';
import { invariant } from '../domain.js';

/** Durable replacement at a completed tool boundary. Originals remain in the session log and artifact store. */
export function compactToolResults(agent: Agent, engine: RouterEngine): number {
  const settings = engine.config.optimization; if (!settings) return 0;
  const task = engine.task(agent.id), surface = new Set(agent.session.surface.nodes);
  const events = agent.session.snapshotEvents().filter(e => e.type === 'tool/result' && surface.has(e.seq));
  let count = 0;
  for (const event of events.slice(0, Math.max(0, events.length - settings.retainRecentToolResults))) {
    if (event.type !== 'tool/result' || event.data.message.isError) continue;
    const message = event.data.message; if (!message.content.every(c => c.type === 'text')) continue;
    const text = message.content.map(c => c.type === 'text' ? c.text : '').join('');
    if (text.length <= settings.toolResultMaxChars || text.includes('[jev-context:')) continue;
    const id = digest([task.id, text]), edge = Math.floor((settings.toolResultMaxChars - 220) / 2);
    engine.store.saveArtifact(id, task.id, text);
    const reduced = `${text.slice(0, edge)}\n[jev-context:${id}; ${text.length} chars. Middle omitted. Use router_read_context with id and offset to read original.]\n${text.slice(-edge)}`;
    agent.session.append('tool/result', { ...event.data, message: { ...message,
      content: [{ type: 'text', text: reduced }] } },
    { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
    engine.store.event(task.id, 'context_compacted', { artifactId: id, sourceSeq: event.seq, beforeChars: text.length, afterChars: reduced.length }); count++;
  }
  if (count) engine.invalidate(agent.id); return count;
}

export interface Checkpoint { goal: string; facts: string[]; changes: { path: string; version: string }[]; tests: string[]; unresolved: string[]; evidenceRef: string }
/** Host-approved checkpoint only; never silently summarize or reinterpret reasoning blocks. */
export function checkpoint(agent: Agent, engine: RouterEngine, covered: SessionSeq[], value: Checkpoint): void {
  invariant(agent.status === 'idle', 'CHECKPOINT_REQUIRES_IDLE');
  invariant(value.goal.trim() && value.evidenceRef.trim() && covered.length, 'CHECKPOINT_EVIDENCE_REQUIRED');
  invariant(engine.task(agent.id).status === 'active', 'TASK_CLOSED');
  invariant(value.facts.length <= 32 && value.facts.every(f => f.length <= 1000), 'TASK_FACTS_TOO_LARGE');
  const nodes = [...agent.session.surface.nodes], start = nodes.indexOf(covered[0]!), end = nodes.indexOf(covered.at(-1)!);
  invariant(start >= 0 && end >= start && JSON.stringify(nodes.slice(start, end + 1)) === JSON.stringify(covered), 'CHECKPOINT_RANGE');
  const set = new Set(covered), events = agent.session.snapshotEvents().filter(e => set.has(e.seq));
  invariant(events.every(e => e.type !== 'system/message' && e.type !== 'developer/message'), 'CHECKPOINT_PROTECTED_MESSAGE');
  const calls = new Set<string>(), results = new Set<string>();
  for (const e of events) {
    const m = agent.session.deriveEventMessage(e); if (!m) continue;
    for (const c of m.content) if (c.type === 'tool-call') calls.add(c.id);
    if (m.role === 'tool') results.add(m.toolCallId);
  }
  invariant(calls.size === results.size && [...calls].every(id => results.has(id)), 'CHECKPOINT_UNPAIRED_TOOLS');
  const text = `Host-verified task checkpoint (facts and evidence, not private reasoning):\n${JSON.stringify(value)}`;
  invariant(text.length <= 16000, 'CHECKPOINT_TOO_LARGE');
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: { op: 'replace', startSeq: covered[0]!, endSeq: covered.at(-1)! }, sourceEventSeqs: covered });
  engine.updateTask(agent.id, { text: value.goal, facts: value.facts, reevaluate: true });
  engine.store.event(engine.task(agent.id).id, 'checkpoint', { sourceSeqs: covered, evidenceRef: value.evidenceRef, hash: digest(value) });
}
