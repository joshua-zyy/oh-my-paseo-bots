import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { rememberExplicit, correctExplicitMemory, forgetExplicitMemory } from '../server/memory.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-memory-governance-'));
  const store = new BotStore({ baseDir: directory });
  await store.ensureChief();
  const file = join(directory, 'chief.json');
  return { store, directory, file, document: async () => JSON.parse(await readFile(file, 'utf8')), close: () => rm(directory, { recursive: true, force: true }) };
}

test('同Bot同确认状态的精确重复复用条目且不写盘，不自动确认候选或合并不同内容', async () => {
  const f = await fixture();
  try {
    const first = await f.store.addMemory('chief', { content: '默认中文', kind: 'confirmed' });
    const before = await readFile(f.file, 'utf8');
    const repeated = await Promise.all(Array.from({ length: 3 }, () => f.store.addMemory('chief', { content: ' 默认中文 ', kind: 'confirmed' })));
    assert.deepEqual(repeated.map(entry => entry.id), [first.id, first.id, first.id]);
    assert.equal(await readFile(f.file, 'utf8'), before);
    const candidate = await f.store.addMemory('chief', { content: '默认中文', kind: 'candidate' });
    assert.notEqual(candidate.id, first.id);
    await f.store.addMemory('chief', { content: '本次使用英文', kind: 'confirmed' });
    await f.store.createBot({ id: 'other', name: '其他同事', role: '核对' });
    assert.notEqual((await f.store.addMemory('other', { content: '默认中文', kind: 'confirmed' })).id, first.id);
    assert.equal((await f.store.listMemories('chief')).length, 3);
    assert.equal((await f.store.getContextMemories('chief')).length, 2);
    const unchanged = await readFile(f.file, 'utf8');
    await f.store.updateMemory('chief', first.id, { content: '默认中文', kind: 'confirmed' });
    assert.equal(await readFile(f.file, 'utf8'), unchanged, '不把重复保存变成变更记录');
    const confirmed = await f.store.updateMemory('chief', candidate.id, { kind: 'confirmed' });
    assert.equal(confirmed.id, first.id, '确认重复候选复用已有明确记忆');
    assert.equal((await f.store.listMemories('chief')).length, 2);
    const merged = (await f.document()).memories.find((item: { id: string }) => item.id === candidate.id);
    assert.ok(merged.archivedAt);
    assert.equal(merged.history.at(-1).action, 'merged');
    assert.equal(merged.history.at(-1).targetId, first.id);
  } finally { await f.close(); }
});

test('明确记忆保留原生消息来源，纠正保留旧值和本次来源，遗忘可追溯但不再注入', async () => {
  const f = await fixture();
  try {
    await f.store.linkSession('chief', { sessionId: 'native-chief' });
    let message = '请记住：默认中文。';
    const api = { agents: { ref: () => ({ timeline: { refetch: async () => ({ error: null, staleCursor: false, gap: false, epoch: 'e', hasOlder: false, entries: [{ item: { type: 'user_message', text: message } }] }) } }) } } as unknown as PaseoApi;
    const saved = await rememberExplicit(f.store, api, 'chief', 'native-chief', { content: '默认中文', userQuote: message });
    assert.deepEqual((await f.document()).memories[0].origin, { type: 'message', agentId: 'native-chief', userQuote: message });
    message = '请纠正长期记忆：默认英文。';
    await correctExplicitMemory(f.store, api, 'chief', 'native-chief', { memoryId: saved.id, currentContent: '默认中文', content: '默认英文', userQuote: message });
    const corrected = (await f.document()).memories[0];
    assert.equal(corrected.content, '默认英文');
    assert.deepEqual(corrected.history[0].before, { content: '默认中文', kind: 'confirmed' });
    assert.deepEqual(corrected.history[0].origin, { type: 'message', agentId: 'native-chief', userQuote: message });
    assert.equal(corrected.history[0].action, 'updated');
    message = '请遗忘默认英文这条长期记忆。';
    await forgetExplicitMemory(f.store, api, 'chief', 'native-chief', { memoryId: saved.id, currentContent: '默认英文', userQuote: message });
    assert.deepEqual(await new BotStore({ baseDir: f.directory }).getContextMemories('chief'), []);
    const archived = (await f.document()).memories[0];
    assert.ok(archived.archivedAt);
    assert.equal(archived.history[1].action, 'archived');
    assert.equal(archived.history[1].origin.userQuote, message);
    assert.equal(archived.history[0].before.content, '默认中文');
  } finally { await f.close(); }
});

test('旧存档没有来源时不伪造来源或改写文件，归档保留原条目且默认列表排除', async () => {
  const f = await fixture();
  try {
    const entry = await f.store.addMemory('chief', { content: '旧约定', kind: 'confirmed' });
    const legacy = await f.document();
    delete legacy.memories[0].origin;
    delete legacy.memories[0].history;
    const before = JSON.stringify(legacy);
    await writeFile(f.file, before);
    assert.equal((await new BotStore({ baseDir: f.directory }).getContextMemories('chief'))[0].content, '旧约定');
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.equal(await f.store.removeMemory('chief', entry.id), true);
    assert.equal(await f.store.removeMemory('chief', entry.id), false);
    assert.deepEqual(await f.store.listMemories('chief'), []);
    const archived = (await f.document()).memories.find((item: { id: string }) => item.id === entry.id);
    assert.ok(archived, '遗忘保留可恢复条目，不物理删除');
    assert.equal(archived.origin, undefined, '未知历史来源不补造');
    assert.equal(archived.history[0].action, 'archived');
    const restored = await f.store.restoreMemory('chief', entry.id);
    assert.equal(restored.id, entry.id);
    assert.equal(restored.origin, undefined);
    assert.equal(restored.archivedAt, undefined);
    assert.deepEqual(restored.history.map(item => item.action), ['archived', 'restored']);
    assert.deepEqual((await f.store.getContextMemories('chief')).map(item => item.id), [entry.id]);
    const unchanged = await readFile(f.file, 'utf8');
    await f.store.restoreMemory('chief', entry.id);
    assert.equal(await readFile(f.file, 'utf8'), unchanged);
    await f.store.removeMemory('chief', entry.id);
    const replacement = await f.store.addMemory('chief', { content: '旧约定', kind: 'confirmed' });
    assert.notEqual(replacement.id, entry.id, '用户重新保存不暗中复活旧条目');
    await assert.rejects(() => f.store.restoreMemory('chief', entry.id), /已存在相同/);
  } finally { await f.close(); }
});
