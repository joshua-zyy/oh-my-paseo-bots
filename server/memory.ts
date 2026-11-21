import type { PaseoApi, PaseoAgentTimelineRefetchOptions } from '@getpaseo/client';
import type { BotStore } from './store.js';

export type MemoryAccess = Pick<BotStore, 'addMemory' | 'updateMemory' | 'removeMemory'>;

/** 来源核对失败时提供同一绑定会话的原生原文，供按原标准重试，不接受拼接附件。 */
export class MemorySourceError extends Error {
  constructor(message: string, readonly userMessage: string) { super(message); this.name = 'MemorySourceError'; }
}

/** Fetch back to the latest native user message, without a fixed tail truncation. */
export async function latestUserMessage(paseo: PaseoApi, agentId: string): Promise<string> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let options: PaseoAgentTimelineRefetchOptions = { direction: 'tail', limit: 100, projection: 'canonical' };
  let epoch: string | undefined;
  let previousCursor: string | undefined;
  while (true) {
    const page = await timeline.refetch(options);
    if (page.error || page.staleCursor || page.gap || (epoch !== undefined && page.epoch !== epoch)) {
      throw new Error('无法稳定核实用户记忆请求，未保存为明确记忆');
    }
    epoch = page.epoch;
    for (const entry of [...page.entries].reverse()) {
      if (entry.item.type === 'user_message') return entry.item.text;
    }
    if (!page.hasOlder || !page.startCursor) throw new Error('找不到原生用户消息，未保存为明确记忆');
    const cursor = JSON.stringify(page.startCursor);
    if (cursor === previousCursor) throw new Error('原生历史分页未推进，未保存为明确记忆');
    previousCursor = cursor;
    options = { direction: 'before', cursor: page.startCursor, limit: 100, projection: 'canonical' };
  }
}

/**
 * The Bot judges explicit natural-language intent; the server verifies its quoted
 * source against native history. This is evidence checking, not semantic isolation.
 */
export async function rememberExplicit(
  store: BotStore,
  paseo: PaseoApi,
  botId: string,
  agentId: string,
  input: { content: string; userQuote: string },
  access: MemoryAccess = store,
) {
  const userMessage = await memoryRequest(store, paseo, botId, agentId, input.userQuote);
  if (!input.content.trim() || !userMessage.includes(input.content.trim())) {
    throw new Error('记忆内容不在原生用户消息中；请逐字保存用户明确声明，推断使用候选工具');
  }
  const memory = await access.addMemory(botId, { content: input.content, kind: 'confirmed', source: 'user', origin: { type: 'message', agentId, userQuote: input.userQuote.trim() } });
  return { id: memory.id, content: memory.content, kind: 'confirmed' as const };
}

async function memoryRequest(store: BotStore, paseo: PaseoApi, botId: string, agentId: string, userQuote: string) {
  const bot = await store.getBot(botId);
  if (!bot || (!bot.sessions.some(session => session.sessionId === agentId) && !bot.creationIntents.some(intent => intent.agentId === agentId))) {
    throw new Error('该原生会话未关联到此 Bot');
  }
  const quote = userQuote.trim();
  const userMessage = await latestUserMessage(paseo, agentId);
  if (!quote || !userMessage.includes(quote)) {
    throw new MemorySourceError('记忆依据与最新原生用户消息不符，未保存为明确记忆', userMessage);
  }
  return userMessage;
}

export interface MemoryCorrection { memoryId: string; currentContent: string; userQuote: string; content: string }
export type MemoryForget = Omit<MemoryCorrection, 'content'>;

/** Mutations require the whole current user message and an exact old value, so stale selections cannot overwrite corrections. */
async function correctionSource(store: BotStore, paseo: PaseoApi, botId: string, agentId: string, input: MemoryForget) {
  const userMessage = await memoryRequest(store, paseo, botId, agentId, input.userQuote);
  if (input.userQuote.trim() !== userMessage.trim()) throw new MemorySourceError('发布／纠正／遗忘需引用最新完整用户消息', userMessage);
  return userMessage;
}
export async function correctExplicitMemory(store: BotStore, paseo: PaseoApi, botId: string, agentId: string, input: MemoryCorrection, access: MemoryAccess = store) {
  const userMessage = await correctionSource(store, paseo, botId, agentId, input);
  if (!input.content.trim() || !userMessage.includes(input.content.trim())) throw new Error('纠正内容须逐字来自用户当前消息；推断先存候选');
  return access.updateMemory(botId, input.memoryId, { content: input.content, kind: 'confirmed', origin: { type: 'message', agentId, userQuote: input.userQuote.trim() } }, input.currentContent);
}
export async function forgetExplicitMemory(store: BotStore, paseo: PaseoApi, botId: string, agentId: string, input: MemoryForget, access: MemoryAccess = store) {
  await correctionSource(store, paseo, botId, agentId, input);
  const removed = await access.removeMemory(botId, input.memoryId, input.currentContent, { type: 'message', agentId, userQuote: input.userQuote.trim() });
  return { memoryId: input.memoryId, removed, note: '仅归档当前场景记忆条目，不再参与默认读取；可从记忆页恢复，不擦除原生历史或备份。' };
}
