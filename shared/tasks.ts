import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const task = z.object({
  agentId: z.string(), title: z.string(), goal: z.string().optional(),
  conversation: z.literal(true).optional(),
  status: z.enum(['active', 'stopping', 'canceled', 'completed', 'awaiting_review']),
  summary: z.string().optional(), evidence: z.array(z.string()).optional(), detail: z.string().optional(),
  specialists: z.array(z.string()),
  routine: z.object({ id: z.uuid(), runId: z.string(), prompt: z.string() }).optional(),
  followups: z.array(z.object({ key: z.string(), name: z.string(), cron: z.string(), timezone: z.string(), prompt: z.string(), nativeId: z.string().optional(), status: z.string(), detail: z.string().optional() })),
});
export const listTasks = defineRpc({ name: 'bots.tasks', input: z.object({ botId: z.string() }), output: z.array(task) });
export const cancelTask = defineRpc({ name: 'bots.task.cancel', input: z.object({ botId: z.string(), agentId: z.string() }), output: task });
