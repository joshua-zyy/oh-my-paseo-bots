import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const channelIdSchema = z.uuid().brand<'ChannelId'>();
export const channelDetailsSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  memberIds: z.array(z.string().trim().min(1).max(64)).min(1),
  adminBotId: z.string().trim().min(1).max(64),
  cwd: z.string().trim().min(1),
  instructions: z.string().max(24000).default(''),
}).refine(value => new Set(value.memberIds).size === value.memberIds.length, '频道成员不能重复')
  .refine(value => value.memberIds.includes(value.adminBotId), '管理员必须是频道成员');
export const channelCreateSchema = channelDetailsSchema.safeExtend({ id: channelIdSchema });
export const channelSchema = channelCreateSchema.safeExtend({
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), archivedAt: z.iso.datetime().optional(),
});
export type ChannelId = z.output<typeof channelIdSchema>;
export type ChannelDetails = z.output<typeof channelDetailsSchema>;
export type Channel = z.output<typeof channelSchema>;

export const listChannels = defineRpc({ name: 'bots.channels.list', input: z.object({ includeArchived: z.boolean().default(false) }), output: z.array(channelSchema) });
export const createChannel = defineRpc({ name: 'bots.channels.create', input: channelCreateSchema, output: channelSchema });
export const updateChannel = defineRpc({ name: 'bots.channels.update', input: z.object({ channelId: channelIdSchema, details: channelDetailsSchema }), output: channelSchema });
const session = z.object({ botId: z.string(), agentId: z.string() });
const attachment = z.object({ type: z.literal('text'), mimeType: z.literal('text/plain'), title: z.string(), text: z.string() });
export const channelView = defineRpc({ name: 'bots.channels.view', input: z.object({ channelId: channelIdSchema }), output: z.object({ channel: channelSchema, members: z.array(z.object({ id: z.string(), name: z.string() })), sessions: z.array(session) }) });
export const routeChannelMessage = defineRpc({ name: 'bots.channels.route', input: z.object({ channelId: channelIdSchema, text: z.string().trim().min(1) }), output: z.object({ targets: z.array(session.extend({ attachment })) }) });
export const openChannel = defineRpc({ name: 'bots.channels.open', input: z.object({ channelId: channelIdSchema, botId: z.string().optional() }), output: session });
export const channelContext = defineRpc({ name: 'bots.channels.context', input: z.object({ channelId: channelIdSchema, agentId: z.string().min(1) }), output: attachment });
export const archiveChannel = defineRpc({ name: 'bots.channels.archive', input: z.object({ channelId: channelIdSchema, archived: z.boolean() }), output: channelSchema });
