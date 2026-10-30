import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { PaseoApi, PaseoAgentConfig } from '@getpaseo/client';
import type { BotStore } from './store.js';
import { botPrompt } from './prompt.js';
import type { BotMcp } from './mcp.js';

export interface SessionInput {
  botId: string;
  requestId: string;
  title: string;
  prompt: string;
  parentAgentId?: string;
}

/** 原生侧只需 id 与 workspaceId 即可关联；不复制会话状态。 */
type NativeSession = { id: string; workspaceId?: string | null };

/** 原生会话已创建（可能是复用旧意图的结果），不含任务完成状态。 */
export interface StartedSession {
  agentId: string;
  /** 原始意图的 requestId：UI 丢过 requestId 时会复用它。 */
  requestId: string;
}

/**
 * 创建或复用 Bot 的原生会话。
 *
 * 先在 store 落盘「创建意图」，再调用原生 create，成功后才原子关联会话；
 * 因此落盘失败后重试不会重复创建，输入变化也不会被静默吞掉。
 */
export async function startBotSession(
  store: BotStore,
  paseo: PaseoApi,
  input: SessionInput,
  placement: { cwd: string; config: PaseoAgentConfig },
  tools: Pick<BotMcp, 'mount'>,
): Promise<StartedSession> {
  const data = await store.getBot(input.botId);
  if (!data) throw new Error(`Bot 不存在：${input.botId}`);
  const memories = await store.getContextMemories(input.botId);
  const systemPrompt = botPrompt({ ...data.bot, confirmedMemories: memories.map((memory) => memory.content) });
  const execution = data.bot.execution;
  const cwd = execution.cwd ?? placement.cwd;
  if (!isAbsolute(cwd)) throw new Error('Bot 工作目录必须为宿主绝对路径');
  // 模式与思考选项属于具体模型；改选模型时不沿用另一模型的宿主选项。
  const inheritOptions = execution.provider === undefined || execution.provider === placement.config.provider;
  const config: PaseoAgentConfig = {
    ...placement.config,
    provider: execution.provider ?? placement.config.provider,
    modeId: execution.modeId === null ? undefined : execution.modeId ?? (inheritOptions ? placement.config.modeId : undefined),
    thinkingOptionId: execution.thinkingOptionId === null ? undefined : execution.thinkingOptionId ?? (inheritOptions ? placement.config.thinkingOptionId : undefined),
  };
  const fingerprint = createHash('sha256')
    .update(
      stable({
        bot: input.botId,
        title: input.title,
        prompt: input.prompt,
        parentAgentId: input.parentAgentId,
        cwd,
        config,
        systemPrompt,
      }),
    )
    .digest('hex');

  const proposal = await store.prepareCreation(input.botId, { requestId: input.requestId, fingerprint });
  const botTools = await tools.mount(input.botId, proposal.intent.agentId);
  // 已 created 且未 ack 的同输入请求只能拿回已知 agentId，不再创建。
  if (proposal.action === 'known') return { agentId: proposal.intent.agentId, requestId: proposal.intent.requestId };

  let agent: NativeSession | null = null;
  if (proposal.action === 'retry_pending') agent = await refreshNativeAgent(paseo, proposal.intent.agentId);
  if (!agent) {
    const options = {
      agentId: proposal.intent.agentId,
      idempotencyKey: `paseo-guys:${input.botId}:${proposal.intent.requestId}`,
      ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
      config: { ...config, systemPrompt, mcpServers: { ...config.mcpServers, 'paseo-guys': botTools } },
      title: input.title,
      prompt: input.prompt,
      labels: { 'paseo-guys.bot': input.botId, 'paseo-guys.request': proposal.intent.requestId },
    };
    // parent 默认继承父工作区；显式放置才能让固定同事使用自己的目录。
    agent = input.parentAgentId
      ? await (await paseo.workspaces.open(cwd)).agents.create(options)
      : await paseo.agents.create({ ...options, cwd });
  }

  await store.completeCreation(input.botId, proposal.intent.requestId, {
    sessionId: agent.id,
    title: input.title,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
  });
  return { agentId: agent.id, requestId: proposal.intent.requestId };
}

/**
 * 回查上次创建的结果：仅当原生明确答复时才下结论。
 * 回查失败视为未知，直接报错，绝不靠重新创建来掩盖不确定。
 */
async function refreshNativeAgent(paseo: PaseoApi, agentId: string): Promise<NativeSession | null> {
  try {
    const refreshed = await paseo.agents.ref(agentId).refresh();
    return refreshed?.agent ?? null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`会话创建结果未知：无法回查原生会话 ${agentId}，未重复创建（${reason}）`);
  }
}

/** 键序无关的稳定序列化，保证同一输入得到同一 fingerprint。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
