import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BotStore } from '../server/store.js';
import { readAttention, type AttentionSources } from '../server/attention.js';
import { attentionView } from '../shared/attention.js';
import type { TaskRecord } from '../server/tasks.js';

type Native = NonNullable<Awaited<ReturnType<AttentionSources['agent']>>>;
const agent = (patch: Partial<Native> = {}): Native => ({ title: '原生工作', status: 'idle', pendingPermissions: [], lastError: undefined, archivedAt: null, labels: {}, ...patch });
const task = (agentId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ agentId, title: agentId, status: 'active', specialists: [], followups: [], ...patch });
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
    mail: { list: async () => [] },
    routines: { list: async (_id, options) => { assert.equal(options?.reconcile, false); return []; } },
    gmail: { inspect: async () => null },
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

test('单个来源或原生查询失败保留其他Bot/其他来源，不能伪报无待办', async () => fixture(async f => {
  f.tasks.set('chief', [task('bad'), task('good')]); f.native.set('good', agent({ status: 'error', lastError: '保留异常' }));
  const base = f.sources.agent; f.sources.agent = async id => { if (id === 'bad') throw new Error('原生离线'); return base(id); };
  f.sources.mail = { list: async id => { if (id === 'helper') throw new Error('邮件存档损坏'); return []; } };
  const view = await f.read();
  assert.equal(view.entries.length, 1); assert.equal(view.entries[0].sourceId, 'good');
  assert.deepEqual(view.issues.map(e => [e.botId, e.source]), [['chief', 'agent:bad'], ['helper', 'mail']]);
  f.sources.store = { ...f.sources.store, getBot: async () => null, listBots: async () => { throw new Error('全量读取失败'); } };
  await assert.rejects(f.read(), /全量读取失败/, '整次失败不能返回健康空列表');
}));

test('坏Bot存档明确报缺失来源而非空成功，原文件保留', async () => fixture(async f => {
  const file = join(f.dir, 'broken.json'); await writeFile(file, '{broken');
  const view = await f.read(); assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0].botId, 'broken'); assert.equal(view.issues[0].source, 'store');
  assert.equal(await readFile(file, 'utf8'), '{broken');
}));

test('已归档Bot/旧聊天段及跨Bot委派不重复聚合；尚未报告的独立事项归档仍未知', async () => fixture(async f => {
  await f.store.setArchived('helper', true);
  f.tasks.set('helper', [task('never-read')]);
  f.tasks.set('chief', [task('parent', { specialists: ['colleague'] }), task('old-chat', { conversation: true }), task('unfinished')]);
  f.native.set('parent', agent());
  f.native.set('colleague', agent({ status: 'error', labels: { 'paseo-guys.bot': 'helper' } }));
  f.native.set('old-chat', agent({ archivedAt: 'now', status: 'closed' })); f.native.set('unfinished', agent({ archivedAt: 'now', status: 'closed' }));
  const view = await f.read(); assert.deepEqual(view.entries.map(e => e.sourceId), ['unfinished']);
  assert(!f.queried.includes('never-read')); assert.deepEqual(view.botIds, ['chief']);
}));

test('创建未知/heartbeat未知与能力待确认只读：不ack创建、不复制MCP密钥或记忆正文', async () => fixture(async f => {
  const proposal = await f.store.prepareCreation('chief', { requestId: randomUUID(), fingerprint: 'a'.repeat(64) });
  await f.store.configureCapabilities('helper', { id: 'a'.repeat(64), fingerprint: 'b'.repeat(64), createdAt: new Date().toISOString(), state: 'pending', sourceAgentId: 'chief-native', summary: '需配置现有MCP', skills: [], mcp: [{ path: 'synthetic-only', name: 'synthetic', type: 'stdio' }] }, { skills: [], mcpServers: { synthetic: { type: 'stdio', command: 'never-launch' } } });
  await f.store.addMemory('chief', { kind: 'candidate', content: 'PRIVATE-MEMORY-BODY' });
  f.tasks.set('chief', [task('parent', { status: 'completed', followups: [{ key: 'fixed-key', name: '跟进', cron: '0 9 * * *', timezone: 'Asia/Shanghai', prompt: 'PRIVATE-FOLLOWUP', status: 'unknown', detail: '回执丢失' }] })]);
  const before = await readFile(join(f.dir, 'chief.json'), 'utf8');
  const view = await f.read(); assert.deepEqual(view.entries.map(e => e.source).sort(), ['capability', 'creation', 'followup']);
  assert.equal(view.entries.find(e => e.source === 'creation')!.sourceId, proposal.intent.requestId);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-MEMORY-BODY|PRIVATE-FOLLOWUP/);
  assert.equal(await readFile(join(f.dir, 'chief.json'), 'utf8'), before);
}));

test('邮件只投影确认/未知，已发送撤销不列待办；未知新状态不自动当成功', async () => fixture(async f => {
  f.sources.mail = { list: async botId => botId === 'chief' ? ['pending_confirmation', 'approved', 'draft', 'creating_draft', 'draft_unknown', 'sending', 'send_unknown', 'sent', 'revoked', 'future'].map(status => ({ id: status, subject: status, status, text: 'PRIVATE-MAIL-BODY', to: ['private@example.test'] })) as any : [] };
  const view = await f.read(); assert.equal(view.entries.length, 8);
  assert.equal(view.entries.filter(e => e.kind === 'decision').length, 3); assert.equal(view.entries.filter(e => e.kind === 'unknown').length, 5);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-MAIL-BODY|private@example.test/);
  assert(view.entries.every(e => e.target.panel === 'work'));
}));

test('例程未知/最新失败与Gmail失效/未知独立聚合，不列旧失败或已停用失效检查', async () => fixture(async f => {
  const make = (id: string, patch: object = {}) => ({ routine: { id, botId: 'chief', name: id, state: 'ready', nativeId: `native-${id}`, ...patch }, native: { status: 'active', runs: [] } });
  const rows = [make('unknown', { state: 'unknown' }), make('request', { runRequest: { state: 'unknown' } }), { ...make('failed'), native: { status: 'active', runs: [{ startedAt: '2026-11-09T02:00:00Z', status: 'failed', error: '异常' }] } }, { ...make('recovered'), native: { status: 'active', runs: [{ startedAt: '2026-11-09T02:00:00Z', status: 'succeeded' }, { startedAt: '2026-11-09T01:00:00Z', status: 'failed' }] } }, make('sync'), make('disabled'), make('dispatch'), make('canceled', { state: 'canceled' })];
  f.sources.routines = { list: async (botId, options) => { assert.equal(options?.reconcile, false); return botId === 'chief' ? rows as any : []; } };
  f.sources.gmail = { inspect: async (_id, routineId) => ({ state: routineId === 'dispatch' ? 'dispatch_unknown' : 'needs_sync', enabled: routineId === 'sync', detail: '游标或创建未知' }) as any };
  const view = await f.read();
  assert.deepEqual(view.entries.map(e => [e.source, e.sourceId]).sort(), [['routine', 'unknown'], ['routine', 'request'], ['routine', 'failed'], ['routine', 'canceled'], ['gmail', 'sync'], ['gmail', 'dispatch']].sort());
  assert.equal(view.scheduleIds.length, rows.length); assert.equal(view.entries.find(e => e.sourceId === 'failed')?.kind, 'failure');
}));
