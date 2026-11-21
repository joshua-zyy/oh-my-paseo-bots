import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useBotRpc as useRpc } from './attention-state.js';
import * as rpc from '../shared/tasks.js';
import { History } from './history.js';
import { Usage } from './usage.js';
import { Actions, Button, Copy, Disclosure, Notice, Section } from './ui.js';

export function Tasks({ botId, openAgent, revision = 0 }: { botId: string; openAgent?: (id: string) => void; revision?: number }) {
  const list = useRpc(rpc.listTasks);
  const cancel = useRpc(rpc.cancelTask);
  const [tasks, setTasks] = useState<RpcOutput<typeof rpc.listTasks>>();
  const [opened, setOpened] = useState<string>();
  const [allFinished, setAllFinished] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action?: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action?.(); } catch (failure) { setError(String(failure)); }
    finally {
      try { setTasks(await list({ botId })); } catch (failure) { setError(current => `${current}${current ? '；' : ''}${String(failure)}`); }
      guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void list({ botId }).then(value => { if (active) setTasks(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list, revision]);
  const status = { active: '进行中', stopping: '停止待确认', canceled: '已取消', completed: '已报告完成', awaiting_review: '待核对交付' };
  const current = tasks?.filter(task => !['completed', 'canceled'].includes(task.status)) ?? [];
  const finished = tasks?.filter(task => ['completed', 'canceled'].includes(task.status)) ?? [];
  const finishedAction = finished.length > 10 ? <Button label={allFinished ? '只看最近' : '查看全部'} onPress={() => setAllFinished(value => !value)} /> : undefined;
  return <>
    <Notice error={error} />
    {([['进行中', current], [allFinished ? '全部已结束事项' : '最近结束', (allFinished ? [...finished] : finished.slice(-10)).reverse()]] as const).map(([title, rows], index) => (index === 0 || rows.length > 0) && <Section key={title} title={title} action={index === 0 ? <Button label="刷新事项" disabled={busy} onPress={() => void run()} /> : finishedAction}>
      {!tasks && !error && <Copy muted>读取事项中…</Copy>}
      {tasks && !rows.length && <Copy muted>暂无事项</Copy>}
      {rows.map(task => <Disclosure key={task.agentId} title={task.title} status={status[task.status]} open={opened === task.agentId} onPress={() => setOpened(opened === task.agentId ? undefined : task.agentId)}>
        <Copy>{task.summary || task.goal || task.agentId}</Copy>{task.detail && <Copy muted>{task.detail}</Copy>}
        {task.evidence?.map((item, i) => <Copy key={i}>{item}</Copy>)}
        <Actions><Button label="打开会话" disabled={!openAgent || busy} onPress={() => openAgent?.(task.agentId)} /><Button label={task.status === 'stopping' ? '核对停止' : '取消事项'} disabled={busy || task.status === 'canceled' || task.status === 'completed'} onPress={() => void run(() => cancel({ botId, agentId: task.agentId }))} /></Actions>
        {!['completed', 'canceled'].includes(task.status) && <Copy muted small>取消会停止后续推进及关联专家；已准入外发可能完成，未知结果仍可回查。</Copy>}
        {task.specialists.map(id => <Actions key={id}><Copy muted small>{id}</Copy><Button label="查看专家" disabled={busy || !openAgent} onPress={() => openAgent?.(id)} /></Actions>)}
        <History botId={botId} agentId={task.agentId} /><Usage agentId={task.agentId} />
      </Disclosure>)}
    </Section>)}
  </>;
}
