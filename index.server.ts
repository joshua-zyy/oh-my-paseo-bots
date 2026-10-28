import type { PluginServerContext, PluginHookAgent, PluginHookContext } from '@getpaseo/plugin/server';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { BotStore } from './server/store.js';
import { BotJournal } from './server/journal.js';
import { startBotSession } from './server/sessions.js';
import { BotMcp } from './server/mcp.js';
import { rememberExplicit } from './server/memory.js';
import type { PaseoApi } from '@getpaseo/client';
import * as rpc from './shared/contracts.js';
import * as officeRpc from './shared/office.js';
import { BotOfficeAccess } from './server/office.js';

export default function contribute(server: PluginServerContext) {
  const baseDir = process.env.PASEO_GUYS_DATA_DIR ?? join(homedir(), '.paseo-guys');
  const store = new BotStore({ baseDir });
  const journal = new BotJournal({ baseDir: join(baseDir, 'journal') });
  const officeSettings = server.registerSettings(officeRpc.officeSettings);
  const office = new BotOfficeAccess({ baseDir, store, readConfig: async botId => {
    const state = await officeSettings.read();
    if (state.status !== 'ready') throw new Error('办公配置无效，请先在固定同事入口设置账户和数据范围');
    return state.values.bots[botId] ?? {};
  } });
  let currentPaseo: PaseoApi | undefined;
  const mcp = new BotMcp({ baseDir, store, journal, office, rememberExplicit: async (botId, agentId, input) => {
    if (!currentPaseo) throw new Error('原生宿主上下文尚未就绪，未保存明确记忆');
    return rememberExplicit(store, currentPaseo, botId, agentId, input);
  } });
  const restoring = mcp.restore();
  void restoring.catch(error => console.error('Bot MCP 端点恢复失败', error));
  const settings = server.registerSettings(rpc.settings);
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
    return { bots, corrupt };
  });
  server.handle(rpc.createBot, async input => ({ id: (await store.createBot(input)).bot.id }));
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
    currentPaseo = paseo;
    const state = await settings.read();
    if (state.status !== 'ready') throw new Error(`Bot 设置无效：${state.error}`);
    const { cwd, provider, modeId, thinkingOptionId } = state.values;
    if (!isAbsolute(cwd)) throw new Error('Bot 工作目录必须为宿主绝对路径');
    return startBotSession(store, paseo, { ...input, requestId: input.requestId ?? randomUUID() }, { cwd, config: { provider, modeId, thinkingOptionId } }, mcp);
  });
  async function associate(agent: PluginHookAgent, context: PluginHookContext) {
    currentPaseo = context.paseo;
    const snapshot = await context.paseo.agents.ref(agent.id).refresh();
    const botId = snapshot?.agent.labels?.['paseo-guys.bot'];
    if (!botId || !await store.getBot(botId)) return null;
    try { await store.linkSession(botId, { sessionId: agent.id, title: agent.title, workspaceId: agent.workspaceId }); }
    catch (error) { console.error(`Bot ${botId} 会话关联未保存；仍记录原生观察`, error); }
    return botId;
  }
  const opened = server.before('agent.session_open', async ({ request }, context) => {
    currentPaseo = context.paseo;
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
  const ended = server.on('agent.turn_ended', async (event, context) => {
    const botId = await associate(event.agent, context);
    if (botId) await journal.append(botId, {
      agentId: event.agent.id, turnId: event.turnId, kind: 'turn_ended', outcome: event.outcome.kind,
      ...(event.outcome.kind === 'failed' ? { error: event.outcome.error.message.trim().slice(0, 4000) || '原生轮次失败（无详细信息）' } : {}),
    });
  });
  return async () => { started(); ended(); opened(); await restoring.catch(() => {}); await mcp.close(); };
}
