import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PaseoApi } from '@getpaseo/client';
import type { MemoryOrigin } from '../shared/memory.js';
import { BotStore } from '../server/store.js';
import { BotJournal } from '../server/journal.js';
import { TeamMemoryStore } from '../server/team-memory.js';
import { ChannelStore } from '../server/channels.js';
import { ChannelContextStore } from '../server/channel-context.js';
import { channelIdSchema } from '../shared/channels.js';
import { createBotMcpServer, type BotMcpToolScope } from '../server/mcp.js';
import { rememberExplicit, correctExplicitMemory, publishExplicitTeamMemory } from '../server/memory.js';

const quote = (text: string): MemoryOrigin => ({ type: 'message', agentId: 'native-chief', userQuote: text });
const manual: MemoryOrigin = { type: 'manual' };
interface Row { id: string; content: string; origin?: MemoryOrigin; contentOrigin?: MemoryOrigin | null }
interface Result { memories: Row[]; total: number }
async function reader(scope: BotMcpToolScope) {
  const server = createBotMcpServer(scope), client = new Client({ name: 'memory-origin-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return {
    async read(args: Record<string, unknown> = {}): Promise<Result> {
      const result = await client.callTool({ name: 'read_memories', arguments: args }); assert.notEqual(result.isError, true);
      const blocks = result.content as { type: string; text: string }[];
      return JSON.parse(blocks.find(block => block.type === 'text')!.text);
    },
    close: async () => { await client.close(); await server.close(); },
  };
}
async function fixture(run: (f: { dir: string; file: string; store: BotStore; team: TeamMemoryStore; scope: BotMcpToolScope; api: PaseoApi; message(value: string): void; read(args?: Record<string, unknown>): Promise<Result> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-memory-origin-'));
  let connected: Awaited<ReturnType<typeof reader>> | undefined;
  try {
    const store = new BotStore({ baseDir: dir }); await store.ensureChief(); await store.linkSession('chief', { sessionId: 'native-chief' });
    await store.createBot({ id: 'other', name: '其他同事', role: '验证' });
    const team = new TeamMemoryStore(dir), journal = new BotJournal({ baseDir: join(dir, 'journal') });
    const scope: BotMcpToolScope = { botId: 'chief', agentId: 'native-chief', store, journal, readTeamMemories: () => team.confirmed() };
    let message = '';
    const api = { agents: { ref: () => ({ timeline: { refetch: async () => ({ error: null, epoch: 'e', hasOlder: false, entries: [{ item: { type: 'user_message', text: message } }] }) } }) } } as unknown as PaseoApi;
    connected = await reader(scope);
    await run({ dir, file: join(dir, 'chief.json'), store, team, scope, api, message: value => { message = value; }, read: connected.read });
  } finally { await connected?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('MCP分别表达创建来源和当前正文出处，不扩大为完整历史或改变存档', async () => fixture(async f => {
  const initial = '请记住：默认中文。'; f.message(initial);
  const saved = await rememberExplicit(f.store, f.api, 'chief', 'native-chief', { content: '默认中文', userQuote: initial });
  const corrected = '请纠正：默认英文。'; f.message(corrected);
  await correctExplicitMemory(f.store, f.api, 'chief', 'native-chief', { memoryId: saved.id, currentContent: '默认中文', content: '默认英文', userQuote: corrected });
  const before = await readFile(f.file, 'utf8');
  const row = (await f.read({ memoryIds: [saved.id] })).memories[0];
  assert.equal(row.content, '默认英文'); assert.deepEqual(row.origin, quote(initial)); assert.deepEqual(row.contentOrigin, quote(corrected));
  assert(!('history' in row)); assert(!('updatedAt' in row));
  assert.equal(await readFile(f.file, 'utf8'), before);
}));

test('候选确认及仅kind变化不把确认者改称正文作者，候选仍不供给', async () => fixture(async f => {
  const origin: MemoryOrigin = { type: 'agent', agentId: 'candidate-author' };
  const entry = await f.store.addMemory('chief', { kind: 'candidate', content: 'A', origin });
  assert.equal((await f.read()).memories.length, 0);
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed', origin: manual });
  assert.deepEqual((await f.read()).memories[0].contentOrigin, origin);
  await f.store.updateMemory('chief', entry.id, { kind: 'candidate' });
  assert.equal((await f.read()).memories.length, 0);
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed' });
  assert.deepEqual((await f.read()).memories[0].contentOrigin, origin, '确认来源缺失也不抹掉已知正文出处');
}));

test('正文与kind同改取正文写入操作，无变化编辑/重复保存的新来源不伪装成新事件', async () => fixture(async f => {
  const entry = await f.store.addMemory('chief', { kind: 'candidate', content: 'A', origin: { type: 'agent', agentId: 'initial' } });
  const changed = quote('请确认新的正文B');
  await f.store.updateMemory('chief', entry.id, { content: 'B', kind: 'confirmed', origin: changed });
  await f.store.updateMemory('chief', entry.id, { kind: 'candidate', origin: manual });
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed', origin: manual });
  const before = await readFile(f.file, 'utf8');
  await f.store.updateMemory('chief', entry.id, { content: 'B', kind: 'confirmed', origin: quote('无变化调用') });
  await f.store.addMemory('chief', { content: 'B', kind: 'confirmed', origin: quote('重复保存') });
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.deepEqual((await f.read()).memories[0].contentOrigin, changed);
}));

test('A→B→A最近正文写入缺出处时停未知，随后kind/归档恢复不回退原引文', async () => fixture(async f => {
  const entry = await f.store.addMemory('chief', { content: 'A', kind: 'confirmed', origin: quote('创建A') });
  await f.store.updateMemory('chief', entry.id, { content: 'B', origin: quote('写入B') });
  await f.store.updateMemory('chief', entry.id, { content: 'A' });
  await f.store.updateMemory('chief', entry.id, { kind: 'candidate', origin: manual });
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed', origin: manual });
  assert.equal((await f.read()).memories[0].contentOrigin, null);
  await f.store.removeMemory('chief', entry.id); assert.equal((await f.read()).memories.length, 0);
  await f.store.restoreMemory('chief', entry.id);
  assert.equal((await f.read()).memories[0].contentOrigin, null);
  assert.deepEqual((await f.read()).memories[0].origin, quote('创建A'));
}));

test('按数组操作顺序读最后正文写入，不按相同/倒退时间排序，也不原地反转history', async () => fixture(async f => {
  const entry = await f.store.addMemory('chief', { content: 'A', kind: 'confirmed', origin: quote('创建A') });
  await f.store.updateMemory('chief', entry.id, { content: 'B', origin: quote('写入B') });
  await f.store.updateMemory('chief', entry.id, { content: 'A', origin: quote('最后写回A') });
  await f.store.updateMemory('chief', entry.id, { kind: 'candidate', origin: manual });
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed', origin: manual });
  const raw = JSON.parse(await readFile(f.file, 'utf8'));
  raw.memories[0].history.forEach((event: { at: string }, index: number) => { event.at = index < 2 ? '2026-11-09T10:00:00Z' : '2026-11-08T10:00:00Z'; });
  await writeFile(f.file, JSON.stringify(raw));
  const shared = (await f.store.getContextMemories('chief'))[0], before = JSON.stringify(shared);
  const local = await reader({ ...f.scope, memoryStore: { getContextMemories: async () => [shared], addMemory: async () => { throw new Error('read must not write'); } } });
  try {
    assert.deepEqual((await local.read()).memories[0].contentOrigin, quote('最后写回A'));
    assert.deepEqual((await local.read()).memories[0].contentOrigin, quote('最后写回A'));
    assert.equal(JSON.stringify(shared), before);
  } finally { await local.close(); }
}));

test('真实旧版无origin/history仍确认可读不回写，后来的明确正文纠正可建立出处', async () => fixture(async f => {
  const entry = await f.store.addMemory('chief', { content: '旧值', kind: 'confirmed' });
  const raw = JSON.parse(await readFile(f.file, 'utf8')); delete raw.memories[0].origin; delete raw.memories[0].history;
  const before = JSON.stringify(raw); await writeFile(f.file, before);
  const old = (await f.read()).memories[0]; assert.equal(old.content, '旧值'); assert.equal(old.contentOrigin, null); assert.equal(old.origin, undefined);
  assert.equal(await readFile(f.file, 'utf8'), before);
  await f.store.updateMemory('chief', entry.id, { kind: 'candidate', origin: manual });
  await f.store.updateMemory('chief', entry.id, { kind: 'confirmed', origin: manual });
  assert.equal((await f.read()).memories[0].contentOrigin, null);
  const message = '请纠正为新值'; f.message(message);
  await correctExplicitMemory(f.store, f.api, 'chief', 'native-chief', { memoryId: entry.id, currentContent: '旧值', content: '新值', userQuote: message });
  assert.deepEqual((await f.read()).memories[0].contentOrigin, quote(message));
  assert.equal((await f.read()).memories[0].origin, undefined);
}));

test('合并旧ID空读不回退目标或全量，目标与恢复原条目各保留自己正文的出处', async () => fixture(async f => {
  const first = await f.store.addMemory('chief', { content: 'A', kind: 'confirmed', origin: quote('创建A') });
  const target = await f.store.addMemory('chief', { content: 'B', kind: 'confirmed', origin: quote('创建B') });
  const merged = await f.store.updateMemory('chief', first.id, { content: 'B', origin: quote('合并请求') }); assert.equal(merged.id, target.id);
  assert.deepEqual((await f.read({ memoryIds: [first.id] })).memories, []);
  assert.deepEqual((await f.read({ memoryIds: [first.id], query: 'B' })).memories, []);
  assert.deepEqual((await f.read({ memoryIds: [target.id] })).memories[0].contentOrigin, quote('创建B'));
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(f.store.updateMemory('chief', first.id, { content: 'C' }), /not found/);
  assert.equal(await f.store.removeMemory('chief', first.id), false); assert.equal(await readFile(f.file, 'utf8'), before);
  await f.store.restoreMemory('chief', first.id);
  const restored = (await f.read({ memoryIds: [first.id] })).memories[0]; assert.equal(restored.content, 'A'); assert.deepEqual(restored.contentOrigin, quote('创建A'));
}));

test('合法片段引文不必包含全文，contentOrigin不扩写或补造用户消息', async () => fixture(async f => {
  const message = '请记住下面的安排。固定值是蓝色。'; f.message(message);
  const entry = await rememberExplicit(f.store, f.api, 'chief', 'native-chief', { content: '固定值是蓝色', userQuote: '请记住下面的安排。' });
  const row = (await f.read({ memoryIds: [entry.id] })).memories[0];
  assert.deepEqual(row.contentOrigin, quote('请记住下面的安排。'));
}));

test('团队发布/修改只使用团队自己的manual来源，不扩散私聊出处或历史', async () => fixture(async f => {
  const entry = await f.store.addMemory('chief', { content: '可共享正文', kind: 'confirmed', origin: quote('PRIVATE-ORIGINAL-QUOTE') });
  const message = '请发布这条已确认记忆给团队'; f.message(message);
  await publishExplicitTeamMemory(f.store, f.api, 'chief', 'native-chief', { memoryId: entry.id, currentContent: entry.content, userQuote: message }, f.team);
  const team = (await f.read({ scope: 'team' })).memories[0];
  assert.deepEqual(team.origin, manual); assert.deepEqual(team.contentOrigin, manual); assert.doesNotMatch(JSON.stringify(team), /PRIVATE-ORIGINAL-QUOTE|native-chief|history/);
  await f.team.updateMemory(team.id, { content: '已修改团队正文', kind: 'confirmed' });
  const updated = (await f.read({ scope: 'team' })).memories[0]; assert.deepEqual(updated.contentOrigin, manual); assert.doesNotMatch(JSON.stringify(updated), /PRIVATE-ORIGINAL-QUOTE/);
}));

test('频道读口只投影本群正文出处，不能因同一Bot绑定读到个人原话', async () => fixture(async f => {
  const privateEntry = await f.store.addMemory('chief', { content: 'PRIVATE-CONTENT', kind: 'confirmed', origin: quote('PRIVATE-QUOTE') });
  const channels = new ChannelStore({ baseDir: f.dir, bots: f.store });
  const id = channelIdSchema.parse(randomUUID());
  await channels.create({ id, name: '合成群', adminBotId: 'chief', memberIds: ['chief'], cwd: f.dir, instructions: '' });
  const context = new ChannelContextStore(f.dir, f.store, channels);
  const origin: MemoryOrigin = { type: 'message', agentId: 'group-native', userQuote: '本群原话' };
  const current: MemoryOrigin = { type: 'message', agentId: 'group-native', userQuote: '本群正文纠正' };
  const entry = await context.addMemory(id, { content: '本群旧值', kind: 'confirmed', origin });
  await context.updateMemory(id, entry.id, { content: '本群新值', origin: current });
  const scoped = await reader({ ...f.scope, channelId: id, memoryStore: { getContextMemories: () => context.confirmed(id), addMemory: (_botId, input) => context.addMemory(id, input) } });
  try {
    const rows = (await scoped.read()).memories; assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].origin, origin); assert.deepEqual(rows[0].contentOrigin, current);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-CONTENT|PRIVATE-QUOTE|native-chief|history/);
    assert.deepEqual((await scoped.read({ memoryIds: [privateEntry.id] })).memories, []);
  } finally { await scoped.close(); }
}));
