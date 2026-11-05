import type { PaseoApi } from '@getpaseo/client';
import { CHIEF_BOT_ID } from '../shared/bot.js';
import type { BotStore } from './store.js';
import type { TaskTracker } from './tasks.js';
import type { BotRoutines } from './routines.js';

/** 归档不是停止执行：有未处理工作时要求用户先在原入口完成或取消。 */
export async function archiveBot({ store, tasks, routines, paseo }: {
  store: BotStore; tasks: Pick<TaskTracker, 'list'>; routines: Pick<BotRoutines, 'list'>; paseo: PaseoApi;
}, botId: string) {
  if (botId === CHIEF_BOT_ID) throw new Error('主 Bot Chief 不能归档');
  const bot = await store.getBot(botId);
  if (!bot) throw new Error(`Bot 不存在：${botId}`);
  if (bot.bot.archivedAt) return bot.bot;
  if (bot.creationIntents.some(intent => intent.status === 'pending')) throw new Error('存在未决创建，请先在工作记录回查创建结果');
  const work = await tasks.list(botId);
  if (work.some(task => (!task.conversation && !['completed', 'canceled'].includes(task.status)) || task.followups.some(followup => !['inactive', 'deleted'].includes(followup.status)))) throw new Error('存在未结束事项或跟进，请先完成或取消后再归档');
  const schedules = await routines.list(botId);
  if (schedules.some(({ routine, native, error }) => error || !native || (routine.state !== 'canceled' && native.status !== 'completed') || native.status === 'active' || native.runs.some(run => run.status === 'running'))) throw new Error('存在有效或结果未确认的例程，请先在例程页取消并核对结果');
  for (const session of bot.sessions) {
    const snapshot = await paseo.agents.ref(session.sessionId).refresh();
    if (snapshot && !snapshot.agent.archivedAt && (snapshot.agent.status === 'running' || snapshot.agent.status === 'initializing' || snapshot.agent.pendingPermissions.length)) throw new Error('同事仍在回复或等待授权，请先处理后再归档');
  }
  return store.setArchived(botId, true);
}
