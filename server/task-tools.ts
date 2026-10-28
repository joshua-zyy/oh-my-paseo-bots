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
  server.registerTool('create_followup', {
    description: '为用户交办事项配置原生 heartbeat。仅在明确交办的范围内使用，不授予外发权限，不创建新目标。稳定 name 复用；未知结果保留可见，不新建其他名字规避。',
    inputSchema: { name: z.string().min(1), prompt: z.string().min(1), cron: z.string().min(1), timezone: z.string().min(1) },
  }, input => run(() => tasks.follow(botId, agentId, input)));
  server.registerTool('complete_task', {
    description: '仅当约定交付条件已满足时完成事项并归档根会话、专家及跟进。先向用户交付最终结果；summary 和 evidence 会持久保存。派发回执、草稿或轮次结束均不能作为完成依据。资源告警后继续授权内工作，不以费用或轮次数自动完成。',
    inputSchema: { summary: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1) },
  }, input => run(() => tasks.stop(botId, agentId, { ...input, outcome: 'completed' })));
  if (cancelExplicit) server.registerTool('cancel_task', {
    description: '仅在用户本条消息明确要求取消本事项时使用；引用完整用户消息供服务端核对来源。资源告警、费用或暂时无进展都不是取消授权。解释自然语言意图仍由主 Bot 负责。',
    inputSchema: { userQuote: z.string().trim().min(1).max(8000) },
  }, ({ userQuote }) => run(() => cancelExplicit(botId, agentId, userQuote)));
}
