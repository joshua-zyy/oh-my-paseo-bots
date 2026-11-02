import type { PaseoApi, PaseoAgentTimelineRefetchOptions } from '@getpaseo/client';
import type { BotStore } from './store.js';

export type BotHistoryInput = { agentId: string } & Pick<PaseoAgentTimelineRefetchOptions, 'direction' | 'cursor' | 'limit'>;

/** Read native history in place; Bot linkage grants no access to unrelated specialists. */
export async function readBotHistory(store: BotStore, paseo: PaseoApi, botId: string, input: BotHistoryInput) {
  const bot = await store.getBot(botId);
  if (!bot || (!bot.sessions.some(session => session.sessionId === input.agentId) && !bot.creationIntents.some(intent => intent.agentId === input.agentId))) {
    throw new Error('该原生会话未关联到此 Bot');
  }
  const direction = input.direction ?? 'tail';
  if ((direction === 'tail' && input.cursor) || (direction !== 'tail' && !input.cursor)) throw new Error('tail 不使用游标；before／after 需使用上一页返回的游标');
  const page = await paseo.agents.ref(input.agentId).timeline.refetch({ direction, cursor: input.cursor, limit: input.limit ?? 50, projection: 'canonical' });
  if (page.error || page.staleCursor || page.gap || (input.cursor && page.epoch !== input.cursor.epoch)) {
    throw new Error(`原生历史无法稳定读取，请从 tail 重新查询${page.error ? `：${page.error}` : ''}`);
  }
  return {
    agentId: input.agentId, epoch: page.epoch, direction,
    startCursor: page.startCursor, endCursor: page.endCursor,
    hasOlder: page.hasOlder, hasNewer: page.hasNewer,
    entries: page.entries,
  };
}
