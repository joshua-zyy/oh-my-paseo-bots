import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CHIEF_BOT_ID } from '../shared/bot.js';
import { capabilityPlanInput } from '../shared/capability-guidance.js';
import { botIdSchema } from './store.js';
import type { CapabilityGuidance } from './capability-guidance.js';

/** Chief selects existing capabilities; only the separate user RPC can approve a plan. */
export function registerCapabilityTools(server: McpServer, scope: {
  botId: string; agentId: string; service: CapabilityGuidance; authorize(): Promise<unknown>;
}) {
  if (scope.botId !== CHIEF_BOT_ID) return;
  const run = async (action: () => Promise<unknown>) => {
    try { await scope.authorize(); return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
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
  server.registerTool('propose_colleague_capabilities', {
    description: 'Chief按用户需求选择现有SKILL.md绝对路径和MCP来源文件/名称，为固定同事生成待确认方案。保持同一requestId重试，不传命令/env/密钥，不安装、不扩大账户权限。用户在同事页顶部「能力待确认」核对并确认后才保存；未确认不能假称配置成功，也不派发依赖这些能力的工作。只剩等待就结束本轮，不轮询、不重新提案催促；用户拒绝后不自行重提。',
    inputSchema: capabilityPlanInput.safeExtend({ colleagueId: botIdSchema }),
  }, input => run(() => scope.service.propose(input.colleagueId, scope.agentId, input)));
}
