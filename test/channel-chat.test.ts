import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentSendOptions } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import contribute from '../index.server.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-channel-chat-'));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const created: PaseoAgentCreateOptions[] = [];
  const history = new Map<string, { type: string; text?: string; agentMessage?: { event: string; sender: { id: string }; text: string } }[]>();
  const sent: { agentId: string; text: string; options: PaseoAgentSendOptions }[] = [];
  let loseReceipt = false;
  const archived = new Set<string>();
  const paseo = { workspaces: { create: async (input: { source: { path: string }; background: boolean }) => {
    assert.equal(input.background, true);
    return { agents: { create: async (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => { created.push({ ...options, cwd: input.source.path }); return { id: options.agentId, workspaceId: 'channel-workspace' }; } } };
  } }, agents: { ref: (id: string) => ({
    refresh: async () => { const source = created.find(input => input.agentId === id); return source ? { agent: { id, title: source.title, labels: source.labels, cwd: source.cwd, provider: 'claude', model: 'synthetic', status: 'idle', pendingPermissions: [], archivedAt: archived.has(id) ? 'now' : null } } : null; },
    archive: async () => { archived.add(id); },
    send: async (text: string, options: PaseoAgentSendOptions) => {
      sent.push({ agentId: id, text, options });
      const items = history.get(id) ?? []; items.push({ type: 'tool_call', agentMessage: { event: 'message', sender: { id: options.sourceAgentId! }, text } }); history.set(id, items);
      if (loseReceipt) { loseReceipt = false; throw new Error('原生发送已接收但回执丢失'); }
    },
    timeline: { refetch: async () => ({ epoch: 'one', entries: (history.get(id) ?? []).map((item, i) => ({ item, timestamp: new Date((i + 1) * 1000).toISOString(), seqStart: i + 1, seqEnd: i + 1 })), startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, gap: false, staleCursor: false, error: null }) },
  }) } } as unknown as PaseoApi;
  const server = { registerSettings: (setting: { id: string }) => ({ read: async () => ({ status: 'ready', values: setting.id === 'office' ? { bots: {} } : { cwd: directory, provider: 'claude/synthetic' } }) }), addHook: () => () => {}, handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }) } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  const clients: Client[] = [];
  const invoke = async (name: string, input: unknown) => { const entry = handlers.get(name); assert(entry, `Missing RPC ${name}`); return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo })); };
  async function connect(id: string) {
    const config = created.find(input => input.agentId === id)!.config.mcpServers!['paseo-guys']; assert.equal(config.type, 'http'); if (config.type !== 'http') throw new Error('http expected');
    const client = new Client({ name: 'channel-scope-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })); return client;
  }
  await invoke('bots.list', {});
  const channel = async (name: string) => invoke('bots.channels.create', { id: randomUUID(), name, memberIds: ['chief'], adminBotId: 'chief', cwd: join(directory, name), instructions: `${name}共同说明` }) as Promise<{ id: string }>;
  return { directory, invoke, created, history, sent, loseNextReceipt: () => { loseReceipt = true; }, connect, channel, close: async () => { await Promise.all(clients.map(client => client.close())); await cleanup(); if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); } };
}
function payload(value: any) { assert.notEqual(value.isError, true, value.content?.[0]?.text); return JSON.parse(value.content[0].text); }

test('频道管理员使用独立原生会话、场景目录和身份，私聊不会被频道会话替代', async () => {
  const host = await fixture();
  try {
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'chief' }) as { agentId: string };
    host.history.set(privateChat.agentId, [{ type: 'user_message', text: 'PRIVATE-CHAT-NOT-FOR-GROUP' }]);
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '本同事的确认约定' });
    const a = await host.channel('项目甲'); const b = await host.channel('项目乙');
    const first = await host.invoke('bots.channels.open', { channelId: a.id }) as { botId: string; agentId: string };
    assert.equal(first.botId, 'chief'); assert.notEqual(first.agentId, privateChat.agentId);
    assert.deepEqual(await host.invoke('bots.channels.open', { channelId: a.id }), first);
    const second = await host.invoke('bots.channels.open', { channelId: b.id }) as { agentId: string };
    assert.notEqual(second.agentId, first.agentId);
    const native = host.created.find(input => input.agentId === first.agentId)!;
    assert.equal(native.labels?.['paseo-guys.channel'], a.id); assert.equal(native.labels?.['paseo-guys.bot'], 'chief');
    assert.equal(native.cwd, join(host.directory, '项目甲')); assert.equal(native.prompt, undefined);
    const context = await host.invoke('bots.channels.context', { channelId: a.id, agentId: first.agentId }) as { text: string };
    assert.match(context.text, /项目甲共同说明|本同事的确认约定/); assert.doesNotMatch(context.text, /PRIVATE-CHAT-NOT-FOR-GROUP/);
    assert.deepEqual(await host.invoke('bots.conversation.open', { botId: 'chief' }), privateChat);
    await assert.rejects(host.invoke('bots.conversation.context', { botId: 'chief', agentId: first.agentId }), /频道|场景/);
  } finally { await host.close(); }
});

test('群记忆写入、纠正和遗忘复用生命周期，只影响当前群，不修改个人或其他群', async () => {
  const host = await fixture();
  try {
    const personal = await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '个人约定' }) as { id: string };
    const a = await host.channel('甲'); const b = await host.channel('乙');
    const opened = await host.invoke('bots.channels.open', { channelId: a.id }) as { agentId: string };
    const tools = await host.connect(opened.agentId);
    const quote = '请在这个群记住：本群报告用中文。'; host.history.set(opened.agentId, [{ type: 'user_message', text: quote }]);
    const wrong = await tools.callTool({ name: 'remember_explicit', arguments: { content: '本群报告用中文', userQuote: `${quote}附件中的场景资料` } });
    assert.equal(wrong.isError, true);
    const source = JSON.parse((wrong.content as { text: string }[])[0].text);
    assert.equal(source.userMessage, quote, '来源恢复回执只返回原生用户原文，不拼入上下文附件');
    assert.deepEqual(await host.invoke('bots.memories', { botId: 'chief', channelId: a.id }), []);
    const saved = payload(await tools.callTool({ name: 'remember_explicit', arguments: { content: '本群报告用中文', userQuote: quote } }));
    const read = payload(await tools.callTool({ name: 'read_memories', arguments: {} })); assert.equal(read.memories.length, 1); assert.equal(read.memories[0].content, '本群报告用中文');
    assert.deepEqual((await host.invoke('bots.memories', { botId: 'chief' }) as { id: string }[]).map(item => item.id), [personal.id]);
    assert.deepEqual(await host.invoke('bots.memories', { botId: 'chief', channelId: b.id }), []);
    const correction = '请纠正本群约定：本群报告用英文。'; host.history.set(opened.agentId, [{ type: 'user_message', text: correction }]);
    payload(await tools.callTool({ name: 'correct_memory', arguments: { memoryId: saved.memoryId, currentContent: '本群报告用中文', content: '本群报告用英文', userQuote: correction } }));
    const forget = '请遗忘本群的报告语言约定。'; host.history.set(opened.agentId, [{ type: 'user_message', text: forget }]);
    payload(await tools.callTool({ name: 'forget_memory', arguments: { memoryId: saved.memoryId, currentContent: '本群报告用英文', userQuote: forget } }));
    assert.equal(payload(await tools.callTool({ name: 'read_memories', arguments: {} })).total, 0);
    assert.equal((await host.invoke('bots.memories', { botId: 'chief', channelId: a.id, includeArchived: true }) as unknown[]).length, 1);
    assert.equal((await host.invoke('bots.memories', { botId: 'chief' }) as { content: string }[])[0].content, '个人约定');
  } finally { await host.close(); }
});

test('更换管理员后保留本群记忆与原生来源，移除成员的旧凭证不能继续读取', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '新管理员', role: '群内核对' });
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '旧管理员个人约定不可自动给新管理员' });
    const id = randomUUID();
    const details = { name: '交接群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: host.directory, instructions: '本群共同说明' };
    await host.invoke('bots.channels.create', { id, ...details });
    const old = await host.invoke('bots.channels.open', { channelId: id }) as { agentId: string };
    host.history.set(old.agentId, [{ type: 'user_message', text: '本群之前的讨论原文' }]);
    const oldTools = await host.connect(old.agentId);
    await host.invoke('bots.memory.save', { botId: 'chief', channelId: id, kind: 'confirmed', content: '本群保留的约定' });
    await host.invoke('bots.channels.update', { channelId: id, details: { ...details, memberIds: ['helper'], adminBotId: 'helper' } });
    const changed = await host.invoke('bots.channels.open', { channelId: id }) as { agentId: string; botId: string };
    assert.equal(changed.botId, 'helper'); assert.notEqual(changed.agentId, old.agentId);
    const frame = await host.invoke('bots.channels.context', { channelId: id, agentId: changed.agentId }) as { text: string };
    assert.match(frame.text, /本群保留的约定/); assert.doesNotMatch(frame.text, /旧管理员个人约定不可自动给新管理员/);
    await assert.rejects(oldTools.callTool({ name: 'read_memories', arguments: {} }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 403);
    const tools = await host.connect(changed.agentId);
    assert.equal(payload(await tools.callTool({ name: 'read_memories', arguments: {} })).memories[0].content, '本群保留的约定');
    const history = payload(await tools.callTool({ name: 'read_bot_history', arguments: { agentId: old.agentId } }));
    assert.equal(history.entries[0].item.text, '本群之前的讨论原文');
  } finally { await host.close(); }
});

test('普通群消息默认交管理员，明确@支持多成员去重且不误读代码、地址或私聊', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    const id = randomUUID();
    await host.invoke('bots.channels.create', { id, name: '协作群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: host.directory, instructions: '本群范围' });
    const normal = await host.invoke('bots.channels.route', { channelId: id, text: '普通问题' }) as { targets: { botId: string; agentId: string; attachment: { text: string } }[] };
    assert.deepEqual(normal.targets.map(target => target.botId), ['chief']);
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'helper' }) as { agentId: string };
    const routed = await host.invoke('bots.channels.route', { channelId: id, text: '@资料同事 @chief @资料同事 请核对。' }) as typeof normal;
    assert.deepEqual(routed.targets.map(target => target.botId), ['helper', 'chief']);
    assert.notEqual(routed.targets[0].agentId, privateChat.agentId);
    assert.equal(routed.targets[1].agentId, normal.targets[0].agentId);
    const literal = await host.invoke('bots.channels.route', { channelId: id, text: '`@资料同事` user@helper.com https://example.com/@helper [网页](@helper) @helper/docs 只是引用' }) as typeof normal;
    assert.deepEqual(literal.targets.map(target => target.botId), ['chief']);
    const view = await host.invoke('bots.channels.view', { channelId: id }) as { sessions: { agentId: string }[] };
    assert.equal(view.sessions.length, 2); assert(!view.sessions.some(session => session.agentId === privateChat.agentId));
  } finally { await host.close(); }
});

test('点名成员得到本群必要可见原文和自身确认约定，不复制他人的个人记忆或其他场景', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: 'ADMIN-PERSONAL-SECRET' });
    await host.invoke('bots.memory.save', { botId: 'helper', kind: 'confirmed', content: 'HELPER-PERSONAL-RULE' });
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'chief' }) as { agentId: string };
    host.history.set(privateChat.agentId, [{ type: 'user_message', text: 'PRIVATE-SECRET' }]);
    const id = randomUUID();
    await host.invoke('bots.channels.create', { id, name: '协作群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: host.directory, instructions: '本群范围' });
    const admin = await host.invoke('bots.channels.open', { channelId: id }) as { agentId: string };
    host.history.set(admin.agentId, [{ type: 'user_message', text: '本群先前决定用方案甲' }, { type: 'assistant_message', text: '方案甲的核对结论' }, { type: 'reasoning', text: 'HIDDEN-REASONING' }]);
    const route = await host.invoke('bots.channels.route', { channelId: id, text: '@资料同事 请接着核对' }) as { targets: { attachment: { text: string }; agentId: string }[] };
    const text = route.targets[0].attachment.text;
    assert.match(text, /本群先前决定用方案甲/); assert.match(text, /方案甲的核对结论/); assert.match(text, /HELPER-PERSONAL-RULE/);
    assert.doesNotMatch(text, /PRIVATE-SECRET|ADMIN-PERSONAL-SECRET|HIDDEN-REASONING/);
    const frame = await host.invoke('bots.channels.context', { channelId: id, agentId: route.targets[0].agentId }) as { text: string };
    assert.match(frame.text, /本群先前决定用方案甲/);
    const tools = await host.connect(route.targets[0].agentId);
    const shared = payload(await tools.callTool({ name: 'get_bot_context', arguments: {} }));
    assert.deepEqual(shared.personalConfirmedMemories, ['HELPER-PERSONAL-RULE']);
    host.history.set(admin.agentId, [{ type: 'user_message', text: '预算内完整原话' }, { type: 'assistant_message', text: '不可截断'.repeat(5000) }]);
    const limited = await host.invoke('bots.channels.context', { channelId: id, agentId: route.targets[0].agentId }) as { text: string };
    const data = JSON.parse(limited.text.slice(limited.text.indexOf('\n') + 1));
    assert.equal(data.recentDiscussion.partial, true);
    assert(Buffer.byteLength(JSON.stringify(data.recentDiscussion), 'utf8') <= 16_000);
    assert.deepEqual(data.recentDiscussion.messages.map((message: { text: string }) => message.text), ['预算内完整原话']);
  } finally { await host.close(); }
});

test('群外、已归档同事及同名歧义不退回管理员或启动未获准的成员', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'outsider', name: '群外同事', role: '其他场景' });
    const a = await host.channel('甲'); const before = host.created.length;
    await assert.rejects(host.invoke('bots.channels.route', { channelId: a.id, text: '@群外同事 请回应' }), /不属于此频道/);
    assert.equal(host.created.length, before);
    await host.invoke('bots.create', { id: 'same-a', name: '同名', role: '甲' });
    await host.invoke('bots.create', { id: 'same-b', name: '同名', role: '乙' });
    await assert.rejects(host.invoke('bots.channels.route', { channelId: a.id, text: '@同名 请回应' }), /同名|标识/);
    await host.invoke('bots.channels.update', { channelId: a.id, details: { name: '甲', memberIds: ['chief', 'outsider'], adminBotId: 'chief', cwd: host.directory, instructions: '' } });
    await host.invoke('bots.archive', { botId: 'outsider' });
    await assert.rejects(host.invoke('bots.channels.route', { channelId: a.id, text: '@群外同事 请回应' }), /归档/);
    await host.invoke('bots.channels.archive', { channelId: a.id, archived: true });
    await assert.rejects(host.invoke('bots.channels.route', { channelId: a.id, text: '普通消息' }), /归档/);
    assert.equal(host.created.length, before);
  } finally { await host.close(); }
});

test('管理员通过原生来源交办，成员回报唤醒原发起者，重复和未知回执按原生历史回查', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: 'ADMIN-PRIVATE-RULE' });
    await host.invoke('bots.memory.save', { botId: 'helper', kind: 'confirmed', content: 'HELPER-RULE' });
    const id = randomUUID();
    await host.invoke('bots.channels.create', { id, name: '协作群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: host.directory, instructions: '共同范围' });
    const admin = await host.invoke('bots.channels.open', { channelId: id }) as { agentId: string };
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'helper' }) as { agentId: string };
    const tools = await host.connect(admin.agentId);
    const input = { colleagueId: 'helper', requestId: 'verify-input', prompt: '只核对合成输入并回报核对依据' };
    host.loseNextReceipt();
    assert.equal((await tools.callTool({ name: 'ask_channel_member', arguments: input })).isError, true);
    const receipt = payload(await tools.callTool({ name: 'ask_channel_member', arguments: input }));
    assert.equal(host.sent.length, 1); assert.notEqual(receipt.agentId, privateChat.agentId);
    assert.equal(host.sent[0].options.sourceAgentId, admin.agentId);
    const request = JSON.parse(host.sent[0].text);
    assert.equal(request.replyId, receipt.replyId); assert.equal(request.goal, input.prompt);
    assert.deepEqual(request.context.personalConfirmedMemories, ['HELPER-RULE']);
    assert(!host.sent[0].text.includes('ADMIN-PRIVATE-RULE'));
    assert.equal((await tools.callTool({ name: 'ask_channel_member', arguments: { ...input, prompt: '偷偷替换原目标' } })).isError, true);
    assert.equal(host.sent.length, 1);
    const member = await host.connect(receipt.agentId);
    assert(!(await member.listTools()).tools.some(tool => tool.name === 'ask_channel_member'));
    assert.equal((await member.callTool({ name: 'remember_explicit', arguments: { content: input.prompt, userQuote: input.prompt } })).isError, true, '同事消息不能冒充最新原生用户记忆依据');
    const report = { replyId: receipt.replyId, summary: '合成输入已核对', evidence: ['synthetic/result.json'] };
    host.loseNextReceipt();
    assert.equal((await member.callTool({ name: 'report_channel_result', arguments: report })).isError, true);
    payload(await member.callTool({ name: 'report_channel_result', arguments: report }));
    assert.equal(host.sent.length, 2); assert.equal(host.sent[1].agentId, admin.agentId);
    assert.equal(host.sent[1].options.sourceAgentId, receipt.agentId);
    assert.deepEqual(JSON.parse(host.sent[1].text).evidence, report.evidence);
    assert.equal((await member.callTool({ name: 'report_channel_result', arguments: { ...report, summary: '不能改写旧回报' } })).isError, true);
    assert.equal(host.sent.length, 2);
    assert.deepEqual(await host.invoke('bots.memories', { botId: 'helper', channelId: id }), []);
  } finally { await host.close(); }
});

test('群内交办不接受群外或自身，伪造和跨群回报不能传给任意接收者', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    const id = randomUUID();
    const details = { name: '甲群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: host.directory, instructions: '' };
    await host.invoke('bots.channels.create', { id, ...details });
    const admin = await host.invoke('bots.channels.open', { channelId: id }) as { agentId: string };
    const tools = await host.connect(admin.agentId);
    for (const colleagueId of ['chief', 'outsider']) assert.equal((await tools.callTool({ name: 'ask_channel_member', arguments: { colleagueId, requestId: 'nope', prompt: '不能派发' } })).isError, true);
    assert.equal(host.sent.length, 0);
    const receipt = payload(await tools.callTool({ name: 'ask_channel_member', arguments: { colleagueId: 'helper', requestId: 'one', prompt: '核对合成数据' } }));
    const other = await host.channel('乙');
    const otherAdmin = await host.invoke('bots.channels.open', { channelId: other.id }) as { agentId: string };
    const otherTools = await host.connect(otherAdmin.agentId);
    const report = { replyId: receipt.replyId, summary: '伪造回报', evidence: ['无实际来源'] };
    assert.equal((await otherTools.callTool({ name: 'report_channel_result', arguments: report })).isError, true);
    await host.invoke('bots.channels.update', { channelId: id, details: { ...details, adminBotId: 'helper' } });
    assert(!(await tools.listTools()).tools.some(tool => tool.name === 'ask_channel_member'));
    const helper = await host.connect(receipt.agentId);
    await host.invoke('bots.channels.update', { channelId: id, details: { ...details, memberIds: ['helper'], adminBotId: 'helper' } });
    assert.equal((await helper.callTool({ name: 'report_channel_result', arguments: report })).isError, true, '旧发起者退出群后不再外送回报');
    assert.equal(host.sent.length, 1);
  } finally { await host.close(); }
});

test('团队记忆显式发布后跨Bot/频道只读可用，不混入个人与群记忆', async () => {
  const host = await fixture();
  try {
    await host.invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: 'PERSONAL-ONLY' });
    const a = await host.channel('甲');
    await host.invoke('bots.memory.save', { botId: 'chief', channelId: a.id, kind: 'confirmed', content: 'GROUP-ONLY' });
    const shared = await host.invoke('bots.memory.save', { botId: 'chief', team: true, kind: 'confirmed', content: 'TEAM-PUBLISHED', origin: { type: 'message', agentId: 'private-source', userQuote: 'PRIVATE-QUOTE' } }) as { id: string; origin: unknown };
    assert.deepEqual(shared.origin, { type: 'manual' }, '发布只接受用户确认的内容，不复制私聊来源');
    await host.invoke('bots.memory.save', { botId: 'chief', team: true, kind: 'candidate', content: 'TEAM-UNCONFIRMED' });
    assert.deepEqual((await host.invoke('bots.memories', { botId: 'chief' }) as { content: string }[]).map(entry => entry.content), ['PERSONAL-ONLY']);
    assert.deepEqual((await host.invoke('bots.memories', { botId: 'chief', channelId: a.id }) as { content: string }[]).map(entry => entry.content), ['GROUP-ONLY']);
    assert.equal((await host.invoke('bots.memories', { botId: 'helper', team: true }) as unknown[]).length, 2);
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'helper' }) as { agentId: string };
    const group = await host.invoke('bots.channels.open', { channelId: a.id }) as { agentId: string };
    const privateFrame = await host.invoke('bots.conversation.context', { botId: 'helper', agentId: privateChat.agentId }) as { text: string };
    const groupFrame = await host.invoke('bots.channels.context', { channelId: a.id, agentId: group.agentId }) as { text: string };
    assert.match(privateFrame.text, /TEAM-PUBLISHED/); assert.doesNotMatch(privateFrame.text, /TEAM-UNCONFIRMED|PERSONAL-ONLY|GROUP-ONLY|PRIVATE-QUOTE/);
    assert.match(groupFrame.text, /TEAM-PUBLISHED/); assert.doesNotMatch(groupFrame.text, /TEAM-UNCONFIRMED|PRIVATE-QUOTE/);
    const tools = await host.connect(privateChat.agentId);
    const context = payload(await tools.callTool({ name: 'get_bot_context', arguments: {} }));
    assert.deepEqual(context.teamConfirmedMemories, ['TEAM-PUBLISHED']);
    const selected = payload(await tools.callTool({ name: 'read_memories', arguments: { scope: 'team', memoryIds: [shared.id] } }));
    assert.equal(selected.memories[0].content, 'TEAM-PUBLISHED');
    assert.equal(selected.scope, 'team');
    const task = await host.invoke('bots.start', { botId: 'helper', title: '独立合成工作', prompt: '仅核对当前共享约定' }) as { agentId: string };
    const taskPrompt = host.created.find(native => native.agentId === task.agentId)!.config.systemPrompt!;
    assert.match(taskPrompt, /TEAM-PUBLISHED/); assert.doesNotMatch(taskPrompt, /TEAM-UNCONFIRMED|PERSONAL-ONLY|GROUP-ONLY|PRIVATE-QUOTE/);
    host.history.set(privateChat.agentId, [{ type: 'user_message', text: '请记住：只能存个人' }]);
    assert.equal((await tools.callTool({ name: 'remember_explicit', arguments: { scope: 'team', content: '只能存个人', userQuote: '请记住：只能存个人' } })).isError, true, 'Agent不能将写入升级为团队共享');
    assert.equal((await host.invoke('bots.memories', { botId: 'chief', team: true }) as unknown[]).length, 2);
  } finally { await host.close(); }
});

test('团队记忆去重、纠正、归档恢复作用于共享副本，其他作用域保持原值', async () => {
  const host = await fixture();
  try {
    const personal = await host.invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '原始个人约定' }) as { id: string };
    const input = { botId: 'chief', team: true, kind: 'confirmed', content: '原始个人约定' };
    const published = await host.invoke('bots.memory.save', input) as { id: string };
    assert.notEqual(personal.id, published.id);
    assert.equal((await host.invoke('bots.memory.save', input) as { id: string }).id, published.id);
    await host.invoke('bots.memory.correct', { botId: 'chief', team: true, memoryId: published.id, content: '仅修改团队副本', kind: 'confirmed' });
    assert.equal((await host.invoke('bots.memories', { botId: 'chief' }) as { content: string }[])[0].content, '原始个人约定');
    await host.invoke('bots.memory.forget', { botId: 'chief', team: true, memoryId: published.id });
    assert.deepEqual(await host.invoke('bots.memories', { botId: 'chief', team: true }), []);
    await host.invoke('bots.memory.restore', { botId: 'chief', team: true, memoryId: published.id });
    const entry = (await host.invoke('bots.memories', { botId: 'chief', team: true }) as { content: string; history: { action: string }[] }[])[0];
    assert.equal(entry.content, '仅修改团队副本'); assert.deepEqual(entry.history.map(change => change.action), ['updated', 'archived', 'restored']);
    const a = await host.channel('甲');
    await assert.rejects(host.invoke('bots.memory.save', { ...input, channelId: a.id }), /团队|频道|scope|Unrecognized|invalid|Invalid/);
  } finally { await host.close(); }
});

test('签名群工具不能查私聊或另一个群，私聊工具也不能读群历史', async () => {
  const host = await fixture();
  try {
    const privateChat = await host.invoke('bots.conversation.open', { botId: 'chief' }) as { agentId: string };
    const a = await host.channel('甲'); const b = await host.channel('乙');
    const first = await host.invoke('bots.channels.open', { channelId: a.id }) as { agentId: string };
    const second = await host.invoke('bots.channels.open', { channelId: b.id }) as { agentId: string };
    const group = await host.connect(first.agentId); const personal = await host.connect(privateChat.agentId);
    assert.equal((await group.callTool({ name: 'read_bot_history', arguments: { agentId: privateChat.agentId } })).isError, true);
    assert.equal((await group.callTool({ name: 'read_bot_history', arguments: { agentId: second.agentId } })).isError, true);
    assert.equal((await personal.callTool({ name: 'read_bot_history', arguments: { agentId: first.agentId } })).isError, true);
    payload(await group.callTool({ name: 'read_bot_history', arguments: { agentId: first.agentId } }));
    await host.invoke('bots.channels.archive', { channelId: a.id, archived: true });
    await assert.rejects(group.callTool({ name: 'propose_memory', arguments: { content: '不能继续写已归档群' } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 403);
    assert.deepEqual(await host.invoke('bots.memories', { botId: 'chief', channelId: a.id, includeArchived: true }), []);
  } finally { await host.close(); }
});
