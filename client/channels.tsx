import { useEffect, useRef, useState } from 'react';
import type { RpcInput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import * as rpc from '../shared/channels.js';
import type { Channel } from '../shared/channels.js';
import { CHIEF_BOT_ID } from '../shared/bot.js';
import { Actions, Button, Copy, Field, Notice, Section } from './ui.js';
import { PathPicker } from './path-picker.js';

type Member = { id: string; name: string; archivedAt?: string; execution?: { cwd?: string } };

export function Channels({ bots }: { bots: Member[] }) {
  const list = useRpc(rpc.listChannels);
  const create = useRpc(rpc.createChannel);
  const update = useRpc(rpc.updateChannel);
  const archive = useRpc(rpc.archiveChannel);
  const [items, setItems] = useState<Channel[]>();
  const [editing, setEditing] = useState<Channel | null>();
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  useEffect(() => {
    let active = true;
    void list({ includeArchived: true }).then(rows => { if (active) setItems(rows); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [list]);
  async function run(action: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  async function save(input: RpcInput<typeof rpc.createChannel>) {
    await run(async () => {
      const { id, ...details } = input;
      const saved = editing ? await update({ channelId: id, details }) : await create(input);
      setItems(current => [...(current ?? []).filter(item => item.id !== saved.id), saved]);
      setEditing(undefined); setShowArchived(false);
    });
  }
  return <>
    <Copy muted>为项目设置成员、管理员和共同工作范围。频道聊天尚未接入；保存配置不会启动 Agent、复制私聊或改变成员权限。</Copy>
    <Notice error={error} />
    {editing !== undefined ? <ChannelEditor key={editing?.id ?? 'new'} channel={editing ?? undefined} bots={bots} busy={busy} save={save} cancel={() => setEditing(undefined)} /> : <>
      <Actions><Button label={showArchived ? '活动频道' : '已归档频道'} selected={showArchived} disabled={busy} onPress={() => setShowArchived(value => !value)} /><Button label="刷新频道" disabled={busy} onPress={() => void run(async () => setItems(await list({ includeArchived: true })))} /><Button label="新建频道" icon="Plus" disabled={busy || !bots.some(bot => !bot.archivedAt)} onPress={() => { setError(''); setEditing(null); }} /></Actions>
      {!items && !error && <Copy muted>读取频道中…</Copy>}
      {items && !items.some(item => Boolean(item.archivedAt) === showArchived) && <Copy muted>{showArchived ? '没有已归档频道。' : '还没有项目频道。'}</Copy>}
      {items?.filter(item => Boolean(item.archivedAt) === showArchived).map(channel => <Section key={channel.id} title={channel.name}>
        <Copy muted>{channel.memberIds.map(id => bots.find(bot => bot.id === id)?.name ?? id).join('、')} · 管理员：{bots.find(bot => bot.id === channel.adminBotId)?.name ?? channel.adminBotId}{channel.archivedAt ? ' · 已归档' : ''}</Copy>
        <Copy small>{channel.cwd}</Copy>
        <Actions>
          {!channel.archivedAt && <Button label={`编辑${channel.name}`} icon="Settings" disabled={busy} onPress={() => { setError(''); setEditing(channel); }} />}
          <Button label={channel.archivedAt ? `恢复${channel.name}` : `归档${channel.name}`} icon={channel.archivedAt ? 'ArchiveRestore' : 'Archive'} disabled={busy} onPress={() => void run(async () => {
            const saved = await archive({ channelId: channel.id, archived: !channel.archivedAt });
            setItems(current => current?.map(item => item.id === saved.id ? saved : item));
            if (!saved.archivedAt) setShowArchived(false);
          })} />
        </Actions>
      </Section>)}
    </>}
  </>;
}

export function ChannelEditor({ channel, bots, busy, save, cancel }: {
  channel?: Channel; bots: Member[]; busy: boolean; save(input: RpcInput<typeof rpc.createChannel>): Promise<void>; cancel(): void;
}) {
  const initialAdmin = bots.find(bot => bot.id === CHIEF_BOT_ID && !bot.archivedAt) ?? bots.find(bot => !bot.archivedAt);
  // 与现有聊天请求相同的客户端 UUID 方式；表单重试沿用此标识。
  const [id] = useState(() => channel?.id ?? rpc.channelIdSchema.parse('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => { const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16); })));
  const [name, setName] = useState(channel?.name ?? '');
  const [members, setMembers] = useState(channel?.memberIds ?? (initialAdmin ? [initialAdmin.id] : []));
  const [admin, setAdmin] = useState(channel?.adminBotId ?? initialAdmin?.id ?? '');
  const [cwd, setCwd] = useState(channel?.cwd ?? initialAdmin?.execution?.cwd ?? '');
  const [instructions, setInstructions] = useState(channel?.instructions ?? '');
  const shown = bots.filter(bot => !bot.archivedAt || members.includes(bot.id));
  return <Section title={channel ? '频道设置' : '新建频道'}>
    <Field label="频道名称" value={name} onChangeText={setName} maxLength={200} disabled={busy} />
    <Section title="频道成员"><SettingsCard>{shown.map(bot => <SettingsSwitch key={bot.id} label={bot.name} hint={bot.id === admin ? '当前管理员；先更换管理员才能移除' : bot.archivedAt ? '同事已归档' : undefined} value={members.includes(bot.id)} disabled={busy || bot.id === admin} onValueChange={selected => setMembers(current => selected ? [...current, bot.id] : current.filter(id => id !== bot.id))} />)}</SettingsCard></Section>
    <SettingsCard><SettingsSelect label="管理员" value={admin} options={members.map(id => ({ value: id, label: bots.find(bot => bot.id === id)?.name ?? id }))} disabled={busy} onValueChange={setAdmin} /></SettingsCard>
    <Copy muted small>管理员负责默认回应与组织协作，此角色不扩大同事的工具或账户权限。</Copy>
    <SettingsCard><PathPicker label="频道工作目录" value={cwd || undefined} disabled={busy} onChange={path => setCwd(path ?? '')} /></SettingsCard>
    <Field label="共同说明" value={instructions} onChangeText={setInstructions} multiline maxLength={24000} disabled={busy} placeholder="这个项目的目标、交付条件与共同约定；不填写凭据。" />
    <Actions><Button label="取消编辑频道" disabled={busy} onPress={cancel} /><Button label="保存频道" primary disabled={busy || !name.trim() || !cwd.trim() || !members.includes(admin)} onPress={() => void save({ id, name: name.trim(), memberIds: members, adminBotId: admin, cwd: cwd.trim(), instructions })} /></Actions>
  </Section>;
}
