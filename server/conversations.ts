import type { PaseoApi, PaseoAgent } from '@getpaseo/client';
import type { BotDetails } from '../shared/bot.js';
import { CONVERSATION_PREVIOUS_LABEL } from '../shared/chat.js';
import type { BotStore } from './store.js';

/** Conversation links live in native labels; each segment keeps its own timeline and tasks. */
export async function readConversation(store: BotStore, paseo: PaseoApi, botId: string, agentId: string) {
  const bot = await store.getBot(botId);
  if (!bot) throw new Error('未找到本 Bot 的持续聊天');
  const linked = new Set([...bot.sessions.map(session => session.sessionId), ...bot.creationIntents.map(intent => intent.agentId)]);
  const segments: PaseoAgent[] = [];
  let current: string | undefined = agentId;
  while (current) {
    if (!linked.delete(current)) throw new Error('持续聊天的原生会话关联无效');
    const snapshot = await paseo.agents.ref(current).refresh();
    if (!snapshot || snapshot.agent.labels['paseo-guys.bot'] !== botId || snapshot.agent.labels['paseo-guys.conversation'] !== 'true') throw new Error('未找到本 Bot 关联的原生持续聊天');
    segments.push(snapshot.agent);
    current = snapshot.agent.labels[CONVERSATION_PREVIOUS_LABEL];
  }
  return { agent: segments[0], previousAgentIds: segments.slice(1).reverse().map(agent => agent.id) };
}

/** Map the current native configuration rather than the Bot's future-session defaults. */
export function conversationExecution(agent: PaseoAgent): BotDetails['execution'] {
  return {
    cwd: agent.cwd,
    ...(agent.model ? { provider: `${agent.provider}/${agent.model}` } : {}),
    modeId: agent.currentModeId ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? null,
  };
}
