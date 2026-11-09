import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const gmailCheck = z.object({
  botId: z.string(), routineId: z.uuid(), prompt: z.string().trim().min(1).max(1500),
  enabled: z.boolean(), account: z.email(), query: z.string(),
  state: z.enum(['ready', 'needs_sync', 'dispatch_unknown']), detail: z.string().optional(),
  noticeEpisode: z.string().optional(),
});
export type GmailCheckView = z.infer<typeof gmailCheck>;
const owner = { botId: z.string(), routineId: z.uuid() };
export const inspectGmailCheck = defineRpc({ name: 'bots.gmail_check', input: z.object(owner), output: gmailCheck.nullable() });
export const enableGmailCheck = defineRpc({ name: 'bots.gmail_check.enable', input: z.object({ ...owner, prompt: z.string().trim().min(1).max(1500) }), output: gmailCheck });
export const disableGmailCheck = defineRpc({ name: 'bots.gmail_check.disable', input: z.object(owner), output: gmailCheck });
