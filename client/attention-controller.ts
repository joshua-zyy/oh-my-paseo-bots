import type { PaseoApi } from '@getpaseo/client';
import type { AttentionEntry, AttentionView } from '../shared/attention.js';
import { observeAgentChanges } from './agent-changes.js';
import { AttentionNotices } from './attention-notices.js';
import { readCapabilityStatus } from '../shared/capability-timeline.js';

export interface AttentionSnapshot { value?: AttentionView; error: string; loading: boolean }
export interface AttentionController {
  readonly ready: Promise<void>;
  getSnapshot(): AttentionSnapshot;
  subscribe(listener: () => void): () => void;
  present(listener: (entries: AttentionEntry[]) => void): () => void;
  refresh(): Promise<void>;
  release(): Promise<void>;
}

/** One installed client owns observations and a bounded reread for sources without events. */
export function createAttentionController(api: PaseoApi, read: () => Promise<AttentionView>): AttentionController {
  let snapshot: AttentionSnapshot = { error: '', loading: false };
  let disposed = false, dirty = false, seed = true, inFlight: Promise<void> | undefined;
  let reread: ReturnType<typeof setTimeout> | undefined;
  let memberKey = '', agents: ReturnType<typeof observeAgentChanges> | undefined;
  const listeners = new Set<() => void>(), presenters = new Set<(entries: AttentionEntry[]) => void>();
  const errors = new Map<string, string>(), retiring = new Set<Promise<void>>(), releaseErrors: unknown[] = [];
  const notices = new AttentionNotices();
  const capabilitySources = new Map<string, { ready: Promise<void>; release(): Promise<void> }>();
  function publish(patch: Partial<AttentionSnapshot> = {}) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch, error: [...errors.values()].join('；') };
    for (const listener of listeners) listener();
  }
  function issue(source: string, error?: unknown) {
    if (error) errors.set(source, `${source}未确认：${String(error)}`); else errors.delete(source);
    publish();
  }
  function retire(observer: ReturnType<typeof observeAgentChanges>) {
    const pending = observer.release().catch(error => { releaseErrors.push(error); issue('旧订阅释放', error); }).finally(() => { retiring.delete(pending); });
    retiring.add(pending);
  }
  function capabilityMembers(view: AttentionView) {
    const ids = new Set(view.capabilityAgentIds ?? []);
    for (const [id, source] of capabilitySources) if (!ids.has(id)) {
      capabilitySources.delete(id); issue(`能力记录订阅:${id}`);
      const pending = source.release().catch(error => { releaseErrors.push(error); issue('旧能力记录订阅释放', error); }).finally(() => { retiring.delete(pending); });
      retiring.add(pending);
    }
    for (const id of ids) {
      if (capabilitySources.has(id)) continue;
      let active = true;
      const name = `能力记录订阅:${id}`;
      try {
        const subscription = api.agents.ref(id).timeline.subscribe(({ event }) => {
          if (disposed || !active) return;
          if (event.type === 'error') { issue(name, event.error); return; }
          if (event.type === 'subscription_restored' || event.type === 'replacement') {
            issue(name); seed = true; void refresh();
          } else if (event.type === 'timeline' && readCapabilityStatus(event.item)) void refresh();
        });
        const ready = subscription.ready.then(() => {
          if (disposed || !active) return;
          issue(name); void refresh(); // Close the establishment window with an authoritative reread.
        }, error => { if (active && !disposed) issue(name, error); });
        capabilitySources.set(id, { ready, async release() { active = false; await subscription.release(); } });
      } catch (error) { issue(name, error); }
    }
  }
  function members(view: AttentionView) {
    capabilityMembers(view);
    const key = JSON.stringify([view.botIds, view.scheduleIds]);
    if (key === memberKey) return;
    memberKey = key;
    if (agents) retire(agents);
    agents = observeAgentChanges(api, [...view.botIds.map(id => ({ 'paseo-guys.bot': id })), ...view.scheduleIds.map(id => ({ 'paseo.schedule-id': id }))], () => { void refresh(); }, error => issue('原生状态订阅', error), () => {
      if (disposed || memberKey !== key) return;
      issue('原生状态订阅'); seed = true; void refresh();
    });
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    clearTimeout(reread); reread = undefined;
    dirty = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (dirty && !disposed) {
        dirty = false; publish({ loading: true });
        try {
          const value = await read();
          if (disposed) break;
          errors.delete('待办读取');
          const current = notices.collect(value, seed); seed = false;
          publish({ value, loading: false }); members(value);
          if (current.length) {
            const present = presenters.values().next().value;
            try { present?.(current); } catch (error) { issue('应用内呈现', error); }
          }
        } catch (error) {
          seed = true; errors.set('待办读取', `待办读取未确认，保留上次结果：${String(error)}`); publish({ loading: false });
        }
      }
    })().finally(() => {
      inFlight = undefined;
      if (dirty && !disposed) void refresh();
      // Fixed delay after completion: no overlapping reads or queued timer ticks.
      else if (!disposed) reread = setTimeout(() => { reread = undefined; void refresh(); }, 15_000);
    });
    return inFlight;
  }
  const events = api.observeEvents(['agent_attention_required', 'status.plugin_settings_changed'], { notifications: false });
  const unsubscribe = events.subscribe({
    snapshot: () => { if (disposed) return; issue('原生事件订阅'); seed = true; void refresh(); },
    update: message => {
      if (message.type === 'agent_attention_required' || message.type === 'status' && message.payload.status === 'plugin_settings_changed' && message.payload.pluginId === 'oh-my-paseo-bots') void refresh();
    },
    error: error => issue('原生事件订阅', error),
  });
  const ready = (async () => {
    await events.ready.catch(error => issue('原生事件订阅', error));
    await refresh(); await agents?.ready;
    await Promise.all([...capabilitySources.values()].map(source => source.ready)); await refresh();
  })();
  return {
    ready, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    present(listener) { presenters.add(listener); return () => { presenters.delete(listener); }; },
    refresh,
    async release() {
      disposed = true; clearTimeout(reread); reread = undefined;
      listeners.clear(); presenters.clear(); unsubscribe();
      const results = await Promise.allSettled([events.release(), agents?.release(), ...[...capabilitySources.values()].map(source => source.release()), ...retiring]);
      capabilitySources.clear();
      for (const result of results) if (result.status === 'rejected') releaseErrors.push(result.reason);
      if (releaseErrors.length) throw new AggregateError(releaseErrors, '待办订阅清理未确认');
    },
  };
}

/** A failed receipt invalidates our view, never retries the action or changes its result. */
export async function attentionMutation<T>(controller: AttentionController | null, action: () => Promise<T>): Promise<T> {
  try { return await action(); } finally { if (controller) void controller.refresh(); }
}
