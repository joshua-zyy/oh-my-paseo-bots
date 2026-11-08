import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import * as rpc from '../shared/contracts.js';
import type { MemoryOrigin } from '../shared/memory.js';
import type { ChannelId } from '../shared/channels.js';
import { Actions, Button, Copy, Disclosure, Field, Notice, Section, useUi } from './ui.js';
import { useBotUpdates } from './use-bot-updates.js';

export function Memories({ botId, channelId, openAgent }: { botId: string; channelId?: ChannelId; openAgent?: (agentId: string) => void }) {
  const updates = useBotUpdates(botId);
  const list = useRpc(rpc.listMemories);
  const save = useRpc(rpc.saveMemory);
  const correct = useRpc(rpc.correctMemory);
  const forget = useRpc(rpc.forgetMemory);
  const restore = useRpc(rpc.restoreMemory);
  const [team, setTeam] = useState(false);
  const [published, setPublished] = useState(false);
  const owner = { botId, ...(team ? { team: true as const } : channelId ? { channelId } : {}) };
  const [showArchived, setShowArchived] = useState(false);
  const [opened, setOpened] = useState<string>();
  const { colors } = useUi();
  const [entries, setEntries] = useState<RpcOutput<typeof rpc.listMemories>>([]);
  const [editing, setEditing] = useState<{ id?: string; content: string; kind: 'candidate' | 'confirmed'; sharing?: boolean }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action?: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action?.(); setEntries(await list({ ...owner, includeArchived: true })); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void list({ ...owner, includeArchived: true }).then(value => { if (active) setEntries(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, channelId, team, list, updates.revision]);
  const groups = [
    { key: 'candidate', title: '待确认', items: entries.filter(item => !item.archivedAt && item.kind === 'candidate') },
    { key: 'confirmed', title: '已确认', items: entries.filter(item => !item.archivedAt && item.kind === 'confirmed') },
    ...(showArchived ? [{ key: 'archived', title: '已归档', items: entries.filter(item => item.archivedAt) }] : []),
  ];
  const actions = { updated: '修改／确认', archived: '遗忘／拒绝', restored: '恢复', merged: '合并重复' };
  return <>
    <Actions><Button label={channelId ? '本群记忆' : '个人记忆'} selected={!team} disabled={busy || !!editing} onPress={() => { setEntries([]); setTeam(false); setPublished(false); }} /><Button label="团队共享记忆" selected={team} disabled={busy || !!editing} onPress={() => { setEntries([]); setTeam(true); setPublished(false); }} /></Actions>
    <Copy muted small>{team ? '当前为团队共享区：确认内容对全体Bot可读。你也可在对话中明确要求发布当前场景的确认条目；不会自动共享私聊来源或历史。' : '当前记忆默认仅属本同事或本群；只有你明确发布的内容才进入团队共享区。'}</Copy>
    {published && <Copy small>已发布团队共享副本，可到「团队共享记忆」查看；原条与副本的纠正、遗忘分别操作，不自动同步。</Copy>}
    <Notice error={error || updates.error} />
    <Actions><Button label="刷新" disabled={busy} onPress={() => void run()} /><Button label="添加记忆" icon="Plus" disabled={busy} onPress={() => setEditing({ content: '', kind: 'confirmed' })} /><Button label="已归档" selected={showArchived} disabled={busy} onPress={() => setShowArchived(value => !value)} /></Actions>
    <Copy muted small>遗忘或拒绝后不再提供给 Bot，可在已归档中恢复；不会擦除会话历史和备份。</Copy>
    {editing && <View style={{ padding: 16, marginVertical: 16, borderRadius: 8, backgroundColor: colors.surface1 }}>
      {editing.sharing && <Copy small>确认发布下方内容给全体Bot；不复制原条来源、私聊原话或历史。发布后是独立副本。</Copy>}
      <Field label={editing.sharing ? '发布内容预览' : editing.id ? '纠正记忆' : '记忆内容'} value={editing.content} maxLength={8000} multiline disabled={busy} onChangeText={content => setEditing({ ...editing, content })} />
      <Actions><Button label="取消" disabled={busy} onPress={() => setEditing(undefined)} />{editing.sharing ? <Button label="确认发布给全团队" primary disabled={busy || !editing.content.trim()} onPress={() => void run(async () => { await save({ botId, team: true, kind: 'confirmed', content: editing.content }); setEditing(undefined); setPublished(true); })} /> : <Button label="保存记忆" primary disabled={busy || !editing.content.trim()} onPress={() => void run(async () => {
        if (editing.id) await correct({ ...owner, memoryId: editing.id, kind: editing.kind, content: editing.content });
        else await save({ ...owner, kind: 'confirmed', content: editing.content });
        setEditing(undefined);
      })} />}</Actions>
      {editing.id && <Copy muted small>只修改当前记忆，历史和备份保留。</Copy>}
    </View>}
    {groups.map(group => (group.items.length > 0 || group.key !== 'candidate') && <Section key={group.key} title={group.title}>
      {group.items.map(entry => <View key={entry.id} style={{ paddingVertical: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Copy>{entry.content}</Copy>
        <Actions>{entry.archivedAt ? <Button label="恢复" disabled={busy} onPress={() => void run(() => restore({ ...owner, memoryId: entry.id }))} /> : <>
          {entry.kind === 'candidate' && <Button label="确认" disabled={busy} onPress={() => void run(() => correct({ ...owner, memoryId: entry.id, kind: 'confirmed', content: entry.content }))} />}
          {!team && entry.kind === 'confirmed' && <Button label="发布到团队" disabled={busy} onPress={() => setEditing({ content: entry.content, kind: 'confirmed', sharing: true })} />}
          <Button label="编辑" disabled={busy} onPress={() => setEditing({ id: entry.id, content: entry.content, kind: entry.kind })} />
          <Button label={entry.kind === 'candidate' ? '拒绝' : '遗忘'} disabled={busy} onPress={() => void run(() => forget({ ...owner, memoryId: entry.id }))} />
        </>}</Actions>
        <Disclosure title="来源与变更记录" open={opened === entry.id} onPress={() => setOpened(opened === entry.id ? undefined : entry.id)}>
          <Copy muted small>创建时间：{entry.createdAt}</Copy>
          <MemoryOriginView label="创建来源" origin={entry.origin} openAgent={openAgent} />
          {entry.history.map((change, index) => <View key={index} style={{ gap: 6, paddingTop: 10 }}>
            <Copy muted small>{change.at} · {actions[change.action]}</Copy>
            {change.action === 'updated' && <Copy muted small>修改前（{change.before.kind === 'candidate' ? '候选' : '已确认'}）：{change.before.content}</Copy>}
            {change.action === 'merged' && <Copy muted small>合并到：{change.targetId}</Copy>}
            <MemoryOriginView label="操作来源" origin={change.origin} openAgent={openAgent} />
          </View>)}
          {!entry.history.length && <Copy muted small>暂无变更记录</Copy>}
        </Disclosure>
      </View>)}
      {!group.items.length && <Copy muted>暂无记忆</Copy>}
    </Section>)}
  </>;
}

function MemoryOriginView({ label, origin, openAgent }: { label: string; origin?: MemoryOrigin; openAgent?: (agentId: string) => void }) {
  return <>
    <Copy muted small>{label}：{!origin ? '未记录' : origin.type === 'manual' ? '用户明确录入／发布（不附会话原文）' : origin.type === 'message' ? '核对过的用户消息' : 'Agent 提出的候选'}</Copy>
    {origin && origin.type !== 'manual' && <>
      <Copy muted small>会话：{origin.agentId}</Copy>
      {origin.type === 'message' && <Copy muted small>用户原话：{origin.userQuote}</Copy>}
      <Button label="打开来源会话" disabled={!openAgent} onPress={() => openAgent?.(origin.agentId)} />
    </>}
  </>;
}
