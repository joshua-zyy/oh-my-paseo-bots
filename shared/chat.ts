import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { mailAction } from './office.js';
import { botExecutionSchema } from './bot.js';

export const CONVERSATION_PREVIOUS_LABEL = 'paseo-guys.conversation.previous';
export const conversationConfiguration = defineRpc({
  name: 'bots.conversation.configuration', input: z.object({ botId: z.string().min(1), agentId: z.string().min(1) }),
  output: z.object({ execution: botExecutionSchema, defaultCwd: z.string().optional(), previousAgentIds: z.array(z.string()) }),
});
export const changeConversation = defineRpc({
  name: 'bots.conversation.change',
  input: z.object({ botId: z.string().min(1), agentId: z.string().min(1), requestId: z.uuid(), execution: botExecutionSchema.pick({ provider: true, cwd: true, thinkingOptionId: true }).refine(value => value.provider !== undefined || value.cwd !== undefined || value.thinkingOptionId !== undefined, '请选择模型、思考等级或工作区') }),
  output: z.object({ agentId: z.string() }),
});

export const conversationContext = defineRpc({
  name: 'bots.conversation.context', input: z.object({ botId: z.string(), agentId: z.string() }),
  output: z.object({ type: z.literal('text'), mimeType: z.literal('text/plain'), title: z.string(), text: z.string() }),
});

export const conversationWork = defineRpc({
  name: 'bots.conversation.work', input: z.object({ botId: z.string(), agentId: z.string() }),
  output: z.object({
    entries: z.array(z.object({
      agentId: z.string(), botId: z.string(), botName: z.string(), title: z.string(),
      nativeStatus: z.string(), pendingPermissions: z.number().int().nonnegative(), error: z.string().optional(),
      status: z.enum(['active', 'stopping', 'canceled', 'completed', 'awaiting_review']).optional(),
      summary: z.string().optional(), evidence: z.array(z.string()).optional(), detail: z.string().optional(),
    })),
    mail: z.array(mailAction.extend({ botId: z.string() })),
  }),
});
