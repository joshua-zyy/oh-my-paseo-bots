import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PaseoApi } from '@getpaseo/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BotStore } from '../server/store.js';
import { TaskTracker, type TaskRecord } from '../server/tasks.js';
import { registerTaskTools } from '../server/task-tools.js';

async function withTasks(run: (fixture: { tracker: TaskTracker; reopen: () => TaskTracker; dir: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-guys-task-tools-'));
  const store = new BotStore({ baseDir: join(dir, 'store') });
  const reopen = () => new TaskTracker({
    baseDir: dir,
    store: new BotStore({ baseDir: join(dir, 'store') }),
    cli: { command: 'unused', cwd: dir },
    getPaseo: () => ({ agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, labels: {} } }), archive: async () => {
      if (agentId === 'agent-stopping') throw new Error('offline archive pending');
      return { archivedAt: 'now' };
    } }) } }) as unknown as PaseoApi,
    execute: async () => { throw new Error('queries must not execute CLI'); },
  });
  try {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '持续跟进' });
    await store.createBot({ id: 'other', name: '其他 Bot', role: '其他事项' });
    const tracker = reopen();
    for (const agentId of ['agent-old', 'agent-stopping', 'agent-completed', 'agent-canceled', 'agent-new']) {
      await store.linkSession('chief', { sessionId: agentId });
      await tracker.ensure('chief', agentId, { title: agentId, ...(agentId === 'agent-old' ? { goal: '交付已核对的资料摘要' } : {}) });
    }
    await tracker.observeSpecialist('chief', 'agent-old', 'expert-old');
    await tracker.stop('chief', 'agent-completed', { outcome: 'completed', summary: '资料已交付', evidence: ['local/report.md'] });
    await tracker.stop('chief', 'agent-canceled', { outcome: 'canceled', summary: '用户取消旧事项' });
    await assert.rejects(tracker.stop('chief', 'agent-stopping', { outcome: 'canceled', summary: '停止待确认' }));
    await store.linkSession('other', { sessionId: 'agent-other' });
    await tracker.ensure('other', 'agent-other', { title: '其他 Bot 私有事项', goal: '不应出现在主 Bot 查询中' });
    await run({ tracker, reopen, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withClient(tracker: TaskTracker, run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: 'offline-task-tools', version: '0' });
  registerTaskTools(server, tracker, 'chief', 'agent-new');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'offline-task-tools-client', version: '0' });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function payload<T>(result: unknown): T {
  const value = result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(value.isError, true, value.content[0].text);
  return JSON.parse(value.content[0].text) as T;
}

test('新会话可发现同 Bot 的旧未结事项，按需读取完整记录，终态默认略过但可查询', async () => {
  await withTasks(async ({ tracker }) => withClient(tracker, async client => {
    const catalog = (await client.listTools()).tools;
    for (const name of ['list_bot_tasks', 'read_bot_task']) {
      const tool = catalog.find(item => item.name === name);
      assert.ok(tool, `${name} must be exposed`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal('botId' in (tool.inputSchema.properties ?? {}), false);
    }
    const listed = payload<Partial<TaskRecord>[]>(await client.callTool({ name: 'list_bot_tasks', arguments: {} }));
    assert.deepEqual(listed, [
      { agentId: 'agent-old', title: 'agent-old', status: 'active', goal: '交付已核对的资料摘要' },
      { agentId: 'agent-stopping', title: 'agent-stopping', status: 'stopping', summary: '停止待确认' },
      { agentId: 'agent-new', title: 'agent-new', status: 'active' },
    ]);
    assert.deepEqual(payload(await client.callTool({ name: 'read_bot_task', arguments: { agentId: 'agent-old' } })), JSON.parse(JSON.stringify(await tracker.get('chief', 'agent-old'))));
    assert.equal(payload<TaskRecord>(await client.callTool({ name: 'read_task', arguments: {} })).agentId, 'agent-new');
    const all = payload<Partial<TaskRecord>[]>(await client.callTool({ name: 'list_bot_tasks', arguments: { includeFinished: true } }));
    assert.deepEqual(all.map(item => item.status), ['active', 'stopping', 'completed', 'canceled', 'active']);
    assert.equal(all.find(item => item.agentId === 'agent-completed')?.summary, '资料已交付');
    const completed = payload<TaskRecord>(await client.callTool({ name: 'read_bot_task', arguments: { agentId: 'agent-completed' } }));
    assert.deepEqual(completed.evidence, ['local/report.md']);
    assert.equal(completed.status, 'completed');
  }));
});

test('跨 Bot 和未知事项不能读取，查询不写回或恢复任何旧事项', async () => {
  await withTasks(async ({ tracker, dir }) => withClient(tracker, async client => {
    const files = [join(dir, 'tasks', 'chief.json'), join(dir, 'tasks', 'other.json')];
    const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
    for (const agentId of ['agent-other', 'agent-missing']) {
      const result = await client.callTool({ name: 'read_bot_task', arguments: { agentId, botId: 'other' } });
      assert.equal(result.isError, true);
      assert.match((result.content as { text: string }[])[0].text, /未找到|不存在|未登记/);
      assert.doesNotMatch(JSON.stringify(result), /其他 Bot 私有事项|不应出现在主 Bot 查询中/);
    }
    await client.callTool({ name: 'list_bot_tasks', arguments: { includeFinished: true, botId: 'other' } });
    await client.callTool({ name: 'read_bot_task', arguments: { agentId: 'agent-stopping' } });
    assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  }));
});

test('重开 BotStore 和 TaskTracker 后，新会话仍可查询既有事项及交付证据', async () => {
  await withTasks(async ({ reopen }) => withClient(reopen(), async client => {
    const listed = payload<Partial<TaskRecord>[]>(await client.callTool({ name: 'list_bot_tasks', arguments: {} }));
    assert.deepEqual(listed.map(item => item.agentId), ['agent-old', 'agent-stopping', 'agent-new']);
    const old = payload<TaskRecord>(await client.callTool({ name: 'read_bot_task', arguments: { agentId: 'agent-old' } }));
    assert.equal(old.goal, '交付已核对的资料摘要');
    assert.deepEqual(old.specialists, ['expert-old']);
    const completed = payload<TaskRecord>(await client.callTool({ name: 'read_bot_task', arguments: { agentId: 'agent-completed' } }));
    assert.equal(completed.summary, '资料已交付');
    assert.deepEqual(completed.evidence, ['local/report.md']);
  }));
});

test('持续聊天的控制记录不出现在事项目录', async () => {
  await withTasks(async ({ tracker, dir }) => {
    const store = new BotStore({ baseDir: join(dir, 'store') });
    await store.linkSession('chief', { sessionId: 'conversation-chief' });
    const input = { title: '主聊天', conversation: true as const };
    await tracker.ensure('chief', 'conversation-chief', input);
    await withClient(tracker, async client => {
      const listed = payload<Partial<TaskRecord>[]>(await client.callTool({ name: 'list_bot_tasks', arguments: { includeFinished: true } }));
      assert.equal(listed.some(task => task.agentId === 'conversation-chief'), false);
    });
  });
});
