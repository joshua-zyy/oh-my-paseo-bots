import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentSendOptions, PaseoAgentTimelineRefetchOptions } from '@getpaseo/client';
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
  const history = new Map<string, { type: string; text: string }[]>();
  const historyReads: { agentId: string; limit?: number }[] = [];
  const historyFailures = new Map<string, string>();
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
  }, ref: (id: string) => ({
    refresh: async () => ({ id, title: `oh-my-paseo-bots:${created.find(item => item.cwd === id.slice('workspace:'.length))?.labels?.['paseo-guys.bot']}`, workspaceDirectory: id.slice('workspace:'.length), background: true }),
    agents: { create: async (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => {
      const workspace = await paseo.workspaces.create({ source: { kind: 'directory', path: id.slice('workspace:'.length) }, background: true });
      return workspace.agents.create(options);
    } },
  }) }, agents: { ref: (agentId: string) => ({
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
    timeline: { refetch: async (options: PaseoAgentTimelineRefetchOptions) => {
      historyReads.push({ agentId, limit: options.limit });
      const items = history.get(agentId) ?? [{ type: 'user_message', text: '取消旧任务' }];
      const start = Math.max(0, items.length - (options.limit ?? 50));
      return { entries: items.slice(start).map((item, index) => ({ seqStart: start + index + 1, seqEnd: start + index + 1, item })), error: historyFailures.get(agentId) ?? null, staleCursor: false, gap: false, hasOlder: start > 0, hasNewer: false };
    } },
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
    directory, invoke, created, archived, statuses, messages, history, historyReads, historyFailures, connect, loseNextCreation: () => { loseCreation = true; },
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

test('跨后端切换首次消息交接可见原文与来源，切回包含新进展且不读取其他Bot', async () => {
  const host = await fixture();
  const data = (context: { text: string }) => JSON.parse(context.text.split('\n历史交接数据：\n')[1]) as { partial: boolean; messages: { agentId: string; seqStart: number; role: string; text: string }[] };
  try {
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '当前确认约定：报告用中文' });
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const firstItems = [
      { type: 'user_message', text: '北桥方案已定：先核对输入，不执行外发。' },
      { type: 'reasoning', text: 'HIDDEN-REASONING' },
      { type: 'tool_call', text: 'PRIVATE-TOOL-STATE' },
      { type: 'assistant_message', text: '已核对输入；下一步只制作草案。' },
    ];
    host.history.set(first.agentId, firstItems);
    await host.invoke('bots.create', { id: 'other', name: '其他同事', role: '不参与此聊天' });
    const other = await host.invoke('bots.start', { botId: 'other', title: '独立合成事项', prompt: '仅合成核对' }) as { agentId: string };
    host.history.set(other.agentId, [{ type: 'user_message', text: 'OTHER-BOT-PRIVATE' }]);
    const second = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model' } }) as { agentId: string };
    host.history.set(second.agentId, []);
    const prompt = host.created.find(item => item.agentId === second.agentId)!.config.systemPrompt!;
    assert.match(prompt, /优先使用本轮附件中的交接原文/);
    assert.doesNotMatch(prompt, /首次回复前先用/);
    const before = await new BotStore({ baseDir: host.directory }).getBot('chief');
    const context = await host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }) as { text: string };
    assert.deepEqual(data(context), { partial: false, messages: [
      { agentId: first.agentId, seqStart: 1, seqEnd: 1, role: 'user', text: firstItems[0].text },
      { agentId: first.agentId, seqStart: 4, seqEnd: 4, role: 'assistant', text: firstItems[3].text },
    ] });
    assert.match(context.text, /当前确认约定：报告用中文/);
    assert.doesNotMatch(context.text, /HIDDEN-REASONING|PRIVATE-TOOL-STATE|OTHER-BOT-PRIVATE/);
    assert.deepEqual(await host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }), context, '准备重试不消费交接或写入额外状态');
    assert.deepEqual(await new BotStore({ baseDir: host.directory }).getBot('chief'), before);
    const secondItems = [{ type: 'user_message', text: '新增决定：草案附上核对清单。' }, { type: 'assistant_message', text: '已完成草案，仍未发送。' }];
    host.history.set(second.agentId, secondItems);
    const reads = host.historyReads.length;
    const ongoing = await host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }) as { text: string };
    assert(!ongoing.text.includes('历史交接数据：'), '已有当前分段历史后不重复注入旧原文');
    assert.deepEqual(host.historyReads.slice(reads), [{ agentId: second.agentId, limit: 1 }]);
    const third = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: second.agentId, requestId: randomUUID(), execution: { provider: 'pi/vendor/old' } }) as { agentId: string };
    host.history.set(third.agentId, []);
    const returned = data(await host.invoke('bots.conversation.context', { botId: 'chief', agentId: third.agentId }) as { text: string });
    assert.deepEqual(returned.messages.map(message => message.text), [firstItems[0].text, firstItems[3].text, ...secondItems.map(item => item.text)]);
    assert.deepEqual(returned.messages.map(message => message.agentId), [first.agentId, first.agentId, second.agentId, second.agentId]);
    assert(host.historyReads.every(read => read.agentId !== other.agentId));
    host.created.find(item => item.agentId === third.agentId)!.labels!['paseo-guys.conversation.previous'] = other.agentId;
    const priorReads = host.historyReads.length;
    await assert.rejects(() => host.invoke('bots.conversation.context', { botId: 'chief', agentId: third.agentId }), /关联/);
    assert.equal(host.historyReads.length, priorReads, '归属无效时不读取任何原文');
  } finally { await host.close(); }
});

test('交接按UTF8预算保留完整原文并报告遗漏，原生历史失败不冒充成功', async () => {
  const host = await fixture();
  try {
    const first = await host.invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    const second = await host.invoke('bots.conversation.change', { botId: 'chief', agentId: first.agentId, requestId: randomUUID(), execution: { provider: 'codex/new-model' } }) as { agentId: string };
    host.history.set(second.agentId, []);
    const items = [{ type: 'user_message', text: '最初目标：只制作草案。' }, { type: 'assistant_message', text: '过大原文'.repeat(8000) }, ...Array.from({ length: 20 }, (_, index) => ({ type: index % 2 ? 'assistant_message' : 'user_message', text: `${index}：${'合成材料核对记录'.repeat(100)}` }))];
    host.history.set(first.agentId, items);
    const context = await host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }) as { text: string };
    const block = context.text.slice(context.text.indexOf('\n以下是旧分段的可见对话原文'));
    assert(Buffer.byteLength(block, 'utf8') <= 16_000);
    const handoff = JSON.parse(block.split('\n历史交接数据：\n')[1]) as { partial: boolean; messages: { text: string }[] };
    assert.equal(handoff.partial, true);
    assert(handoff.messages.some(message => message.text === items[0].text));
    assert(handoff.messages.some(message => message.text === items.at(-1)!.text));
    assert(handoff.messages.some(message => message.text === items.at(-2)!.text));
    assert(handoff.messages.every(message => items.some(item => item.text === message.text)), '不生成摘要、不截断原文为半句话');
    assert(!handoff.messages.some(message => message.text === items[1].text));
    host.history.set(first.agentId, Array.from({ length: 60 }, (_, index) => ({ type: 'user_message', text: `短记录${index}` })));
    const paged = await host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }) as { text: string };
    const pageData = JSON.parse(paged.text.split('\n历史交接数据：\n')[1]);
    assert.equal(pageData.partial, true, '原生分页遗漏也必须报告');
    assert.equal(pageData.messages.length, 50);
    host.historyFailures.set(first.agentId, 'synthetic-history-error');
    await assert.rejects(() => host.invoke('bots.conversation.context', { botId: 'chief', agentId: second.agentId }), /无法稳定读取/);
  } finally { await host.close(); }
});

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
    assert.equal(configuration.defaultCwd, join(host.directory, 'v2', 'workspace', 'chief'));
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
    assert.equal(configuration.defaultCwd, join(host.directory, 'v2', 'workspace', 'chief'));
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
