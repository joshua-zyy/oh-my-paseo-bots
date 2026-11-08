import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TeamMemoryStore } from '../server/team-memory.js';

test('团队发布使用既有生命周期，重新读取保留条目和归档状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-team-'));
  try {
    const store = new TeamMemoryStore(dir);
    const entry = await store.addMemory({ kind: 'confirmed', content: '团队共同约定' });
    await store.addMemory({ kind: 'candidate', content: '未确认共享候选' });
    const restored = new TeamMemoryStore(dir);
    assert.deepEqual((await restored.confirmed()).map(entry => entry.content), ['团队共同约定']);
    assert.deepEqual((await restored.listMemories()).map(entry => entry.origin), [{ type: 'manual' }, { type: 'manual' }]);
    await restored.removeMemory(entry.id);
    assert.deepEqual(await new TeamMemoryStore(dir).confirmed(), []);
    await new TeamMemoryStore(dir).restoreMemory(entry.id);
    assert.equal((await new TeamMemoryStore(dir).confirmed())[0].id, entry.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('团队存档损坏时明确报错并保留原文件，不用空记忆覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-team-corrupt-'));
  try {
    const file = join(dir, 'team-memories.json');
    for (const data of ['{broken', '{"version":1,"memories":[{"id":"invalid"}]}']) {
      await writeFile(file, data);
      const store = new TeamMemoryStore(dir);
      await assert.rejects(store.confirmed(), /存档损坏/);
      await assert.rejects(store.addMemory({ kind: 'confirmed', content: '不能覆盖' }), /存档损坏/);
      assert.equal(await readFile(file, 'utf8'), data);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
