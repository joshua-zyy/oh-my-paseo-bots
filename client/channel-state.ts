import type { PaseoApi } from '@getpaseo/client';
import type { RpcOutput } from '@getpaseo/plugin';
import type { ChannelId, routeChannelMessage } from '../shared/channels.js';
import type { ChatState } from './chat-state.js';

export type ChannelTarget = RpcOutput<typeof routeChannelMessage>['targets'][number] & { sent?: boolean; unknown?: boolean; error?: string };

/** Native histories stay separate; dedupe only copies of the same user message ID. */
export function channelTimeline(states: Record<string, ChatState>) {
  const users = new Set<string>();
  return Object.entries(states).flatMap(([agentId, state]) => state.entries.map(entry => ({ agentId, entry })))
    .sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp) || a.agentId.localeCompare(b.agentId) || a.entry.seqStart - b.entry.seqStart)
    .filter(({ entry }) => {
      if (entry.item.type !== 'user_message') return true;
      const id = entry.item.clientMessageId ?? entry.item.messageId;
      if (!id) return true;
      if (users.has(id)) return false;
      users.add(id); return true;
    });
}

/** Per-recipient receipts let a partial/unknown send retry the original IDs and snapshots. */
export async function deliverChannelMessage(api: PaseoApi, authorize: (input: { channelId: ChannelId; agentId: string }) => Promise<unknown>, message: { channelId: ChannelId; text: string; messageId: string; targets: ChannelTarget[] }): Promise<ChannelTarget[]> {
  const { channelId, text, messageId, targets } = message;
  return Promise.all(targets.map(async target => {
    if (target.sent) return target;
    let dispatched = false;
    try {
      await authorize({ channelId, agentId: target.agentId });
      dispatched = true;
      await api.agents.ref(target.agentId).send(text, { messageId, activeTurnBehavior: 'steer', attachments: [target.attachment] });
      return { ...target, sent: true, unknown: false, error: undefined };
    } catch (error) {
      return { ...target, unknown: target.unknown || dispatched, error: `${dispatched ? '发送回执未确认' : '场景核对失败，未再次发送'}：${String(error)}` };
    }
  }));
}
