import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { PaseoApi, PaseoAgentConfig } from '@getpaseo/client';
import type { BotStore } from './store.js';
import { botPrompt } from './prompt.js';
import type { BotMcp } from './mcp.js';
import type { BotDetails } from '../shared/bot.js';
import { CONVERSATION_PREVIOUS_LABEL } from '../shared/chat.js';

export interface SessionInput {
  botId: string;
  requestId: string;
  title: string;
  prompt?: string;
  parentAgentId?: string;
  kind?: 'conversation';
  execution?: BotDetails['execution'];
  previousAgentId?: string;
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
  const { cwd, config, systemPrompt: botSystemPrompt } = await botSessionConfig(store, input.botId, placement, input.kind ?? 'interactive', input.execution);
  const systemPrompt = input.previousAgentId
    ? `${botSystemPrompt}\n\n当前是同一 Bot 持续聊天切换模型或工作区后的原生会话。上一段原生会话标识：${input.previousAgentId}。优先使用本轮附件中的交接原文理解用户已交办的目标、决定与上下文；附件缺失或内容不足时，再用 read_bot_history 查读此前分段的相关历史。此前事项保留原父会话及其回报，不因配置切换重新派发或扩大授权。`
    : botSystemPrompt;
  const fingerprint = createHash('sha256')
    .update(
      stable({
        bot: input.botId,
        title: input.title,
        prompt: input.prompt,
        parentAgentId: input.parentAgentId,
        kind: input.kind,
        previousAgentId: input.previousAgentId,
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
      idempotencyKey: `oh-my-paseo-bots:v2:${input.botId}:${proposal.intent.requestId}`,
      background: true,
      ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
      config: { ...config, systemPrompt, mcpServers: { ...config.mcpServers, 'paseo-guys': botTools } },
      title: input.title,
      prompt: input.prompt,
      labels: { 'paseo-guys.bot': input.botId, 'paseo-guys.request': proposal.intent.requestId, ...(input.kind ? { 'paseo-guys.conversation': 'true', ...(input.previousAgentId ? { [CONVERSATION_PREVIOUS_LABEL]: input.previousAgentId } : {}) } : {}) },
    };
    // 隐藏的原生工作区按 Bot 与目录复用；位置不改变原生父子关系。
    const { workspace, replacementId } = await botWorkspace(store, paseo, input.botId, cwd);
    // 原生失败回执也绑定原工作区；已确认失效时给替代位置稳定的新键。
    if (replacementId) options.idempotencyKey += `:workspace:${replacementId}`;
    agent = await workspace.agents.create(options);
  }

  await store.completeCreation(input.botId, proposal.intent.requestId, {
    sessionId: agent.id,
    title: input.title,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
  });
  return { agentId: agent.id, requestId: proposal.intent.requestId };
}

/** 复用实际有效的关联；归档后的旧创建回执不代表工作区仍存在。 */
async function botWorkspace(store: BotStore, paseo: PaseoApi, botId: string, cwd: string) {
  const links = await store.listSessions(botId);
  const ids = [...new Set([...links].reverse().map(link => link.workspaceId).filter((id): id is string => !!id))];
  for (const id of ids) {
    const workspace = paseo.workspaces.ref(id);
    const snapshot = await workspace.refresh(); // 请求失败是未知，不能按不存在重建。
    // 只复用当前 v2 注册记录中的专属后台位置，不读取旧根层关联。
    if (snapshot?.title === `oh-my-paseo-bots:v2:${botId}` && snapshot.background && !snapshot.archivingAt && snapshot.workspaceDirectory && !relative(cwd, snapshot.workspaceDirectory)) return { workspace };
  }
  const workspace = await paseo.workspaces.create({
    source: { kind: 'directory', path: cwd },
    title: `oh-my-paseo-bots:v2:${botId}`,
    background: true,
    // 同一失效关联后的并发创建仍用同一键；新关联落盘后直接复用它。
    idempotencyKey: `${botWorkspaceKey(botId, cwd)}${ids[0] ? `:${ids[0]}` : ''}`,
  });
  return { workspace, replacementId: ids[0] };
}

export function botWorkspaceKey(botId: string, cwd: string): string {
  return `oh-my-paseo-bots:v2:workspace:${createHash('sha256').update(stable({ bot: botId, cwd })).digest('hex')}`;
}

/** 只复用当前 checkout 的已登记项目；不把独立目录或嵌套 checkout 挂到外层项目。 */
export async function findRegisteredCheckoutProject(paseo: PaseoApi, cwd: string): Promise<string | undefined> {
  const directory = await realpath(cwd);
  let root = directory;
  for (;;) {
    try {
      const git = await lstat(join(root, '.git'));
      if (!git.isDirectory() && !git.isFile()) return;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(root);
      if (parent === root) return;
      root = parent;
    }
  }
  if (!relative(root, directory)) return; // Paseo 自己会复用同目录登记。
  const { projects } = await paseo.projects.list();
  if (projects.some(project => !relative(directory, project.projectRootPath))) return;
  return projects.find(project => project.projectKind === 'git' && !relative(root, project.projectRootPath))?.projectId;
}

/** 主总管与专长委派复用配置映射及技能路径检查。 */
export async function botSessionConfig(store: BotStore, botId: string, placement: { cwd: string; config: PaseoAgentConfig }, kind: 'interactive' | 'conversation' = 'interactive', overrides?: BotDetails['execution']) {
  const data = await store.getBot(botId);
  if (!data) throw new Error(`Bot 不存在：${botId}`);
  const { skills, disabledMcpServers = [] } = data.bot.capabilities;
  const mcpServers = Object.fromEntries(Object.entries(data.bot.capabilities.mcpServers).filter(([name]) => !disabledMcpServers.includes(name)));
  for (const skill of skills) {
    if (!isAbsolute(skill.path)) throw new Error(`技能必须使用宿主绝对路径：${skill.path}`);
    if (!(await stat(skill.path)).isFile()) throw new Error(`技能路径必须指向 SKILL.md 文件：${skill.path}`);
  }
  // 持续聊天通过发送前附件或 get_bot_context 取得最新记忆，不固化到启动提示词。
  const memories = kind === 'conversation' ? [] : await store.getContextMemories(botId);
  const systemPrompt = botPrompt({ id: data.bot.id, name: data.bot.name, role: data.bot.role, instructions: data.bot.instructions, skills, confirmedMemories: memories.map(memory => memory.content), kind });
  const execution = { ...data.bot.execution, ...overrides };
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
