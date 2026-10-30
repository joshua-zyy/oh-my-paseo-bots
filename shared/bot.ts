import { z } from 'zod';

/** 只映射宿主已有执行配置，不保存 Provider 登录或新增授权。 */
export const botExecutionSchema = z.object({
  provider: z.string().trim().regex(/^[^/\s]+\/.+$/, '使用宿主已有的 provider/model 标识').optional(),
  cwd: z.string().trim().min(1).optional(),
  // 缺省继承匹配模型的宿主默认；null 明确使用 Provider 自身默认。
  modeId: z.string().trim().min(1).nullable().optional(),
  thinkingOptionId: z.string().trim().min(1).nullable().optional(),
});

const botFields = z.object({
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  instructions: z.string().max(24000),
  execution: botExecutionSchema,
});

/** 旧 Bot 不含新增字段时按空覆盖读取，不改写原文件。 */
export const botDetailsSchema = botFields.extend({
  instructions: botFields.shape.instructions.default(''),
  execution: botExecutionSchema.default({}),
});
// Patch 不应用缺省值，避免只改名称时清空已有说明或执行配置。
export const botPatchSchema = botFields.partial().refine(value => Object.values(value).some(item => item !== undefined), {
  message: '至少提供一个需要更新的 Bot 字段',
});

export type BotDetails = z.output<typeof botDetailsSchema>;
export type BotDetailsInput = z.input<typeof botDetailsSchema>;
export type BotPatch = z.input<typeof botPatchSchema>;
