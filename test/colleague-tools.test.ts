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
  const tasks = new TaskTracker({ baseDir: directory, store, cli: { command: '', cwd: '' }, getPaseo: () => ({ agents: { ref: () => ({ archive: async () => ({ archivedAt: 'now' }) }) } }) as unknown as PaseoApi });
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
