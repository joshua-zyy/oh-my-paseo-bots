import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { History } from './history.js';
import { SettingsAction, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import * as rpc from '../shared/tasks.js';

export function Tasks({ botId, openAgent }: { botId: string; openAgent?: (id: string) => void }) {
  const list = useRpc(rpc.listTasks);
  const cancel = useRpc(rpc.cancelTask);
  const [tasks, setTasks] = useState<RpcOutput<typeof rpc.listTasks>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action?: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action?.(); } catch (e) { setError(String(e)); }
    finally {
      try { setTasks(await list({ botId })); } catch (e) { setError(String(e)); }
      guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void list({ botId }).then(value => { if (active) setTasks(value); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [botId, list]);
  const status: Record<string, string> = { active: '进行中', stopping: '停止尚未确认', canceled: '已取消', completed: '已报告完成', awaiting_review: '运行已结束，待核对交付' };
  return <SettingsSection title={`事项与原生跟进：${botId}`}>
    <SettingsRow label="取消事项会停止后续推进并归档对应原生会话与专家；Paseo 的单轮停止按钮只停止当前轮次。已准入的外发可能完成，未知结果仍可回查。" error={error || null} />
    <SettingsRow label="完成工具归档当前会话时可能中断收尾回复。交付摘要与证据保存在事项中，工作日志仍记录原生轮次的实际结果。" />
    <SettingsAction label="重新读取事项状态" actionLabel="刷新" disabled={busy} onPress={() => void run()} />
    {tasks.map(task => <SettingsSection key={task.agentId} title={`${status[task.status]}：${task.title}`}>
      <SettingsRow label={task.summary || task.goal || task.agentId} hint={task.detail} />
      {task.evidence?.map((item, index) => <SettingsRow key={index} label={`交付证据：${item}`} />)}
      <SettingsAction label="原生执行与实际结果" actionLabel="打开会话" disabled={!openAgent || busy} onPress={() => openAgent?.(task.agentId)} />
      <History key={task.agentId} botId={botId} agentId={task.agentId} />
      <SettingsAction label="停止这个事项及其跟进" actionLabel={task.status === 'stopping' ? '重试确认停止' : '取消事项'} disabled={busy || task.status === 'canceled' || task.status === 'completed'} onPress={() => void run(() => cancel({ botId, agentId: task.agentId }))} />
      {task.followups.map(followup => <SettingsRow key={followup.key} label={`${followup.name} · ${followup.cron} · ${followup.timezone}`} hint={`登记状态 ${followup.status}；${followup.nativeId || '原生标识未确认'}；${followup.detail || '创建回执不等于实际执行，请查原生会话与工作日志'}`} />)}
      {task.specialists.map(id => <SettingsAction key={id} label={`原生专家 ${id}`} actionLabel="查看实际结果" disabled={busy || !openAgent} onPress={() => openAgent?.(id)} />)}
    </SettingsSection>)}
  </SettingsSection>;
}
