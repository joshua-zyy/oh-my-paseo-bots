import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskTracker } from './tasks.js';

/** 只关联原生能力：创建回执不等于执行，轮次结束不等于任务完成。 */
export function registerTaskTools(server: McpServer, tasks: TaskTracker, botId: string, agentId: string, cancelExplicit?: (botId: string, agentId: string, quote: string) => Promise<unknown>) {
  const run = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '原生事项操作未完成' }] }; }
  };
  server.registerTool('read_task', {
    description: '查看当前事项、原生专家标识、跟进登记和停止状态。跟进 active 仅为创建回执，不证明已运行；用 Paseo 原生会话和日志核对实际结果。',
    annotations: { readOnlyHint: true },
  }, () => run(async () => (await tasks.get(botId, agentId)) ?? tasks.requireActive(botId, agentId)));
  server.registerTool('list_bot_tasks', {
    description: '查看本 Bot 跨会话的事项目录，默认列进行中、停止待确认及例程交付待核对事项；includeFinished 可包含已完成和已取消事项。仅查询，不恢复或重新派发旧事项。',
    annotations: { readOnlyHint: true },
    inputSchema: { includeFinished: z.boolean().default(false) },
  }, ({ includeFinished }) => run(async () => (await tasks.list(botId))
    .filter(task => includeFinished || task.status === 'active' || task.status === 'stopping' || task.status === 'awaiting_review')
    .map(task => ({
      agentId: task.agentId,
      title: task.title,
      status: task.status,
      ...(task.goal !== undefined ? { goal: task.goal } : {}),
      ...(task.summary !== undefined ? { summary: task.summary } : {}),
    }))));
  server.registerTool('read_bot_task', {
    description: '按原生 agentId 读取本 Bot 已登记事项的完整记录，包括目标、专家、跟进和交付证据。仅查询，不改变状态、不恢复或重新派发事项。',
    annotations: { readOnlyHint: true },
    inputSchema: { agentId: z.string().min(1) },
  }, ({ agentId: targetAgentId }) => run(async () => {
    const task = (await tasks.list(botId)).find(item => item.agentId === targetAgentId);
    if (!task) throw new Error(`未找到本 Bot 登记的事项：${targetAgentId}`);
    return task;
  }));
  server.registerTool('create_followup', {
    description: '为用户交办事项配置原生 heartbeat。仅在明确交办的范围内使用，不授予外发权限，不创建新目标。稳定 name 复用；未知结果保留可见，不新建其他名字规避。',
    inputSchema: { name: z.string().min(1), prompt: z.string().min(1), cron: z.string().min(1), timezone: z.string().min(1) },
  }, input => run(() => tasks.follow(botId, agentId, input)));
  server.registerTool('complete_task', {
    description: '仅当约定交付条件已满足时保存 summary 和 evidence。普通子事项先经原生通信向仍进行中的委派事项回报摘要与证据；普通事项随后停止跟进并归档。独立例程只保存本次报告，随后正常回复，让原生调度收尾。派发回执、草稿或轮次结束均不能作为完成依据，不以费用或轮次数自动完成。',
    inputSchema: { summary: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1) },
  }, input => run(() => tasks.stop(botId, agentId, { ...input, outcome: 'completed' })));
  if (cancelExplicit) server.registerTool('cancel_task', {
    description: '仅在用户本条消息明确要求取消本事项时使用；引用完整用户消息供服务端核对来源。资源告警、费用或暂时无进展都不是取消授权。解释自然语言意图仍由主 Bot 负责。',
    inputSchema: { userQuote: z.string().trim().min(1).max(8000) },
  }, ({ userQuote }) => run(() => cancelExplicit(botId, agentId, userQuote)));
}
