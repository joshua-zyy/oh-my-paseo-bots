import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await invoke('bots.create', { id: 'chief', name: '主 Bot', role: '核对' });
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
    const tools = created[0].config.mcpServers!['paseo-guys'];
    assert.equal(tools.type, 'http');
    if (tools.type !== 'http') throw new Error('expected HTTP tools');
    const client = new Client({ name: 'plugin-contract-test', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
      const catalog = await client.listTools();
      assert.ok(catalog.tools.some(tool => tool.name === 'propose_mail'));
      assert.equal(catalog.tools.some(tool => /approve|allow_fixed/.test(tool.name)), false);
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
