import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi } from '@getpaseo/client';

test('业务面板由原生状态、权限及重连更新，流式 token 不反复读取业务目录', async () => {
  const { observeAgentChanges } = await import(new URL('../client/agent-changes.js', import.meta.url).href);
  let accept!: (snapshot: unknown) => void;
  let update!: (message: unknown) => void;
  let changes = 0;
  let released = 0;
  let agent = { id: 'worker', status: 'running', updatedAt: 'first', archivedAt: null, activeTurn: { turnId: 'turn-1' }, pendingPermissions: [] as { id: string }[] };
  const snapshot = (subscriptionId = 'sub-1') => ({ subscriptionId, entries: [{ agent }] });
  const api = { agents: { list: async (options: unknown) => {
    assert.deepEqual(options, { includeBackground: true, filter: { labels: { 'paseo.parent-agent-id': 'chat' }, includeArchived: true }, subscribe: {} });
    return { ...snapshot(), subscription: {
      subscribe: (observer: { snapshot(value: unknown): void; update(message: unknown): void }) => { accept = observer.snapshot; update = observer.update; accept(snapshot()); return () => {}; },
      release: async () => { released++; },
    } };
  } } } as unknown as PaseoApi;
  const observer = observeAgentChanges(api, [{ 'paseo.parent-agent-id': 'chat' }], () => { changes++; }, (error: unknown) => assert.fail(String(error)));
  await observer.ready;
  assert.equal(changes, 1);
  const upsert = () => update({ type: 'agent_update', payload: { kind: 'upsert', agent } });
  agent = { ...agent, updatedAt: 'token-stream' };
  upsert();
  assert.equal(changes, 1);
  agent = { ...agent, pendingPermissions: [{ id: 'permission-1' }] };
  upsert();
  assert.equal(changes, 2);
  agent = { ...agent, status: 'idle', updatedAt: 'ended' };
  upsert();
  assert.equal(changes, 3);
  accept(snapshot('restored-sub'));
  assert.equal(changes, 4, '重连即使状态相同也补读业务状态');
  update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'worker' } });
  assert.equal(changes, 5, '原生移除事件也更新工作目录');
  await observer.release();
  accept(snapshot('after-release'));
  assert.equal(changes, 5);
  assert.equal(released, 1);
});
