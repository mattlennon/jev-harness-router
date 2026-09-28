import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { install } from '../harness/plugin.js';
import type { RouterEngine } from '../engine.js';

/** Full official runtime for the runnable local demo and integration tests. */
export async function nativeRuntime(engine: RouterEngine) {
  const ctx = new Context();
  const disposers: (() => Promise<void>)[] = [];
  async function mounted(fiber: ReturnType<Context['plugin']>) {
    disposers.push(async () => { await fiber.dispose(); });
    await fiber.await();
  }
  const close = async () => { for (const dispose of disposers.reverse()) await dispose(); };
  try {
    await mounted(ctx.plugin(LlmRuntime));
    await mounted(ctx.plugin(SessionStore));
    await mounted(ctx.plugin(SessionProjectionRegistry));
    await mounted(ctx.plugin(SystemPrompt, { personaPrefix: '' }));
    await mounted(ctx.plugin(ToolRuntime));
    await mounted(ctx.plugin(AgentRegistry));
    await mounted(ctx.plugin({ name: 'demo-router', inject: ['llm'], apply(c: Context) { install(c, engine); } }));
    await mounted(ctx.plugin(AgentLoop, { agents: [] }));
    return { ctx, close };
  } catch (error) { await close(); throw error; }
}
