import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CHIEF_BOT_ID } from '../shared/bot.js';
import { capabilityPlanInput } from '../shared/capability-guidance.js';
import { botIdSchema } from './store.js';
import type { CapabilityGuidance } from './capability-guidance.js';

/** Chief selects existing capabilities; only the separate user RPC can approve a plan. */
export function registerCapabilityTools(server: McpServer, scope: {
  botId: string; agentId: string; service: CapabilityGuidance; authorize(): Promise<unknown>; readUserMessage(): Promise<string>;
}) {
  if (scope.botId !== CHIEF_BOT_ID) return;
  const run = async (action: () => Promise<unknown>, userQuote?: string) => {
    try {
      await scope.authorize();
      if (userQuote !== undefined) {
        const userMessage = await scope.readUserMessage();
        if (userQuote.trim() !== userMessage.trim()) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: '配置依据与最新完整原生用户消息不符，未配置', userMessage }) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
    }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '能力配置未完成' }] }; }
  };
  server.registerTool('list_available_capabilities', {
    description: 'Chief发现本机已经存在的技能索引和MCP配置来源；只返回元数据，不返回密钥、不安装、不启用。可用query筛选技能/连接名称，offset继续技能分页。先复用，不自动新增或改写技能；未发现的能力如实说明，不猜路径或命令。',
    annotations: { readOnlyHint: true },
    inputSchema: { colleagueId: botIdSchema.default(CHIEF_BOT_ID), query: z.string().trim().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) },
  }, input => run(async () => {
    const catalog = await scope.service.catalog(input.colleagueId);
    const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) => terms.every(term => text.toLowerCase().includes(term));
    const skills = catalog.skills.filter(skill => matches(`${skill.name} ${skill.description}`));
    return { skills: skills.slice(input.offset, input.offset + input.limit), total: skills.length, nextOffset: input.offset + input.limit < skills.length ? input.offset + input.limit : null, sources: catalog.sources.map(source => ({ ...source, names: source.names.filter(name => matches(`${source.label} ${name}`)) })).filter(source => source.names.length || source.error), errors: catalog.errors };
  }));
  server.registerTool('read_colleague_capabilities', {
    description: 'Chief核对指定同事当前技能索引、MCP名称与最近能力方案的用户决定，不返回凭据。pending不是已配置；applied仅表示配置保存，之后的新对话/新任务才使用，不代表实际交付。',
    annotations: { readOnlyHint: true }, inputSchema: { colleagueId: botIdSchema },
  }, input => run(() => scope.service.inspect(input.colleagueId)));
  server.registerTool('configure_colleague_capabilities', {
    description: 'Chief依据当前用户交办配置现有能力，userQuote引用最新完整原话，不拼附件。既有技能索引及接收方已经启用且配置完全相同的MCP直接保存，返回applied；未知、新增、变更或禁用MCP返回pending，用户确认后才保存，不能以本机存在配置视为已授权。混合请求若含待确认连接则整体pending，可先单独完成独立的技能配置。不传命令/env/密钥/authorized，不安装或扩权；保持同一requestId重试。只剩等待时结束本轮，不轮询、催促或派发依赖未批准能力的工作；拒绝后不自行重提。仅新会话/任务使用。',
    inputSchema: capabilityPlanInput.safeExtend({ colleagueId: botIdSchema, userQuote: z.string().trim().min(1).max(8000) }),
  }, input => run(() => scope.service.configure(input.colleagueId, scope.agentId, input), input.userQuote));
}
