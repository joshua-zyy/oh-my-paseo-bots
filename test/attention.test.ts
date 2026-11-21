import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../server/store.js';
import { readAttention, type AttentionSources } from '../server/attention.js';
import { attentionView } from '../shared/attention.js';
import type { TaskRecord } from '../server/tasks.js';

type Native = NonNullable<Awaited<ReturnType<AttentionSources['agent']>>>;
const agent = (patch: Partial<Native> = {}): Native => ({ title: '原生工作', status: 'idle', pendingPermissions: [], lastError: undefined, archivedAt: null, labels: {}, ...patch });
const task = (agentId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ agentId, title: agentId, status: 'active', specialists: [], ...patch });
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.dir, { recursive: true, force: true }); }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-attention-'));
  const store = new BotStore({ baseDir: dir });
  await store.createBot({ id: 'chief', name: '主Bot', role: '核对' });
  await store.createBot({ id: 'helper', name: '同事', role: '合成资料' });
  const tasks = new Map<string, TaskRecord[]>();
  const native = new Map<string, Native | null>();
  const queried: string[] = [];
  const sources: AttentionSources = {
    store, tasks: { list: async botId => tasks.get(botId) ?? [] },
    agent: async id => { queried.push(id); return native.get(id) ?? null; },
  };
  return { dir, store, tasks, native, queried, sources, read: async () => attentionView.parse(await readAttention(sources)) };
}

test('待办跨Bot聚合权限/异常/停止/交付核对；普通运行与结束不当失败，ID和顺序稳定', async () => fixture(async f => {
  f.tasks.set('chief', [task('permission'), task('error'), task('running'), task('stopping', { status: 'stopping' }), task('review', { status: 'awaiting_review' }), task('done', { status: 'completed' }), task('chat', { conversation: true })]);
  f.tasks.set('helper', [task('missing'), task('closed')]);
  f.native.set('permission', agent({ pendingPermissions: [{ id: 'p', provider: 'codex', name: 'tool', kind: 'tool' }] }));
  f.native.set('error', agent({ status: 'error', lastError: '合成异常' }));
  f.native.set('running', agent({ status: 'running', lastError: '已恢复的旧错误' }));
  f.native.set('stopping', agent()); f.native.set('review', agent()); f.native.set('chat', agent()); f.native.set('closed', agent({ status: 'closed' }));
  const before = structuredClone([...f.tasks]);
  const view = await f.read();
  assert.deepEqual(view.entries.map(e => [e.sourceId, e.kind]).sort(), [['permission', 'decision'], ['error', 'failure'], ['stopping', 'unknown'], ['review', 'decision'], ['missing', 'unknown'], ['closed', 'unknown']].sort());
  assert.deepEqual(view.botIds, ['chief', 'helper']); assert.deepEqual(view.issues, []);
  assert(!f.queried.includes('done')); assert.deepEqual([...f.tasks], before, '查看不确认、归档、重试或结束事项');
  assert.deepEqual(await f.read(), view, '重复读取不消失、不标读、不改变稳定ID或状态');
  assert(view.entries.some(e => e.botId === 'helper')); assert.equal(new Set(view.entries.map(e => e.id)).size, view.entries.length);
}));

test('坏Bot存档明确报缺失来源而非空成功，原文件保留', async () => fixture(async f => {
  const file = join(f.dir, 'v2', 'specialists', 'broken.json'); await writeFile(file, '{broken');
  const view = await f.read(); assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0].botId, 'broken'); assert.equal(view.issues[0].source, 'store');
  assert.equal(await readFile(file, 'utf8'), '{broken');
}));
