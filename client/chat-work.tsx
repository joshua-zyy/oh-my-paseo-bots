import { useEffect, useMemo, useRef, useState } from 'react';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import { conversationWork } from '../shared/chat.js';
import { cancelTask } from '../shared/tasks.js';
import { observeAgentChanges } from './agent-changes.js';
import { OfficeActions } from './office.js';
import { Actions, Button, Copy, Notice, useUi } from './ui.js';

export function ChatWork({ botId, agentId, signal, openAgent }: { botId: string; agentId: string; signal: string; openAgent(id: string): void }) {
  const api = usePaseo();
  const read = useRpc(conversationWork);
  const cancel = useRpc(cancelTask);
  const { colors } = useUi();
  const [value, setValue] = useState<RpcOutput<typeof conversationWork>>({ entries: [], mail: [] });
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function refresh() { setValue(await read({ botId, agentId })); }
  useEffect(() => {
    let active = true;
    void read({ botId, agentId }).then(value => { if (active) { setValue(value); setError(''); } }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, agentId, read, revision, signal]);
  useEffect(() => {
    const observer = observeAgentChanges(api, [{ 'paseo-guys.bot': botId }, { 'paseo.parent-agent-id': agentId }], () => setRevision(value => value + 1), failure => setError(String(failure)));
    return () => { void observer.release().catch(error => console.error('工作状态订阅清理失败', error)); };
  }, [api, botId, agentId]);
  const mail = useMemo(() => {
    const pending = value.mail.filter(action => !['sent', 'revoked'].includes(action.status));
    const recent = value.mail.filter(action => ['sent', 'revoked'].includes(action.status)).slice(-2);
    return [...new Set([...pending, ...recent].map(action => action.botId))].map(botId => ({ botId, actions: [...pending, ...recent].filter(action => action.botId === botId) }));
  }, [value.mail]);
  const current = value.entries.filter(item => !item.status || !['completed', 'canceled'].includes(item.status));
  const recent = value.entries.filter(item => item.status && ['completed', 'canceled'].includes(item.status)).slice(-3);
  const statuses: Record<string, string> = { active: '进行中', stopping: '停止待确认', canceled: '已取消', completed: '已报告完成', awaiting_review: '待核对交付' };
  const nativeStatuses: Record<string, string> = { running: '运行中', initializing: '正在启动', idle: '等待回复', closed: '回复已结束', error: '运行异常', unknown: '状态待确认' };
  async function stop(botId: string, agentId: string) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await cancel({ botId, agentId }); await refresh(); } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    <Notice error={error} />
    {[...current, ...recent].map(item => <View key={item.agentId} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${item.title}`} onPress={() => openAgent(item.agentId)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Icon name={item.pendingPermissions ? 'CircleAlert' : item.status === 'completed' ? 'CircleCheck' : item.status === 'canceled' ? 'CircleX' : 'ListTodo'} size={16} color={item.pendingPermissions || item.error ? colors.statusDanger : colors.foregroundMuted} />
        <Text style={{ color: colors.foreground, fontSize: 14, flex: 1 }}>{item.title}</Text>
        <Copy muted small>{item.pendingPermissions ? '待授权' : item.error ? '运行异常' : item.status ? statuses[item.status] : nativeStatuses[item.nativeStatus] ?? '状态待确认'}</Copy>
      </Pressable>
      {item.botId !== botId && <Copy muted small>{item.botName}</Copy>}
      {item.summary && <Copy>{item.summary}</Copy>}
      {item.evidence?.map((evidence, index) => <Copy key={index} muted small>{evidence}</Copy>)}
      {item.detail && <Copy muted small>{item.detail}</Copy>}
      {item.error && <Notice error={item.error} />}
      {item.status && !['completed', 'canceled'].includes(item.status) && <Actions><Button label="取消事项" disabled={busy} onPress={() => void stop(item.botId, item.agentId)} /></Actions>}
    </View>)}
    {mail.map(group => <OfficeActions key={group.botId} botId={group.botId} inlineActions={group.actions} onChanged={refresh} />)}
  </>;
}
