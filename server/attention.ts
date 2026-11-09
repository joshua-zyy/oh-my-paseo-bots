import type { PaseoAgent } from '@getpaseo/client';
import type { AttentionEntry, AttentionView } from '../shared/attention.js';
import type { BotIdentity, BotStore } from './store.js';
import type { TaskRecord, TaskTracker } from './tasks.js';
import type { MailOutbox } from './mail.js';
import type { BotRoutines } from './routines.js';
import type { GmailChecks } from './gmail-checks.js';

export interface AttentionSources {
  store: Pick<BotStore, 'listBots' | 'getBot'>;
  tasks: Pick<TaskTracker, 'list'>;
  mail: Pick<MailOutbox, 'list'>;
  routines: Pick<BotRoutines, 'list'>;
  gmail: Pick<GmailChecks, 'inspect'>;
  agent(id: string): Promise<Pick<PaseoAgent, 'title' | 'status' | 'pendingPermissions' | 'lastError' | 'archivedAt' | 'labels'> | null>;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const finished = (task: TaskRecord) => task.status === 'completed' || task.status === 'canceled';

/** Read existing sources only. No unread store, status writes, approvals or side-effect reconciliation. */
export async function readAttention(sources: AttentionSources): Promise<AttentionView> {
  const result: AttentionView = { entries: [], issues: [], botIds: [], scheduleIds: [] };
  const entries = new Map<string, AttentionEntry>();
  const schedules = new Set<string>();
  const bots = await sources.store.listBots((id, error) => result.issues.push({ botId: id, source: 'store', detail: message(error) }));
  result.botIds = bots.filter(bot => !bot.archivedAt).map(bot => bot.id).sort();
  function add(bot: BotIdentity, source: AttentionEntry['source'], sourceId: string, kind: AttentionEntry['kind'], title: string, target: AttentionEntry['target'], detail?: string) {
    const id = JSON.stringify([bot.id, source, sourceId]);
    entries.set(id, { id, botId: bot.id, botName: bot.name, source, sourceId, kind, title, target, ...(detail ? { detail } : {}) });
  }
  await Promise.all(bots.filter(bot => !bot.archivedAt).map(async bot => {
    async function read(source: string, work: () => Promise<void>) {
      try { await work(); } catch (error) { result.issues.push({ botId: bot.id, source, detail: message(error) }); }
    }
    if (bot.capabilityRequest?.state === 'pending') add(bot, 'capability', bot.capabilityRequest.id, 'decision', '能力方案待确认', { panel: 'capabilities' }, bot.capabilityRequest.summary);
    return Promise.all([
      read('work', async () => {
        const document = await sources.store.getBot(bot.id);
        if (!document) throw new Error('同事记录未找到，未判定无待办');
        for (const intent of document.creationIntents) {
          if (intent.status === 'pending') add(bot, 'creation', intent.requestId, 'unknown', '会话创建结果待回查', { panel: 'work' }, '只回查原请求，不换键重建；查看不确认创建。');
        }
        const tasks = await sources.tasks.list(bot.id);
        const taskById = new Map(tasks.map(task => [task.agentId, task]));
        const ids = new Set(tasks.filter(task => !finished(task)).flatMap(task => [task.agentId, ...task.specialists]));
        for (const session of document.sessions) if (!taskById.has(session.sessionId)) ids.add(session.sessionId);
        for (const task of tasks) for (const followup of task.followups) {
          if (followup.status === 'unknown') add(bot, 'followup', JSON.stringify([task.agentId, followup.key]), 'unknown', `${followup.name} · 跟进结果未知`, { panel: 'work' }, followup.detail);
        }
        await Promise.all([...ids].map(id => read(`agent:${id}`, async () => {
          const task = taskById.get(id);
          const agent = await sources.agent(id);
          if (agent?.labels['paseo-guys.bot'] && agent.labels['paseo-guys.bot'] !== bot.id) return;
          // Old conversation segments and archived unmanaged specialists are not unresolved work.
          if (agent?.archivedAt && (task?.conversation || !task)) return;
          const title = task?.title ?? agent?.title ?? id;
          if (agent?.pendingPermissions.length) add(bot, 'work', id, 'decision', `${title} · 待原生授权或回答`, { panel: 'agent', agentId: id }, `${agent.pendingPermissions.length}项请求；打开会话核对，查看不批准。`);
          else if (agent && (agent.status === 'error' || agent.lastError && !['running', 'initializing'].includes(agent.status))) add(bot, 'work', id, 'failure', `${title} · 运行异常`, { panel: 'agent', agentId: id }, agent.lastError ?? undefined);
          else if (task?.status === 'awaiting_review') add(bot, 'work', id, 'decision', `${title} · 待核对交付`, { panel: 'work' }, task.detail ?? task.summary);
          else if (task?.status === 'stopping') add(bot, 'work', id, 'unknown', `${title} · 停止待确认`, { panel: 'work' }, task.detail);
          else if (!agent || task && !task.conversation && (agent.archivedAt || agent.status === 'closed')) add(bot, 'work', id, 'unknown', `${title} · 工作结果待确认`, { panel: 'work' }, '原生回复结束或状态缺失不等于交付完成；核对原事项与产物。');
        })));
      }),
      read('mail', async () => {
        for (const action of await sources.mail.list(bot.id)) {
          if (['sent', 'revoked'].includes(action.status)) continue;
          const decision = ['pending_confirmation', 'approved', 'draft'].includes(action.status);
          add(bot, 'mail', action.id, decision ? 'decision' : 'unknown', `${action.subject} · ${decision ? '外发待处理' : '外发结果待回查'}`, { panel: 'work' }, decision ? '到原办公动作页核对完整收件人、正文和范围；查看不会发送。' : action.detail ?? '只回查原动作；发送在途或结果未知不等于失败，勿盲目重发。');
        }
      }),
      read('routines', async () => {
        for (const row of await sources.routines.list(bot.id, { reconcile: false })) {
          const { routine, native } = row;
          if (routine.nativeId) schedules.add(routine.nativeId);
          if (row.error || routine.state === 'unknown' || routine.runRequest?.state === 'unknown' || routine.state === 'canceled' && native?.status === 'active') {
            add(bot, 'routine', routine.id, 'unknown', `${routine.name} · 原生例程结果待回查`, { panel: 'routines' }, row.error ?? routine.detail ?? '只核对原例程及原运行请求，不重新派发。');
          } else if (routine.state !== 'canceled') {
            const latest = [...(native?.runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
            if (latest?.status === 'failed') add(bot, 'routine', routine.id, 'failure', `${routine.name} · 最近运行失败`, { panel: 'routines' }, latest.error ?? undefined);
          }
          await read(`gmail:${routine.id}`, async () => {
            const check = await sources.gmail.inspect(bot.id, routine.id);
            if (check?.state === 'dispatch_unknown' || check?.enabled && check.state === 'needs_sync') add(bot, 'gmail', routine.id, 'unknown', `${routine.name} · ${check.state === 'needs_sync' ? 'Gmail游标失效' : '邮件派发结果未知'}`, { panel: 'routines' }, check.detail ?? '保留原游标与请求，查看不重置或重派。');
          });
        }
      }),
    ]);
  }));
  const order = { decision: 0, failure: 1, unknown: 2 };
  result.entries = [...entries.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.botId.localeCompare(b.botId) || a.id.localeCompare(b.id));
  result.issues.sort((a, b) => `${a.botId}:${a.source}`.localeCompare(`${b.botId}:${b.source}`));
  result.scheduleIds = [...schedules].sort();
  return result;
}
