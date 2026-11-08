import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { botSkillSchema, mcpImportSchema, mcpNameSchema } from './capabilities.js';

export const capabilityPlanInput = z.strictObject({
  requestId: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1000),
  skills: z.array(z.string().trim().min(1)).max(50).default([]),
  mcpImports: z.array(mcpImportSchema).max(30).default([]),
}).refine(value => value.skills.length + value.mcpImports.length > 0, '至少选择一项已有能力');
export type CapabilityPlanInput = z.output<typeof capabilityPlanInput>;

export const capabilityRequestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  sourceAgentId: z.string().min(1),
  summary: z.string().min(1).max(1000),
  skills: z.array(botSkillSchema),
  mcp: z.array(z.object({ path: z.string(), name: mcpNameSchema, type: z.enum(['stdio', 'http', 'sse']) })),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['pending', 'applied', 'rejected']),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type CapabilityRequest = z.output<typeof capabilityRequestSchema>;
export const capabilityRequestView = capabilityRequestSchema.omit({ fingerprint: true });
export type CapabilityRequestView = z.output<typeof capabilityRequestView>;
export const inspectCapabilities = defineRpc({
  name: 'bots.capabilities.inspect', input: z.object({ botId: z.string().min(1) }),
  output: z.object({ botId: z.string(), skills: z.array(botSkillSchema), mcpNames: z.array(z.string()), request: capabilityRequestView.optional() }),
});
export const decideCapabilities = defineRpc({
  name: 'bots.capabilities.decide',
  input: z.object({ botId: z.string().min(1), requestId: capabilityRequestSchema.shape.id, decision: z.enum(['apply', 'reject']) }),
  output: capabilityRequestView,
});
