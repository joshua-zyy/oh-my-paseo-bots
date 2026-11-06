import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentSendOptions } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';

async function fixture({ home = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-conversation-settings-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  const previousHome = process.env.PASEO_HOME;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = directory;
  if (home) process.env.PASEO_HOME = join(directory, 'paseo'); else delete process.env.PASEO_HOME;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const created: PaseoAgentCreateOptions[] = [];
  const archived = new Set<string>();
  const statuses = new Map<string, string>();
  const messages: { agentId: string; text: string; options?: PaseoAgentSendOptions }[] = [];
  let loseCreation = false;
  let failCreation = false;
  const paseo = { providers: { snapshot: async () => ({ entries: [
    { provider: 'pi', enabled: true, status: 'ready', models: [{ id: 'vendor/old', label: 'Old', thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultThinkingOptionId: 'low' }] },
    { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'new-model', label: 'New', thinkingOptions: [{ id: 'medium', label: 'Medium' }] }] },
  ] }) }, workspaces: { create: async (input: { source: { path: string }; background: boolean }) => {
    assert.equal(input.background, true);
    return { agents: { create: async (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => {
      if (failCreation) { failCreation = false; throw new Error('原生创建尚未执行'); }
      created.push({ ...options, cwd: input.source.path });
      if (loseCreation) { loseCreation = false; throw new Error('原生创建回执丢失'); }
      return { id: options.agentId, workspaceId: `workspace:${input.source.path}` };
    } } };
  } }, agents: { ref: (agentId: string) => ({
    refresh: async () => {
      const input = created.find(item => item.agentId === agentId);
      if (!input) return null;
      const separator = input.config.provider.indexOf('/');
      return { agent: {
        id: agentId, title: input.title, provider: input.config.provider.slice(0, separator), model: input.config.provider.slice(separator + 1), cwd: input.cwd,
        currentModeId: input.config.modeId ?? null, thinkingOptionId: input.config.thinkingOptionId ?? null,
        status: statuses.get(agentId) ?? 'idle', pendingPermissions: [], archivedAt: archived.has(agentId) ? 'now' : null,
        labels: { ...input.labels, ...(input.parent ? { 'paseo.parent-agent-id': input.parent } : {}) },
      } };
    },
    archive: async () => { archived.add(agentId); return { archivedAt: 'now' }; },
    send: async (text: string, options?: PaseoAgentSendOptions) => { messages.push({ agentId, text, options }); },
    timeline: { refetch: async () => ({ entries: [{ seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: '取消旧任务' } }], error: null, staleCursor: false, gap: false, hasOlder: false, hasNewer: false }) },
  }) } } as unknown as PaseoApi;
  const server = {
    registerSettings: (definition: { id: string }) => ({ read: async () => ({ status: 'ready', values: definition.id === 'office' ? { bots: {} } : { cwd: directory, provider: 'pi/vendor/old', modeId: 'old-mode', thinkingOptionId: 'old-thinking', ...(home ? { paseoHome: join(directory, 'paseo') } : {}) } }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    addHook: () => () => {},
  } as unknown as PluginServerContext;
  let cleanup = contribute(server);
  const clients: Client[] = [];
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name);
    assert.ok(entry, `RPC ${name} must be registered`);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  }
  async function connect(agentId: string) {
    const config = created.find(item => item.agentId === agentId)!.config.mcpServers!['paseo-guys'];
    assert.equal(config.type, 'http');
    if (config.type !== 'http') throw new Error('Expected HTTP');
    const client = new Client({ name: 'conversation-settings-test', version: '0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    return client;
  }
  await invoke('bots.list', {});
  return {
    directory, invoke, created, archived, statuses, messages, connect, loseNextCreation: () => { loseCreation = true; },
    failNextCreation: () => { failCreation = true; },
    reload: async () => { await Promise.all(clients.splice(0).map(client => client.close())); await cleanup(); cleanup = contribute(server); },
    close: async () => {
      await Promise.all(clients.map(client => client.close())); await cleanup();
      if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
      if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function payload(result: unknown) {
  const value = result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(value.isError, true, value.content[0].text);
  return JSON.parse(value.content[0].text);
}

test('聊天思考等级采用宿主目录，保留草稿所需历史衔接、原模型和Bot默认，子事项继承新等级', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const request = { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { thinkingOptionId: 'high' } };
    const changed = await host.invoke('bots.conversation.change', request) as { agentId: string };
    assert.notEqual(changed.agentId, first.agentId);
    const created = host.created.find(item => item.agentId === changed.agentId)!;
    assert.equal(created.config.thinkingOptionId, 'high');
    assert.equal(created.config.provider, 'pi/vendor/old');
    assert.equal(created.config.modeId, 'old-mode');
    assert.equal(created.cwd, host.directory);
    assert.equal(created.labels?.['paseo-guys.conversation.previous'], first.agentId);
    assert.equal(created.prompt, undefined);
    assert.deepEqual(await host.invoke('bots.conversation.change', request), changed, '丢失回执可沿原请求核实，不重建');
    const count = host.created.length;
    assert.deepEqual(await host.invoke('bots.conversation.change', { ...request, agentId: changed.agentId, requestId: randomUUID() }), changed);
    assert.equal(host.created.length, count, '重复选择当前等级不创建会话');
    const client = await host.connect(changed.agentId);
    const task = payload(await client.callTool({ name: 'start_task', arguments: { requestId: 'thinking-child', title: '合成工作', prompt: '仅检查合成资料' } }));
    assert.equal(host.created.find(item => item.agentId === task.agentId)!.config.thinkingOptionId, 'high');
    const original = (await new BotStore({ baseDir: host.directory }).getBot('chief'))!.bot.execution;
    assert.deepEqual(original, {}, '聊天选择不修改Bot未来会话默认');
    const reset = await host.invoke('bots.conversation.change', { ...request, agentId: changed.agentId, requestId: randomUUID(), execution: { thinkingOptionId: null } }) as { agentId: string };
    assert.equal(host.created.find(item => item.agentId === reset.agentId)!.config.thinkingOptionId, undefined, '模型默认不回落宿主 old-thinking');
    const configuration = await host.invoke('bots.conversation.configuration', { botId: 'chief', agentId: reset.agentId }) as { execution: { thinkingOptionId: string | null } };
    assert.equal(configuration.execution.thinkingOptionId, null);
    const beforeInvalid = host.created.length;
    await assert.rejects(() => host.invoke('bots.conversation.change', { ...request, requestId: randomUUID(), execution: { thinkingOptionId: 'invented-level' } }), /思考|支持/);
    assert.equal(host.created.length, beforeInvalid);
    host.statuses.set(first.agentId, 'running');
    await assert.rejects(() => host.invoke('bots.conversation.change', { ...request, requestId: randomUUID() }), /回复|结束/);
  } finally { await host.close(); }
});

test('消息框切换模型和工作区新建原生会话，保留历史链、Bot 默认配置和旧任务绑定', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.update', { botId: 'chief', patch: { execution: { provider: 'pi/vendor/old', cwd: host.directory } } });
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对合成资料', execution: { provider: 'pi/vendor/helper', cwd: host.directory } });
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const original = await host.connect(first.agentId);
    const oldTask = payload(await original.callTool({ name: 'start_task', arguments: { requestId: 'old-task', title: '旧任务', prompt: '只检查合成数据' } }));
    const delegated = payload(await original.callTool({ name: 'delegate_to_colleague', arguments: { colleagueId: 'helper', requestId: 'old-delegation', title: '资料核对', prompt: '只检查合成数据' } }));
    const selected = join(host.directory, 'selected-project');
    const changed = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model', cwd: selected } }) as { agentId: string };
    assert.notEqual(changed.agentId, first.agentId);
    const native = host.created.find(item => item.agentId === changed.agentId)!;
    assert.equal(native.cwd, selected);
    assert.equal(native.config.provider, 'codex/new-model');
    assert.equal(native.config.modeId, undefined);
    assert.equal(native.config.thinkingOptionId, undefined);
    assert.equal(native.parent, undefined, '聊天衔接不使用原生 parent，不改变子任务生命周期');
    assert.equal(native.labels?.['paseo-guys.conversation.previous'], first.agentId);
    assert.equal(native.prompt, undefined, '仅选择配置不发起模型轮次');
    assert.equal(host.archived.size, 0);
    assert.equal(host.created.find(item => item.agentId === oldTask.agentId)!.parent, first.agentId);
    assert.deepEqual((await new BotStore({ baseDir: host.directory }).getBot('chief'))!.bot.execution, { provider: 'pi/vendor/old', cwd: host.directory });
    const configuration = await host.invoke('bots.conversation.configuration', { botId: 'chief', agentId: changed.agentId }) as { execution: { provider: string; cwd: string }; previousAgentIds: string[] };
    assert.equal(configuration.execution.provider, 'codex/new-model');
    assert.equal(configuration.execution.cwd, selected);
    assert.deepEqual(configuration.previousAgentIds, [first.agentId]);
    const count = host.created.length;
    assert.deepEqual(await host.invoke('bots.conversation.change', { botId: 'chief', agentId: changed.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model', cwd: selected } }), changed);
    assert.equal(host.created.length, count, '重复选择当前配置不创建新会话');
    const current = await host.connect(changed.agentId);
    const nextTask = payload(await current.callTool({ name: 'start_task', arguments: { requestId: 'new-task', title: '新任务', prompt: '只检查合成数据' } }));
    const execution = host.created.find(item => item.agentId === nextTask.agentId)!;
    assert.equal(execution.cwd, selected);
    assert.equal(execution.config.provider, 'codex/new-model');
    assert.equal(execution.parent, changed.agentId);
    const nextDelegation = payload(await current.callTool({ name: 'delegate_to_colleague', arguments: { colleagueId: 'helper', requestId: 'new-delegation', title: '第二份资料核对', prompt: '只检查合成数据' } }));
    assert.equal(host.created.find(item => item.agentId === nextDelegation.agentId)!.config.provider, 'pi/vendor/helper', '跨 Bot 委派保留接收方模型，不继承主聊天的选择');
    const colleague = await host.connect(delegated.agentId);
    payload(await colleague.callTool({ name: 'complete_task', arguments: { summary: '资料同事已经核对', evidence: ['synthetic-colleague-report.md'] } }));
    const worker = await host.connect(oldTask.agentId);
    payload(await worker.callTool({ name: 'complete_task', arguments: { summary: '旧任务已经核对', evidence: ['synthetic-report.md'] } }));
    assert.equal(host.messages.at(-1)!.agentId, first.agentId, '旧任务仍向原父聊天回报');
    const work = await host.invoke('bots.conversation.work', { botId: 'chief', agentId: changed.agentId }) as { entries: { agentId: string; botId: string; summary?: string }[] };
    assert.equal(work.entries.find(item => item.agentId === oldTask.agentId)?.summary, '旧任务已经核对');
    assert.deepEqual(work.entries.filter(item => item.agentId === delegated.agentId).map(item => [item.botId, item.summary]), [['helper', '资料同事已经核对']], '最新聊天保留旧父会话的跨 Bot 任务报告及归属');
    const context = await host.invoke('bots.conversation.context', { botId: 'chief', agentId: changed.agentId }) as { text: string };
    assert.ok(context.text.includes(first.agentId), '本轮上下文指向本 Bot 的旧原生历史');
    await host.reload();
    const restored = await host.invoke('bots.conversation.configuration', { botId: 'chief', agentId: changed.agentId }) as { previousAgentIds: string[] };
    assert.deepEqual(restored.previousAgentIds, [first.agentId]);
  } finally { await host.close(); }
});

test('读取当前配置不创建默认目录；选择 Bot 工作区时才准备目录并切换', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const configuration = await host.invoke('bots.conversation.configuration', { botId: 'chief', agentId: first.agentId }) as { defaultCwd: string };
    assert.equal(configuration.defaultCwd, join(host.directory, 'paseo', 'oh-my-paseo-bots', 'workspaces', 'chief'));
    await assert.rejects(() => stat(configuration.defaultCwd), { code: 'ENOENT' });
    const result = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { cwd: configuration.defaultCwd } }) as { agentId: string };
    assert.equal((await stat(configuration.defaultCwd)).isDirectory(), true);
    assert.equal(host.created.find(input => input.agentId === result.agentId)!.cwd, configuration.defaultCwd);
  } finally { await host.close(); }
});

test('显式项目的聊天配置读取和模型切换不依赖默认工作区或 CLI home', async () => {
  const host = await fixture({ home: false });
  try {
    await host.invoke('bots.update', { botId: 'chief', patch: { execution: { cwd: host.directory } } });
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const configuration = await host.invoke('bots.conversation.configuration', { botId: 'chief', agentId: first.agentId }) as { execution: { cwd: string }; defaultCwd?: string };
    assert.equal(configuration.execution.cwd, host.directory);
    assert.equal(configuration.defaultCwd, undefined);
    const changed = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model' } }) as { agentId: string };
    assert.equal(host.created.find(input => input.agentId === changed.agentId)!.cwd, host.directory);
  } finally { await host.close(); }
});

test('配置切换创建前失败后重新打开已有聊天；未决切换仍按原配置和原请求恢复', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const request = { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model' } };
    host.failNextCreation();
    await assert.rejects(() => host.invoke('bots.conversation.change', request), /尚未执行/);
    assert.deepEqual(await host.invoke('bots.conversation.open', { botId: 'chief' }), first);
    assert.equal(host.created.length, 1, '重新打开不按普通默认参数重放配置切换');
    const pending = await host.invoke('bots.creations.pending', { botId: 'chief' }) as { requestId: string }[];
    assert.ok(pending.some(intent => intent.requestId === request.requestId));
    const restored = await host.invoke('bots.conversation.change', request) as { agentId: string };
    assert.equal(host.created.length, 2);
    const native = host.created.find(input => input.agentId === restored.agentId)!;
    assert.equal(native.config.provider, request.execution.provider);
    assert.equal(native.labels?.['paseo-guys.conversation.previous'], first.agentId);
  } finally { await host.close(); }
});

test('配置切换回执丢失沿原请求回查；运行中或其他 Bot 会话不能切换', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const request = { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'pi/vendor/new' } };
    host.statuses.set(first.agentId, 'running');
    await assert.rejects(() => host.invoke('bots.conversation.change', request), /运行|回复|结束/);
    assert.equal(host.created.length, 1);
    host.statuses.set(first.agentId, 'idle');
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对' });
    await assert.rejects(() => host.invoke('bots.conversation.change', { ...request, botId: 'helper' }), /关联|持续聊天/);
    host.loseNextCreation();
    await assert.rejects(() => host.invoke('bots.conversation.change', request), /回执丢失/);
    assert.equal(host.created.length, 2);
    const recovered = await host.invoke('bots.conversation.change', request) as { agentId: string };
    assert.equal(recovered.agentId, host.created[1].agentId);
    assert.equal(host.created.length, 2);
    assert.equal(host.created[1].config.provider, 'pi/vendor/new', '只在第一个斜线处分 Provider');
    assert.equal(host.archived.size, 0);
  } finally { await host.close(); }
});

test('切换后的聊天可按最新原话取消同一历史链的旧子任务，不接管无关会话', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const original = await host.connect(first.agentId);
    const old = payload(await original.callTool({ name: 'start_task', arguments: { requestId: 'old-task', title: '旧任务', prompt: '只检查合成数据' } }));
    const separate = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const unrelated = await host.connect(separate.agentId);
    const other = payload(await unrelated.callTool({ name: 'start_task', arguments: { requestId: 'other-task', title: '无关任务', prompt: '只检查合成数据' } }));
    const changed = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'pi/vendor/new' } }) as { agentId: string };
    const current = await host.connect(changed.agentId);
    assert.equal((await current.callTool({ name: 'cancel_task', arguments: { userQuote: '取消旧任务', targetAgentId: other.agentId } })).isError, true);
    assert.equal((await current.callTool({ name: 'cancel_task', arguments: { userQuote: '伪造依据', targetAgentId: old.agentId } })).isError, true);
    payload(await current.callTool({ name: 'cancel_task', arguments: { userQuote: '取消旧任务', targetAgentId: old.agentId } }));
    assert.equal(host.archived.has(old.agentId), true);
    assert.equal(host.archived.has(changed.agentId), false);
    assert.equal(host.archived.has(other.agentId), false);
  } finally { await host.close(); }
});
