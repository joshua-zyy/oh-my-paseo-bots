import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';
import { archiveBot } from '../server/bot-archive.js';
import { botSessionConfig } from '../server/sessions.js';
import { TaskTracker, type TaskRecord } from '../server/tasks.js';
import type { BotRoutines } from '../server/routines.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bot-archive-'));
  const store = new BotStore({ baseDir: directory });
  await store.ensureChief();
  await store.createBot({ id: 'helper', name: '资料同事', role: '核对合成资料' });
  const tasks: TaskRecord[] = [];
  const routines: Awaited<ReturnType<BotRoutines['list']>> = [];
  let status = 'idle';
  let pendingPermissions: object[] = [];
  let unavailable = false;
  const paseo = { agents: { ref: () => ({ refresh: async () => {
    if (unavailable) throw new Error('native offline');
    return { agent: { status, pendingPermissions, archivedAt: null } };
  } }) } } as unknown as PaseoApi;
  return { directory, store, tasks, routines, paseo,
    status: (value: string) => { status = value; }, permissions: () => { pendingPermissions = [{}]; }, unavailable: () => { unavailable = true; },
    archive: () => archiveBot({ store, tasks: { list: async () => tasks }, routines: { list: async () => routines }, paseo }, 'helper'),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('归档和恢复保留身份、记忆、原生历史关联，归档阻止新执行并保护 Chief', async () => {
  const f = await fixture();
  try {
    await f.store.addMemory('helper', { kind: 'confirmed', content: '合成偏好' });
    await f.store.linkSession('helper', { sessionId: 'old-chat', title: '旧聊天' });
    const prior = (await f.store.getBot('helper'))!;
    const archived = await f.archive();
    assert.ok(archived.archivedAt);
    assert.equal((await f.archive()).archivedAt, archived.archivedAt, '重复请求不改变归档时间');
    const saved = (await new BotStore({ baseDir: f.directory }).getBot('helper'))!;
    assert.deepEqual(saved.sessions, prior.sessions);
    assert.deepEqual(saved.memories, prior.memories);
    assert.deepEqual(saved.bot.execution, prior.bot.execution);
    await assert.rejects(() => botSessionConfig(f.store, 'helper', { cwd: f.directory, config: { provider: 'pi/test' } }), /归档/);
    await assert.rejects(() => f.store.prepareCreation('helper', { requestId: 'new', fingerprint: 'a'.repeat(64) }), /归档/);
    const tracker = new TaskTracker({ baseDir: f.directory, store: f.store, getPaseo: () => f.paseo, cli: { command: '', cwd: f.directory } });
    await assert.rejects(() => tracker.requireActive('helper', 'old-chat'), /归档/, '旧会话的推进工具也不能绕过归档');
    await assert.rejects(() => f.store.setArchived('chief', true), /Chief|主 Bot/);
    const restored = await f.store.setArchived('helper', false);
    assert.equal(restored.archivedAt, undefined);
    assert.equal((await botSessionConfig(f.store, 'helper', { cwd: f.directory, config: { provider: 'pi/test' } })).config.provider, 'pi/test');
  } finally { await f.close(); }
});

test('未结束事项、未决创建、原生运行、权限与例程都阻止归档，失败不写入归档状态', async () => {
  for (const condition of ['task', 'creation', 'running', 'permission', 'routine', 'offline'] as const) {
    const f = await fixture();
    try {
      await f.store.linkSession('helper', { sessionId: 'chat' });
      if (condition === 'task') f.tasks.push({ agentId: 'work', title: '未交付', status: 'awaiting_review', followups: [], specialists: [] });
      if (condition === 'creation') await f.store.prepareCreation('helper', { requestId: 'unknown', fingerprint: 'a'.repeat(64) });
      if (condition === 'running') f.status('running');
      if (condition === 'permission') f.permissions();
      if (condition === 'routine') f.routines.push({ routine: { id: 'synthetic', botId: 'helper', name: '合成例程', prompt: '本地合成', cron: '0 0 * * *', timezone: 'UTC', continuity: false, state: 'unknown', execution: { provider: 'pi/test', cwd: f.directory } }, native: null });
      if (condition === 'offline') f.unavailable();
      await assert.rejects(() => f.archive(), /未结束|创建|回复|授权|例程|offline/);
      assert.equal((await f.store.getBot('helper'))!.bot.archivedAt, undefined, condition);
    } finally { await f.close(); }
  }
});

test('空闲持续聊天不当作未结束事项；已取消例程保留原生暂停记录仍可归档', async () => {
  const f = await fixture();
  try {
    await f.store.linkSession('helper', { sessionId: 'chat' });
    f.tasks.push({ agentId: 'chat', conversation: true, title: '持续聊天', status: 'active', followups: [], specialists: [] });
    f.routines.push({ routine: { id: 'synthetic', botId: 'helper', name: '旧例程', prompt: '合成', cron: '0 0 * * *', timezone: 'UTC', continuity: false, state: 'canceled', nativeId: 'native', execution: { provider: 'pi/test', cwd: f.directory } }, native: { status: 'paused', runs: [] } as any });
    assert.ok((await f.archive()).archivedAt);
  } finally { await f.close(); }
});

test('归档 RPC 默认从目录移除，可列出恢复；归档后的旧聊天不能再打开', async () => {
  const f = await fixture();
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = f.directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const server = { registerSettings: () => ({ read: async () => ({ status: 'invalid', error: '合成环境未配置模型' }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }), on: () => () => {}, before: () => () => {},
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name)!;
    assert.ok(entry, name);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo: f.paseo })) as any;
  }
  try {
    await invoke('bots.archive', { botId: 'helper' });
    assert.deepEqual((await invoke('bots.list', {})).bots.map((bot: any) => bot.id), ['chief']);
    assert.equal((await invoke('bots.list', { includeArchived: true })).bots.length, 2);
    await assert.rejects(() => invoke('bots.conversation.open', { botId: 'helper' }), /归档/);
    await assert.rejects(() => invoke('bots.archive', { botId: 'chief' }), /Chief|主 Bot/);
    await invoke('bots.restore', { botId: 'helper' });
    assert.equal((await invoke('bots.list', {})).bots.length, 2);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
    await f.close();
  }
});
