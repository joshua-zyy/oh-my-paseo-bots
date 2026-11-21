// Adapted from oliexe/paseo-bots client/useChat.ts. See THIRD_PARTY_NOTICES.md.
import type { PaseoApi, PaseoAgent } from '@getpaseo/client';

type Handle = ReturnType<PaseoApi['agents']['ref']>;
type Page = Awaited<ReturnType<Handle['timeline']['refetch']>>;
export type ChatEntry = Page['entries'][number];
export interface ChatState {
  agentId: string | null;
  agent: PaseoAgent | null;
  entries: ChatEntry[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  startCursor: Page['startCursor'];
  endCursor: Page['endCursor'];
  error: string;
}
export const EMPTY_CHAT: ChatState = { agentId: null, agent: null, entries: [], loading: false, loadingOlder: false, hasOlder: false, startCursor: null, endCursor: null, error: '' };

function merge(current: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const entries = new Map<number, ChatEntry>();
  for (const entry of [...current, ...incoming]) entries.set(entry.seqStart, entry);
  return [...entries.values()].sort((a, b) => a.seqStart - b.seqStart);
}

/** 只持有当前显示的原生历史分页和订阅，不持久化聊天或启动执行。 */
export function observeChat(api: PaseoApi, botId: string, agentId: string, changed: (state: ChatState) => void) {
  const handle = api.agents.ref(agentId);
  let state: ChatState = { ...EMPTY_CHAT, agentId, loading: true };
  let disposed = false;
  let busy: Promise<void> | null = null;
  let queued: 'tail' | 'after' | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (patch: Partial<ChatState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    changed(state);
  };
  const fail = (error: unknown) => publish({ error: error instanceof Error ? error.message : String(error), loading: false, loadingOlder: false });
  changed(state);

  function sync(mode: 'tail' | 'after'): Promise<void> {
    if (busy) {
      if (queued !== 'tail') queued = mode;
      return busy;
    }
    const fetch = async () => {
      let tail = mode === 'tail' || !state.endCursor;
      while (!disposed) {
        const page = await handle.timeline.refetch({ direction: tail ? 'tail' : 'after', ...(tail ? {} : { cursor: state.endCursor! }), projection: 'projected', limit: 40 });
        if (disposed) return;
        if (page.error) throw new Error(page.error);
        if (!tail && (page.reset || page.staleCursor || page.gap || page.epoch !== state.endCursor?.epoch)) { tail = true; continue; }
        publish({
          entries: tail ? page.entries : merge(state.entries, page.entries),
          startCursor: tail ? page.startCursor : state.startCursor,
          endCursor: tail ? page.endCursor : page.endCursor ?? state.endCursor,
          hasOlder: tail ? page.hasOlder : state.hasOlder,
          agent: page.agent ?? handle.current() ?? state.agent,
          loading: false, error: '',
        });
        if (!page.hasNewer || !page.entries.length) return;
        tail = false;
      }
    };
    busy = fetch().catch(fail).finally(async () => {
      busy = null;
      const next = queued;
      queued = null;
      if (next && !disposed) await sync(next);
    });
    return busy;
  }

  const refreshAgent = () => {
    void handle.refresh().then(snapshot => {
      if (snapshot) publish({ agent: snapshot.agent });
      else publish({ agent: null, error: '原生会话已移除' });
    }).catch(fail);
  };
  const unsubscribeAgent = handle.subscribe(update => {
    // A query can evict an agent without deleting its native conversation.
    if (update.kind === 'remove') refreshAgent();
    else publish({ agent: handle.current() });
  });
  const timeline = handle.timeline.subscribe(({ event }) => {
    if (disposed) return;
    if (event.type === 'error') { fail(event.error); return; }
    if (event.type === 'replacement') { void sync('tail'); return; }
    if (event.type === 'subscription_restored') refreshAgent();
    if (!timer) timer = setTimeout(() => { timer = undefined; void sync('after'); }, 80);
  });
  // handle.subscribe 是本地监听；owned 列表观察才向 SDK 提供实时状态和权限更新。
  const directory = api.agents.list({ includeBackground: true, filter: { labels: { 'paseo-guys.bot': botId }, includeArchived: true }, page: { limit: 1 }, subscribe: {} });
  const ready = Promise.all([timeline.ready, directory]).then(async ([, result]) => {
    if (disposed) return;
    result.subscription.subscribe({ snapshot: refreshAgent, update: () => {}, error: fail });
    await sync('tail');
  }).catch(fail);

  return {
    ready,
    refresh: () => sync('after'),
    async loadOlder() {
      if (state.loadingOlder || !state.hasOlder || !state.startCursor || disposed) return;
      if (busy) await busy;
      publish({ loadingOlder: true });
      try {
        const page = await handle.timeline.refetch({ direction: 'before', cursor: state.startCursor!, projection: 'projected', limit: 40 });
        if (disposed) return;
        if (page.error) throw new Error(page.error);
        if (page.reset || page.staleCursor || page.gap || page.epoch !== state.endCursor?.epoch) { await sync('tail'); return; }
        publish({ entries: merge(state.entries, page.entries), startCursor: page.startCursor, hasOlder: page.hasOlder && page.entries.length > 0, error: '' });
      } catch (error) { fail(error); }
      finally { publish({ loadingOlder: false }); }
    },
    async release() {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeAgent();
      await Promise.all([timeline.release(), directory.then(result => result.subscription.release(), () => {})]);
    },
  };
}
