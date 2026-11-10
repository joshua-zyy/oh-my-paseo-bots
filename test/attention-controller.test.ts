import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi } from '@getpaseo/client';
import type { AttentionEntry, AttentionView } from '../shared/attention.js';
import { createAttentionController, attentionMutation } from '../client/attention-controller.js';
import { AttentionNotices } from '../client/attention-notices.js';
import { observeAgentChanges } from '../client/agent-changes.js';
import { capabilityStatusItem, CAPABILITY_TIMELINE } from '../shared/capability-timeline.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = (episode: string, channel: 'plugin' | 'host' | 'progress' = 'plugin'): AttentionEntry => ({ id: 'stable', sourceId: 'request', botId: 'chief', botName: '主Bot', source: 'capability', kind: 'decision', title: '标题', target: { panel: 'capabilities' }, notice: { channel, reason: 'capability', episode } });
const view = (entries: AttentionEntry[] = []): AttentionView => ({ entries, issues: [], botIds: ['chief'], scheduleIds: [] });
function subscription(name: string) {
  const observers = new Set<any>(); let released = 0, failRelease = false;
  const snapshot = { subscriptionId: name, requestId: name, entries: [] };
  return {
    ready: Promise.resolve(snapshot), subscriptionId: name,
    subscribe(observer: any) { observers.add(observer); observer.snapshot(snapshot); return () => { observers.delete(observer); }; },
    update(message: any) { for (const observer of observers) observer.update(message); },
    error(error: unknown) { for (const observer of observers) observer.error?.(error); },
    restore(id = name) { for (const observer of observers) observer.snapshot({ ...snapshot, subscriptionId: id }); },
    async release() { released++; if (failRelease) throw new Error('release failed'); },
    released: () => released, failRelease: () => { failRelease = true; },
  };
}
function nativeTimeline() {
  const handlers = new Set<(message: any) => void>();
  let ready: Promise<void> = Promise.resolve(), starts = 0, released = 0;
  return {
    subscribe(handler: (message: any) => void) {
      starts++; handlers.add(handler);
      return Object.assign(() => { handlers.delete(handler); }, { ready, async release() { released++; handlers.delete(handler); } });
    },
    emit(event: any) { for (const handler of handlers) handler({ agentId: 'real-source', event }); },
    setReady(value: Promise<void>) { ready = value; }, starts: () => starts, released: () => released,
  };
}
function fixture() {
  const events = subscription('events'), metadata: ReturnType<typeof subscription>[] = [];
  const timelines = new Map<string, ReturnType<typeof nativeTimeline>>();
  const timeline = (id: string) => { if (!timelines.has(id)) timelines.set(id, nativeTimeline()); return timelines.get(id)!; };
  let current = view(), fail = false, reads = 0, active = 0, maxActive = 0, globalDisposal = 0;
  let override: (() => Promise<AttentionView>) | undefined;
  const api = {
    observeEvents: (names: string[], options: { notifications: boolean }) => { assert.deepEqual(names, ['agent_attention_required', 'status.plugin_settings_changed']); assert.equal(options.notifications, false); return events; },
    agents: { ref: (id: string) => ({ timeline: timeline(id) }), list: async (options: any) => { assert.equal(options.includeBackground, true); assert.equal(options.filter.includeArchived, true); const item = subscription(`meta-${metadata.length}`); metadata.push(item); return { ...await item.ready, subscription: item }; } },
    dispose: async () => { globalDisposal++; },
  } as unknown as PaseoApi;
  const read = async () => {
    reads++; active++; maxActive = Math.max(maxActive, active);
    try { if (fail) throw new Error('offline'); return override ? await override() : current; } finally { active--; }
  };
  return { events, metadata, timeline, api, read, set: (next: AttentionView) => { current = next; }, fail: (next = true) => { fail = next; }, override: (next: typeof override) => { override = next; }, reads: () => reads, maxActive: () => maxActive, globalDisposal: () => globalDisposal };
}

test('一份安装观察由两个UI共享，首次不Toast，普通重绘不读取，清理不dispose宿主API', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  let a = 0, b = 0; const stopA = c.subscribe(() => { a++; }), stopB = c.subscribe(() => { b++; });
  const state = c.getSnapshot(), count = f.reads(); assert.equal(c.getSnapshot(), state); assert.equal(f.metadata.length, 1); assert.equal(f.reads(), count);
  f.set(view([entry('episode-1')])); await c.refresh(); assert(a && b); stopA(); stopB(); assert.equal(f.metadata[0].released(), 0, 'UI卸载不释放安装观察');
  await c.release(); assert.equal(f.events.released(), 1); assert.equal(f.metadata[0].released(), 1); assert.equal(f.globalDisposal(), 0);
  const before = f.reads(); f.events.update({ type: 'agent_attention_required', payload: {} }); await tick(); assert.equal(f.reads(), before);
});

test('原生/真实设置事件刷新，finished不直接提醒；只通知一个挂载呈现者，同轮不重复', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  const first: AttentionEntry[][] = [], second: AttentionEntry[][] = [];
  const stopFirst = c.present(entries => first.push(entries)); c.present(entries => second.push(entries));
  f.events.update({ type: 'agent_attention_required', payload: { reason: 'finished' } }); await c.refresh(); assert.equal(first.length, 0);
  f.set(view([entry('episode-1')]));
  f.events.update({ type: 'status', payload: { status: 'plugin_settings_changed', pluginId: 'unrelated' } }); await tick(); assert.equal(c.getSnapshot().value!.entries.length, 0);
  f.events.update({ type: 'status', payload: { status: 'plugin_settings_changed', pluginId: 'oh-my-paseo-bots' } }); await c.refresh(); assert.equal(first.length, 1); assert.equal(second.length, 0);
  await c.refresh(); assert.equal(first.length, 1); stopFirst(); f.set(view([entry('episode-2')])); await c.refresh(); assert.equal(second.length, 1);
  await c.release();
});

test('刷新在途合并后读，单并发且不丢失新失效，不按重绘高频扫描', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  let resolve!: (value: AttentionView) => void; let first = true;
  const pending = new Promise<AttentionView>(done => { resolve = done; });
  f.override(async () => { if (first) { first = false; return pending; } return view([entry('latest')]); });
  const before = f.reads(), read = c.refresh(); const again = c.refresh(); c.refresh(); assert.equal(again, read);
  resolve(view()); await read; assert.equal(f.reads() - before, 2); assert.equal(f.maxActive(), 1); assert.equal(c.getSnapshot().value!.entries[0].notice!.episode, 'latest');
  const count = f.reads(); await tick(); await tick(); assert.equal(f.reads(), count); await c.release();
});

test('读失败留旧值，读成功不清订阅失败；ACK恢复建基线不将旧变化当新', async () => {
  const f = fixture(); f.set(view([entry('initial')])); const c = createAttentionController(f.api, f.read); await c.ready;
  const notices: AttentionEntry[][] = []; c.present(items => notices.push(items)); const previous = c.getSnapshot().value;
  f.events.error(new Error('lost subscription')); f.fail(); await c.refresh(); assert.equal(c.getSnapshot().value, previous); assert.match(c.getSnapshot().error, /保留上次结果/);
  f.fail(false); f.set(view([entry('after-gap')])); await c.refresh(); assert.match(c.getSnapshot().error, /lost subscription/); assert.equal(notices.length, 0);
  f.events.restore('reconnected'); await c.refresh(); assert.equal(c.getSnapshot().error, ''); assert.equal(notices.length, 0); await c.release();
});

test('原生运行updatedAt变化不触发token扫描；状态变化可刷新', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  const actor = { id: 'worker', status: 'running', activeTurn: { turnId: 'turn' }, pendingPermissions: [], archivedAt: null, updatedAt: 'first' };
  f.metadata[0].update({ type: 'agent_update', payload: { kind: 'upsert', agent: actor } }); await c.refresh(); const before = f.reads();
  f.metadata[0].update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...actor, updatedAt: 'token-update' } } }); await tick(); assert.equal(f.reads(), before);
  f.metadata[0].update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...actor, status: 'idle' } } }); await c.refresh(); assert(f.reads() > before); await c.release();
});

test('当前客户端成功或失败回执都核对投影，不重试动作、不改变原错误', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  let actions = 0; f.set(view([entry('local')])); const result = await attentionMutation(c, async () => { actions++; return 'saved'; }); await c.refresh(); assert.equal(result, 'saved'); assert.equal(c.getSnapshot().value!.entries.length, 1);
  const error = new Error('uncertain receipt'); await assert.rejects(attentionMutation(c, async () => { actions++; throw error; }), e => e === error); assert.equal(actions, 2); await c.release();
});

test('一个来源释放失败仍释放其他来源，已dispose的在途读取不会更新UI或再订阅', async () => {
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  let resolve!: (value: AttentionView) => void; f.override(() => new Promise(done => { resolve = done; })); const pending = c.refresh();
  f.events.failRelease(); await assert.rejects(c.release(), /清理未确认/); assert.equal(f.metadata[0].released(), 1);
  const previous = c.getSnapshot(); resolve(view([entry('late')])); await pending; assert.equal(c.getSnapshot(), previous); assert.equal(f.metadata.length, 1);
});

test('全部元数据来源ACK后才恢复，单个恢复不掩盖另一来源失败', async () => {
  const f = fixture(); let restored = 0;
  const watcher = observeAgentChanges(f.api, [{ bot: 'a' }, { bot: 'b' }], () => {}, () => {}, () => { restored++; }); await watcher.ready;
  assert.equal(restored, 1); f.metadata[0].error(new Error('lost')); f.metadata[1].restore(); assert.equal(restored, 1); f.metadata[0].restore(); assert.equal(restored, 2); await watcher.release();
});

test('提醒仅用明确plugin原因/轮次，首次/恢复不报旧项，标题说明变化不重复', () => {
  const n = new AttentionNotices(); assert.deepEqual(n.collect(view([entry('old')])), []);
  assert.deepEqual(n.collect(view([{ ...entry('old'), title: 'changed', detail: 'changed' }])), []);
  assert.equal(n.collect(view([entry('new')])).length, 1);
  assert.deepEqual(n.collect(view([entry('native', 'host')])), []); assert.deepEqual(n.collect(view([entry('inflight', 'progress')])), []);
  assert.deepEqual(n.collect(view([entry('restored')]), true), []);
});

test('局部缺失恢复只建该来源基线，其他来源新的重要事项仍提示', () => {
  const n = new AttentionNotices(); n.collect(view([entry('old')]));
  n.collect({ ...view(), issues: [{ botId: 'chief', source: 'store', detail: 'offline' }] });
  const other = { ...entry('new-other'), id: 'other', botId: 'helper' };
  const result = n.collect(view([entry('recovered'), other])); assert.deepEqual(result, [other]);
});

const capabilityRow = (state: 'pending' | 'applied' | 'rejected') => ({ ...capabilityStatusItem('chief', '主Bot', { id: 'a'.repeat(64), sourceAgentId: 'real-source', summary: '合成', state, skills: [], mcp: [], createdAt: 'synthetic' }), pluginId: CAPABILITY_TIMELINE.pluginId });
const sourceView = (entries: AttentionEntry[] = []): AttentionView => ({ ...view(entries), capabilityAgentIds: ['real-source'] });

test('能力状态行精确订阅驱动自动形成与清除；普通token/其他插件/非法数据不扫描', async () => {
  const f = fixture(); f.set(sourceView()); const c = createAttentionController(f.api, f.read); await c.ready;
  const notices: AttentionEntry[][] = []; c.present(items => notices.push(items));
  const timeline = f.timeline('real-source'), before = f.reads();
  timeline.emit({ type: 'timeline', item: { type: 'assistant_message', text: 'token' } });
  timeline.emit({ type: 'timeline', item: { ...capabilityRow('pending'), pluginId: 'unrelated' } });
  timeline.emit({ type: 'timeline', item: { ...capabilityRow('pending'), data: { state: 'pending' } } });
  await tick(); assert.equal(f.reads(), before);
  f.set(sourceView([entry('new-decision')])); timeline.emit({ type: 'timeline', item: capabilityRow('pending') });
  await tick(); assert(f.reads() > before); assert.equal(c.getSnapshot().value!.entries.length, 1); assert.equal(notices.length, 1);
  f.set(sourceView()); timeline.emit({ type: 'timeline', item: capabilityRow('rejected') });
  await tick(); assert.equal(c.getSnapshot().value!.entries.length, 0); assert.equal(notices.length, 1, '解决不是新的重要提醒');
  assert.equal(timeline.starts(), 1); await c.release(); assert.equal(timeline.released(), 1);
});

test('能力来源建立期间的变化不丢，来源复用/移除与恢复不由UI生命周期管理', async () => {
  const f = fixture(); f.set(sourceView()); let ack!: () => void;
  const ready = new Promise<void>(resolve => { ack = resolve; }); f.timeline('real-source').setReady(ready);
  const c = createAttentionController(f.api, f.read); await tick();
  f.set(sourceView([entry('during-ack')])); f.timeline('real-source').emit({ type: 'timeline', item: capabilityRow('pending') });
  ack(); await c.ready; assert.equal(c.getSnapshot().value!.entries[0].notice!.episode, 'during-ack');
  await c.refresh(); assert.equal(f.timeline('real-source').starts(), 1);
  f.timeline('real-source').emit({ type: 'error', error: 'lost capability stream' });
  await c.refresh(); assert.match(c.getSnapshot().error, /lost capability stream/, '一次读取不抹掉订阅错误');
  f.set(sourceView()); f.timeline('real-source').emit({ type: 'subscription_restored' }); await tick();
  assert.equal(c.getSnapshot().value!.entries.length, 0); assert.equal(c.getSnapshot().error, '');
  f.set(view()); await c.refresh(); assert.equal(f.timeline('real-source').released(), 1);
  await c.release(); const count = f.reads(); f.timeline('real-source').emit({ type: 'timeline', item: capabilityRow('pending') }); await tick(); assert.equal(f.reads(), count);
});

test('无原生事件的另一客户端提交由有界重读自动形成/清除，同项与普通进展不重复提醒', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  t.after(() => c.release());
  const notices: AttentionEntry[][] = []; c.present(items => notices.push(items));
  const before = f.reads(); f.set(view([entry('remote-decision')]));
  t.mock.timers.tick(14_999); await tick(); assert.equal(f.reads(), before);
  t.mock.timers.tick(1); await tick(); assert.equal(f.reads(), before + 1);
  assert.equal(c.getSnapshot().value!.entries.length, 1); assert.equal(notices.length, 1);
  t.mock.timers.tick(15_000); await tick(); assert.equal(notices.length, 1, '重读不是新的episode');
  f.set(view()); t.mock.timers.tick(15_000); await tick();
  assert.equal(c.getSnapshot().value!.entries.length, 0); assert.equal(notices.length, 1, '已决定不提醒');
  f.set(view([entry('ordinary-inflight', 'progress')])); t.mock.timers.tick(15_000); await tick();
  assert.equal(notices.length, 1, '没有新进展不等于重要异常');
});

test('无Agent的例程失败无需伪造注意事件即可自动发现', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  t.after(() => c.release());
  const notices: AttentionEntry[][] = []; c.present(items => notices.push(items));
  const failed: AttentionEntry = { ...entry('failed-run'), source: 'routine', kind: 'failure', target: { panel: 'routines' }, notice: { channel: 'plugin', reason: 'routine_failed', episode: 'failed-run' } };
  f.set(view([failed])); t.mock.timers.tick(15_000); await tick();
  assert.deepEqual(c.getSnapshot().value!.entries, [failed]); assert.deepEqual(notices, [[failed]]);
  f.set(view()); t.mock.timers.tick(15_000); await tick(); assert.equal(c.getSnapshot().value!.entries.length, 0);
});

test('慢自动重读不堆积，原生失效仍合并后读，完成后才安排下一次且卸载释放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), c = createAttentionController(f.api, f.read); await c.ready;
  t.after(() => c.release());
  let resolve!: (value: AttentionView) => void; let first = true;
  const pending = new Promise<AttentionView>(done => { resolve = done; });
  f.override(async () => { if (first) { first = false; return pending; } return view([entry('after-slow-read')]); });
  const before = f.reads(); t.mock.timers.tick(15_000); await tick(); assert.equal(f.reads(), before + 1);
  t.mock.timers.tick(60_000); await tick(); assert.equal(f.reads(), before + 1); assert.equal(f.maxActive(), 1);
  f.events.update({ type: 'agent_attention_required', payload: {} });
  resolve(view()); await tick(); assert.equal(f.reads(), before + 2); assert.equal(f.maxActive(), 1);
  const count = f.reads(); t.mock.timers.tick(14_999); await tick(); assert.equal(f.reads(), count);
  t.mock.timers.tick(1); await tick(); assert.equal(f.reads(), count + 1);
  await c.release(); const after = f.reads(); t.mock.timers.tick(60_000); await tick(); assert.equal(f.reads(), after);
});

test('自动读失败保旧值/错误，继续核对不批准或重派，原生读仍即时并重置延迟', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.set(view([entry('initial')])); const c = createAttentionController(f.api, f.read); await c.ready;
  t.after(() => c.release());
  const previous = c.getSnapshot().value; f.fail(); t.mock.timers.tick(15_000); await tick();
  assert.equal(c.getSnapshot().value, previous); assert.match(c.getSnapshot().error, /保留上次结果/);
  f.fail(false); f.set(view()); t.mock.timers.tick(15_000); await tick();
  assert.equal(c.getSnapshot().value!.entries.length, 0); assert.equal(c.getSnapshot().error, '');
  t.mock.timers.tick(14_999); f.set(view([entry('immediate-native')]));
  f.events.update({ type: 'agent_attention_required', payload: {} }); await tick();
  assert.equal(c.getSnapshot().value!.entries[0].notice!.episode, 'immediate-native');
  const count = f.reads(); t.mock.timers.tick(1); await tick(); assert.equal(f.reads(), count, '原截止时刻不再重复读');
  t.mock.timers.tick(14_999); await tick(); assert.equal(f.reads(), count + 1);
});
