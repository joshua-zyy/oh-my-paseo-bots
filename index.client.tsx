import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import { Icon, Modal, ScrollView, SidebarRow, TextInput } from '@getpaseo/plugin/client/ui';
import * as rpc from './shared/contracts.js';
import { CHIEF_BOT_ID } from './shared/bot.js';
import { Memories } from './client/memories.js';
import { Routines } from './client/routines.js';
import { Work } from './client/work.js';
import { BotConfiguration } from './client/bot-config.js';
import { HostSettings } from './client/host-settings.js';
import { Actions, Button, Copy, Field, Notice, UiProvider } from './client/ui.js';

function Bots({ theme, layout, navigation }: PluginScreenProps) {
  const list = useRpc(rpc.listBots);
  const create = useRpc(rpc.createBot);
  const update = useRpc(rpc.updateBot);
  const [bots, setBots] = useState<RpcOutput<typeof rpc.listBots>['bots']>([]);
  const [selected, select] = useState(CHIEF_BOT_ID);
  const [tab, setTab] = useState<'工作' | '记忆' | '例程'>('工作');
  const [panel, setPanel] = useState<'settings' | 'host' | null>(null);
  const [picker, setPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [width, setWidth] = useState<number>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const compact = layout.compact || (width !== undefined && width < 840);
  const { colors } = theme;
  async function refresh() {
    const result = await list({});
    setBots(result.bots);
    if (result.corrupt.length) setError(`存档损坏：${result.corrupt.join('、')}。原文件已保留。`);
  }
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); }, [list]);
  const current = bots.find(bot => bot.id === selected);
  const shown = [...bots].sort((a, b) => a.id === CHIEF_BOT_ID ? -1 : b.id === CHIEF_BOT_ID ? 1 : a.name.localeCompare(b.name, 'zh-CN')).filter(bot => `${bot.name} ${bot.id} ${bot.role}`.toLowerCase().includes(search.toLowerCase()));
  function choose(id: string) { select(id); setPanel(null); setPicker(false); }
  const roster = <>
    <TextInput accessibilityLabel="搜索同事" placeholder="搜索同事" value={search} onChangeText={setSearch} placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 6, padding: 10, fontSize: compact ? 16 : 14, marginBottom: 12 }} />
    {shown.map(bot => <Pressable key={bot.id} accessibilityRole="button" accessibilityLabel={bot.name} accessibilityState={{ selected: selected === bot.id }} disabled={busy} onPress={() => choose(bot.id)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: compact ? 44 : 40, borderRadius: 6, backgroundColor: selected === bot.id ? colors.surface2 : pressed ? colors.surface1 : 'transparent' })}>
      <Icon name={bot.id === CHIEF_BOT_ID ? 'Users' : 'UserRound'} size={16} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foreground, fontSize: 14, flex: 1 }}>{bot.name}</Text>
    </Pressable>)}
    {!shown.length && <Copy muted>没有匹配的同事</Copy>}
  </>;
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  return <UiProvider value={{ colors, compact }}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, flexDirection: compact ? 'column' : 'row', backgroundColor: colors.surface0 }}>
      {!compact && <View style={{ width: 220, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.surface1 }}>
        <View style={{ padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Copy>同事</Copy><Button label="添加" icon="Plus" disabled={busy} onPress={() => setCreating(true)} /></View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 20 }} keyboardShouldPersistTaps="handled">{roster}</ScrollView>
        <View style={{ padding: 10, borderTopWidth: 1, borderTopColor: colors.border }}><Button label="宿主设置" icon="Settings2" disabled={busy} onPress={() => setPanel('host')} /></View>
      </View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ paddingHorizontal: compact ? 16 : 28, paddingTop: 18, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            {panel ? <><Button label="返回" icon="ArrowLeft" disabled={busy} onPress={() => setPanel(null)} /><Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '500', flex: 1 }}>{panel === 'host' ? '宿主设置' : '同事设置'}</Text></> : <>
              {compact ? <View style={{ flex: 1 }}><Button label={current?.name || '选择同事'} icon="ChevronDown" disabled={busy} onPress={() => setPicker(true)} /></View> : <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: '500', flex: 1 }}>{current?.name || '固定同事'}</Text>}
              {compact && <Button label="添加" icon="Plus" disabled={busy} onPress={() => setCreating(true)} />}
              <Button label="设置" icon="Settings" disabled={!current || busy} onPress={() => setPanel('settings')} />
            </>}
          </View>
          {!panel && <View style={{ flexDirection: 'row', gap: 24, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            {(['工作', '记忆', '例程'] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} disabled={busy} onPress={() => setTab(item)} style={{ minHeight: 44, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: tab === item ? colors.foreground : 'transparent' }}><Text style={{ color: tab === item ? colors.foreground : colors.foregroundMuted, fontSize: 14 }}>{item}</Text></Pressable>)}
          </View>}
        </View>
        <ScrollView key={`${selected}:${panel || tab}`} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 16 : 28, paddingTop: 14, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          <View style={{ maxWidth: 960, width: '100%', alignSelf: 'center' }}>
            <Notice error={creating ? '' : error} />
            {panel === 'host' ? <HostSettings /> : current ? panel === 'settings' ? <BotConfiguration key={`${current.id}:${current.updatedAt}`} bot={current} botId={selected} disabled={busy} save={async patch => {
              if (guard.current) return;
              guard.current = true;
              setBusy(true); setError('');
              try { await update({ botId: selected, patch }); await refresh(); }
              catch (failure) { setError(String(failure)); }
              finally { guard.current = false; setBusy(false); }
            }} /> : tab === '工作' ? <Work key={selected} botId={selected} openAgent={openAgent} /> : tab === '记忆' ? <Memories key={selected} botId={selected} /> : <Routines key={selected} botId={selected} openAgent={openAgent} /> : <Copy muted>读取同事中…</Copy>}
          </View>
        </ScrollView>
      </View>
    </View>
    <Modal title="选择同事" open={picker} onOpenChange={setPicker}><Modal.Content>{roster}<Button label="宿主设置" icon="Settings2" onPress={() => { setPicker(false); setPanel('host'); }} /></Modal.Content></Modal>
    <Modal title="添加同事" open={creating} onOpenChange={open => { setCreating(open); if (!open) setError(''); }}><Modal.Content>{creating && <NewBot busy={busy} submit={async values => {
      if (guard.current) return;
      guard.current = true;
      setBusy(true); setError('');
      try { await create(values); await refresh(); choose(values.id); setCreating(false); }
      catch (failure) { setError(String(failure).includes(`bot ${values.id} already exists`) ? '标识已存在，请换一个标识。' : String(failure)); }
      finally { guard.current = false; setBusy(false); }
    }} error={error} />}</Modal.Content></Modal>
  </UiProvider>;
}

function NewBot({ busy, submit, error }: { busy: boolean; submit(values: { id: string; name: string; role: string }): Promise<void>; error: string }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  return <><Notice error={error} /><Field label="名称" value={name} onChangeText={setName} maxLength={200} disabled={busy} /><Field label="职责" value={role} onChangeText={setRole} maxLength={200} multiline disabled={busy} /><Field label="标识" value={id} onChangeText={setId} placeholder="colleague" maxLength={64} disabled={busy} /><Actions><Button label="添加同事" primary disabled={busy || !id.trim() || !name.trim() || !role.trim()} onPress={() => void submit({ id, name, role })} /></Actions></>;
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: 'bots', title: '固定同事', Component: Bots });
  const sidebar = client.addSidebarHeaderItem({ id: 'bots', title: '固定同事', Component: ({ openScreen, currentScreen }) => <SidebarRow icon="Users" label="固定同事" active={currentScreen?.screenId === 'bots'} onPress={() => openScreen({ screenId: 'bots' })} /> });
  return () => { sidebar(); screen(); };
}
