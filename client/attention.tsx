import { useEffect, useState } from 'react';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Modal } from '@getpaseo/plugin/client/ui';
import { listAttention, type AttentionEntry, type AttentionView } from '../shared/attention.js';
import { observeAgentChanges } from './agent-changes.js';
import { Button, Copy, Notice, Section } from './ui.js';

/** Navigation only: decisions remain in their original, scope-checked interfaces. */
export function Attention({ bots, onOpen }: { bots: { id: string; updatedAt: string }[]; onOpen(entry: AttentionEntry): void }) {
  const api = usePaseo();
  const read = useRpc(listAttention);
  const [value, setValue] = useState<AttentionView>();
  const [readError, setReadError] = useState('');
  const [subscriptionError, setSubscriptionError] = useState('');
  const error = [readError, subscriptionError].filter(Boolean).join('；');
  const [opened, setOpened] = useState(false);
  const [revision, setRevision] = useState(0);
  const signal = JSON.stringify(bots.map(bot => [bot.id, bot.updatedAt]));
  const owners = [...new Set([...bots.map(bot => bot.id), ...(value?.botIds ?? [])])].sort();
  const botIds = JSON.stringify(owners);
  const scheduleIds = JSON.stringify(value?.scheduleIds ?? []);
  useEffect(() => {
    let active = true;
    void read({}).then(result => { if (active) { setValue(result); setReadError(''); } }).catch(failure => { if (active) setReadError(`待办刷新失败，未判定已清空：${String(failure)}`); });
    return () => { active = false; };
  }, [read, signal, revision]);
  useEffect(() => {
    const labels = [...owners.map(id => ({ 'paseo-guys.bot': id })), ...(value?.scheduleIds ?? []).map(id => ({ 'paseo.schedule-id': id }))];
    setSubscriptionError('');
    const observer = observeAgentChanges(api, labels, () => setRevision(value => value + 1), failure => setSubscriptionError(`待办状态订阅失败，可手动刷新：${String(failure)}`));
    return () => { void observer.release().catch(error => console.error('待办状态订阅清理失败', error)); };
  }, [api, botIds, scheduleIds]);
  return <>
    <Button label={value ? `待办 · ${value.entries.length}${value.issues.length || error ? ' · 待核对' : ''}` : '待办 · 读取中'} icon="CircleAlert" onPress={() => setOpened(true)} />
    <Modal title="集中待办" open={opened} onOpenChange={setOpened}><Modal.Content>
      <Copy muted>查看或收到提醒不代表已处理、已批准或已交付。只跳转原有入口核对；未知结果先回查，不盲目重试。</Copy>
      <Button label="刷新待办" onPress={() => setRevision(value => value + 1)} />
      <Notice error={error} />
      {!value && !error && <Copy muted>正在读取待办…</Copy>}
      {value && error && <Copy muted>下面保留上次读取结果，不代表当前状态。</Copy>}
      {value?.issues.map(issue => <Notice key={`${issue.botId}:${issue.source}`} error={`${issue.botId ?? '同事存档'} · ${issue.source}读取未确认：${issue.detail}`} />)}
      {value?.entries.length === 0 && !error && <Copy muted>{value.issues.length ? '部分来源未读取，不能确认没有待办。' : '当前已读取来源没有待处理工作。'}</Copy>}
      {(['decision', 'failure', 'unknown'] as const).map(kind => {
        const entries = value?.entries.filter(entry => entry.kind === kind) ?? [];
        const titles = { decision: '需要你决定或核对', failure: '失败与异常', unknown: '结果未知' };
        return entries.length ? <Section key={kind} title={`${titles[kind]} · ${entries.length}`}>
          {entries.map(entry => <Section key={entry.id} title={`${entry.botName} · ${entry.title}`}>
            {entry.detail && <Copy>{entry.detail}</Copy>}
            <Button label={entry.target.panel === 'agent' ? '打开原生会话' : '前往原处理入口'} onPress={() => { setOpened(false); onOpen(entry); }} />
          </Section>)}
        </Section> : null;
      })}
    </Modal.Content></Modal>
  </>;
}
