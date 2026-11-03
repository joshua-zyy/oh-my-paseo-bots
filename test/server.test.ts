import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentSendOptions } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';
import { TaskTracker } from '../server/tasks.js';
import { MailOutbox, type GmailClient } from '../server/mail.js';

test('同事页持续聊天复用原生会话，自身子事项完成和定向取消均不关闭聊天', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-conversation-'));
  const previous = process.env.PASEO_GUYS_DATA_DIR;
  process.env.PASEO_GUYS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: unknown) => unknown }>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const created: PaseoAgentCreateOptions[] = [];
  const archived = new Set<string>();
  const messages: { agentId: string; text: string; options?: PaseoAgentSendOptions }[] = [];
  const userMessage = '取消刚刚交办的数字核对';
  const paseo = { workspaces: { create: async (options: { background: boolean }) => {
    assert.equal(options.background, true);
    return { agents: { create: async (input: PaseoAgentCreateOptions) => { created.push(input); return { id: input.agentId!, workspaceId: 'ws-background' }; } } };
  } }, agents: { ref: (agentId: string) => ({
    refresh: async () => {
      const input = created.find(item => item.agentId === agentId);
      return input ? { agent: { id: agentId, title: input.title, status: 'idle', pendingPermissions: [], workspaceId: 'ws-background', archivedAt: archived.has(agentId) ? 'now' : null, labels: { ...input.labels, ...(input.parent ? { 'paseo.parent-agent-id': input.parent } : {}) } } } : null;
    },
    archive: async () => {
      archived.add(agentId);
      await hooks.get('agent.archived')?.({ agent: { id: agentId } }, { paseo });
      return { archivedAt: 'now' };
    },
    send: async (text: string, options?: PaseoAgentSendOptions) => { messages.push({ agentId, text, options }); },
    timeline: { refetch: async () => ({ error: null, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, entries: [{ seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: userMessage } }] }) },
  }) } } as unknown as PaseoApi;
  const server = {
    registerSettings: (definition: { id: string }) => ({ read: async () => ({ status: 'ready', revision: 'ready', values: definition.id === 'office' ? { bots: {} } : { cwd: directory, provider: 'synthetic/model' } }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); }, before: () => () => {},
  } as unknown as PluginServerContext;
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name);
    assert.ok(entry, `RPC ${name} must be registered`);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  }
  const clients: Client[] = [];
  async function connect(agentId: string) {
    const config = created.find(item => item.agentId === agentId)!.config.mcpServers!['paseo-guys'];
    assert.equal(config.type, 'http');
    if (config.type !== 'http') throw new Error('expected HTTP');
    const client = new Client({ name: 'conversation-lifecycle', version: '0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    return client;
  }
  const payload = (result: unknown) => {
    const value = result as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(value.isError, true, value.content[0].text);
    return JSON.parse(value.content[0].text) as { agentId: string; status: string; conversation?: true };
  };
  const cleanup = contribute(server);
  try {
    await invoke('bots.list', {});
    await invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    const conversation = await invoke('bots.conversation.open', { botId: 'chief' }) as { agentId: string };
    const other = await invoke('bots.conversation.open', { botId: 'helper' }) as { agentId: string };
    assert.deepEqual(await invoke('bots.conversation.open', { botId: 'chief' }), conversation);
    assert.deepEqual(await invoke('bots.conversation.open', { botId: 'helper' }), other);
    assert.equal(created.length, 2, '每位 Bot 复用自己持续的原生聊天');
    assert.equal(created[0].prompt, undefined, '打开聊天不发起模型轮次');
    assert.equal(created[0].labels?.['paseo-guys.conversation'], 'true');
    assert.deepEqual(await invoke('bots.reply.stop', { botId: 'chief', agentId: conversation.agentId }), { agentId: conversation.agentId, status: 'idle' });
    assert.match(created[0].config.systemPrompt!, /持续聊天/);
    assert.deepEqual(await invoke('bots.tasks', { botId: 'chief' }), []);
    const client = await connect(conversation.agentId);
    assert.equal(payload(await client.callTool({ name: 'read_task', arguments: {} })).conversation, true);
    assert.equal((await client.callTool({ name: 'complete_task', arguments: { summary: '结束回复', evidence: ['回复'] } })).isError, true);
    const request = { requestId: 'check-1', title: '数字核对', prompt: '核对合成数字，交付 findings.md' };
    const child = payload(await client.callTool({ name: 'start_task', arguments: request }));
    assert.equal(created[2].parent, conversation.agentId);
    assert.equal(created[2].labels?.['paseo-guys.bot'], 'chief');
    assert.equal(created[2].labels?.['paseo-guys.conversation'], undefined);
    const worker = await connect(child.agentId);
    payload(await worker.callTool({ name: 'complete_task', arguments: { summary: '数字已核对', evidence: ['findings.md'] } }));
    assert.equal(archived.has(child.agentId), true);
    assert.equal(archived.has(conversation.agentId), false);
    assert.equal(messages[0].agentId, conversation.agentId);
    assert.match(messages[0].text, /数字已核对/);
    assert.deepEqual(await invoke('bots.conversation.open', { botId: 'chief' }), conversation);
    const next = payload(await client.callTool({ name: 'start_task', arguments: { ...request, requestId: 'check-2' } }));
    assert.equal((await client.callTool({ name: 'cancel_task', arguments: { userQuote: '伪造消息', targetAgentId: next.agentId } })).isError, true);
    assert.equal((await client.callTool({ name: 'cancel_task', arguments: { userQuote: userMessage, targetAgentId: other.agentId } })).isError, true);
    assert.equal((await client.callTool({ name: 'cancel_task', arguments: { userQuote: userMessage } })).isError, true, '取消事项不能关闭当前聊天');
    payload(await client.callTool({ name: 'cancel_task', arguments: { userQuote: userMessage, targetAgentId: next.agentId } }));
    assert.equal(archived.has(next.agentId), true);
    assert.equal(archived.has(conversation.agentId), false);
    assert.match(messages[1].text, /已取消/);
    assert.equal(payload(await client.callTool({ name: 'read_task', arguments: {} })).status, 'active');
    assert.equal((await client.callTool({ name: 'update_colleague', arguments: { patch: { role: '继续核对工作' } } })).isError, undefined);
    assert.deepEqual(await invoke('bots.conversation.open', { botId: 'chief' }), conversation);
    assert.equal((await invoke('bots.tasks', { botId: 'chief' }) as { agentId: string }[]).some(item => item.agentId === conversation.agentId), false);
    await invoke('bots.update', { botId: 'chief', patch: { instructions: '新对话输出精简报告', execution: { provider: 'synthetic/new-model' } } });
    await invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '报告先列结论' });
    const fresh = await invoke('bots.conversation.create', { botId: 'chief' }) as { agentId: string };
    assert.notEqual(fresh.agentId, conversation.agentId);
    assert.deepEqual(await invoke('bots.conversation.open', { botId: 'chief' }), fresh);
    assert.equal(created.at(-1)!.config.provider, 'synthetic/new-model');
    assert.match(created.at(-1)!.config.systemPrompt!, /新对话输出精简报告/);
    assert.match(created.at(-1)!.config.systemPrompt!, /报告先列结论/);
    assert.equal(created.at(-1)!.prompt, undefined, '开新对话不自行发起模型轮次');
    assert.equal(archived.has(conversation.agentId), false, '开新对话不关闭原对话或停止其工作');
    assert.equal((await invoke('bots.tasks', { botId: 'chief' }) as { agentId: string }[]).some(item => item.agentId === fresh.agentId), false);
    const delegated = payload(await client.callTool({ name: 'delegate_to_colleague', arguments: { colleagueId: 'helper', requestId: 'chat-preview', title: '同事核对', prompt: '仅核对合成数据' } }));
    const outbox = new MailOutbox({ baseDir: directory, store: new BotStore({ baseDir: directory }), getClient: async () => ({
      config: { command: 'synthetic', configDir: directory, account: 'sender@example.test', query: 'label:synthetic' },
      buildMail: value => Buffer.from(JSON.stringify(value)).toString('base64url'),
    } as GmailClient) });
    const proposal = { to: ['receiver@example.test'], subject: '合成确认', text: '仅用于离线显示测试' };
    const mainMail = await outbox.propose('chief', conversation.agentId, { ...proposal, requestId: 'main-mail' });
    const colleagueMail = await outbox.propose('helper', delegated.agentId, { ...proposal, requestId: 'colleague-mail' });
    await outbox.propose('helper', other.agentId, { ...proposal, requestId: 'other-mail' });
    const preview = await invoke('bots.conversation.work', { botId: 'chief', agentId: conversation.agentId }) as { entries: { agentId: string; botId: string; status: string; summary?: string }[]; mail: { id: string; botId: string }[] };
    assert.equal(preview.entries.find(item => item.agentId === child.agentId)?.summary, '数字已核对');
    assert.equal(preview.entries.find(item => item.agentId === next.agentId)?.status, 'canceled');
    assert.equal(preview.entries.find(item => item.agentId === delegated.agentId)?.botId, 'helper', '主 Bot 聊天展示实际受托同事的工作');
    assert.equal(preview.entries.some(item => item.agentId === other.agentId), false, '不混入同事无关的持续聊天');
    assert.deepEqual(preview.mail.map(({ id, botId }) => ({ id, botId })), [{ id: mainMail.id, botId: 'chief' }, { id: colleagueMail.id, botId: 'helper' }], '只展示本聊天及受托同事的邮件，保留实际批准归属');
    assert.deepEqual(await invoke('bots.conversation.work', { botId: 'chief', agentId: fresh.agentId }), { entries: [], mail: [] });
    await assert.rejects(() => invoke('bots.conversation.work', { botId: 'helper', agentId: conversation.agentId }), /持续聊天/);
  } finally {
    for (const client of clients) await client.close();
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_GUYS_DATA_DIR; else process.env.PASEO_GUYS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('插件离线接线：无配置不创建；原生创建参数挂载MCP且明确记忆工具可达', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-rpc-'));
  const previous = process.env.PASEO_GUYS_DATA_DIR;
  process.env.PASEO_GUYS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: unknown) => unknown }>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  let configured = false;
  let userMessage = '请记住：后续报告使用中文。';
  const archived: string[] = [];
  const created: PaseoAgentCreateOptions[] = [];
  const paseo = { workspaces: { create: async (options: { source: { path: string } }) => ({ agents: { create: (input: Omit<PaseoAgentCreateOptions, 'cwd'>) => paseo.agents.create({ ...input, cwd: options.source.path }) } }) }, agents: {
    create: async (options: PaseoAgentCreateOptions) => { created.push(options); return { id: options.agentId!, workspaceId: 'ws-configured' }; },
    ref: (id: string) => ({
      archive: async () => { archived.push(id); return { archivedAt: new Date().toISOString() }; },
      refresh: async () => ({ agent: { id, title: '原生事项', workspaceId: 'ws-configured', labels: id === 'grandchild' ? { 'paseo.parent-agent-id': 'child' } : id === 'child' ? { 'paseo.parent-agent-id': created[0].agentId } : { 'paseo-guys.bot': 'chief' } } }),
      timeline: { refetch: async () => ({ error: null, staleCursor: false, gap: false, epoch: 'test-epoch', hasOlder: false, hasNewer: false, startCursor: { epoch: 'test-epoch', seq: 1 }, endCursor: { epoch: 'test-epoch', seq: 1 }, entries: [{ provider: 'pi', timestamp: '2026-11-02T00:00:00Z', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], item: { type: 'user_message', text: userMessage } }] }) },
    }),
  } } as unknown as PaseoApi;
  const server = {
    registerSettings: (definition: { id: string }) => ({ read: async () => definition.id === 'office' ? { status: 'ready', revision: 'o1', values: { bots: {} } } : configured ? { status: 'ready', revision: 'r2', values: { cwd: directory, provider: 'configured/model' } } : { status: 'invalid', revision: 'r1', error: '未配置' } }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
    before: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
  } as unknown as PluginServerContext;
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name)!;
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  }
  const cleanup = contribute(server);
  try {
    assert.deepEqual(await invoke('bots.tools.status', {}), { state: 'idle' });
    assert.ok(handlers.has('bots.routine.create'), '固定入口可登记独立原生例程');
    const seeded = await invoke('bots.list', {}) as { bots: { id: string; name: string }[] };
    assert.deepEqual(seeded.bots.map(bot => bot.id), ['chief'], '首次打开即有固定 Chief，不用手工注册');
    assert.equal(created.length, 0, '创建入口元数据不会自动调用模型');
    const normalWorkspace = { source: { kind: 'directory', path: directory } };
    assert.equal(await hooks.get('workspace.create')!({ request: normalWorkspace }, { paseo }), undefined, '正常 Paseo 工作区不变');
    const botWorkspace = { ...normalWorkspace, agent: { labels: { 'paseo-guys.bot': 'chief' } } };
    assert.deepEqual(await hooks.get('workspace.create')!({ request: botWorkspace }, { paseo }), { ...botWorkspace, background: true });
    const unknownBot = { ...normalWorkspace, agent: { labels: { 'paseo-guys.bot': 'missing' } } };
    assert.equal(await hooks.get('workspace.create')!({ request: unknownBot }, { paseo }), undefined, '未登记标签不能改变正常工作区');
    assert.deepEqual(await invoke('bots.list', {}), seeded, '再次打开沿用同一 Chief');
    await invoke('bots.update', { botId: 'chief', patch: { name: '主 Bot', role: '核对' } });
    await invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '用户明确记忆' });
    const memories = await invoke('bots.memories', { botId: 'chief' }) as { id: string; content: string }[];
    assert.equal(memories[0].content, '用户明确记忆');
    await invoke('bots.memory.correct', { botId: 'chief', memoryId: memories[0].id, content: '纠正后的明确记忆', kind: 'confirmed' });
    assert.deepEqual(await invoke('bots.sessions', { botId: 'chief' }), []);
    await assert.rejects(() => invoke('bots.start', { botId: 'chief', requestId: '8bfe5d9f-f4f1-4ec4-95ef-1626c91f1565', title: '任务', prompt: '工作' }), /Bot 设置无效：未配置/);
    assert.equal(created.length, 0);
    const agent = { id: 'native-agent', workspaceId: 'ws-1', title: '交办事项' };
    const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { 'paseo-guys.bot': 'chief' } } }) }) } } };
    await hooks.get('agent.turn_started')!({ agent, turnId: null }, context);
    await hooks.get('agent.turn_ended')!({ agent, turnId: null, outcome: { kind: 'completed' }, timeline: [] }, context);
    const snapshot = await invoke('bots.journal', { botId: 'chief' }) as { entries: { kind: string; outcome?: string; turnId: string | null }[]; corruptCount: number; total: number };
    const journal = snapshot.entries;
    assert.equal(snapshot.corruptCount, 0);
    assert.equal(snapshot.total, 2);
    assert.deepEqual(journal.map(item => [item.kind, item.outcome, item.turnId]), [['turn_started', undefined, null], ['turn_ended', 'completed', null]]);
    assert.equal(JSON.stringify(journal).includes('task_completed'), false);
    assert.equal((await invoke('bots.tasks', { botId: 'chief' }) as { status: string }[])[0].status, 'active', '原生 completed 仅表示轮次结束');
    const older = await invoke('bots.journal', { botId: 'chief', limit: 1, offset: 1 }) as { entries: { kind: string }[]; offset: number; nextOffset: number | null };
    assert.deepEqual(older.entries.map(item => item.kind), ['turn_started']);
    assert.deepEqual([older.offset, older.nextOffset], [1, null]);
    assert.deepEqual(await invoke('bots.sessions', { botId: 'chief' }), [{ sessionId: 'native-agent', title: '交办事项', workspaceId: 'ws-1' }]);
    configured = true;
    const input = { botId: 'chief', title: '记忆任务', prompt: '请记住：后续报告使用中文。' };
    const started = await invoke('bots.start', input) as { agentId: string; requestId: string };
    assert.deepEqual(await invoke('bots.start', input), started);
    assert.equal(created.length, 1);
    assert.deepEqual(await invoke('bots.tools.status', {}), { state: 'ready' });
    assert.equal(created[0].config.toolPolicy, undefined);
    assert.match(created[0].config.systemPrompt!, /团队固定 Chief/);
    const tools = created[0].config.mcpServers!['paseo-guys'];
    assert.equal(tools.type, 'http');
    if (tools.type !== 'http') throw new Error('expected HTTP tools');
    const client = new Client({ name: 'plugin-contract-test', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
      const catalog = await client.listTools();
      assert.ok(catalog.tools.some(tool => tool.name === 'get_bot_context'), '每次独立例程可读取当前固定身份、记忆和工作约束');
      for (const name of ['correct_memory', 'forget_memory', 'read_bot_history']) assert.ok(catalog.tools.some(tool => tool.name === name), `${name} 通过当前 Bot 工具可达`);
      assert.ok(catalog.tools.some(tool => tool.name === 'propose_mail'));
      assert.equal(catalog.tools.some(tool => /approve|allow_fixed/.test(tool.name)), false);
      const colleague = await client.callTool({ name: 'create_colleague', arguments: { id: 'helper', name: '核对同事', role: '复核资料', instructions: '结论附来源' } });
      assert.equal(colleague.isError, undefined);
      assert.equal(JSON.parse((colleague.content as { text: string }[])[0].text).started, false);
      assert.equal((await client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'helper', patch: { role: '核对原文资料' } } })).isError, undefined);
      assert.equal(created.length, 1, 'HTTP MCP 配置同事不会隐式启动额外原生 Agent');
      const office = await client.callTool({ name: 'office_scope', arguments: {} });
      assert.equal(office.isError, undefined);
      assert.deepEqual(JSON.parse((office.content as { text: string }[])[0].text), { gmail: { configured: false }, feishu: { configured: false, documentIds: [], wikiTokens: [] } });
      const result = await client.callTool({ name: 'remember_explicit', arguments: { content: '后续报告使用中文', userQuote: '请记住：后续报告使用中文。' } });
      assert.equal(result.isError, undefined);
      const saved = await invoke('bots.memories', { botId: 'chief' }) as { id: string; kind: string; content: string }[];
      assert.ok(saved.some(item => item.kind === 'confirmed' && item.content === '后续报告使用中文'));
      const memoryId = saved.find(item => item.content === '后续报告使用中文')!.id;
      userMessage = '请纠正长期记忆：后续报告使用英文。';
      assert.equal((await client.callTool({ name: 'correct_memory', arguments: { memoryId, currentContent: '后续报告使用中文', content: '后续报告使用英文', userQuote: userMessage } })).isError, undefined);
      userMessage = '请遗忘后续报告使用英文这条长期记忆。';
      assert.equal((await client.callTool({ name: 'forget_memory', arguments: { memoryId, currentContent: '后续报告使用英文', userQuote: userMessage } })).isError, undefined);
      assert.deepEqual((await invoke('bots.memories', { botId: 'chief' }) as { content: string }[]).map(item => item.content), ['纠正后的明确记忆']);
      // 专家只靠原生父链关联到事项，不获得根 Bot 的会话绑定或工具凭证。
      const specialist = { id: 'grandchild', parentAgentId: 'child', title: '专家核对', workspaceId: 'ws-expert' };
      await hooks.get('agent.created')!({ agent: specialist }, { paseo });
      await hooks.get('agent.turn_ended')!({ agent: specialist, turnId: 'expert-turn', outcome: { kind: 'canceled', reason: 'Interrupted' } }, { paseo });
      const tasks = await invoke('bots.tasks', { botId: 'chief' }) as { agentId: string; status: string; specialists: string[] }[];
      assert.deepEqual(tasks.find(task => task.agentId === started.agentId)?.specialists, ['grandchild']);
      assert.equal(tasks.find(task => task.agentId === started.agentId)?.status, 'active', '自由 canceled.reason 不取消整个事项');
      assert.equal((await invoke('bots.sessions', { botId: 'chief' }) as { sessionId: string }[]).some(item => item.sessionId === 'grandchild'), false);
      assert.equal((await client.callTool({ name: 'cancel_task', arguments: { userQuote: '伪造取消' } })).isError, true);
      assert.equal(archived.length, 0);
      userMessage = '取消这个事项，不再继续跟进。';
      const canceled = await client.callTool({ name: 'cancel_task', arguments: { userQuote: userMessage } });
      assert.equal(canceled.isError, undefined);
      assert.deepEqual(archived, [started.agentId]);
      assert.equal((await client.callTool({ name: 'propose_mail', arguments: { requestId: 'after-stop', to: ['test@example.com'], subject: '测试', text: '停止后不得提案' } })).isError, true);
      assert.equal((await client.callTool({ name: 'create_followup', arguments: { name: '继续', prompt: '继续推进', cron: '0 9 * * *', timezone: 'Asia/Shanghai' } })).isError, true);
      for (const name of ['propose_memory', 'remember_explicit', 'correct_memory', 'forget_memory']) {
        assert.equal((await client.callTool({ name, arguments: { memoryId, currentContent: '后续报告使用英文', content: '取消', userQuote: userMessage } })).isError, true, `${name} 不允许终态事项继续写记忆`);
      }
      assert.equal((await client.callTool({ name: 'read_bot_history', arguments: { agentId: started.agentId } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'read_bot_history', arguments: { agentId: specialist.id } })).isError, true);
      const history = await invoke('bots.history', { botId: 'chief', agentId: started.agentId }) as { entries: { item: { text: string } }[] };
      assert.equal(history.entries[0].item.text, userMessage);
      assert.equal((await invoke('bots.tasks', { botId: 'chief' }) as { agentId: string; status: string }[]).find(task => task.agentId === started.agentId)?.status, 'canceled');
      assert.equal(created.length, 1, '终态历史查询不重新派发');
    } finally { await client.close(); }
    await invoke('bots.creation.acknowledge', { botId: 'chief', requestId: started.requestId });
    assert.deepEqual(await invoke('bots.creations.pending', { botId: 'chief' }), []);
    const next = await invoke('bots.start', { botId: 'chief', title: '独立事项', prompt: '交付 report.md 并核对' }) as { agentId: string };
    const nextTools = created[1].config.mcpServers!['paseo-guys'];
    if (nextTools.type !== 'http') throw new Error('expected HTTP tools');
    const finisher = new Client({ name: 'finish-contract-test', version: '0' });
    try {
      await finisher.connect(new StreamableHTTPClientTransport(new URL(nextTools.url), { requestInit: { headers: nextTools.headers } }));
      assert.equal((await finisher.callTool({ name: 'complete_task', arguments: { summary: '仅轮次结束', evidence: [] } })).isError, true);
      assert.equal(archived.length, 1);
      assert.equal((await finisher.callTool({ name: 'complete_task', arguments: { summary: '已核对交付物', evidence: ['report.md'] } })).isError, undefined);
      assert.deepEqual(archived, [started.agentId, next.agentId]);
      const finished = (await invoke('bots.tasks', { botId: 'chief' }) as { agentId: string; status: string; evidence: string[] }[]).find(task => task.agentId === next.agentId)!;
      assert.equal(finished.status, 'completed');
      assert.deepEqual(finished.evidence, ['report.md']);
    } finally { await finisher.close(); }
  } finally {
    await cleanup();
    assert.equal(hooks.size, 0);
    if (previous === undefined) delete process.env.PASEO_GUYS_DATA_DIR;
    else process.env.PASEO_GUYS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('恢复会话时原生回查、Bot 存档或 MCP 预热失败只报告错误，不阻断打开', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-open-'));
  const previous = process.env.PASEO_GUYS_DATA_DIR;
  process.env.PASEO_GUYS_DATA_DIR = directory;
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const server = {
    registerSettings: () => ({}),
    handle: (contract: PluginRpcContract, handler: (input: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
    before: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  try {
    const event = { request: { agentId: 'existing-agent' } };
    let failure: Error | undefined = new Error('原生回查不可达');
    const context = { paseo: { agents: { ref: () => ({ refresh: async () => {
      if (failure) throw failure;
      return { agent: { labels: { 'paseo-guys.bot': 'chief' } } };
    } }) } } };
    const open = () => hooks.get('agent.session_open')!(event, context);
    await assert.doesNotReject(open);
    failure = undefined;
    await handlers.get('bots.create')!({ id: 'chief', name: '主 Bot', role: '核对' });
    // 存档有效但未关联此 Agent，mount 拒绝；仍可打开原生会话。
    await assert.doesNotReject(open);
    await writeFile(join(directory, 'chief.json'), '{broken');
    await assert.doesNotReject(open);
    assert.equal(errors.length, 3);
    assert.ok(errors.every(args => String(args[0]).includes('existing-agent')));
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_GUYS_DATA_DIR;
    else process.env.PASEO_GUYS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('固定同事贯穿接线：目录、接收方身份记忆、原生父项和重复委派结果保持关联', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-colleagues-'));
  const previous = process.env.PASEO_GUYS_DATA_DIR;
  process.env.PASEO_GUYS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: unknown) => unknown }>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const created: PaseoAgentCreateOptions[] = [];
  const opened: string[] = [];
  const nativeEvents: { kind: 'send' | 'archive'; agentId: string; text?: string; options?: PaseoAgentSendOptions }[] = [];
  const failureMessages: { agentId: string; text: string; options?: PaseoAgentSendOptions }[] = [];
  const createNative = async (options: PaseoAgentCreateOptions, workspaceCwd?: string) => {
    // 实机已证实：未显式放置的子 Agent 会继承父 workspace，cwd 参数不改变归属。
    const parent = created.find(item => item.agentId === options.parent);
    created.push({ ...options, cwd: workspaceCwd ?? parent?.cwd ?? options.cwd });
    return { id: options.agentId!, workspaceId: 'ws-team' };
  };
  const paseo = { workspaces: { create: async (options: { source: { path: string } }) => {
    const cwd = options.source.path;
    opened.push(cwd);
    return { agents: { create: (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => createNative({ ...options, cwd }, cwd) } };
  } }, agents: {
    create: createNative,
    ref: (id: string) => ({
      send: async (text: string, options?: PaseoAgentSendOptions) => {
        if (text.includes('原生轮次失败')) {
          failureMessages.push({ agentId: id, text, options });
          return;
        }
        nativeEvents.push({ kind: 'send', agentId: id, text, options });
        const tasks = await invoke('bots.tasks', { botId: 'researcher' }) as { agentId: string; status: string; evidence: string[] }[];
        const report = tasks.find(task => task.agentId === options?.sourceAgentId)!;
        assert.equal(report.status, 'stopping', '回报前已保存交付，当前子 Agent 尚未归档');
        assert.deepEqual(report.evidence, ['findings.md']);
      },
      archive: async () => { nativeEvents.push({ kind: 'archive', agentId: id }); return { archivedAt: 'now' }; },
      refresh: async () => {
        const options = created.find(item => item.agentId === id);
        return options ? { agent: { id, title: options.title, workspaceId: 'ws-team', labels: { ...options.labels, ...(options.parent ? { 'paseo.parent-agent-id': options.parent } : {}) } } } : null;
      },
    }),
  } } as unknown as PaseoApi;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: 'ready', revision: 'r1', values: { cwd: directory, provider: 'configured/model', modeId: 'host-mode', thinkingOptionId: 'host-thinking' } }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
    before: () => () => {},
  } as unknown as PluginServerContext;
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name)!;
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  }
  const payload = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const client = new Client({ name: 'fixed-chief', version: '0' });
  const childClient = new Client({ name: 'fixed-colleague', version: '0' });
  const cleanup = contribute(server);
  try {
    const rootSkill = join(directory, 'root-skill', 'SKILL.md');
    const readerSkill = join(directory, 'reader-skill', 'SKILL.md');
    await mkdir(join(directory, 'root-skill')); await mkdir(join(directory, 'reader-skill'));
    await writeFile(rootSkill, '---\nname: chief-check\ndescription: Chief 合成技能\n---\nROOT-SKILL-BODY-ONLY');
    await writeFile(readerSkill, '---\nname: reader-check\ndescription: 资料合成技能\n---\nREADER-SKILL-BODY-ONLY');
    const rootServer = { type: 'http', url: 'http://127.0.0.1:31911/synthetic', headers: { Authorization: 'SYNTHETIC-ROOT-TRANSPORT-SECRET' } };
    const readerServer = { type: 'stdio', command: 'synthetic-reader', args: ['--fixture'], env: { SYNTHETIC_ONLY: 'READER-TRANSPORT-SECRET' }, alwaysLoad: true };
    await invoke('bots.create', { id: 'chief', name: '主 Bot', role: '协调交付', instructions: 'Chief 专用说明', execution: { provider: 'chief-provider/model', cwd: join(directory, 'chief'), modeId: 'chief-mode', thinkingOptionId: 'chief-thinking' }, capabilities: { skills: [{ name: 'chief-check', description: 'Chief 合成技能', path: rootSkill }], mcpServers: { 'chief-helper': rootServer } } });
    await invoke('bots.create', { id: 'researcher', name: '资料同事', role: '核对资料', instructions: '资料同事专用说明', execution: { provider: 'research-provider/model', cwd: join(directory, 'researcher') }, capabilities: { skills: [{ name: 'reader-check', description: '资料合成技能', path: readerSkill }], mcpServers: { 'reader-helper': readerServer } } });
    await invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '主 Bot 的无关记忆' });
    await invoke('bots.memory.save', { botId: 'researcher', kind: 'confirmed', content: '结论必须附资料来源' });
    const root = await invoke('bots.start', { botId: 'chief', title: '整理合成资料', prompt: '请分工核对指定资料并形成报告' }) as { agentId: string };
    assert.equal(created[0].cwd, join(directory, 'chief'));
    assert.equal(created[0].config.provider, 'chief-provider/model');
    assert.equal(created[0].config.modeId, 'chief-mode');
    assert.equal(created[0].config.thinkingOptionId, 'chief-thinking');
    assert.match(created[0].config.systemPrompt!, /Chief 专用说明/);
    assert.deepEqual(created[0].config.mcpServers!['chief-helper'], rootServer);
    assert.equal(created[0].config.mcpServers!['reader-helper'], undefined);
    assert.match(created[0].config.systemPrompt!, /chief-check/);
    assert.doesNotMatch(created[0].config.systemPrompt!, /reader-check|TRANSPORT-SECRET|SKILL-BODY-ONLY/);
    const tools = created[0].config.mcpServers!['paseo-guys'];
    if (tools.type !== 'http') throw new Error('expected HTTP tools');
    await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
    const directoryResult = await client.callTool({ name: 'list_colleagues', arguments: {} });
    assert.deepEqual(payload(directoryResult), [{ id: 'researcher', name: '资料同事', role: '核对资料' }]);
    const request = { colleagueId: 'researcher', requestId: 'source-check', title: '核对资料来源', prompt: '只核对指定合成资料，交付 findings.md 并注明来源' };
    const delegated = await client.callTool({ name: 'delegate_to_colleague', arguments: request });
    assert.equal(delegated.isError, undefined);
    const child = payload(delegated) as { agentId: string; requestId: string };
    assert.deepEqual(payload(await client.callTool({ name: 'delegate_to_colleague', arguments: request })), child);
    assert.deepEqual(payload(await client.callTool({ name: 'delegate_to_colleague', arguments: { ...request, requestId: 'same-work-another-key' } })), child, '同一未结工作复用时返回有效的原始请求键');
    assert.equal(created.length, 2, '相同委派不新建第三个原生会话');
    assert.equal(created[1].parent, root.agentId);
    assert.equal(created[1].cwd, join(directory, 'researcher'));
    assert.deepEqual(opened, [join(directory, 'chief'), join(directory, 'researcher')], '根 Bot 和接收方各自显式选择后台工作区，保留原生 parent');
    assert.equal(created[1].config.provider, 'research-provider/model');
    assert.equal(created[1].config.modeId, undefined, '模型改选后不套用另一模型的宿主模式');
    assert.equal(created[1].config.thinkingOptionId, undefined);
    assert.deepEqual(created[1].config.mcpServers!['reader-helper'], readerServer);
    assert.equal(created[1].config.mcpServers!['chief-helper'], undefined);
    assert.match(created[1].config.systemPrompt!, /reader-check/);
    assert.doesNotMatch(created[1].config.systemPrompt!, /chief-check|TRANSPORT-SECRET|SKILL-BODY-ONLY/);
    assert.match(created[1].config.systemPrompt!, /资料同事专用说明/);
    assert.match(created[1].config.systemPrompt!, /只修改自己/);
    assert.doesNotMatch(created[1].config.systemPrompt!, /团队固定 Chief/);
    assert.doesNotMatch(created[1].config.systemPrompt!, /Chief 专用说明/);
    assert.equal(created[1].labels?.['paseo-guys.bot'], 'researcher');
    assert.match(created[1].config.systemPrompt!, /资料同事|结论必须附资料来源/);
    assert.doesNotMatch(created[1].config.systemPrompt!, /主 Bot 的无关记忆/);
    const childTools = created[1].config.mcpServers!['paseo-guys'];
    if (childTools.type !== 'http') throw new Error('expected HTTP tools');
    assert.notEqual(childTools.url, tools.url);
    await childClient.connect(new StreamableHTTPClientTransport(new URL(childTools.url), { requestInit: { headers: childTools.headers } }));
    const ownMemories = payload(await childClient.callTool({ name: 'read_memories', arguments: {} }));
    assert.deepEqual(ownMemories.memories.map((item: { content: string }) => item.content), ['结论必须附资料来源']);
    await hooks.get('agent.created')!({ agent: { id: child.agentId, parentAgentId: root.agentId, title: request.title, workspaceId: 'ws-team' } }, { paseo });
    const rootTask = payload(await client.callTool({ name: 'read_task', arguments: {} }));
    assert.deepEqual(rootTask.specialists, [child.agentId]);
    assert.equal(rootTask.status, 'active', '委派启动不等于主事项完成');
    assert.equal(payload(await childClient.callTool({ name: 'read_task', arguments: {} })).status, 'active');
    const failedTurn = { agent: { id: child.agentId, parentAgentId: root.agentId, title: request.title, workspaceId: 'ws-team' }, turnId: 'failed-turn', outcome: { kind: 'failed', error: { message: 'synthetic provider failure' } }, timeline: [] };
    await hooks.get('agent.turn_ended')!(failedTurn, { paseo });
    assert.equal(failureMessages.length, 1, '同事原生轮次失败须回报 Chief，而非只记日志');
    assert.equal(failureMessages[0].agentId, root.agentId);
    assert.deepEqual(failureMessages[0].options, { sourceAgentId: child.agentId, activeTurnBehavior: 'steer', messageId: `paseo-guys:failure:${child.agentId}:failed-turn` });
    assert.match(failureMessages[0].text, new RegExp(child.agentId));
    assert.match(failureMessages[0].text, /未完成|未保存.*交付/);
    assert.doesNotMatch(failureMessages[0].text, /主 Bot 的无关记忆|TRANSPORT-SECRET|synthetic provider failure/);
    assert.equal(payload(await client.callTool({ name: 'read_task', arguments: {} })).status, 'active');
    assert.equal(payload(await childClient.callTool({ name: 'read_task', arguments: {} })).status, 'active');
    assert.equal(nativeEvents.length, 0, '失败回报不归档或重新执行');
    assert.equal(created.length, 2, '失败回报不重新派发');
    await hooks.get('agent.turn_ended')!({ ...failedTurn, turnId: null }, { paseo });
    assert.deepEqual(failureMessages[1].options, { sourceAgentId: child.agentId, activeTurnBehavior: 'steer' }, '宿主无 turnId 时不复用跨轮次的固定消息键');
    await hooks.get('agent.turn_ended')!({ ...failedTurn, outcome: { kind: 'completed' } }, { paseo });
    await hooks.get('agent.turn_ended')!({ ...failedTurn, outcome: { kind: 'canceled', reason: 'native turn interrupted' } }, { paseo });
    assert.equal(failureMessages.length, 2, '单轮完成或取消不被当作事项失败回报');
    const rootSessions = await invoke('bots.sessions', { botId: 'chief' }) as { sessionId: string }[];
    assert.deepEqual(rootSessions.map(item => item.sessionId), [root.agentId]);
    const childSessions = await invoke('bots.sessions', { botId: 'researcher' }) as { sessionId: string }[];
    assert.deepEqual(childSessions.map(item => item.sessionId), [child.agentId]);
    assert.equal(typeof hooks.get('agent.archived'), 'function');
    await hooks.get('agent.archived')!({ agent: { id: child.agentId }, archivedAt: new Date().toISOString() }, { paseo });
    assert.equal(payload(await childClient.callTool({ name: 'read_task', arguments: {} })).status, 'canceled', '同事被原生归档后不能继续显示进行中');
    await hooks.get('agent.turn_ended')!({ ...failedTurn, turnId: 'late-failure' }, { paseo });
    assert.equal(failureMessages.length, 2, '已停止的子事项不因迟到失败观察重新推进 Chief');
    assert.equal((await childClient.callTool({ name: 'create_followup', arguments: { name: '继续', prompt: '继续', cron: '* * * * *', timezone: 'Asia/Shanghai' } })).isError, true);
    assert.equal(payload(await client.callTool({ name: 'read_task', arguments: {} })).status, 'active', '单独归档同事不自动完成 Chief 的事项');
    const updated = await invoke('bots.update', { botId: 'researcher', patch: { instructions: '更新后的资料同事说明', execution: {} } }) as { updatedAt: string };
    assert.match(updated.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const listed = await invoke('bots.list', {}) as { bots: { id: string; instructions: string; execution: object }[] };
    assert.deepEqual(listed.bots.find(bot => bot.id === 'researcher')?.execution, {});
    const next = payload(await client.callTool({ name: 'delegate_to_colleague', arguments: { ...request, requestId: 'new-work-after-finish' } }));
    assert.notEqual(next.agentId, child.agentId, '同事已结束后，明确的新请求可再次交办同样的工作');
    assert.equal(created.length, 3);
    assert.equal(created[2].cwd, directory);
    assert.equal(created[2].config.provider, 'configured/model');
    assert.equal(created[2].config.modeId, 'host-mode');
    assert.equal(created[2].config.thinkingOptionId, 'host-thinking');
    assert.match(created[2].config.systemPrompt!, /更新后的资料同事说明/);
    assert.equal(created[1].config.provider, 'research-provider/model', '编辑只作用于新会话');
    const deliveryTools = created[2].config.mcpServers!['paseo-guys'];
    if (deliveryTools.type !== 'http') throw new Error('expected HTTP tools');
    const deliveryClient = new Client({ name: 'colleague-delivery', version: '0' });
    try {
      await deliveryClient.connect(new StreamableHTTPClientTransport(new URL(deliveryTools.url), { requestInit: { headers: deliveryTools.headers } }));
      const report = { summary: '资料已核对并写入 findings.md', evidence: ['findings.md'] };
      const result = await deliveryClient.callTool({ name: 'complete_task', arguments: report });
      assert.equal(result.isError, undefined);
      assert.equal(payload(result).status, 'completed');
      assert.deepEqual(nativeEvents.map(({ kind, agentId }) => ({ kind, agentId })), [
        { kind: 'send', agentId: root.agentId }, { kind: 'archive', agentId: next.agentId },
      ], '固定同事的实际交付先通过原生通信回报 Chief，再归档');
      assert.deepEqual(nativeEvents[0].options, { sourceAgentId: next.agentId, activeTurnBehavior: 'steer', messageId: `paseo-guys:delivery:${next.agentId}` });
      const returned = JSON.parse(nativeEvents[0].text!.split('\n')[1]);
      assert.deepEqual(returned, { agentId: next.agentId, title: request.title, ...report });
      assert.doesNotMatch(nativeEvents[0].text!, /主 Bot 的无关记忆|TRANSPORT-SECRET|SKILL-BODY-ONLY/);
      assert.equal(payload(await client.callTool({ name: 'read_task', arguments: {} })).status, 'active', '子交付回报不自动完成 Chief 事项');
      await deliveryClient.callTool({ name: 'complete_task', arguments: report });
      assert.equal(nativeEvents.length, 2, '重复完成不重复回报或归档');
      assert.equal(created.length, 3, '回报沿用原生通信，不创建新执行 Agent');
    } finally { await deliveryClient.close(); }
    const pending = payload(await client.callTool({ name: 'delegate_to_colleague', arguments: { ...request, requestId: 'pending-during-parent-stop', title: '父事项取消时尚未交付' } }));
    // Simulate a persisted native routine parent, which has schedule labels rather than a Bot label.
    const routineId = randomUUID();
    const persistedTasks = new TaskTracker({ baseDir: directory, store: new BotStore({ baseDir: directory }), cli: { command: '', cwd: directory }, getPaseo: () => paseo });
    await persistedTasks.ensure('chief', root.agentId, { title: '例程主事项', routine: { id: routineId, runId: randomUUID(), prompt: '合成例程核对' } });
    await mkdir(join(directory, 'routines'), { recursive: true });
    await writeFile(join(directory, 'routines', 'state.json'), JSON.stringify({ schemaVersion: 1, routines: [{ id: routineId, botId: 'chief', name: '合成例程', prompt: '合成例程核对', cron: '* * * * *', timezone: 'UTC', continuity: false, execution: { provider: 'configured/model', cwd: directory }, state: 'ready', nativeId: 'synthetic-schedule' }] }));
    delete created[0].labels!['paseo-guys.bot'];
    created[0].labels!['paseo.schedule-id'] = 'synthetic-schedule';
    await hooks.get('agent.turn_ended')!({ ...failedTurn, agent: { ...failedTurn.agent, id: pending.agentId }, turnId: 'routine-parent-failure' }, { paseo });
    assert.equal(failureMessages.length, 3, '无 Bot 标签的例程父事项仍收到固定同事失败回报');
    assert.equal(failureMessages[2].agentId, root.agentId);
    await invoke('bots.task.cancel', { botId: 'chief', agentId: root.agentId });
    await hooks.get('agent.turn_ended')!({ ...failedTurn, agent: { ...failedTurn.agent, id: pending.agentId }, turnId: 'failure-after-parent-stop' }, { paseo });
    assert.equal(failureMessages.length, 3, '父事项已停止时不能被失败观察唤醒');
  } finally {
    await client.close(); await childClient.close(); await cleanup();
    if (previous === undefined) delete process.env.PASEO_GUYS_DATA_DIR; else process.env.PASEO_GUYS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
