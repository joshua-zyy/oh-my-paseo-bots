import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginServerContext, PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';
import { BotMcp } from '../server/mcp.js';

type Open = (event: { request: PluginSessionOpenRequest }, context: { paseo: PaseoApi }) => Promise<PluginSessionOpenRequest | void>;
async function fixture(t: TestContext, run: (f: { store: BotStore; open: Open; associate: () => Promise<void>; request: PluginSessionOpenRequest; paseo: PaseoApi }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-claude-memory-'));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = dir;
  t.mock.method(console, 'error', () => undefined);
  const hooks = new Map<string, Open>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: 'ready', values: { cwd: dir, provider: 'claude/existing-model' } }) }),
    handle: () => undefined,
    addHook: (name: string, hook: Open) => { hooks.set(name, hook); return () => hooks.delete(name); },
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  const store = new BotStore({ baseDir: dir });
  await store.createBot({ id: 'chief', name: '合成 Bot', role: '只测会话环境' });
  const request: PluginSessionOpenRequest = {
    agentId: randomUUID(), workspaceId: null, provider: 'claude', cwd: dir,
    reason: 'create', purpose: 'interactive', title: '合成开口',
    background: true, labels: { 'paseo-guys.bot': 'chief' }, metadata: {}, tools: [], mcpServers: {},
    env: { EXISTING_SESSION_VALUE: 'keep', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
  };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: request.labels } }) }) } } as unknown as PaseoApi;
  const associate = () => (hooks.get('agent.create.after') as unknown as (event: unknown, context: unknown) => Promise<void>)({ agent: { id: request.agentId, workspaceId: null, parentAgentId: null, provider: 'claude', cwd: dir, title: '合成纳管' } }, { paseo });
  try { await run({ store, open: hooks.get('agent.open.before')!, associate, request, paseo }); }
  finally {
    await cleanup();
    if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('Claude Bot 首次/恢复/刷新/历史打开均关闭自动记忆且保留其它环境，不依赖原生回查', async t => fixture(t, async f => {
  await f.store.linkSession('chief', { sessionId: f.request.agentId });
  const paseo = { agents: { ref: () => ({ refresh: async () => { throw new Error('首次打开尚无可回查会话'); } }) } } as unknown as PaseoApi;
  for (const reason of ['create', 'resume', 'refresh', 'import'] as const) {
    for (const purpose of ['interactive', 'history'] as const) {
      const request = { ...f.request, reason, purpose, env: Object.freeze({ ...f.request.env }) };
      const result = await f.open({ request }, { paseo });
      assert.deepEqual(result, { ...request, env: { EXISTING_SESSION_VALUE: 'keep', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
      assert.equal(request.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '0', '不修改宿主/调用方传入环境');
    }
  }
}));

test('会话关联尚未完成时，真实 Bot 创建意图也关闭自动记忆', async t => fixture(t, async f => {
  const { intent } = await f.store.prepareCreation('chief', { requestId: randomUUID(), fingerprint: 'a'.repeat(64) });
  const request = { ...f.request, agentId: intent.agentId };
  assert.equal((await f.store.getBot('chief'))!.sessions.length, 0);
  const result = await f.open({ request }, { paseo: f.paseo });
  assert.equal(result?.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
}));

test('已核实 Claude Bot 的 MCP 预热失败不撤销记忆关闭，仍保留原非阻断开口', async t => fixture(t, async f => {
  await f.store.linkSession('chief', { sessionId: f.request.agentId });
  t.mock.method(BotMcp.prototype, 'mount', async () => { throw new Error('synthetic MCP warming failure'); });
  const result = await f.open({ request: f.request }, { paseo: f.paseo });
  assert.equal(result?.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
}));

test('普通 Claude/未知 Bot 标签/其他 Provider 不改变自动记忆或其它设置', async t => fixture(t, async f => {
  for (const labels of [{}, { 'paseo-guys.bot': 'missing' }] as Record<string, string>[]) {
    const request = { ...f.request, labels };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels } }) }) } } as unknown as PaseoApi;
    assert.equal(await f.open({ request }, { paseo }), undefined, '未纳管普通会话不变');
    assert.equal(request.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '0');
  }
  await f.store.linkSession('chief', { sessionId: f.request.agentId });
  for (const provider of ['pi', 'codex', 'claude-custom']) {
    const request = { ...f.request, provider };
    assert.equal(await f.open({ request }, { paseo: f.paseo }), undefined);
    assert.equal(request.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '0');
  }
}));
