import { useState } from 'react';
import { Modal } from '@getpaseo/plugin/client/ui';
import type { AttentionEntry } from '../shared/attention.js';
import { AttentionToast, useAttentionController, useAttentionSnapshot } from './attention-state.js';
import { Button, Copy, Notice, Section } from './ui.js';

/** Navigation only: decisions remain in their original, scope-checked interfaces. */
export function Attention({ onOpen, compact = false }: { onOpen(entry: AttentionEntry): void; compact?: boolean }) {
  const controller = useAttentionController();
  const { value, error, loading } = useAttentionSnapshot();
  const [opened, setOpened] = useState(false);
  return <>
    {compact && <AttentionToast />}
    <Button label={value ? `待办 · ${value.entries.length}${value.issues.length || error ? ' · 待核对' : ''}` : error ? '待办 · 待核对' : '待办 · 读取中'} icon="CircleAlert" onPress={() => { setOpened(true); void controller.refresh(); }} />
    <Modal title="集中待办" open={opened} onOpenChange={setOpened}><Modal.Content>
      <Copy muted>查看或收到提醒不代表已处理、已批准或已交付。只跳转原有入口核对；未知结果先回查，不盲目重试。</Copy>
      <Button label="刷新待办" onPress={() => { void controller.refresh(); }} />
      <Notice error={error} />
      {!value && !error && <Copy muted>正在读取待办…</Copy>}
      {value && loading && <Copy muted>正在刷新，下面暂保留上次读取结果，不代表当前状态。</Copy>}
      {value && error && !loading && <Copy muted>下面保留上次读取结果，不代表当前状态。</Copy>}
      {value?.issues.map(issue => <Notice key={`${issue.botId}:${issue.source}`} error={`${issue.botId ?? '同事存档'} · ${issue.source}读取未确认：${issue.detail}`} />)}
      {value?.entries.length === 0 && !error && !loading && <Copy muted>{value.issues.length ? '部分来源未读取，不能确认没有待办。' : '当前已读取来源没有待处理工作。'}</Copy>}
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
