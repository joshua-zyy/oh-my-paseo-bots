import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

const token = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);
export const gmailConfig = z.object({
  command: z.string().min(1).default('gws'),
  configDir: z.string().min(1),
  account: z.email(),
  query: z.string().trim().min(1),
});
export const feishuConfig = z.object({
  command: z.string().min(1).default('lark-mcp'),
  args: z.array(z.string()).default([]),
  appId: token,
  secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('APP_SECRET'),
  documentIds: z.array(token).default([]),
  wikiTokens: z.array(token).default([]),
});
export type FeishuConfig = z.infer<typeof feishuConfig>;
export const botOffice = z.object({ gmail: gmailConfig.optional(), feishu: feishuConfig.optional() });
export type BotOffice = z.infer<typeof botOffice>;
export const officeSettings = defineSettings({
  id: 'office', scope: 'host', version: 1,
  schema: z.object({ bots: z.record(z.string(), botOffice).default({}) }),
});

export const officeStatus = defineRpc({
  name: 'bots.office.status', input: z.object({ botId: z.string() }),
  output: z.object({
    gmail: z.object({ configured: z.boolean(), account: z.string().optional(), query: z.string().optional() }),
    feishu: z.object({ configured: z.boolean(), documentIds: z.array(z.string()), wikiTokens: z.array(z.string()) }),
  }),
});

export const mailAction = z.object({
  id: z.string(), requestId: z.string(), agentId: z.string(), account: z.string(), query: z.string(),
  to: z.array(z.string()), subject: z.string(), text: z.string(), sourceIds: z.array(z.string()),
  messageId: z.string(), status: z.string(), detail: z.string().optional(),
  draftId: z.string().optional(), sentId: z.string().optional(),
  approvedAt: z.string().optional(), grantId: z.string().optional(),
});
const actionInput = z.object({ botId: z.string(), actionId: z.string() });
export const listMail = defineRpc({ name: 'bots.mail.list', input: z.object({ botId: z.string() }), output: z.array(mailAction) });
export const sendMail = defineRpc({ name: 'bots.mail.confirm_send', input: actionInput, output: mailAction });
export const reconcileMail = defineRpc({ name: 'bots.mail.reconcile', input: actionInput, output: mailAction });
export const revokeMail = defineRpc({ name: 'bots.mail.revoke', input: actionInput, output: mailAction });
const mailGrant = z.object({ id: z.string(), agentId: z.string(), account: z.string(), to: z.array(z.string()), subject: z.string(), text: z.string(), sourceIds: z.array(z.string()), revokedAt: z.string().optional() });
export const listMailGrants = defineRpc({ name: 'bots.mail.grants', input: z.object({ botId: z.string() }), output: z.array(mailGrant) });
export const allowFixedMail = defineRpc({ name: 'bots.mail.allow_fixed', input: actionInput, output: mailGrant });
export const revokeMailGrant = defineRpc({ name: 'bots.mail.revoke_grant', input: z.object({ botId: z.string(), grantId: z.string() }), output: z.object({}) });
