import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentTimelineRefetchOptions } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { readBotHistory } from '../server/history.js';

test('历史只读本Bot已关联会话和创建意图，游标分页与失效如实返回', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-history-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行任务' });
    await store.linkSession('chief', { sessionId: 'old-chief' });
    await store.linkSession('expert', { sessionId: 'old-expert' });
    const intent = await store.prepareCreation('chief', { requestId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64) });
    const calls: { id: string; options: PaseoAgentTimelineRefetchOptions }[] = [];
    let failure: Record<string, unknown> = {};
    const api = { agents: { ref: (id: string) => ({ timeline: { refetch: async (options: PaseoAgentTimelineRefetchOptions) => {
      calls.push({ id, options });
      return { agentId: id, error: null, epoch: 'e1', staleCursor: false, gap: false, hasOlder: options.direction === 'tail', hasNewer: options.direction === 'before', startCursor: { epoch: 'e1', seq: 1 }, endCursor: { epoch: 'e1', seq: 3 }, entries: [{ item: { type: 'assistant_message', text: 'report.json 已交付' } }], ...failure };
    } } }) } } as unknown as PaseoApi;
    const before = await store.getBot('chief');
    const page = await readBotHistory(store, api, 'chief', { agentId: 'old-chief', limit: 2 });
    assert.equal(page.hasOlder, true);
    assert.equal(page.entries[0].item.type, 'assistant_message');
    await readBotHistory(store, api, 'chief', { agentId: 'old-chief', direction: 'before', cursor: page.startCursor!, limit: 2 });
    await readBotHistory(store, api, 'chief', { agentId: intent.intent.agentId, direction: 'after', cursor: page.endCursor! });
    assert.deepEqual(calls[0].options, { direction: 'tail', cursor: undefined, limit: 2, projection: 'canonical' });
    assert.equal(calls[1].options.cursor?.seq, 1);
    await assert.rejects(() => readBotHistory(store, api, 'chief', { agentId: 'old-expert' }), /未关联到此 Bot/);
    await assert.rejects(() => readBotHistory(store, api, 'chief', { agentId: 'unlinked-specialist' }), /未关联到此 Bot/);
    assert.equal(calls.length, 3, '跨Bot和未关联专家未访问原生历史');
    await assert.rejects(() => readBotHistory(store, api, 'chief', { agentId: 'old-chief', direction: 'before' }), /需使用上一页/);
    for (const invalid of [{ error: '读取失败' }, { staleCursor: true }, { gap: true }, { epoch: 'e2' }]) {
      failure = invalid;
      await assert.rejects(() => readBotHistory(store, api, 'chief', { agentId: 'old-chief', direction: 'before', cursor: page.startCursor! }), /无法稳定读取/);
    }
    assert.deepEqual(await store.getBot('chief'), before, '历史查询未修改Bot、记忆或会话关联');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
