import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentCreateOptions, PaseoWorkspaceCreateOptions } from '@getpaseo/client';
import { BotStore, StoreError } from '../server/store.js';
import { startBotSession } from '../server/sessions.js';

const placement = (cwd: string) => ({ cwd, config: { provider: 'configured-provider/model' } });
const tools = { mount: async (botId: string, agentId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:1/bots/${botId}/${agentId}` }) };

test('技能文件在原生创建前校验；已有宿主MCP保留，能力修改进入幂等指纹', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-capabilities-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: 'Chief', role: '核对' });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'capabilities', title: '核对', prompt: '仅合成技能' };
    for (const path of ['./SKILL.md', join(directory, 'missing', 'SKILL.md'), directory]) {
      await store.updateBot('chief', { capabilities: { skills: [{ name: 'synthetic', path }] } });
      await assert.rejects(() => startBotSession(store, api, input, placement(directory), tools), /绝对路径|ENOENT|文件/);
    }
    assert.equal(created.length, 0);
    assert.deepEqual(await store.listPendingCreations('chief'), [], '无效技能不派发原生执行或创建意图');
    const path = join(directory, 'SKILL.md');
    await writeFile(path, '---\nname: synthetic\ndescription: 合成技能\n---\n只读取本目录合成文件');
    const selected = { type: 'http' as const, url: 'https://synthetic.invalid/selected' };
    await store.updateBot('chief', { capabilities: { skills: [{ name: 'synthetic', path }], mcpServers: { selected } } });
    const host = { ...placement(directory), config: { ...placement(directory).config, mcpServers: { existing: { type: 'http' as const, url: 'https://synthetic.invalid/host' } } } };
    await startBotSession(store, api, input, host, tools);
    assert.equal(created[0].config.mcpServers!.existing.type, 'http');
    assert.deepEqual(created[0].config.mcpServers!.selected, selected);
    assert.ok(created[0].config.mcpServers!['paseo-guys']);
    await store.updateBot('chief', { capabilities: { skills: [{ name: 'synthetic', path }], mcpServers: { selected: { ...selected, url: 'https://synthetic.invalid/changed' } } } });
    await assert.rejects(() => startBotSession(store, api, input, host, tools), (error: unknown) => error instanceof StoreError && error.code === 'request_conflict');
    assert.equal(created.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('同输入并发启动复用一个意图、Agent 和原生幂等键', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-concurrent-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对交付' });
    const created: PaseoAgentCreateOptions[] = [];
    const api = { workspaces: { create: async () => ({ agents: { create: (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => api.agents.create({ ...options, cwd: directory }) } }) }, agents: {
      create: async (options: PaseoAgentCreateOptions) => {
        created.push(options);
        if (created.length === 1) entered();
        if (created.length === 2) release();
        await gate;
        return { id: options.agentId!, workspaceId: 'ws-1' };
      },
      ref: () => ({ refresh: async () => null }),
    } } as unknown as PaseoApi;
    const input = { botId: 'chief', title: '核对资料', prompt: '检查指定资料' };
    const first = startBotSession(store, api, { ...input, requestId: 'r1' }, placement(directory), tools);
    await firstEntered;
    const second = startBotSession(store, api, { ...input, requestId: 'r2' }, placement(directory), tools);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.requestId, 'r1');
    assert.equal(created.length, 2, '请求并发到达宿主；实际启动去重由原生 receipt 负责');
    assert.deepEqual([...new Set(created.map(item => item.idempotencyKey))], ['paseo-guys:chief:r1']);
    assert.deepEqual([...new Set(created.map(item => item.agentId))], [a.agentId]);
    assert.deepEqual((await store.listPendingCreations('chief')).map(item => [item.requestId, item.status]), [['r1', 'created']]);
    assert.deepEqual((await store.listSessions('chief')).map(item => item.sessionId), [a.agentId]);
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 记录原生调用；`existing` 中的 agentId 视为回查可见，用于验证不重复创建。 */
function fakePaseo(existing: string[] = []) {
  const created: PaseoAgentCreateOptions[] = [];
  const workspaces: PaseoWorkspaceCreateOptions[] = [];
  const create = async (options: PaseoAgentCreateOptions) => {
    created.push(options);
    return { id: options.agentId ?? `agent-native-${created.length}`, workspaceId: 'ws-1' };
  };
  const api = {
    workspaces: {
      open: async (cwd: string) => ({ agents: { create: (options: Omit<PaseoAgentCreateOptions, 'cwd'>) => create({ ...options, cwd }) } }),
      create: async (options: PaseoWorkspaceCreateOptions) => {
        workspaces.push(options);
        const cwd = options.source.kind === 'directory' ? options.source.path : '';
        return { agents: { create: (input: Omit<PaseoAgentCreateOptions, 'cwd'>) => create({ ...input, cwd }) } };
      },
    },
    agents: {
      create,
      ref: (agentId: string) => ({
        refresh: async () => (existing.includes(agentId) ? { agent: { id: agentId, workspaceId: 'ws-1' } } : null),
      }),
    },
  } as unknown as PaseoApi;
  return { api, created, workspaces };
}

test('Bot 会话和固定委派使用后台工作区，保留目录并按 Bot 复用原生工作区', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-background-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '协调' });
    await store.createBot({ id: 'reader', name: '资料同事', role: '核对', execution: { cwd: join(directory, 'reader') } });
    const { api, created, workspaces } = fakePaseo();
    const first = await startBotSession(store, api, { botId: 'chief', requestId: 'first', title: '对话', prompt: '整理' }, placement(directory), tools);
    await startBotSession(store, api, { botId: 'chief', requestId: 'second', title: '其他工作', prompt: '检查' }, placement(directory), tools);
    await startBotSession(store, api, { botId: 'reader', requestId: 'child', parentAgentId: first.agentId, title: '资料核对', prompt: '核对来源' }, placement(directory), tools);
    assert.equal(workspaces.length, 3);
    assert.ok(workspaces.every(workspace => workspace.background === true));
    assert.ok(workspaces[0].idempotencyKey);
    assert.equal(workspaces[0].idempotencyKey, workspaces[1].idempotencyKey, '同 Bot 同目录交由原生幂等复用');
    assert.notEqual(workspaces[0].idempotencyKey, workspaces[2].idempotencyKey, '固定同事使用自己的工作区');
    assert.equal(created[0].cwd, directory);
    assert.equal(created[2].cwd, join(directory, 'reader'));
    assert.equal(created[2].parent, first.agentId, '隔离位置不改变原生父子关系');
    assert.equal(created[2].background, undefined, '后台标记属于工作区创建，不传给已有工作区内的 Agent');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class FlakyLinkStore extends BotStore {
  failNextCreation = true;
  override async completeCreation(...args: Parameters<BotStore['completeCreation']>): ReturnType<BotStore['completeCreation']> {
    if (this.failNextCreation) {
      this.failNextCreation = false;
      throw new Error('模拟落盘失败');
    }
    return super.completeCreation(...args);
  }
}

test('Bot 新会话传递确认记忆，使用原生幂等键并持久化会话关联', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-session-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对交付' });
    await store.addMemory('chief', { kind: 'confirmed', content: '明确记忆标记' });
    await store.addMemory('chief', { kind: 'candidate', content: '候选秘密标记' });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'stable-request', title: '核对资料', prompt: '检查指定资料' };

    const first = await startBotSession(store, api, input, placement(directory), tools);
    assert.equal(created.length, 1);
    assert.equal(first.requestId, 'stable-request');
    assert.equal(first.agentId, created[0].agentId);
    assert.equal(created[0].idempotencyKey, 'paseo-guys:chief:stable-request');
    assert.ok(created[0].config.systemPrompt?.includes('明确记忆标记'));
    assert.equal(created[0].config.systemPrompt?.includes('候选秘密标记'), false);
    assert.equal(created[0].config.modeId, undefined);
    assert.deepEqual(created[0].config.mcpServers, { 'paseo-guys': await tools.mount('chief', first.agentId) });

    // 同一 requestId 重试：已 created 且未 ack，只拿回已知 agentId，不再创建。
    assert.deepEqual(await startBotSession(store, api, input, placement(directory), tools), first);
    assert.equal(created.length, 1);

    const links = await new BotStore({ baseDir: directory }).listSessions('chief');
    assert.deepEqual(links.map((link) => [link.sessionId, link.workspaceId]), [[first.agentId, 'ws-1']]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('显式原生默认清除宿主模式，配置变化仍受原请求幂等约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-config-session-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对', instructions: '长期说明', execution: { modeId: null, thinkingOptionId: null } });
    const { api, created } = fakePaseo();
    const defaults = { cwd: directory, config: { provider: 'configured/model', modeId: 'host-mode', thinkingOptionId: 'host-thinking' } };
    const input = { botId: 'chief', requestId: 'config-request', title: '任务', prompt: '核对' };
    await startBotSession(store, api, input, defaults, tools);
    assert.equal(created[0].config.provider, 'configured/model');
    assert.equal(created[0].config.modeId, undefined);
    assert.equal(created[0].config.thinkingOptionId, undefined);
    assert.match(created[0].config.systemPrompt!, /长期说明/);
    await store.updateBot('chief', { instructions: '更新后的长期说明', execution: { cwd: join(directory, 'new') } });
    await assert.rejects(() => startBotSession(store, api, input, defaults, tools), (error: unknown) => error instanceof StoreError && error.code === 'request_conflict');
    assert.equal(created.length, 1);
    await startBotSession(store, api, { ...input, requestId: 'new-config-request' }, defaults, tools);
    assert.equal(created[1].cwd, join(directory, 'new'));
    assert.equal(created[1].config.modeId, 'host-mode');
    assert.match(created[1].config.systemPrompt!, /更新后的长期说明/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('有效工作目录按 Bot 覆盖后校验，相对路径不创建原生会话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-config-cwd-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对', execution: { cwd: directory } });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'cwd-request', title: '任务', prompt: '核对' };
    await startBotSession(store, api, input, placement('unused-relative-default'), tools);
    assert.equal(created[0].cwd, directory);
    await store.updateBot('chief', { execution: { cwd: 'relative-folder' } });
    await assert.rejects(() => startBotSession(store, api, { ...input, requestId: 'bad-cwd' }, placement(directory), tools), /宿主绝对路径/);
    assert.equal(created.length, 1);
    assert.equal((await store.listPendingCreations('chief')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('身份提示词改变后原requestId不能静默复用旧身份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-identity-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '原职责' });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'identity-request', title: '工作', prompt: '核对' };
    await startBotSession(store, api, input, placement(directory), tools);
    const record = (await store.getBot('chief'))!;
    record.bot.role = '更新后的职责';
    await writeFile(join(directory, 'chief.json'), JSON.stringify(record));
    await assert.rejects(() => startBotSession(store, api, input, placement(directory), tools), (error: unknown) => error instanceof StoreError && error.code === 'request_conflict');
    assert.equal(created.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('固定同事委派使用接收方身份和记忆，绑定原生父事项且不跨父项复用请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-colleague-session-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '协调交付' });
    await store.createBot({ id: 'researcher', name: '资料同事', role: '读取资料并给出可核对结论' });
    await store.addMemory('chief', { kind: 'confirmed', content: 'Chief 的无关私人记忆' });
    await store.addMemory('researcher', { kind: 'confirmed', content: '资料结论须附来源' });
    await store.addMemory('researcher', { kind: 'candidate', content: '尚未确认的候选偏好' });
    const { api, created } = fakePaseo();
    const input = { botId: 'researcher', requestId: 'delegation-one', parentAgentId: 'chief-native', title: '核对资料', prompt: '只核对指定合成资料并写 findings.md' };
    const result = await startBotSession(store, api, input, placement(directory), tools);
    assert.equal(created[0].parent, 'chief-native');
    assert.match(created[0].config.systemPrompt!, /资料同事/);
    assert.match(created[0].config.systemPrompt!, /资料结论须附来源/);
    assert.doesNotMatch(created[0].config.systemPrompt!, /Chief 的无关私人记忆|尚未确认的候选偏好/);
    assert.equal(created[0].labels?.['paseo-guys.bot'], 'researcher');
    assert.deepEqual(created[0].config.mcpServers, { 'paseo-guys': await tools.mount('researcher', result.agentId) });
    assert.deepEqual(await store.listSessions('chief'), []);
    assert.equal((await store.listSessions('researcher'))[0].sessionId, result.agentId);
    assert.deepEqual(await startBotSession(store, api, input, placement(directory), tools), result);
    assert.equal(created.length, 1);
    const anotherParent = { ...input, parentAgentId: 'another-chief' };
    await assert.rejects(() => startBotSession(store, api, anotherParent, placement(directory), tools),
      (error: unknown) => error instanceof StoreError && error.code === 'request_conflict');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('原生创建成功后落盘失败：UI 丢 requestId 重试复用同一意图，不重复创建', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-session-retry-'));
  try {
    await new BotStore({ baseDir: directory }).createBot({ id: 'chief', name: '主 Bot', role: '核对交付' });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'r1', title: '核对资料', prompt: '检查指定资料' };

    await assert.rejects(() => startBotSession(new FlakyLinkStore({ baseDir: directory }), api, input, placement(directory), tools), /落盘失败/);
    assert.equal(created.length, 1);

    // UI 丢了 requestId，新实例用新 requestId 重试同一输入：复用原意图与原幂等键。
    const retried = await startBotSession(new BotStore({ baseDir: directory }), api, { ...input, requestId: 'r2' }, placement(directory), tools);
    assert.deepEqual(retried, { agentId: created[0].agentId, requestId: 'r1' });
    const keys = new Set(created.map((options) => options.idempotencyKey));
    assert.deepEqual([...keys], ['paseo-guys:chief:r1']);
    assert.equal(created.length, 2, '原生仍会用同一 agentId/幂等键再调一次，由原生幂等去重');

    const store = new BotStore({ baseDir: directory });
    assert.deepEqual(
      (await store.listSessions('chief')).map((link) => link.sessionId),
      [created[0].agentId],
    );
    assert.deepEqual(
      (await store.getBot('chief'))?.creationIntents.map((intent) => [intent.requestId, intent.status, intent.acknowledged]),
      [['r1', 'created', false]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending 意图先回查原生会话：回查失败报未知，已存在则不重复创建', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-session-refresh-'));
  try {
    const input = { botId: 'chief', requestId: 'r1', title: '核对资料', prompt: '检查指定资料' };
    await new BotStore({ baseDir: directory }).createBot({ id: 'chief', name: '主 Bot', role: '核对交付' });
    // 先制造 pending 意图（原生已创建、落盘失败）
    await assert.rejects(
      () => startBotSession(new FlakyLinkStore({ baseDir: directory }), fakePaseo().api, input, placement(directory), tools),
      /落盘失败/,
    );
    const pending = (await new BotStore({ baseDir: directory }).listPendingCreations('chief'))[0];
    assert.equal(pending?.status, 'pending');

    // 回查失败：报未知，且不重复创建
    const broken = {
      agents: {
        create: async () => assert.fail('不得重复创建'),
        ref: () => ({ refresh: async () => { throw new Error('daemon 不可达'); } }),
      },
    } as unknown as PaseoApi;
    await assert.rejects(
      () => startBotSession(new BotStore({ baseDir: directory }), broken, { ...input, requestId: 'r2' }, placement(directory), tools),
      /无法回查/,
    );

    // 回查可见：直接用已知 agentId 补完，不再 create
    const visible = fakePaseo([pending.agentId]);
    assert.deepEqual(
      await startBotSession(new BotStore({ baseDir: directory }), visible.api, { ...input, requestId: 'r3' }, placement(directory), tools),
      { agentId: pending.agentId, requestId: 'r1' },
    );
    assert.equal(visible.created.length, 0);
    assert.deepEqual(
      (await new BotStore({ baseDir: directory }).listPendingCreations('chief')).map((intent) => [intent.requestId, intent.status]),
      [['r1', 'created']],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('不同输入是独立新事项：不吞掉、不被旧未决阻挡，ack 后从待确认列表消失', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-session-independent-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对交付' });
    const { api, created } = fakePaseo();
    const input = { botId: 'chief', requestId: 'r1', title: '核对资料', prompt: '检查指定资料' };
    await startBotSession(store, api, input, placement(directory), tools);

    // 旧创建未 ack 且输入不同：登为独立新意图，不重复使用旧会话也不报错
    const second = await startBotSession(store, api, { ...input, requestId: 'r2', prompt: '另一个目标' }, placement(directory), tools);
    assert.deepEqual(second, { agentId: created[1].agentId, requestId: 'r2' });
    assert.equal(created.length, 2);
    assert.notEqual(second.agentId, created[0].agentId);

    // 两个未决创建都可见
    assert.deepEqual(
      (await store.listPendingCreations('chief')).map((intent) => [intent.requestId, intent.status, intent.acknowledged]),
      [
        ['r1', 'created', false],
        ['r2', 'created', false],
      ],
    );

    // 同一 requestId 改输入被拒绝，且不新增会话
    await assert.rejects(
      () => startBotSession(store, api, { ...input, prompt: '被改掉的目标' }, placement(directory), tools),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'request_conflict');
        return true;
      },
    );
    assert.equal(created.length, 2);

    // 用户 ack 一个，另一个仍可见
    await store.acknowledgeCreation('chief', 'r1');
    assert.deepEqual(
      (await store.listPendingCreations('chief')).map((intent) => intent.requestId),
      ['r2'],
    );
    await store.acknowledgeCreation('chief', 'r2');
    assert.deepEqual(await store.listPendingCreations('chief'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
