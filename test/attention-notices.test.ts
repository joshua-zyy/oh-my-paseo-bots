import test from 'node:test';
import assert from 'node:assert/strict';
import { readAttention, type AttentionSources } from '../server/attention.js';
import { TASK_STOPPING_IN_FLIGHT, type TaskRecord } from '../server/tasks.js';

const task = (agentId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ agentId, title: agentId, status: 'active', followups: [], specialists: [], ...patch });
function fixture() {
  const jobs: TaskRecord[] = [], agents = new Map<string, any>();
  const sources: AttentionSources = {
    store: { listBots: async () => [{ id: 'chief', name: '主Bot', role: '核对', instructions: '', createdAt: 'now', updatedAt: 'now', capabilities: { skills: [], mcpServers: {} }, execution: {} }], getBot: async () => ({ schemaVersion: 1, bot: (await sources.store.listBots())[0], memories: [], sessions: [], creationIntents: [] }) },
    tasks: { list: async () => jobs }, mail: { list: async () => [] }, routines: { list: async () => [] }, gmail: { inspect: async () => null },
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

test('正常草稿/发送在途不是重要未知，明确未知的事件键忽略标题详情，仅按请求/阶段/绑定区分', async () => {
  const f = fixture();
  const actions: any[] = ['creating_draft', 'sending', 'draft_unknown', 'send_unknown', 'pending_confirmation'].map(status => ({ id: status, requestId: 'fixed-request', status, subject: '原标题', detail: '原说明', draftId: 'known-draft', approvedAt: 'approval-1' }));
  f.sources.mail.list = async () => actions;
  const first = (await f.read()).entries;
  assert(first.filter(e => ['creating_draft', 'sending'].includes(e.sourceId)).every(e => e.notice?.channel === 'progress'));
  assert(first.filter(e => ['draft_unknown', 'send_unknown'].includes(e.sourceId)).every(e => e.notice?.reason === 'mail_unknown' && e.notice.channel === 'plugin'));
  assert.equal(first.find(e => e.sourceId === 'pending_confirmation')!.notice?.reason, 'mail_decision');
  actions.forEach(action => { action.subject = '不同标题'; action.detail = '不同说明'; action.updatedAt = 'arbitrary-new-timestamp'; });
  assert.deepEqual((await f.read()).entries.map(e => e.notice), first.map(e => e.notice));
  actions[2].approvedAt = 'approval-2';
  assert.notEqual((await f.read()).entries.find(e => e.sourceId === 'draft_unknown')!.notice!.episode, first.find(e => e.sourceId === 'draft_unknown')!.notice!.episode);
});

test('同一例程两轮失败保留条目ID但提醒轮次不同，不靠标题、错误文本或更新时间', async () => {
  const f = fixture();
  let run = { id: 'run-1', startedAt: '2026-11-09T01:00:00Z', status: 'failed', error: '失败' };
  f.sources.routines.list = async () => [{ routine: { id: 'routine-id', name: '例程', state: 'ready' }, native: { status: 'active', runs: [run] } }] as any;
  const [first] = (await f.read()).entries;
  assert.equal(first.notice?.reason, 'routine_failed');
  run.error = '新的错误描述';
  const [same] = (await f.read()).entries; assert.equal(same.notice!.episode, first.notice!.episode);
  run = { ...run, id: 'run-2', startedAt: '2026-11-09T02:00:00Z' };
  const [next] = (await f.read()).entries; assert.equal(next.id, first.id); assert.notEqual(next.notice!.episode, first.notice!.episode);
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
