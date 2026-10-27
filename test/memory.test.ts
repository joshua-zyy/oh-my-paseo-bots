import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaseoApi } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { rememberExplicit } from '../server/memory.js';

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
