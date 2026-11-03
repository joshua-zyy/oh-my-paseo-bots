import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { mailAction } from './office.js';

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
