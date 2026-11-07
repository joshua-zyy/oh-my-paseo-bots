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
export const archiveChannel = defineRpc({ name: 'bots.channels.archive', input: z.object({ channelId: channelIdSchema, archived: z.boolean() }), output: channelSchema });
