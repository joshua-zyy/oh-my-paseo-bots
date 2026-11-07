import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';
import { ChannelStore } from '../server/channels.js';
import * as rpc from '../shared/channels.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-channels-'));
  const bots = new BotStore({ baseDir: directory });
  await bots.ensureChief();
  await bots.createBot({ id: 'helper', name: '资料同事', role: '核对资料' });
  const channels = new ChannelStore({ baseDir: directory, bots });
  const input = () => rpc.createChannel.input.parse({ id: randomUUID(), name: '项目讨论', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: directory, instructions: '先核对输入，不执行外发。' });
  return { directory, bots, channels, input, close: () => rm(directory, { recursive: true, force: true }) };
}

test('频道保存场景配置并可重新读取，同事身份、私聊及记忆不被复制或改写', async () => {
  const host = await fixture();
  try {
    await host.bots.addMemory('chief', { kind: 'confirmed', content: '私聊确认约定' });
    const before = await host.bots.getBot('chief');
    const input = host.input();
    const saved = await host.channels.create(input);
    assert.equal(saved.id, input.id);
    assert.deepEqual(saved.memberIds, ['chief', 'helper']);
    const restored = new ChannelStore({ baseDir: host.directory, bots: host.bots });
    assert.deepEqual(await restored.get(saved.id), saved);
    const second = await restored.create({ ...host.input(), name: '另一个场景', cwd: join(host.directory, 'second-scene') });
    assert.deepEqual(second.memberIds, saved.memberIds, '同一同事可参与不同频道，不重建同事身份');
    assert.equal((await restored.list()).length, 2);
    const { id, ...details } = input;
    const changed = await restored.update(id, { ...details, name: '交付核对', adminBotId: 'helper', cwd: join(host.directory, 'not-created'), instructions: '只制作可检查的草案。' });
    assert.equal(changed.adminBotId, 'helper');
    assert.equal(changed.name, '交付核对');
    assert.equal(changed.cwd, join(host.directory, 'not-created'));
    assert.equal(changed.createdAt, saved.createdAt);
    assert.deepEqual(await host.bots.getBot('chief'), before);
    assert.doesNotMatch(await readFile(join(host.directory, 'channels', `${id}.json`), 'utf8'), /私聊确认约定|sessions|memories/);
    assert.equal((await host.bots.listBots()).length, 2, '频道不是伪装成同事的额外Bot');
  } finally { await host.close(); }
});

test('频道输入约束管理员归属及成员唯一性，未知同事和相对目录不能写入', async () => {
  const host = await fixture();
  try {
    const input = host.input();
    assert.throws(() => rpc.createChannel.input.parse({ ...input, adminBotId: 'outside' }));
    assert.throws(() => rpc.createChannel.input.parse({ ...input, memberIds: ['chief', 'chief'] }));
    assert.throws(() => rpc.createChannel.input.parse({ ...input, memberIds: [] }));
    assert.throws(() => rpc.createChannel.input.parse({ ...input, id: '../outside' }));
    assert.throws(() => rpc.createChannel.input.parse({ ...input, permissions: 'full-access' }));
    await assert.rejects(host.channels.create({ ...input, memberIds: ['chief', 'missing'] }), /同事.*不存在/);
    await assert.rejects(host.channels.create({ ...input, cwd: 'relative/folder' }), /绝对路径/);
    assert.deepEqual(await host.channels.list(), []);
  } finally { await host.close(); }
});

test('同一创建标识可回查而不重复，归档可恢复且不丢配置', async () => {
  const host = await fixture();
  try {
    const input = host.input();
    const saved = await host.channels.create(input);
    assert.deepEqual(await host.channels.create(input), saved);
    await assert.rejects(host.channels.create({ ...input, name: '另一份输入' }), /已存在/);
    const archived = await host.channels.setArchived(saved.id, true);
    assert.ok(archived.archivedAt);
    assert.deepEqual(await host.channels.list(), []);
    assert.deepEqual(await host.channels.list(true), [archived]);
    assert.deepEqual(await host.channels.setArchived(saved.id, true), archived);
    const { id, ...details } = input;
    await assert.rejects(host.channels.update(id, details), /先恢复/);
    const restored = await host.channels.setArchived(saved.id, false);
    assert.equal(restored.archivedAt, undefined);
    assert.deepEqual(restored.memberIds, saved.memberIds);
    assert.equal(restored.instructions, saved.instructions);
    assert.equal(restored.createdAt, saved.createdAt);
  } finally { await host.close(); }
});

test('损坏频道记录不能被当作空目录或被更新覆盖', async () => {
  const host = await fixture();
  try {
    const input = host.input();
    await host.channels.create(input);
    const file = join(host.directory, 'channels', `${input.id}.json`);
    await writeFile(file, '{broken');
    await assert.rejects(host.channels.get(input.id), /频道存档损坏/);
    await assert.rejects(host.channels.list(), /频道存档损坏/);
    const { id, ...details } = input;
    await assert.rejects(host.channels.update(id, details), /频道存档损坏/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally { await host.close(); }
});

test('频道管理RPC可完成创建、编辑、归档与恢复，不调用执行/会话API', async () => {
  const host = await fixture();
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = host.directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: unknown) => unknown }>();
  const server = { registerSettings: () => ({ read: async () => ({ status: 'ready', values: {} }) }), addHook: () => () => {}, handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }) } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  const invoke = async (name: string, input: unknown) => {
    const entry = handlers.get(name);
    assert.ok(entry, `必须注册${name}`);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo: new Proxy({}, { get() { throw new Error('配置不应启动执行或读取原生会话'); } }) }));
  };
  try {
    const input = host.input();
    await invoke('bots.channels.create', input);
    const { id, ...details } = input;
    const changed = await invoke('bots.channels.update', { channelId: id, details: { ...details, name: '已编辑' } }) as { name: string };
    assert.equal(changed.name, '已编辑');
    await invoke('bots.channels.archive', { channelId: id, archived: true });
    assert.deepEqual(await invoke('bots.channels.list', {}), []);
    await invoke('bots.channels.archive', { channelId: id, archived: false });
    assert.equal((await invoke('bots.channels.list', {}) as unknown[]).length, 1);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
    await host.close();
  }
});
