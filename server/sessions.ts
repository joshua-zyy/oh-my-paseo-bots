import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
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
  const { cwd, config, systemPrompt } = await botSessionConfig(store, input.botId, placement);
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
    // 隐藏的原生工作区按 Bot 与目录复用；位置不改变原生父子关系。
    const workspaceKey = createHash('sha256').update(stable({ bot: input.botId, cwd })).digest('hex');
    const workspace = await paseo.workspaces.create({
      source: { kind: 'directory', path: cwd },
      title: `oh-my-paseo-bots:${input.botId}`,
      background: true,
      idempotencyKey: `oh-my-paseo-bots:workspace:${workspaceKey}`,
    });
    agent = await workspace.agents.create(options);
  }

  await store.completeCreation(input.botId, proposal.intent.requestId, {
    sessionId: agent.id,
    title: input.title,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
  });
  return { agentId: agent.id, requestId: proposal.intent.requestId };
}

/** 普通会话、固定委派与独立例程共用配置映射及技能路径检查。 */
export async function botSessionConfig(store: BotStore, botId: string, placement: { cwd: string; config: PaseoAgentConfig }, kind: 'interactive' | 'routine' = 'interactive') {
  const data = await store.getBot(botId);
  if (!data) throw new Error(`Bot 不存在：${botId}`);
  const { skills, mcpServers } = data.bot.capabilities;
  for (const skill of skills) {
    if (!isAbsolute(skill.path)) throw new Error(`技能必须使用宿主绝对路径：${skill.path}`);
    if (!(await stat(skill.path)).isFile()) throw new Error(`技能路径必须指向 SKILL.md 文件：${skill.path}`);
  }
  const memories = await store.getContextMemories(botId);
  const systemPrompt = botPrompt({ id: data.bot.id, name: data.bot.name, role: data.bot.role, instructions: data.bot.instructions, skills, confirmedMemories: memories.map(memory => memory.content), kind });
  const execution = data.bot.execution;
  const cwd = execution.cwd ?? placement.cwd;
  if (!isAbsolute(cwd)) throw new Error('Bot 工作目录必须为宿主绝对路径');
  const inheritOptions = execution.provider === undefined || execution.provider === placement.config.provider;
  const config: PaseoAgentConfig = {
    ...placement.config,
    ...(Object.keys(mcpServers).length ? { mcpServers: { ...placement.config.mcpServers, ...mcpServers } } : {}),
    provider: execution.provider ?? placement.config.provider,
    modeId: execution.modeId === null ? undefined : execution.modeId ?? (inheritOptions ? placement.config.modeId : undefined),
    thinkingOptionId: execution.thinkingOptionId === null ? undefined : execution.thinkingOptionId ?? (inheritOptions ? placement.config.thinkingOptionId : undefined),
  };
  return { cwd, config, systemPrompt };
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
