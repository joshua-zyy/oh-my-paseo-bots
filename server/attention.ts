import type { PaseoAgent } from '@getpaseo/client';
import type { AttentionEntry, AttentionView } from '../shared/attention.js';
import type { BotIdentity, BotStore } from './store.js';
import { TASK_STOPPING_IN_FLIGHT, type TaskRecord, type TaskTracker } from './tasks.js';

export interface AttentionSources {
  store: Pick<BotStore, 'listBots' | 'getBot'>;
  tasks: Pick<TaskTracker, 'list'>;
  agent(id: string): Promise<Pick<PaseoAgent, 'title' | 'status' | 'pendingPermissions' | 'lastError' | 'archivedAt' | 'labels' | 'activeTurn'> | null>;
  recordIssues?(): AttentionView['issues'];
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const finished = (task: TaskRecord) => task.status === 'completed' || task.status === 'canceled';
const notice = (channel: NonNullable<AttentionEntry['notice']>['channel'], reason: NonNullable<AttentionEntry['notice']>['reason'], ...ids: unknown[]): NonNullable<AttentionEntry['notice']> => ({ channel, reason, episode: JSON.stringify(ids) });

/** Read existing sources only. No unread store, status writes, approvals or side-effect reconciliation. */
export async function readAttention(sources: AttentionSources): Promise<AttentionView> {
  const result: AttentionView = { entries: [], issues: [], botIds: [] };
  const entries = new Map<string, AttentionEntry>();
  const bots = await sources.store.listBots((id, error) => result.issues.push({ botId: id, source: 'store', detail: message(error) }));
  result.botIds = bots.map(bot => bot.id).sort();
  function add(bot: BotIdentity, source: AttentionEntry['source'], sourceId: string, kind: AttentionEntry['kind'], title: string, target: AttentionEntry['target'], detail?: string, reminder?: AttentionEntry['notice']) {
    const id = JSON.stringify([bot.id, source, sourceId]);
    entries.set(id, { id, botId: bot.id, botName: bot.name, source, sourceId, kind, title, target, ...(detail ? { detail } : {}), ...(reminder ? { notice: reminder } : {}) });
  }
  await Promise.all(bots.map(async bot => {
    async function read(source: string, work: () => Promise<void>) {
      try { await work(); } catch (error) { result.issues.push({ botId: bot.id, source, detail: message(error) }); }
    }
    return read('work', async () => {
        const document = await sources.store.getBot(bot.id);
        if (!document) throw new Error('同事记录未找到，未判定无待办');
        for (const intent of document.creationIntents) {
          if (intent.status === 'pending') {
            add(bot, 'creation', intent.requestId, 'unknown', '会话创建结果待回查', { panel: 'work' }, '只回查原请求，不换键重建；查看不确认创建。', notice('progress', 'inflight', intent.requestId));
          }
        }
        const tasks = await sources.tasks.list(bot.id);
        const taskById = new Map(tasks.map(task => [task.agentId, task]));
        const ids = new Set(tasks.filter(task => !finished(task)).flatMap(task => [task.agentId, ...task.specialists]));
        for (const session of document.sessions) if (!taskById.has(session.sessionId)) ids.add(session.sessionId);
        await Promise.all([...ids].map(id => read(`agent:${id}`, async () => {
          const task = taskById.get(id);
          const agent = await sources.agent(id);
          if (agent?.labels['paseo-guys.bot'] && agent.labels['paseo-guys.bot'] !== bot.id) return;
          // Old conversation segments and archived unmanaged specialists are not unresolved work.
          if (agent?.archivedAt && (task?.conversation || !task)) return;
          const title = task?.title ?? agent?.title ?? id;
          const nativeChannel = agent?.labels['paseo.parent-agent-id'] ? 'plugin' : 'host';
          if (agent?.pendingPermissions.length) add(bot, 'work', id, 'decision', `${title} · 待原生授权或回答`, { panel: 'agent', agentId: id }, `${agent.pendingPermissions.length}项请求；打开会话核对，查看不批准。`, notice(nativeChannel, 'native_permission', id, agent.pendingPermissions.map(permission => permission.id).sort()));
          else if (agent && (agent.status === 'error' || agent.lastError && !['running', 'initializing'].includes(agent.status))) add(bot, 'work', id, 'failure', `${title} · 运行异常`, { panel: 'agent', agentId: id }, agent.lastError ?? undefined, notice(nativeChannel, 'native_error', id, agent.activeTurn?.turnId ?? null));
          else if (task?.status === 'awaiting_review') add(bot, 'work', id, 'decision', `${title} · 待核对交付`, { panel: 'work' }, task.detail ?? task.summary, notice('plugin', 'task_review', id));
          else if (task?.status === 'stopping') add(bot, 'work', id, 'unknown', `${title} · 停止待确认`, { panel: 'work' }, task.detail, notice(task.detail === TASK_STOPPING_IN_FLIGHT ? 'progress' : 'plugin', 'task_stop', id));
          else if (!agent || task && !task.conversation && (agent.archivedAt || agent.status === 'closed')) add(bot, 'work', id, 'unknown', `${title} · 工作结果待确认`, { panel: 'work' }, '原生回复结束或状态缺失不等于交付完成；核对原事项与产物。', notice('plugin', 'task_unreported', id));
        })));
      });
  }));
  const order = { decision: 0, failure: 1, unknown: 2 };
  result.entries = [...entries.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.botId.localeCompare(b.botId) || a.id.localeCompare(b.id));
  result.issues.push(...sources.recordIssues?.() ?? []);
  result.issues.sort((a, b) => `${a.botId}:${a.source}`.localeCompare(`${b.botId}:${b.source}`));
  return result;
}
