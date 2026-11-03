import type { PaseoApi, PaseoAgent } from '@getpaseo/client';

/** Own only native metadata subscriptions; reread business data when observable work state changes. */
export function observeAgentChanges(api: PaseoApi, labels: Record<string, string>[], changed: () => void, failed: (error: unknown) => void) {
  let disposed = false;
  const subscriptions = labels.map(async labels => {
    const result = await api.agents.list({ includeBackground: true, filter: { labels, includeArchived: true }, subscribe: {} });
    const agents = new Map<string, PaseoAgent>();
    let subscriptionId: string | null | undefined;
    let previous = '';
    const notify = () => {
      if (disposed) return;
      const signature = JSON.stringify([subscriptionId, [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)).map(agent => [agent.id, agent.status, agent.activeTurn?.turnId, agent.archivedAt, agent.pendingPermissions.map(permission => permission.id), agent.status === 'running' ? null : agent.updatedAt])]);
      if (signature === previous) return;
      previous = signature;
      changed();
    };
    const unsubscribe = result.subscription.subscribe({
      snapshot: snapshot => {
        subscriptionId = snapshot.subscriptionId;
        agents.clear();
        for (const { agent } of snapshot.entries) agents.set(agent.id, agent);
        notify();
      },
      update: message => {
        if (message.type !== 'agent_update') return;
        if (message.payload.kind === 'upsert') agents.set(message.payload.agent.id, message.payload.agent);
        else agents.delete(message.payload.agentId);
        notify();
      },
      error: error => { if (!disposed) failed(error); },
    });
    return { subscription: result.subscription, unsubscribe };
  });
  const ready = Promise.all(subscriptions).then(() => {}).catch(error => { if (!disposed) failed(error); });
  return { ready, async release() {
    disposed = true;
    await Promise.all(subscriptions.map(async request => {
      const { subscription, unsubscribe } = await request;
      unsubscribe(); await subscription.release();
    }));
  } };
}
