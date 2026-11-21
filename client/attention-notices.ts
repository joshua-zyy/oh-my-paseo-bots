import type { AttentionEntry, AttentionView } from '../shared/attention.js';

const key = (entry: AttentionEntry) => entry.notice ? JSON.stringify([entry.notice.channel, entry.notice.reason, entry.notice.episode]) : '';
function recovered(entry: AttentionEntry, issues: AttentionView['issues']) {
  const groups = entry.source === 'work' ? ['work', `agent:${entry.sourceId}`] : ['work'];
  return issues.some(issue => (!issue.botId || issue.botId === entry.botId) && (issue.source === 'store' || groups.includes(issue.source)));
}

/** Client-lifetime deduplication only. No unread history, acknowledgement or timer. */
export class AttentionNotices {
  private seen = new Map<string, string>();
  private issues: AttentionView['issues'] = [];
  private initialized = false;
  collect(view: AttentionView, reset = false): AttentionEntry[] {
    const next = view.issues.length ? new Map(this.seen) : new Map<string, string>();
    const notices: AttentionEntry[] = [];
    for (const entry of view.entries) {
      const signature = key(entry);
      if (!reset && this.initialized && entry.notice?.channel === 'plugin' && this.seen.get(entry.id) !== signature && !recovered(entry, this.issues)) notices.push(entry);
      next.set(entry.id, signature);
    }
    this.seen = next; this.issues = view.issues; this.initialized = true;
    return notices;
  }
}
