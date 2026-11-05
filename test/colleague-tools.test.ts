import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PaseoApi } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerColleagueTools, type ColleagueToolScope } from '../server/colleague-tools.js';
import { BotStore } from '../server/store.js';
import { TaskTracker } from '../server/tasks.js';

// Only local files and SDK InMemoryTransport; fake start never invokes Paseo or a model.
async function withColleagues(run: (value: { client: Client; store: BotStore; tasks: TaskTracker; started: Parameters<ColleagueToolScope['start']>[0][]; failNextStart: () => void }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-colleagues-'));
  const store = new BotStore({ baseDir: directory });
  await store.createBot({ id: 'chief', name: '主同事', role: '核对交付' });
  await store.createBot({ id: 'research', name: '研究同事', role: '整理指定资料' });
  await store.createBot({ id: 'writer', name: '写作同事', role: '撰写报告' });
  await store.linkSession('chief', { sessionId: 'source-agent' });
  const tasks = new TaskTracker({ baseDir: directory, store, cli: { command: '', cwd: '' }, getPaseo: () => ({ agents: { ref: () => ({ refresh: async () => ({ agent: { labels: {} } }), archive: async () => ({ archivedAt: 'now' }) }) } }) as unknown as PaseoApi });
  await tasks.ensure('chief', 'source-agent', { title: '整理资料与核对' });
  const started: Parameters<ColleagueToolScope['start']>[0][] = [];
  let failNext = false;
  const server = new McpServer({ name: 'colleague-tools-test', version: '1.0' });
  registerColleagueTools(server, { store, tasks, botId: 'chief', agentId: 'source-agent', start: async input => {
    started.push(input);
    if (failNext) { failNext = false; throw new Error('synthetic start receipt lost'); }
    return { agentId: 'research-native-agent', requestId: input.requestId };
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'colleague-tools-client', version: '1.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run({ client, store, tasks, started, failNextStart: () => { failNext = true; } });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text).join('');
}

const input = { colleagueId: 'research', requestId: 'research-1', title: '整理指定资料', prompt: '仅核对给出的合成摘要，交付 report.md。' };

test('start_task 用本 Bot 的独立原生子事项执行工作，保留父聊天和稳定请求键', async () => {
  await withColleagues(async ({ client, started, tasks }) => {
    const request = { requestId: 'work-1', title: '核对数字', prompt: '核对合成资料，交付 report.md' };
    const result = await client.callTool({ name: 'start_task', arguments: request });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(started.length, 1);
    assert.equal(started[0].botId, 'chief');
    assert.equal(started[0].parentAgentId, 'source-agent');
    assert.equal(JSON.parse(text(result)).requestId, request.requestId);
    assert.equal((await tasks.get('chief', 'source-agent'))?.status, 'active');
    assert.deepEqual((await tasks.get('chief', 'source-agent'))?.specialists, ['research-native-agent']);
    await tasks.stop('chief', 'source-agent', { outcome: 'canceled', summary: '停止旧事项' });
    assert.equal((await client.callTool({ name: 'start_task', arguments: request })).isError, true);
    assert.equal(started.length, 1, '停止后不再派发');
  });
});

test('Chief可创建和调整固定同事，仅配置选定字段，不启动原生Agent或修改授权', async () => {
  await withColleagues(async ({ client, store, started }) => {
    await store.updateBot('chief', { execution: { provider: 'creator/model', cwd: '/synthetic/chief', modeId: 'creator-mode', thinkingOptionId: 'high' }, capabilities: { skills: [{ name: 'chief-only', path: '/synthetic/chief/SKILL.md' }], mcpServers: { 'chief-only': { type: 'http', url: 'https://synthetic.invalid/mcp' } } } });
    const created = await client.callTool({ name: 'create_colleague', arguments: { id: 'editor', name: '校对', role: '核对数字', instructions: '逐项给出原文依据', execution: { provider: 'known/model', cwd: '/synthetic/editor' } } });
    assert.notEqual(created.isError, true, text(created));
    const catalog = await client.listTools();
    const idRule = (catalog.tools.find(tool => tool.name === 'create_colleague')!.inputSchema.properties!.id as { pattern: string }).pattern;
    assert.equal(new RegExp(idRule).test('Bad ID!'), false, '公开工具schema即声明标识字符规则');
    for (const id of ['Bad ID!', 'Chief', 'con', 'a.b']) {
      assert.equal((await client.callTool({ name: 'create_colleague', arguments: { id, name: '非法标识', role: '核对', instructions: '' } })).isError, true);
    }
    assert.deepEqual((await store.getBot('editor'))!.bot.execution, { provider: 'known/model', cwd: '/synthetic/editor', modeId: 'creator-mode' }, '另选模型清除未重选的思考选项，但不绕过创建者的显式执行模式');
    assert.equal((await client.callTool({ name: 'create_colleague', arguments: { id: 'editor', name: '重复', role: '不应覆盖', instructions: '' } })).isError, true, '同一标识重复登记明确报错，不覆盖或另建身份');
    await store.updateBot('editor', { execution: { provider: 'known/model', cwd: '/synthetic/editor', modeId: 'user-selected-mode', thinkingOptionId: 'high' } });
    const updated = await client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'editor', patch: { role: '核对报告数字', execution: { thinkingOptionId: 'low' } } } });
    assert.notEqual(updated.isError, true, text(updated));
    const record = (await store.getBot('editor'))!;
    assert.equal(record.bot.role, '核对报告数字');
    assert.equal(record.bot.instructions, '逐项给出原文依据');
    assert.deepEqual(record.bot.execution, { provider: 'known/model', cwd: '/synthetic/editor', modeId: 'user-selected-mode', thinkingOptionId: 'low' });
    assert.deepEqual(record.sessions, []);
    assert.deepEqual(record.bot.capabilities, { skills: [], mcpServers: {} }, '新同事不自动继承 Chief 的技能或 MCP 连接范围');
    assert.equal((await client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'editor', patch: { capabilities: { mcpServers: { extra: { type: 'stdio', command: 'not-authorized' } } } } } })).isError, true, '模型管理工具不能自行追加新能力绑定');
    assert.equal(started.length, 0);
    assert.equal((await client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'editor', patch: { execution: { modeId: 'unattended' } } } })).isError, true);
    assert.equal((await store.getBot('editor'))!.bot.execution.modeId, 'user-selected-mode');
    await store.updateBot('chief', { name: '非默认名称' });
    assert.equal((await client.callTool({ name: 'create_colleague', arguments: { id: 'checker', name: '复核', role: '核对', instructions: '' } })).isError, undefined, 'Chief按服务端绑定的固定标识识别，不靠可修改名称');
  });
});

test('并发局部修改同事执行字段不会覆盖另一项已写入的配置', { timeout: 5000 }, async () => {
  await withColleagues(async ({ client, store }) => {
    await store.updateBot('writer', { execution: { provider: 'known/model', cwd: '/before', thinkingOptionId: 'high' } });
    const read = store.getBot.bind(store);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    store.getBot = async id => {
      const value = await read(id);
      if (id === 'writer') { if (++reads === 2) release(); await gate; }
      return value;
    };
    try {
      const results = await Promise.all([
        client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'writer', patch: { execution: { cwd: '/after' } } } }),
        client.callTool({ name: 'update_colleague', arguments: { colleagueId: 'writer', patch: { execution: { thinkingOptionId: 'low' } } } }),
      ]);
      assert.ok(results.every(result => !result.isError));
    } finally { store.getBot = read; }
    assert.deepEqual((await store.getBot('writer'))!.bot.execution, { provider: 'known/model', cwd: '/after', thinkingOptionId: 'low' });
  });
});

test('普通同事只能调整自己；取消后不可创建或调整，既有配置保持不变', async () => {
  await withColleagues(async ({ client, store, tasks }) => {
    await store.createBot({ id: 'checker', name: '复核', role: '核对' });
    await store.updateBot('chief', { name: 'Chief改名仍是Chief' });
    // 用固定同事自己的绑定注册，不接受工具参数伪造 caller。
    const server = new McpServer({ name: 'ordinary-colleague', version: '1' });
    const other = new Client({ name: 'ordinary-client', version: '1' });
    await store.linkSession('checker', { sessionId: 'checker-agent' });
    await tasks.ensure('checker', 'checker-agent', { title: '核对' });
    registerColleagueTools(server, { store, tasks, botId: 'checker', agentId: 'checker-agent', start: async () => { throw new Error('不应启动'); } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await other.connect(a);
      assert.equal((await other.callTool({ name: 'create_colleague', arguments: { id: 'forged', name: '伪造', role: '核对', instructions: '', botId: 'chief' } })).isError, true);
      assert.equal(await store.getBot('forged'), null);
      assert.equal((await other.callTool({ name: 'update_colleague', arguments: { colleagueId: 'chief', patch: { instructions: '不应写入' } } })).isError, true);
      assert.equal((await other.callTool({ name: 'update_colleague', arguments: { patch: { instructions: '仅自己的说明' } } })).isError, undefined);
      assert.equal((await store.getBot('checker'))!.bot.instructions, '仅自己的说明');
      await tasks.stop('checker', 'checker-agent', { outcome: 'canceled', summary: '停止' });
      assert.equal((await other.callTool({ name: 'update_colleague', arguments: { patch: { instructions: '停止后不应写入' } } })).isError, true);
      await tasks.stop('chief', 'source-agent', { outcome: 'canceled', summary: '停止' });
      assert.equal((await client.callTool({ name: 'create_colleague', arguments: { id: 'late', name: '迟到', role: '核对', instructions: '' } })).isError, true);
    } finally { await other.close(); await server.close(); }
  });
});

test('同事目录只返回其他注册Bot的身份，不共享记忆、会话或历史', async () => {
  await withColleagues(async ({ client, store }) => {
    await store.addMemory('chief', { kind: 'confirmed', content: 'SOURCE-PRIVATE-MEMORY' });
    await store.addMemory('research', { kind: 'confirmed', content: 'TARGET-PRIVATE-MEMORY' });
    await store.addMemory('research', { kind: 'candidate', content: 'TARGET-CANDIDATE' });
    await store.linkSession('research', { sessionId: 'private-old-session' });
    const result = await client.callTool({ name: 'list_colleagues', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(text(result)), [
      { id: 'research', name: '研究同事', role: '整理指定资料' },
      { id: 'writer', name: '写作同事', role: '撰写报告' },
    ]);
    assert.doesNotMatch(text(result), /SOURCE-PRIVATE|TARGET-PRIVATE|TARGET-CANDIDATE|private-old-session/);
  });
});

test('委派绑定已选同事、当前原生父会话与稳定请求键，仅传明确输入', async () => {
  await withColleagues(async ({ client, tasks, started }) => {
    const result = await client.callTool({ name: 'delegate_to_colleague', arguments: { ...input, sourceBot: 'writer', parentAgentId: 'forged-parent', config: { modeId: 'unattended' } } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(started, [{
      botId: 'research', parentAgentId: 'source-agent',
      requestId: `delegation:${createHash('sha256').update('source-agent').digest('hex')}:research-1`,
      title: input.title, prompt: input.prompt,
    }]);
    assert.deepEqual(JSON.parse(text(result)), { agentId: 'research-native-agent', requestId: 'research-1' });
    assert.deepEqual((await tasks.get('chief', 'source-agent'))?.specialists, ['research-native-agent']);
    const catalog = await client.listTools();
    assert.match(catalog.tools.find(tool => tool.name === 'delegate_to_colleague')!.description!, /原生|通知/);
    assert.match(catalog.tools.find(tool => tool.name === 'delegate_to_colleague')!.description!, /不.*完成|不.*交付/);
  });
});

test('重试继续用原始外部requestId，内部命名空间不叠加且关联幂等', async () => {
  await withColleagues(async ({ client, tasks, started, failNextStart }) => {
    failNextStart();
    assert.equal((await client.callTool({ name: 'delegate_to_colleague', arguments: input })).isError, true);
    const succeeded = await client.callTool({ name: 'delegate_to_colleague', arguments: input });
    assert.notEqual(succeeded.isError, true);
    const result = JSON.parse(text(succeeded));
    assert.equal(result.requestId, input.requestId);
    await client.callTool({ name: 'delegate_to_colleague', arguments: { ...input, requestId: result.requestId } });
    assert.equal(started.length, 3, '替身只证明相同原生准入键，不宣称原生执行次数');
    assert.equal(new Set(started.map(item => item.requestId)).size, 1);
    assert.deepEqual((await tasks.get('chief', 'source-agent'))?.specialists, ['research-native-agent']);
  });
});

test('停止后的当前事项不能再委派给其他同事', async () => {
  await withColleagues(async ({ client, tasks, started }) => {
    await tasks.stop('chief', 'source-agent', { outcome: 'canceled', summary: '用户取消当前事项' });
    const result = await client.callTool({ name: 'delegate_to_colleague', arguments: input });
    assert.equal(result.isError, true);
    assert.match(text(result), /不再接受|canceled/);
    assert.equal(started.length, 0);
  });
});

test('归档同事不出现在委派目录，旧标识不能委派，恢复后沿用同一身份', async () => {
  await withColleagues(async ({ client, store, started }) => {
    await store.setArchived('research', true);
    const listed = JSON.parse(text(await client.callTool({ name: 'list_colleagues', arguments: {} })));
    assert.deepEqual(listed.map((bot: { id: string }) => bot.id), ['writer']);
    const refused = await client.callTool({ name: 'delegate_to_colleague', arguments: input });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /归档/);
    assert.equal(started.length, 0);
    await store.setArchived('research', false);
    assert.notEqual((await client.callTool({ name: 'delegate_to_colleague', arguments: input })).isError, true);
    assert.equal(started[0].botId, 'research');
    assert.equal((await client.listTools()).tools.some(tool => /archive|restore|delete/.test(tool.name)), false, '归档恢复只由用户页面操作，不授予 Agent');
  });
});

test('自己、未注册或非法目标都不能启动新原生会话', async () => {
  await withColleagues(async ({ client, started }) => {
    for (const colleagueId of ['chief', 'missing', '../research']) {
      const result = await client.callTool({ name: 'delegate_to_colleague', arguments: { ...input, colleagueId } });
      assert.equal(result.isError, true);
    }
    assert.equal(started.length, 0);
  });
});

test('请求键长度有界，空白输入被拒绝，合法最长键可交给store', async () => {
  await withColleagues(async ({ client, store, started }) => {
    for (const change of [{ requestId: 'x'.repeat(121) }, { requestId: '   ' }, { title: '   ' }, { prompt: '   ' }]) {
      assert.equal((await client.callTool({ name: 'delegate_to_colleague', arguments: { ...input, ...change } })).isError, true);
    }
    assert.equal(started.length, 0);
    const result = await client.callTool({ name: 'delegate_to_colleague', arguments: { ...input, requestId: 'x'.repeat(120) } });
    assert.notEqual(result.isError, true);
    assert.ok(started[0].requestId.length <= 200);
    await store.prepareCreation('research', { requestId: started[0].requestId, fingerprint: 'f'.repeat(64) });
  });
});
