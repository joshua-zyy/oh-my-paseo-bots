import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';

async function legacyHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === 'v2') continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else hashes[relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await walk(root);
  return hashes;
}

test('293 份旧文件在旧会话全部钩子和 v2 主总管读写窗口中 SHA-256 不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-v2-isolation-'));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = root;
  const oldFiles = ['chief.json', 'legacy-reader.json', 'channels/archive.json', 'mail/archive.json', 'routines/archive.json', 'journal/archive.json', 'mcp/endpoint.json', 'tasks/chief.json'];
  for (let i = oldFiles.length; i < 293; i++) oldFiles.push(`legacy-${i}.json`);
  for (const file of oldFiles) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), JSON.stringify({ schemaVersion: 1, retained: file, bot: { id: file === 'chief.json' ? 'chief' : 'legacy-reader' }, sessions: [{ sessionId: 'legacy-native' }] }));
  }
  const before = await legacyHashes(root);
  assert.equal(Object.keys(before).length, 293);
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: unknown) => unknown }>();
  const hooks = new Map<string, (event: any, context: any) => Promise<any>>();
  const created = new Map<string, PaseoAgentCreateOptions>();
  let refreshes = 0;
  const cwd = join(root, 'v2', 'workspace', 'chief');
  const paseo = {
    workspaces: {
      create: async (options: any) => {
        assert.equal(options.background, true);
        assert.match(options.title, /^oh-my-paseo-bots:v2:/);
        assert.equal(options.source.path, cwd);
        return { agents: { create: async (input: PaseoAgentCreateOptions) => {
          assert.equal(input.background, true);
          assert.equal(input.prompt, undefined, '打开空聊天不发起模型轮次');
          created.set(input.agentId!, input);
          return { id: input.agentId!, workspaceId: 'synthetic-v2-workspace' };
        } } };
      },
      ref: () => ({ refresh: async () => ({ title: 'oh-my-paseo-bots:v2:chief', background: true, workspaceDirectory: cwd }) }),
    },
    agents: { ref: (id: string) => ({ refresh: async () => {
      refreshes++;
      const input = created.get(id);
      assert.ok(input, '未登记旧 Agent 不得先做原生回查');
      return { agent: { id, title: input.title, workspaceId: 'synthetic-v2-workspace', provider: 'claude', cwd, status: 'idle', pendingPermissions: [], archivedAt: null, labels: input.labels } };
    } }) },
  } as unknown as PaseoApi;
  const cleanup = contribute({
    registerSettings: () => ({ read: async () => ({ status: 'ready', values: { cwd, provider: 'claude/synthetic-model' } }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    addHook: (name: string, hook: (event: any, context: any) => Promise<any>) => { hooks.set(name, hook); return () => hooks.delete(name); },
  } as unknown as PluginServerContext);
  async function invoke(name: string, input: unknown) {
    const binding = handlers.get(name)!;
    return binding.contract.output.parse(await binding.handler(binding.contract.input.parse(input), { paseo }));
  }
  async function oldHooks() {
    const prior = refreshes;
    const agent = { id: 'legacy-native', title: '旧会话', parentAgentId: null, workspaceId: null, provider: 'claude', cwd: root, metadata: {} };
    for (const name of ['agent.create.after', 'agent.turn.before', 'agent.turn.after', 'agent.archive.after']) {
      await hooks.get(name)!({ agent, turnId: 'old-turn', outcome: { kind: 'failed', error: { message: '旧轮次，不纳管' } } }, { paseo });
    }
    for (const reason of ['create', 'resume', 'refresh', 'import']) for (const purpose of ['interactive', 'history']) {
      const request = { agentId: agent.id, provider: 'claude', cwd: root, reason, purpose, labels: { 'paseo-guys.bot': 'chief' }, env: { RETAINED: '1' }, metadata: {} };
      assert.equal(await hooks.get('agent.open.before')!({ request }, { paseo }), undefined);
      assert.deepEqual(request.env, { RETAINED: '1' });
    }
    const request = { title: 'oh-my-paseo-bots:chief', background: false, callerAgentId: agent.id, source: { kind: 'directory', path: root } };
    assert.equal(await hooks.get('workspace.create.before')!({ request }, { paseo }), undefined);
    assert.equal(refreshes, prior, '旧 botId 标签不触发原生恢复、关联或写入');
    assert.deepEqual(await legacyHashes(root), before);
  }
  try {
    assert.deepEqual([...hooks.keys()].sort(), ['agent.archive.after', 'agent.create.after', 'agent.open.before', 'agent.turn.after', 'agent.turn.before', 'workspace.create.before']);
    await oldHooks();
    const list = await invoke('bots.list', {}) as { bots: { id: string }[] };
    assert.deepEqual(list.bots.map(bot => bot.id), ['chief'], '根层旧 Bot 不进入 v2 注册表');
    await invoke('bots.create', { id: 'writer', name: '合成专长', role: '仅核对合成资料' });
    await assert.rejects(() => invoke('bots.conversation.open', { botId: 'writer' }), /专长预设/);
    const main = await invoke('bots.conversation.open', { botId: 'chief' }) as { agentId: string };
    await invoke('bots.memory.save', { botId: 'chief', kind: 'confirmed', content: '合成 v2 约定' });
    const store = new BotStore({ baseDir: root });
    assert.equal((await store.getBot('chief'))?.schemaVersion, 2);
    assert.equal((await store.getBot('writer'))?.schemaVersion, 2);
    assert.equal((await store.getBot('chief'))?.sessions[0].sessionId, main.agentId);
    await stat(join(root, 'v2', 'mcp', 'endpoint.json'));
    await stat(join(root, 'v2', 'tasks', 'chief.json'));
    assert.equal(JSON.parse(await readFile(join(root, 'v2', 'specialists', 'writer.json'), 'utf8')).schemaVersion, 2);
    await oldHooks(); // chief 已在 v2 存在后，旧同名会话仍不得冒认。
    assert.deepEqual(await legacyHashes(root), before);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('linkSession 相同/省略/显式 null 参数真幂等：更新时间、SHA、mtime 与写盘调用均不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-v2-link-'));
  try {
    const store = new BotStore({ baseDir: root });
    await store.ensureChief();
    await store.linkSession('chief', { sessionId: 'native-main', title: '主聊天', workspaceId: null });
    const file = join(root, 'v2', 'chief.json');
    await utimes(file, 946684800, 946684800);
    const before = await readFile(file);
    const record = await store.getBot('chief');
    const beforeStat = await stat(file);
    const writer = store as unknown as { writeDocument: (...args: unknown[]) => Promise<void> };
    const write = writer.writeDocument.bind(store);
    let writes = 0;
    writer.writeDocument = async (...args) => { writes++; await write(...args); };
    for (const input of [{ sessionId: 'native-main', title: '主聊天', workspaceId: null }, { sessionId: 'native-main' }, { sessionId: 'native-main', workspaceId: null }]) {
      await store.linkSession('chief', input);
    }
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(file), before);
    assert.equal((await store.getBot('chief'))?.bot.updatedAt, record?.bot.updatedAt);
    assert.equal((await stat(file)).mtimeMs, beforeStat.mtimeMs);
    await store.linkSession('chief', { sessionId: 'native-main', title: '更新标注' });
    assert.equal(writes, 1);
    assert.equal((await store.listSessions('chief'))[0].title, '更新标注');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v2 目录里的旧版本/错身份 JSON 被拒绝，不回写或替换；根层历史始终只读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-v2-schema-'));
  try {
    const store = new BotStore({ baseDir: root });
    await store.ensureChief();
    const file = join(root, 'v2', 'chief.json');
    const document = JSON.parse(await readFile(file, 'utf8'));
    for (const invalid of [{ ...document, schemaVersion: 1 }, { ...document, bot: { ...document.bot, id: 'other' } }]) {
      const bytes = JSON.stringify(invalid);
      await writeFile(file, bytes);
      await assert.rejects(() => store.ensureChief(), /schema|identity/);
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
