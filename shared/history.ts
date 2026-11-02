import { defineRpc } from '@getpaseo/plugin';
import { AgentTimelineEntryPayloadSchema } from '@getpaseo/protocol/messages';
import { z } from 'zod';

const cursor = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });
export const readHistory = defineRpc({
  name: 'bots.history',
  input: z.object({
    botId: z.string().min(1).max(64), agentId: z.string().min(1).max(200),
    direction: z.enum(['tail', 'before', 'after']).default('tail'),
    cursor: cursor.optional(), limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    agentId: z.string(), epoch: z.string(), direction: z.enum(['tail', 'before', 'after']),
    startCursor: cursor.nullable(), endCursor: cursor.nullable(),
    hasOlder: z.boolean(), hasNewer: z.boolean(), entries: z.array(AgentTimelineEntryPayloadSchema.extend({ item: z.object({ type: z.string(), text: z.string().optional() }).passthrough() })),
  }),
});
