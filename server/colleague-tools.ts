import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotStore } from './store.js';
import type { TaskTracker } from './tasks.js';

export interface ColleagueToolScope {
  store: BotStore;
  tasks: TaskTracker;
  botId: string;
  agentId: string;
  start: (input: { botId: string; parentAgentId: string; requestId: string; title: string; prompt: string }) => Promise<{ agentId: string; requestId: string }>;
}

/** 仅目录与原生创建适配：身份由服务端绑定，不复制其他同事的记忆或历史。 */
export function registerColleagueTools(server: McpServer, scope: ColleagueToolScope): void {
  const run = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '同事委派未完成' }] }; }
  };
  server.registerTool('list_colleagues', {
    description: '查看其他已注册固定同事的标识、名称和职责；不读取其记忆、历史或账户配置。只按当前事项需要选择接收同事。',
    annotations: { readOnlyHint: true },
  }, () => run(async () => (await scope.store.listBots())
    .filter(bot => bot.id !== scope.botId)
    .map(({ id, name, role }) => ({ id, name, role }))));
  server.registerTool('delegate_to_colleague', {
    description: '把当前事项中明确的一部分交给已注册的其他固定同事，通过 Paseo 原生父子会话运行。仅传任务必要上下文；不传全部记忆或历史，不扩大权限。requestId 为本次委派的稳定原始标识，重试用同一输入，不换标识规避未知结果。启动回执不等于完成；使用 Paseo 原生通知与通信取得实际结果并按交付条件核对。',
    inputSchema: {
      colleagueId: z.string().trim().min(1).max(64),
      requestId: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(200),
      prompt: z.string().trim().min(1).max(20000),
    },
  }, input => run(async () => {
    if (input.colleagueId === scope.botId) throw new Error('请委派给其他固定同事，不能委派给自己');
    if (!await scope.store.getBot(input.colleagueId)) throw new Error(`固定同事未注册：${input.colleagueId}`);
    await scope.tasks.requireActive(scope.botId, scope.agentId);
    // 源 Agent 最长200字符；哈希命名空间保证整体不超过存储的200字符上限。
    const source = createHash('sha256').update(scope.agentId).digest('hex');
    const result = await scope.start({
      botId: input.colleagueId,
      parentAgentId: scope.agentId,
      requestId: `delegation:${source}:${input.requestId}`,
      title: input.title,
      prompt: input.prompt,
    });
    await scope.tasks.observeSpecialist(scope.botId, scope.agentId, result.agentId);
    return { agentId: result.agentId, requestId: input.requestId };
  }));
}
