import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import { Icon, Modal, ScrollView, SettingsAction, SettingsCard, SidebarRow, TextInput } from '@getpaseo/plugin/client/ui';
import * as rpc from './shared/contracts.js';
import { CHIEF_BOT_ID } from './shared/bot.js';
import { channelIdSchema, type ChannelId } from './shared/channels.js';
import { Memories } from './client/memories.js';
import { Routines } from './client/routines.js';
import { Work } from './client/work.js';
import { Chat } from './client/chat.js';
import { BotConfiguration } from './client/bot-config.js';
import { HostSettings } from './client/host-settings.js';
import { Channels } from './client/channels.js';
import { useBotUpdates } from './client/use-bot-updates.js';
import { Actions, Button, Copy, Field, Notice, PickerRow, UiProvider } from './client/ui.js';

type Panel = 'menu' | 'settings' | 'host' | 'work' | 'memories' | 'routines' | 'archive' | 'archived' | 'channels';
const panels = { menu: '同事', settings: '同事设置', host: '默认设置', work: '工作记录', memories: '记忆', routines: '例程', archive: '归档同事', archived: '已归档同事', channels: '项目频道' };
const menu = [
  { panel: 'settings', label: '设置', icon: 'Settings' },
  { panel: 'work', label: '工作记录', icon: 'ListTodo' },
  { panel: 'memories', label: '记忆', icon: 'Brain' },
  { panel: 'routines', label: '例程', icon: 'CalendarClock' },
] as const;

function Bots({ theme, layout, host }: PluginScreenProps) {
  const api = usePaseo();
  const list = useRpc(rpc.listBots);
  const create = useRpc(rpc.createBot);
  const update = useRpc(rpc.updateBot);
  const archive = useRpc(rpc.archiveBot);
  const restore = useRpc(rpc.restoreBot);
  const createConversation = useRpc(rpc.createConversation);
  const [bots, setBots] = useState<RpcOutput<typeof rpc.listBots>['bots']>([]);
  const [selected, select] = useState(CHIEF_BOT_ID);
  const updates = useBotUpdates(selected);
  const [conversations, setConversations] = useState<Record<string, string>>({});
  const rememberConversation = useCallback((owner: string, previousId: string, agentId: string) => {
    setConversations(current => {
      if (current[owner] === agentId || (current[owner] && current[owner] !== previousId)) return current;
      return { ...current, [owner]: agentId };
    });
  }, []);
  const [detail, setDetail] = useState<{ agentId: string; owner: string; title: string; executor: string }>();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [channelTarget, setChannelTarget] = useState<ChannelId>();
  const [picker, setPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const compact = layout.compact || (size.width > 0 && size.width < 840);
  const { colors } = theme;
  async function refresh() {
    const result = await list({ includeArchived: true });
    setBots(result.bots);
    select(id => result.bots.some(bot => bot.id === id && !bot.archivedAt) ? id : CHIEF_BOT_ID);
    if (result.corrupt.length) setError(`存档损坏：${result.corrupt.join('、')}。原文件已保留。`);
  }
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); }, [list, updates.revision]);
  const current = bots.find(bot => bot.id === selected && !bot.archivedAt);
  const archived = bots.filter(bot => bot.archivedAt);
  const shown = bots.filter(bot => !bot.archivedAt).sort((a, b) => a.id === CHIEF_BOT_ID ? -1 : b.id === CHIEF_BOT_ID ? 1 : a.name.localeCompare(b.name, 'zh-CN')).filter(bot => `${bot.name} ${bot.role}`.toLowerCase().includes(search.toLowerCase()));
  function choose(id: string) { select(id); setPanel(null); setPicker(false); setDetail(undefined); setError(''); }
  function openAgent(agentId: string, sourceBotId = selected) {
    void api.agents.ref(agentId).refresh().then(snapshot => {
      if (!snapshot) throw new Error('原生会话未找到');
      if (snapshot.agent.labels['paseo-guys.channel']) {
        setChannelTarget(channelIdSchema.parse(snapshot.agent.labels['paseo-guys.channel'])); setPanel('channels'); return;
      }
      const owner = snapshot.agent.labels['paseo-guys.bot'] ?? sourceBotId;
      const executor = snapshot.agent.labels['paseo-guys.bot'] ? bots.find(bot => bot.id === owner)?.name || owner : snapshot.agent.labels['paseo.schedule-id'] ? bots.find(bot => bot.id === owner)?.name || '例程同事' : '原生专家';
      setPanel(null);
      if (snapshot.agent.labels['paseo-guys.conversation'] === 'true') {
        choose(owner); setConversations(current => ({ ...current, [owner]: agentId }));
      } else setDetail({ agentId, owner, title: snapshot.agent.title || '执行详情', executor });
    }).catch(failure => setError(String(failure)));
  }
  async function newConversation() {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { const result = await createConversation({ botId: selected }); setConversations(current => ({ ...current, [selected]: result.agentId })); setPanel(null); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  async function changeArchive(botId: string, shouldArchive: boolean) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try {
      await (shouldArchive ? archive : restore)({ botId });
      await refresh();
      if (shouldArchive) choose(CHIEF_BOT_ID);
    } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  const roster = <>
    <TextInput accessibilityLabel="搜索同事" placeholder="搜索同事" value={search} onChangeText={setSearch} placeholderTextColor={colors.foregroundMuted} style={{ outlineWidth: 0, color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 6, padding: 10, fontSize: compact ? 16 : 14, marginBottom: 12 }} />
    {shown.map(bot => <PickerRow key={bot.id} label={bot.name} icon={bot.id === CHIEF_BOT_ID ? 'Users' : 'UserRound'} selected={selected === bot.id} disabled={busy} onPress={() => choose(bot.id)} />)}
    {!shown.length && <Copy muted>没有匹配的同事</Copy>}
  </>;
  return <UiProvider value={{ colors, compact }}>
    <View onLayout={event => setSize(event.nativeEvent.layout)} style={{ flex: 1, flexDirection: compact ? 'column' : 'row', backgroundColor: colors.surface0 }}>
      {!compact && <View style={{ width: 220, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.surface1 }}>
        <View style={{ padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Copy>同事</Copy><Button label="添加同事" icon="Plus" iconOnly size="xs" disabled={busy} onPress={() => setCreating(true)} /></View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 20 }} keyboardShouldPersistTaps="handled">{roster}</ScrollView>
        <View style={{ padding: 10, borderTopWidth: 1, borderTopColor: colors.border }}><Button label="项目频道" icon="Hash" disabled={busy} onPress={() => { setChannelTarget(undefined); setPanel('channels'); }} /><Button label="已归档同事" icon="Archive" disabled={busy} onPress={() => setPanel('archived')} /><Button label="默认设置" icon="Settings2" disabled={busy} onPress={() => setPanel('host')} /></View>
      </View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {compact ? <View style={{ flex: 1 }}><Button label={current?.name || '选择同事'} icon="ChevronDown" disabled={busy} onPress={() => setPicker(true)} /></View> : <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '300', flex: 1 }}>{current?.name || '同事'}</Text>}
          <Button label="新对话" icon="SquarePen" iconOnly size="xs" disabled={!current || busy} onPress={() => void newConversation()} />
          <Button label="同事菜单" icon="Ellipsis" iconOnly size="xs" disabled={!current || busy} onPress={() => setPanel('menu')} />
        </View>
        {!creating && !panel && (error || updates.error) && <View style={{ paddingHorizontal: compact ? 16 : 28, paddingTop: 12 }}><Notice error={error || updates.error} /></View>}
        {current ? <Chat key={host.id} botId={selected} hostId={host.id} sessionId={conversations[selected]} onConversationChange={rememberConversation} openAgent={openAgent} /> : <View style={{ padding: 24 }}><Copy muted>读取同事中…</Copy></View>}
      </View>
    </View>
    <Modal title="选择同事" open={picker} onOpenChange={setPicker}><Modal.Content>{roster}<Actions><Button label="项目频道" icon="Hash" onPress={() => { setPicker(false); setChannelTarget(undefined); setPanel('channels'); }} /><Button label="已归档同事" icon="Archive" onPress={() => { setPicker(false); setPanel('archived'); }} /><Button label="默认设置" icon="Settings2" onPress={() => { setPicker(false); setPanel('host'); }} /><Button label="添加同事" icon="Plus" onPress={() => { setPicker(false); setCreating(true); }} /></Actions></Modal.Content></Modal>
    <Modal title={panel === 'menu' ? current?.name || '同事' : panel ? panels[panel] : '同事'} open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}><Modal.Content>
      {panel && panel !== 'menu' && panel !== 'host' && panel !== 'archived' && panel !== 'channels' && <View style={{ alignItems: 'flex-start' }}><Button label="返回" icon="ArrowLeft" disabled={busy} onPress={() => setPanel('menu')} /></View>}
      <Notice error={error} />
      {panel === 'archive' && current && <><Copy>归档「{current.name}」后，它会从同事列表与委派目录移除。身份、记忆、聊天历史和工作区文件保留，可从「已归档同事」恢复。</Copy><Copy muted>未结束事项、正在回复、待授权或有效例程须先处理；归档不会替你停止或取消工作。</Copy><Actions><Button label="暂不归档" disabled={busy} onPress={() => setPanel('menu')} /><Button label="确认归档" primary disabled={busy || current.id === CHIEF_BOT_ID} onPress={() => void changeArchive(current.id, true)} /></Actions></>}
      {panel === 'archived' && <>{archived.length ? <SettingsCard>{archived.map(bot => <SettingsAction key={bot.id} label={bot.name} hint={bot.role} actionLabel="恢复" disabled={busy} onPress={() => void changeArchive(bot.id, false)} />)}</SettingsCard> : <Copy muted>没有已归档同事</Copy>}</>}
      {panel === 'menu' ? <>{menu.map(item => <Pressable key={item.panel} accessibilityRole="button" onPress={() => setPanel(item.panel)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, minHeight: 44, backgroundColor: pressed ? colors.surface1 : 'transparent', borderRadius: 6 })}><Icon name={item.icon} size={18} color={colors.foregroundMuted} /><Text style={{ color: colors.foreground, flex: 1, fontSize: 15 }}>{item.label}</Text><Icon name="ChevronRight" size={16} color={colors.foregroundMuted} /></Pressable>)}{current && current.id !== CHIEF_BOT_ID && <Button label="归档同事" icon="Archive" disabled={busy} onPress={() => setPanel('archive')} />}</>
        : panel === 'host' ? <HostSettings /> : panel === 'channels' ? <Channels bots={bots} hostId={host.id} initialChannelId={channelTarget} /> : current ? panel === 'settings' ? <BotConfiguration key={`${current.id}:${current.updatedAt}`} bot={current} botId={selected} disabled={busy} save={async (patch, startNew, mcpImports) => {
          if (guard.current) return;
          guard.current = true; setBusy(true); setError('');
          let saved = false;
          try {
            await update({ botId: selected, patch, mcpImports }); saved = true;
            await refresh();
            if (startNew) { const result = await createConversation({ botId: selected }); setConversations(current => ({ ...current, [selected]: result.agentId })); }
            setPanel(null);
          } catch (failure) { setError(`${saved ? '设置已保存；后续操作失败：' : ''}${String(failure)}`); }
          finally { guard.current = false; setBusy(false); }
        }} /> : panel === 'work' ? <Work key={selected} botId={selected} openAgent={openAgent} /> : panel === 'memories' ? <Memories key={selected} botId={selected} openAgent={openAgent} /> : panel === 'routines' ? <Routines key={selected} botId={selected} openAgent={openAgent} /> : null : null}
    </Modal.Content></Modal>
    <Modal title={detail?.title || '执行详情'} open={detail !== undefined} onOpenChange={open => { if (!open) setDetail(undefined); }}><Modal.Content scrollable={false} style={{ height: Math.max(300, Math.min(640, size.height - 80)), backgroundColor: colors.surface0 }} contentContainerStyle={{ flex: 1, padding: 0, gap: 0 }}>
      {detail && <><View style={{ paddingHorizontal: 24, paddingTop: 12 }}><Copy muted>{detail.executor}</Copy></View><Chat key={`${host.id}:${detail.agentId}`} botId={detail.owner} hostId={host.id} sessionId={detail.agentId} openAgent={id => openAgent(id, detail.owner)} /></>}
    </Modal.Content></Modal>
    <Modal title="添加同事" open={creating} onOpenChange={open => { setCreating(open); if (!open) setError(''); }}><Modal.Content>{creating && <NewBot busy={busy} submit={async values => {
      if (guard.current) return;
      guard.current = true; setBusy(true); setError('');
      try { const result = await create(values); await refresh(); choose(result.id); setCreating(false); }
      catch (failure) { setError(String(failure)); }
      finally { guard.current = false; setBusy(false); }
    }} error={error} />}</Modal.Content></Modal>
  </UiProvider>;
}

function NewBot({ busy, submit, error }: { busy: boolean; submit(values: { name: string; role: string }): Promise<void>; error: string }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  return <><Notice error={error} /><Field label="名称" value={name} onChangeText={setName} maxLength={200} disabled={busy} /><Field label="职责" value={role} onChangeText={setRole} maxLength={200} multiline disabled={busy} /><Actions><Button label="添加同事" primary disabled={busy || !name.trim() || !role.trim()} onPress={() => void submit({ name: name.trim(), role: role.trim() })} /></Actions></>;
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: 'bots', title: '同事', Component: Bots });
  const sidebar = client.addSidebarHeaderItem({ id: 'bots', title: '同事', Component: ({ openScreen, currentScreen }) => <SidebarRow icon="Users" label="同事" active={currentScreen?.screenId === 'bots'} onPress={() => openScreen({ screenId: 'bots' })} /> });
  return () => { sidebar(); screen(); };
}
