import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import contribute from '../index.server.js';

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
  const paseo = { agents: {
    create: async (options: PaseoAgentCreateOptions) => { created.push(options); return { id: options.agentId!, workspaceId: 'ws-configured' }; },
    ref: (id: string) => ({
      archive: async () => { archived.push(id); return { archivedAt: new Date().toISOString() }; },
      refresh: async () => ({ agent: { id, title: '原生事项', workspaceId: 'ws-configured', labels: id === 'grandchild' ? { 'paseo.parent-agent-id': 'child' } : id === 'child' ? { 'paseo.parent-agent-id': created[0].agentId } : { 'paseo-guys.bot': 'chief' } } }),
      timeline: { refetch: async () => ({ error: null, staleCursor: false, gap: false, epoch: 'test-epoch', hasOlder: false, entries: [{ item: { type: 'user_message', text: userMessage } }] }) },
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
      const saved = await invoke('bots.memories', { botId: 'chief' }) as { kind: string; content: string }[];
      assert.ok(saved.some(item => item.kind === 'confirmed' && item.content === '后续报告使用中文'));
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
  const createNative = async (options: PaseoAgentCreateOptions, workspaceCwd?: string) => {
    // 实机已证实：未显式放置的子 Agent 会继承父 workspace，cwd 参数不改变归属。
    const parent = created.find(item => item.agentId === options.parent);
    created.push({ ...options, cwd: workspaceCwd ?? parent?.cwd ?? options.cwd });
    return { id: options.agentId!, workspaceId: 'ws-team' };
  };
  const paseo = { workspaces: { open: async (cwd: string) => {
    opened.push(cwd);
    return { agents: { create: (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => createNative({ ...options, cwd }, cwd) } };
  } }, agents: {
    create: createNative,
    ref: (id: string) => ({ refresh: async () => {
      const options = created.find(item => item.agentId === id);
      return options ? { agent: { id, title: options.title, workspaceId: 'ws-team', labels: { ...options.labels, ...(options.parent ? { 'paseo.parent-agent-id': options.parent } : {}) } } } : null;
    } }),
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
    assert.deepEqual(opened, [join(directory, 'researcher')], '显式选择接收方工作区，但保留原生 parent');
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
    const rootSessions = await invoke('bots.sessions', { botId: 'chief' }) as { sessionId: string }[];
    assert.deepEqual(rootSessions.map(item => item.sessionId), [root.agentId]);
    const childSessions = await invoke('bots.sessions', { botId: 'researcher' }) as { sessionId: string }[];
    assert.deepEqual(childSessions.map(item => item.sessionId), [child.agentId]);
    assert.equal(typeof hooks.get('agent.archived'), 'function');
    await hooks.get('agent.archived')!({ agent: { id: child.agentId }, archivedAt: new Date().toISOString() }, { paseo });
    assert.equal(payload(await childClient.callTool({ name: 'read_task', arguments: {} })).status, 'canceled', '同事被原生归档后不能继续显示进行中');
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
  } finally {
    await client.close(); await childClient.close(); await cleanup();
    if (previous === undefined) delete process.env.PASEO_GUYS_DATA_DIR; else process.env.PASEO_GUYS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
