import { execCommand } from '@getpaseo/plugin/server';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import type { BotStore } from './store.js';
import type { TaskCliProvider, TaskExecute, TaskTracker } from './tasks.js';

export async function stopBotReply(options: {
  store: BotStore; tasks: Pick<TaskTracker, 'list'>; paseo: PaseoApi; botId: string; agentId: string; cli: TaskCliProvider;
}, execute: TaskExecute = execCommand) {
  const { store, tasks, paseo, botId, agentId } = options;
  const bot = await store.getBot(botId);
  const linked = bot && (bot.sessions.some(session => session.sessionId === agentId) || bot.creationIntents.some(intent => intent.agentId === agentId) || (await tasks.list(botId)).some(task => task.specialists.includes(agentId)));
  if (!linked) throw new Error('该原生会话未关联到此 Bot');
  const handle = paseo.agents.ref(agentId);
  const snapshot = await handle.refresh();
  if (!snapshot) throw new Error('原生会话未找到');
  if (snapshot.agent.archivedAt || snapshot.agent.status !== 'running') return { agentId, status: 'idle' as const };
  const cli = typeof options.cli === 'function' ? await options.cli() : options.cli;
  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_AGENT_ID: agentId, PASEO_AGENT_CWD: cli.cwd };
  if (cli.home) delete env.PASEO_HOST;
  const { stdout } = await execute(cli.command, ['agent', 'stop', agentId, ...(cli.home ? ['--home', cli.home] : []), '--json'], { cwd: cli.cwd, env, timeout: 30000, maxBuffer: 1024 * 1024 });
  let response: { stoppedCount: number; agentIds: string[] };
  try { response = z.object({ stoppedCount: z.number().int().nonnegative(), agentIds: z.array(z.literal(agentId)) }).parse(JSON.parse(stdout)); }
  catch { throw new Error('原生停止回执无法核实，请刷新聊天查看实际状态'); }
  if (response.agentIds.includes(agentId)) return { agentId, status: 'requested' as const };
  // The native CLI can finish with exit 0 after reporting a per-agent stop failure.
  const after = await handle.refresh();
  if (!after || after.agent.status === 'running') throw new Error('原生未确认停止，请刷新聊天查看实际状态');
  return { agentId, status: 'idle' as const };
}
