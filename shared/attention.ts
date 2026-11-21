import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const attentionTarget = z.discriminatedUnion('panel', [
  z.object({ panel: z.literal('agent'), agentId: z.string().min(1) }),
  z.object({ panel: z.literal('work') }),
]);
export const attentionNotice = z.object({
  channel: z.enum(['host', 'plugin', 'progress']),
  reason: z.enum(['native_permission', 'native_error', 'task_review', 'task_stop', 'task_unreported', 'inflight']),
  episode: z.string().min(1),
});
export const attentionEntry = z.object({
  id: z.string().min(1), botId: z.string(), botName: z.string(),
  source: z.enum(['work', 'creation']),
  sourceId: z.string(), kind: z.enum(['decision', 'failure', 'unknown']),
  title: z.string(), detail: z.string().optional(), target: attentionTarget,
  notice: attentionNotice.optional(),
});
export type AttentionEntry = z.infer<typeof attentionEntry>;
export type AttentionTarget = z.infer<typeof attentionTarget>;
export const attentionView = z.object({
  entries: z.array(attentionEntry),
  issues: z.array(z.object({ botId: z.string().optional(), source: z.string(), detail: z.string() })),
  botIds: z.array(z.string()),
});
export type AttentionView = z.infer<typeof attentionView>;

/** A derived view, not an approval, acknowledgement or retry endpoint. */
export const listAttention = defineRpc({ name: 'bots.attention', input: z.object({}), output: attentionView });
