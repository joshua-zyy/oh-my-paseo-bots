import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi } from '@getpaseo/client';
import { channelIdSchema } from '../shared/channels.js';
import { channelMentions } from '../shared/channel-mentions.js';
import { channelTimeline, deliverChannelMessage, type ChannelTarget } from '../client/channel-state.js';
import type { ChatState } from '../client/chat-state.js';

const channelId = channelIdSchema.parse('df36bb2c-837d-4051-8a6b-4ae1e07b6041');
const attachment = { type: 'text' as const, mimeType: 'text/plain' as const, title: '初次群上下文', text: '原始快照，不在重试时替换' };

test('点名沿用参考规则：最长名称、稳定ID、多次去重和显式全群', () => {
  const bots = [{ id: 'short', name: '新 Bot' }, { id: 'long', name: '新 Bot 2' }];
  assert.deepEqual(channelMentions('@新 Bot 2 @long @新 Bot 请回应', bots), { ids: ['long', 'short'], all: false });
  assert.deepEqual(channelMentions('@all @long', bots), { ids: ['long'], all: true });
  assert.deepEqual(channelMentions('```\n@long\n``` `@short` [链接](@long) https://x/@long foo@long.com @long/path', bots), { ids: [], all: false });
});

test('群视图按原生时间合并，多收件人的同一用户消息只显示一次，独立同文消息保留', () => {
  const message = (type: string, text: string, time: number, clientMessageId?: string) => ({ item: { type, text, clientMessageId }, timestamp: new Date(time).toISOString(), seqStart: time, seqEnd: time });
  const states = { a: { entries: [message('user_message', '@all 问题', 1, 'one'), message('assistant_message', '甲回答', 4)] }, b: { entries: [message('user_message', '@all 问题', 2, 'one'), message('assistant_message', '乙回答', 3), message('user_message', '@all 问题', 5, 'another')] } } as unknown as Record<string, ChatState>;
  assert.deepEqual(channelTimeline(states).map(row => [row.agentId, 'text' in row.entry.item ? row.entry.item.text : '']), [['a', '@all 问题'], ['b', '乙回答'], ['a', '甲回答'], ['b', '@all 问题']]);
});

test('部分发送失败只重试未确认成员，沿用原消息标识与附件且发送前核对当前场景', async () => {
  const calls: { agentId: string; text: string; options: unknown }[] = [];
  const checked: string[] = [];
  let failure = true;
  const api = { agents: { ref: (agentId: string) => ({ send: async (text: string, options: unknown) => { calls.push({ agentId, text, options }); if (agentId === 'b' && failure) throw new Error('回执丢失'); } }) } } as unknown as PaseoApi;
  const authorize = async ({ agentId }: { agentId: string }) => { checked.push(agentId); };
  const targets: ChannelTarget[] = ['a', 'b'].map(agentId => ({ agentId, botId: agentId, attachment }));
  const message = { channelId, text: '@a @b 原话\n保持完整', messageId: 'same-user-message', targets };
  let result = await deliverChannelMessage(api, authorize, message);
  assert.equal(result[0].sent, true); assert.equal(result[1].unknown, true);
  assert.deepEqual(checked, ['a', 'b']);
  failure = false;
  result = await deliverChannelMessage(api, authorize, { ...message, targets: result });
  assert(result.every(target => target.sent)); assert.deepEqual(calls.map(call => call.agentId), ['a', 'b', 'b']);
  assert.deepEqual(calls[2], calls[1]);
  assert.deepEqual(calls[2].options, { messageId: message.messageId, activeTurnBehavior: 'steer', attachments: [attachment] });
});

test('撤销场景资格后不再次发送，既有未知回执不被改判为未发生', async () => {
  const api = { agents: { ref: () => ({ send: () => assert.fail('场景已撤销不应发送') }) } } as unknown as PaseoApi;
  const result = await deliverChannelMessage(api, async () => { throw new Error('频道已归档'); }, { channelId, text: '原文', messageId: 'old', targets: [{ agentId: 'b', botId: 'b', attachment, unknown: true }] });
  assert.equal(result[0].unknown, true); assert.notEqual(result[0].sent, true); assert.match(result[0].error!, /频道已归档/);
});
