import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaseoApi } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { rememberExplicit, correctExplicitMemory, forgetExplicitMemory } from '../server/memory.js';

test('明确记忆回查跨页原生用户依据，伪造依据与跨Bot会话被拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-memory-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行任务' });
    await store.linkSession('chief', { sessionId: 'native-chief' });
    let calls = 0;
    const api = { agents: { ref: () => ({ timeline: { refetch: async (options: { direction: string }) => {
      calls++;
      return { error: null, epoch: 'epoch-1', staleCursor: false, gap: false, hasOlder: options.direction === 'tail', startCursor: { epoch: 'epoch-1', seq: 101 }, entries: options.direction === 'tail' ? [{ item: { type: 'assistant_message', text: '工作中' } }] : [{ item: { type: 'user_message', text: '请记住：默认使用中文。' } }] };
    } } }) } } as unknown as PaseoApi;
    const memory = await rememberExplicit(store, api, 'chief', 'native-chief', { content: '默认使用中文', userQuote: '请记住：默认使用中文。' });
    assert.equal(memory.kind, 'confirmed');
    assert.equal(calls, 2);
    await assert.rejects(() => rememberExplicit(store, api, 'chief', 'native-chief', { content: '凭空推断用户偏好', userQuote: '请记住：默认使用中文。' }), /记忆内容不在原生用户消息中/);
    await assert.rejects(() => rememberExplicit(store, api, 'chief', 'native-chief', { content: '推断偏好', userQuote: '用户没说过的内容' }), /依据与最新原生用户消息不符/);
    await assert.rejects(() => rememberExplicit(store, api, 'expert', 'native-chief', { content: '不得越Bot保存', userQuote: '请记住：默认使用中文。' }), /未关联到此 Bot/);
    assert.equal((await store.listMemories('chief')).length, 1);
    assert.deepEqual(await store.listMemories('expert'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('对话纠正和遗忘核对完整当前消息、旧值和Bot归属，候选不自动确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-correction-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行任务' });
    await store.linkSession('chief', { sessionId: 'native-chief' });
    const memory = await store.addMemory('chief', { content: '默认中文', kind: 'confirmed' });
    const candidate = await store.addMemory('chief', { content: '可能喜欢英文', kind: 'candidate' });
    let message = '请纠正长期记忆：默认英文。';
    const api = { agents: { ref: () => ({ timeline: { refetch: async () => ({ error: null, epoch: 'e1', staleCursor: false, gap: false, hasOlder: false, entries: [{ item: { type: 'user_message', text: message } }] }) } }) } } as unknown as PaseoApi;
    const input = { memoryId: memory.id, currentContent: memory.content, userQuote: message, content: '默认英文' };
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, userQuote: '纠正长期记忆' }), /完整用户消息/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, userQuote: '旧消息' }), /最新原生用户消息不符/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, content: candidate.content }), /逐字来自用户/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'expert', 'native-chief', input), /未关联到此 Bot/);
    const corrected = await correctExplicitMemory(store, api, 'chief', 'native-chief', input);
    assert.equal(corrected.id, memory.id);
    assert.equal(corrected.content, '默认英文');
    assert.deepEqual((await new BotStore({ baseDir: directory }).getContextMemories('chief')).map(item => item.content), ['默认英文']);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', input), /记忆已改变/);
    message = '请遗忘默认英文这条长期记忆。';
    const forget = { memoryId: memory.id, currentContent: corrected.content, userQuote: message };
    await assert.rejects(() => forgetExplicitMemory(store, api, 'chief', 'native-chief', { ...forget, currentContent: memory.content }), /记忆已改变/);
    await assert.rejects(() => forgetExplicitMemory(store, api, 'chief', 'native-chief', { ...forget, userQuote: input.userQuote }), /最新原生用户消息不符/);
    assert.equal((await forgetExplicitMemory(store, api, 'chief', 'native-chief', forget)).removed, true);
    assert.deepEqual(await store.getContextMemories('chief'), []);
    assert.equal((await store.listMemories('chief'))[0].kind, 'candidate');
    assert.equal(message, forget.userQuote, '遗忘未改写原生历史');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('原子旧值校验让并发纠正只能成功一次，既有UI更新与幂等删除合同保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-cas-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    const memory = await store.addMemory('chief', { content: '旧值', kind: 'confirmed' });
    const results = await Promise.allSettled(['新值一', '新值二'].map(content => store.updateMemory('chief', memory.id, { content }, '旧值')));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected').length, 1);
    await store.updateMemory('chief', memory.id, { content: 'UI纠正' });
    assert.equal(await store.removeMemory('chief', memory.id), true);
    assert.equal(await store.removeMemory('chief', memory.id), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
