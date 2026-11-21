import test from 'node:test';
import assert from 'node:assert/strict';
import { readAttention, type AttentionSources } from '../server/attention.js';
import { TASK_STOPPING_IN_FLIGHT, type TaskRecord } from '../server/tasks.js';

const task = (agentId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ agentId, title: agentId, status: 'active', specialists: [], ...patch });
function fixture() {
  const jobs: TaskRecord[] = [], agents = new Map<string, any>();
  const sources: AttentionSources = {
    store: { listBots: async () => [{ id: 'chief', name: '主Bot', role: '核对', instructions: '', createdAt: 'now', updatedAt: 'now', capabilities: { skills: [], mcpServers: {} }, execution: {} }], getBot: async () => ({ schemaVersion: 2, bot: (await sources.store.listBots())[0], memories: [], sessions: [], creationIntents: [] }) },
    tasks: { list: async () => jobs },
    agent: async id => agents.get(id) ?? { title: id, status: 'idle', pendingPermissions: [], labels: {}, archivedAt: null },
  };
  return { jobs, agents, sources, read: () => readAttention(sources) };
}

test('work分为原生提醒和业务核对，不整类排除；委派请求由插件补充', async () => {
  const f = fixture(); f.jobs.push(task('root'), task('child'), task('review', { status: 'awaiting_review' }), task('stop', { status: 'stopping' }));
  f.agents.set('root', { pendingPermissions: [{ id: 'native-permission' }], labels: {} });
  f.agents.set('child', { pendingPermissions: [{ id: 'child-permission' }], labels: { 'paseo.parent-agent-id': 'parent' } });
  const entries = (await f.read()).entries;
  assert.equal(entries.find(e => e.sourceId === 'root')!.notice?.channel, 'host');
  assert.equal(entries.find(e => e.sourceId === 'child')!.notice?.channel, 'plugin');
  assert.equal(entries.find(e => e.sourceId === 'review')!.notice?.reason, 'task_review');
  assert.equal(entries.find(e => e.sourceId === 'stop')!.notice?.reason, 'task_stop');
  f.agents.get('child').pendingPermissions = [{ id: 'another-request' }];
  assert.notEqual((await f.read()).entries.find(e => e.sourceId === 'child')!.notice!.episode, entries.find(e => e.sourceId === 'child')!.notice!.episode);
});

test('停止进行中使用已证实的生产阶段标记，不把正常完成/取消在途当异常提醒', async () => {
  const f = fixture(); f.jobs.push(task('stop', { status: 'stopping', detail: TASK_STOPPING_IN_FLIGHT }));
  const [inflight] = (await f.read()).entries; assert.equal(inflight.notice?.channel, 'progress');
  f.jobs[0].detail = '原生 archive 失败（synthetic）；事项停在 stopping，可重试 stop';
  const [failed] = (await f.read()).entries; assert.equal(failed.notice?.channel, 'plugin'); assert.equal(failed.notice?.reason, 'task_stop');
  assert.equal(failed.notice!.episode, inflight.notice!.episode, '不是用失败文字生成新轮次');
});

test('已知原生错误使用实际turn/run锚点，Root交宿主、委派交插件；不从错误文本推轮次', async () => {
  const f = fixture(); f.jobs.push(task('error'));
  const value = { status: 'error', lastError: '失败', pendingPermissions: [], labels: { 'paseo.parent-agent-id': 'parent' }, activeTurn: { turnId: 'turn-1' } };
  f.agents.set('error', value);
  const [first] = (await f.read()).entries; assert.equal(first.notice?.channel, 'plugin');
  value.lastError = '不同错误文本'; const [same] = (await f.read()).entries; assert.equal(same.notice!.episode, first.notice!.episode);
  value.activeTurn.turnId = 'turn-2'; const [next] = (await f.read()).entries; assert.notEqual(next.notice!.episode, first.notice!.episode);
  value.labels = {} as typeof value.labels; const [root] = (await f.read()).entries; assert.equal(root.notice?.channel, 'host');
});
