import type { PluginServerContext, PluginHookAgent, PluginHookContext } from '@getpaseo/plugin/server';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { BotStore } from './server/store.js';
import { BotJournal } from './server/journal.js';
import { botSessionConfig, startBotSession, type SessionInput } from './server/sessions.js';
import { BotMcp } from './server/mcp.js';
import { rememberExplicit, latestUserMessage, correctExplicitMemory, forgetExplicitMemory } from './server/memory.js';
import { readBotHistory } from './server/history.js';
import { readHistory } from './shared/history.js';
import type { PaseoApi } from '@getpaseo/client';
import * as rpc from './shared/contracts.js';
import { CHIEF_BOT_ID } from './shared/bot.js';
import * as officeRpc from './shared/office.js';
import { BotOfficeAccess } from './server/office.js';
import { TaskTracker } from './server/tasks.js';
import * as taskRpc from './shared/tasks.js';
import { BotRoutines } from './server/routines.js';
import * as routineRpc from './shared/routines.js';

export default function contribute(server: PluginServerContext) {
  const legacyDir = join(homedir(), '.paseo-guys');
  const baseDir = process.env.OH_MY_PASEO_BOTS_DATA_DIR ?? process.env.PASEO_GUYS_DATA_DIR
    ?? (existsSync(legacyDir) ? legacyDir : join(homedir(), '.oh-my-paseo-bots'));
  const store = new BotStore({ baseDir });
  const journal = new BotJournal({ baseDir: join(baseDir, 'journal') });
  let currentPaseo: PaseoApi | undefined;
  const settings = server.registerSettings(rpc.settings);
  const tasks: TaskTracker = new TaskTracker({ baseDir, store, getPaseo: () => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪');
    return currentPaseo;
  }, routineOwner: agentId => routines.owner(agentId), cli: async () => {
    const state = await settings.read();
    if (state.status !== 'ready') throw new Error('请先设置宿主原生 CLI 与目录');
    const { paseoCommand, paseoHome, cwd } = state.values;
    const home = paseoHome ?? process.env.PASEO_HOME;
    if (!paseoCommand || !home || !isAbsolute(home) || !isAbsolute(cwd)) throw new Error('原生跟进需配置当前 daemon 的 CLI 命令及绝对 home、工作目录');
    return { command: paseoCommand, home, cwd };
  } });
  const officeSettings = server.registerSettings(officeRpc.officeSettings);
  const office = new BotOfficeAccess({ baseDir, store, requireActive: (botId, agentId) => tasks.requireActive(botId, agentId), readConfig: async botId => {
    const state = await officeSettings.read();
    if (state.status !== 'ready') throw new Error('办公配置无效，请先在固定同事入口设置账户和数据范围');
    return state.values.bots[botId] ?? {};
  } });
  const mcp: BotMcp = new BotMcp({ baseDir, store, journal, office, tasks, readContext: (botId, agentId) => routines.context(botId, agentId), startColleague: async input => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未派发同事任务');
    return startBoundSession(input, currentPaseo);
  }, cancelExplicit: async (botId, agentId, quote, targetAgentId) => {
    if (!currentPaseo || (await latestUserMessage(currentPaseo, agentId)).trim() !== quote.trim()) throw new Error('取消依据与原生最新完整用户消息不符，未取消事项');
    if (targetAgentId && targetAgentId !== agentId) {
      const caller = await tasks.requireActive(botId, agentId);
      const target = await currentPaseo.agents.ref(targetAgentId).refresh();
      const owner = target?.agent.labels?.['paseo-guys.bot'];
      if (!caller.specialists.includes(targetAgentId) || target?.agent.labels?.['paseo.parent-agent-id'] !== agentId || !owner) throw new Error('只能取消当前聊天实际交办的固定同事子事项');
      return tasks.stop(owner, targetAgentId, { outcome: 'canceled', summary: '用户在父聊天中明确取消此子事项' });
    }
    await tasks.ensure(botId, agentId, { title: agentId });
    return tasks.stop(botId, agentId, { outcome: 'canceled', summary: '用户在原生会话中明确取消事项' });
  }, rememberExplicit: async (botId, agentId, input) => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未保存明确记忆');
    return rememberExplicit(store, currentPaseo, botId, agentId, input);
  }, correctMemory: async (botId, agentId, input) => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未纠正记忆');
    return correctExplicitMemory(store, currentPaseo, botId, agentId, input);
  }, forgetMemory: async (botId, agentId, input) => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未遗忘记忆');
    return forgetExplicitMemory(store, currentPaseo, botId, agentId, input);
  }, readHistory: async (botId, input) => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未读取历史');
    return readBotHistory(store, currentPaseo, botId, input);
  } });
  const restoring = mcp.restore();
  void restoring.catch(error => console.error('Bot MCP 端点恢复失败', error));
  server.handle(taskRpc.listTasks, async input => (await tasks.list(input.botId)).filter(task => !task.conversation));
  server.handle(readHistory, async (input, { paseo }) => readHistory.output.parse(await readBotHistory(store, paseo, input.botId, input)));
  server.handle(routineRpc.listRoutines, input => routines.list(input.botId));
  server.handle(routineRpc.createRoutine, input => routines.create(input.botId, input));
  server.handle(routineRpc.pauseRoutine, input => routines.action(input.botId, input.routineId, 'pause'));
  server.handle(routineRpc.resumeRoutine, input => routines.action(input.botId, input.routineId, 'resume'));
  server.handle(routineRpc.runRoutine, input => routines.action(input.botId, input.routineId, 'run-once'));
  server.handle(routineRpc.cancelRoutine, async (input, { paseo }) => {
    currentPaseo = paseo;
    return routines.cancel(input.botId, input.routineId);
  });
  server.handle(taskRpc.cancelTask, async (input, { paseo }) => {
    currentPaseo = paseo;
    await tasks.ensure(input.botId, input.agentId, { title: input.agentId });
    return tasks.stop(input.botId, input.agentId, { outcome: 'canceled', summary: '用户在固定同事入口取消事项并停止跟进' });
  });
  server.handle(officeRpc.officeStatus, input => office.scope(input.botId));
  server.handle(officeRpc.listMail, input => office.mail.list(input.botId));
  server.handle(officeRpc.listMailGrants, input => office.mail.listGrants(input.botId));
  server.handle(officeRpc.sendMail, async input => {
    let action = (await office.mail.list(input.botId)).find(item => item.id === input.actionId);
    if (!action) throw new Error('未找到邮件登记');
    if (action.status === 'pending_confirmation' || action.status === 'revoked') action = await office.mail.approve(input.botId, action.id);
    return office.mail.send(input.botId, action.agentId, action.id);
  });
  server.handle(officeRpc.reconcileMail, async input => {
    const action = (await office.mail.list(input.botId)).find(item => item.id === input.actionId);
    if (!action) throw new Error('未找到邮件登记');
    return office.mail.reconcile(input.botId, action.agentId, action.id);
  });
  server.handle(officeRpc.revokeMail, input => office.mail.revoke(input.botId, input.actionId));
  server.handle(officeRpc.allowFixedMail, input => office.mail.allowFixed(input.botId, input.actionId));
  server.handle(officeRpc.revokeMailGrant, async input => { await office.mail.revokeGrant(input.botId, input.grantId); return {}; });
  server.handle(rpc.toolStatus, () => mcp.status());
  server.handle(rpc.listBots, async () => {
    const corrupt: string[] = [];
    const bots = await store.listBots(id => corrupt.push(id));
    if (!bots.some(bot => bot.id === CHIEF_BOT_ID) && !corrupt.includes(CHIEF_BOT_ID)) bots.unshift(await store.ensureChief());
    return { bots, corrupt };
  });
  server.handle(rpc.createBot, async input => ({ id: (await store.createBot(input)).bot.id }));
  server.handle(rpc.updateBot, input => store.updateBot(input.botId, input.patch));
  server.handle(rpc.listMemories, input => store.listMemories(input.botId));
  server.handle(rpc.listSessions, input => store.listSessions(input.botId));
  server.handle(rpc.pendingCreations, input => store.listPendingCreations(input.botId));
  server.handle(rpc.acknowledgeCreation, async input => { await store.acknowledgeCreation(input.botId, input.requestId); return {}; });
  server.handle(rpc.inspectCreation, async (input, { paseo }) => {
    const intent = (await store.listPendingCreations(input.botId)).find(item => item.requestId === input.requestId);
    if (!intent) throw new Error('未找到待核实的创建请求');
    let snapshot;
    try { snapshot = await paseo.agents.ref(intent.agentId).refresh(); }
    catch { return { agentId: intent.agentId, status: 'unknown' as const, detail: '原生会话回查失败；未重新创建' }; }
    if (!snapshot) return { agentId: intent.agentId, status: 'unknown' as const, detail: '暂未找到原生会话；保留未决请求，未重新创建' };
    await store.completeCreation(input.botId, intent.requestId, { sessionId: intent.agentId, title: snapshot.agent.title, workspaceId: snapshot.agent.workspaceId });
    return { agentId: intent.agentId, status: 'created' as const };
  });
  server.handle(rpc.readJournal, async input => {
    if (!await store.getBot(input.botId)) throw new Error(`Bot 不存在：${input.botId}`);
    return journal.inspect(input.botId, { limit: input.limit, offset: input.offset });
  });
  // These RPCs are user-facing controls, never a tool automatically granted to Agents.
  server.handle(rpc.saveMemory, input => store.addMemory(input.botId, input));
  server.handle(rpc.correctMemory, input => store.updateMemory(input.botId, input.memoryId, input));
  server.handle(rpc.startSession, async (input, { paseo }) => {
    return startBoundSession({ ...input, requestId: input.requestId ?? randomUUID() }, paseo);
  });
  server.handle(rpc.openConversation, async ({ botId }, { paseo }) => {
    currentPaseo = paseo;
    const bot = await store.getBot(botId);
    if (!bot) throw new Error(`Bot 不存在：${botId}`);
    const existing = (await tasks.list(botId)).filter(task => task.conversation && task.status === 'active').at(-1);
    const pending = (await store.listPendingCreations(botId)).find(intent => intent.agentId === existing?.agentId);
    let requestId: string = randomUUID();
    if (existing) {
      const snapshot = await paseo.agents.ref(existing.agentId).refresh();
      if (snapshot && !snapshot.agent.archivedAt) {
        if (pending) {
          await store.completeCreation(botId, pending.requestId, { sessionId: existing.agentId, title: snapshot.agent.title, workspaceId: snapshot.agent.workspaceId });
          await store.acknowledgeCreation(botId, pending.requestId);
        }
        await mcp.mount(botId, existing.agentId);
        return { agentId: existing.agentId };
      }
      if (snapshot?.agent.archivedAt) await tasks.observeArchived(botId, existing.agentId);
      else if (pending) requestId = pending.requestId;
      else throw new Error('持续聊天的原生会话暂未找到；保留关联，未重新创建');
    }
    const result = await startBoundSession({ botId, requestId, title: bot.bot.name, kind: 'conversation' }, paseo);
    await store.acknowledgeCreation(botId, result.requestId);
    return { agentId: result.agentId };
  });
  async function startBoundSession(input: SessionInput, paseo: PaseoApi) {
    currentPaseo = paseo;
    const state = await settings.read();
    if (state.status !== 'ready') throw new Error(`Bot 设置无效：${state.error}`);
    const { cwd, provider, modeId, thinkingOptionId } = state.values;
    return startBotSession(store, paseo, input, { cwd, config: { provider, modeId, thinkingOptionId } }, {
      mount: async (botId, agentId) => {
        await tasks.ensure(botId, agentId, { title: input.title, ...(input.kind === 'conversation' ? { conversation: true } : {}) });
        return mcp.mount(botId, agentId);
      },
    });
  }
  const routines = new BotRoutines({ baseDir, store, tasks, cli: async () => {
    const state = await settings.read();
    if (state.status !== 'ready') throw new Error('请先设置宿主原生 CLI 与目录');
    const home = state.values.paseoHome ?? process.env.PASEO_HOME;
    if (!state.values.paseoCommand || !home || !isAbsolute(home)) throw new Error('独立例程需配置当前 daemon 的 CLI 命令及绝对 home');
    return { command: state.values.paseoCommand, home, cwd: state.values.cwd };
  }, defaults: async () => {
    const state = await settings.read();
    if (state.status !== 'ready') throw new Error('Bot 执行设置无效');
    return { cwd: state.values.cwd, config: { provider: state.values.provider, modeId: state.values.modeId, thinkingOptionId: state.values.thinkingOptionId } };
  } });
  async function associate(agent: PluginHookAgent, context: PluginHookContext) {
    currentPaseo = context.paseo;
    const snapshot = await context.paseo.agents.ref(agent.id).refresh();
    const botId = snapshot?.agent.labels?.['paseo-guys.bot'] ?? await routines.owner(agent.id);
    let parentBotId: string | null = null;
    let parentId = agent.parentAgentId;
    const seen = new Set<string>([agent.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = await context.paseo.agents.ref(parentId).refresh();
      const owner = parent?.agent.labels?.['paseo-guys.bot'] ?? await routines.owner(parentId);
      if (owner && await store.getBot(owner)) {
        try {
          await store.linkSession(owner, { sessionId: parentId, title: parent!.agent.title, workspaceId: parent!.agent.workspaceId });
          await tasks.ensure(owner, parentId, { title: parent!.agent.title || parentId, ...(parent?.agent.labels?.['paseo-guys.conversation'] === 'true' ? { conversation: true } : {}) });
          await tasks.observeSpecialist(owner, parentId, agent.id);
        } catch (error) { console.error(`Bot ${owner} 的原生专家关联未保存；仍记录原生观察`, error); }
        parentBotId = owner;
        break;
      }
      parentId = parent?.agent.labels?.['paseo.parent-agent-id'] ?? null;
    }
    if (!botId || !await store.getBot(botId)) return parentBotId;
    try { await store.linkSession(botId, { sessionId: agent.id, title: agent.title, workspaceId: agent.workspaceId }); }
    catch (error) { console.error(`Bot ${botId} 会话关联未保存；仍记录原生观察`, error); }
    try { await tasks.ensure(botId, agent.id, { title: agent.title || agent.id, ...(snapshot?.agent.labels?.['paseo-guys.conversation'] === 'true' ? { conversation: true } : {}) }); }
    catch (error) { console.error(`Bot ${botId} 的事项关联未保存；仍记录原生观察`, error); }
    return botId;
  }
  const hidden = server.before('workspace.create', async ({ request }, { paseo }) => {
    const botId = request.agent?.labels?.['paseo-guys.bot'];
    if (botId && await store.getBot(botId)) return { ...request, background: true };
    const scheduleId = request.agent?.labels?.['paseo.schedule-id'];
    if (scheduleId && await routines.ownsSchedule(scheduleId)) return { ...request, background: true };
    if (request.callerAgentId) {
      const caller = await paseo.agents.ref(request.callerAgentId).refresh();
      const owner = caller?.agent.labels?.['paseo-guys.bot'] ?? await routines.owner(request.callerAgentId);
      if (owner && await store.getBot(owner)) return { ...request, background: true };
    }
  });
  const opened = server.before('agent.session_open', async ({ request }, context) => {
    currentPaseo = context.paseo;
    if (request.labels?.['paseo.schedule-id']) {
      const routine = await routines.bind(request);
      if (!routine) return;
      const bot = await store.getBot(routine.botId);
      if (!bot) throw new Error('例程绑定的 Bot 不存在');
      const config = await botSessionConfig(store, routine.botId, { cwd: request.cwd, config: { provider: request.provider } }, 'routine');
      return { ...request, mcpServers: { ...request.mcpServers, ...config.config.mcpServers, 'paseo-guys': await mcp.mount(routine.botId, request.agentId) } };
    }
    try {
      const snapshot = await context.paseo.agents.ref(request.agentId).refresh();
      const botId = snapshot?.agent.labels?.['paseo-guys.bot'];
      if (botId && await store.getBot(botId)) await mcp.mount(botId, request.agentId);
    } catch (error) {
      console.error(`原生会话 ${request.agentId} 的 Bot 工具恢复失败；继续打开会话`, error);
    }
  });
  const started = server.on('agent.turn_started', async (event, context) => {
    const botId = await associate(event.agent, context);
    if (botId) await journal.append(botId, { agentId: event.agent.id, turnId: event.turnId, kind: 'turn_started' });
  });
  const created = server.on('agent.created', async (event, context) => { await associate(event.agent, context); });
  const archived = server.on('agent.archived', async (event, context) => {
    currentPaseo = context.paseo;
    const snapshot = await context.paseo.agents.ref(event.agent.id).refresh();
    const botId = snapshot?.agent.labels?.['paseo-guys.bot'] ?? await routines.owner(event.agent.id);
    if (botId && await store.getBot(botId)) {
      await tasks.observeArchived(botId, event.agent.id);
      const requestId = snapshot?.agent.labels?.['paseo-guys.request'];
      if (requestId && (await store.listPendingCreations(botId)).some(intent => intent.requestId === requestId && intent.status === 'created')) {
        await store.acknowledgeCreation(botId, requestId);
      }
    }
  });
  const ended = server.on('agent.turn_ended', async (event, context) => {
    const botId = await associate(event.agent, context);
    if (botId) await journal.append(botId, {
      agentId: event.agent.id, turnId: event.turnId, kind: 'turn_ended', outcome: event.outcome.kind,
      ...(event.outcome.kind === 'failed' ? { error: event.outcome.error.message.trim().slice(0, 4000) || '原生轮次失败（无详细信息）' } : {}),
    });
    if (!botId || event.outcome.kind !== 'failed') return;
    const child = await context.paseo.agents.ref(event.agent.id).refresh();
    if (child?.agent.labels?.['paseo-guys.bot'] !== botId || child.agent.archivedAt) return;
    const task = await tasks.get(botId, event.agent.id);
    if (task?.status !== 'active') return;
    const parentId = child.agent.labels['paseo.parent-agent-id'];
    if (!parentId) return;
    const parent = await context.paseo.agents.ref(parentId).refresh();
    const parentBotId = parent?.agent.labels?.['paseo-guys.bot'] ?? await routines.owner(parentId);
    const parentTask = parentBotId ? await tasks.get(parentBotId, parentId) : null;
    if (parentTask?.status !== 'active' || parent?.agent.archivedAt || !parentTask.specialists.includes(event.agent.id)) return;
    await context.paseo.agents.ref(parentId).send(
      `固定同事 ${botId} 的原生轮次失败，尚未保存本事项交付报告。请查询原生状态、活动和已有产物，决定当前授权内的恢复或需要用户决定的事项；不要把失败通知当作完成，也不要自动重新委派。\n${JSON.stringify({ agentId: event.agent.id, title: task.title, turnId: event.turnId })}`,
      { sourceAgentId: event.agent.id, activeTurnBehavior: 'steer', ...(event.turnId === null ? {} : { messageId: `paseo-guys:failure:${event.agent.id}:${event.turnId}` }) },
    );
  });
  return async () => { started(); ended(); created(); archived(); opened(); hidden(); await restoring.catch(() => {}); await mcp.close(); };
}
