// Run after npm run build. This example sends real paid requests when configured.
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as RouterPlugin from '../dist/src/harness/plugin.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const prompt = arg('--prompt');
if (!prompt) throw new Error('Usage: node examples/agent.mjs --prompt "..." [--config PATH --route ID]');
const ctx = new Context(), fibers = [];
const mount = async (plugin, config) => {
  const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await();
};
try {
  await mount(LlmRuntime);
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(SystemPrompt, { personaPrefix: '' });
  await mount(ToolRuntime);
  await mount(AgentRegistry);
  await mount(RouterPlugin, { routerConfigFile: arg('--config', 'config/router.local.json'), databaseFile: arg('--db', 'data/router.sqlite') });
  await mount(AgentLoop, { agents: [] });
  const engine = ctx.jevRouter.engine;
  const fixed = arg('--route');
  const route = engine.route(fixed ?? engine.config.defaultRouteId);
  const session = SessionId(`example-${Date.now()}`);
  const task = engine.beginTask(session, prompt, { ...(fixed ? { fixedRouteId: fixed } : {}) });
  const agent = await ctx.agentLoop.create(session, { provider: route.provider, model: route.model });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const events = agent.session.snapshotEvents();
  // A model reply is not a successful task validation: leave outcome to the host.
  console.log(JSON.stringify({ taskId: task.id, budget: engine.store.budget(task.id), decisions: engine.store.decisions(task.id), sessionEvents: events }, null, 2));
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}
