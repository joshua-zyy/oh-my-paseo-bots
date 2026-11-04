import { z } from 'zod';
import type { PaseoAgentConfig } from '@getpaseo/client';

/** 沿用宿主公开的三种 MCP transport，不引入连接器或权限执行器。 */
const strings = z.record(z.string(), z.string());
const http = { url: z.string().url().regex(/^https?:\/\//), headers: strings.optional(), alwaysLoad: z.boolean().optional() };
export const mcpServerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: strings.optional(), alwaysLoad: z.boolean().optional() }),
  z.strictObject({ type: z.literal('http'), ...http }),
  z.strictObject({ type: z.literal('sse'), ...http }),
]) satisfies z.ZodType<NonNullable<PaseoAgentConfig['mcpServers']>[string]>;
export const mcpNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).refine(name => !['paseo', 'paseo-guys'].includes(name), { message: '宿主与本插件的 MCP 名称不能被覆盖' });

export const botSkillSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  path: z.string().trim().min(1),
});
/** 用户选定的既有能力，独立于执行配置，不自动随 Chief 创建同事而复制。 */
export const botCapabilitiesSchema = z.strictObject({
  skills: z.array(botSkillSchema).default([]),
  mcpServers: z.record(mcpNameSchema, mcpServerSchema).default({}),
  disabledMcpServers: z.array(mcpNameSchema).optional(),
});
export type BotSkill = z.output<typeof botSkillSchema>;

export const mcpImportSchema = z.object({ path: z.string().trim().min(1), names: z.array(mcpNameSchema).min(1) });
export type McpImport = z.output<typeof mcpImportSchema>;
