import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import { Modal, SidebarRow } from '@getpaseo/plugin/client/ui';
import * as rpc from './shared/contracts.js';
import { CHIEF_BOT_ID } from './shared/bot.js';
import { Memories } from './client/memories.js';
import { Chat } from './client/chat.js';
import { BotConfiguration } from './client/bot-config.js';
import { HostSettings } from './client/host-settings.js';
import { useBotUpdates } from './client/use-bot-updates.js';
import { Actions, Button, Copy, Notice, UiProvider } from './client/ui.js';

/** Phase 1 只收口主入口；任务条、专长配置抽屉与 Markdown 记忆留给后续阶段。 */
function Bots({ theme, layout, host }: PluginScreenProps) {
  const api = usePaseo();
  const list = useRpc(rpc.listBots);
  const update = useRpc(rpc.updateBot);
  const createConversation = useRpc(rpc.createConversation);
  const updates = useBotUpdates(CHIEF_BOT_ID);
  const [chief, setChief] = useState<RpcOutput<typeof rpc.listBots>['bots'][number]>();
  const [conversation, setConversation] = useState<string>();
  const [panel, setPanel] = useState<'settings' | 'memories' | null>(null);
  const [defaults, setDefaults] = useState(false);
  const [detail, setDetail] = useState<{ agentId: string; owner: string; title: string }>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const compact = layout.compact || (size.width > 0 && size.width < 840);
  const { colors } = theme;
  const refresh = useCallback(async () => {
    const result = await list({});
    setChief(result.bots.find(bot => bot.id === CHIEF_BOT_ID));
    if (result.corrupt.length) setError(`v2 配置损坏：${result.corrupt.join('、')}。原文件已保留。`);
  }, [list]);
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); }, [refresh, updates.revision]);
  const rememberConversation = useCallback((_owner: string, previousId: string, agentId: string) => {
    setConversation(current => !current || current === previousId ? agentId : current);
  }, []);
  function openAgent(agentId: string, sourceBotId = CHIEF_BOT_ID) {
    void api.agents.ref(agentId).refresh().then(snapshot => {
      if (!snapshot) throw new Error('原生会话未找到');
      setDetail({ agentId, owner: snapshot.agent.labels['paseo-guys.bot'] ?? sourceBotId, title: snapshot.agent.title || '执行详情' });
    }).catch(failure => setError(String(failure)));
  }
  async function run(action: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  async function newConversation() {
    const result = await createConversation({ botId: CHIEF_BOT_ID });
    setConversation(result.agentId); setPanel(null);
  }
  return <UiProvider value={{ colors, compact }}>
    <View onLayout={event => setSize(event.nativeEvent.layout)} style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 14, flex: 1 }}>{chief?.name || '主总管'}</Text>
        <Button label="新对话" icon="SquarePen" iconOnly size="xs" disabled={!chief || busy} onPress={() => void run(newConversation)} />
        <Button label="配置" icon="Settings" iconOnly size="xs" disabled={!chief || busy} onPress={() => { setDefaults(false); setPanel('settings'); }} />
        <Button label="记忆" icon="Brain" iconOnly size="xs" disabled={!chief || busy} onPress={() => setPanel('memories')} />
      </View>
      {(error || updates.error) && <View style={{ paddingHorizontal: 16, paddingTop: 12 }}><Notice error={error || updates.error} /></View>}
      {chief ? <Chat key={host.id} botId={CHIEF_BOT_ID} hostId={host.id} sessionId={conversation} onConversationChange={rememberConversation} openAgent={openAgent} /> : <View style={{ padding: 24 }}><Copy muted>读取主总管中…</Copy></View>}
    </View>
    <Modal title={panel === 'memories' ? '记忆' : '配置'} open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}><Modal.Content>
      <Notice error={error} />
      {panel === 'settings' && <><Actions><Button label="主总管" selected={!defaults} onPress={() => setDefaults(false)} /><Button label="默认设置" selected={defaults} onPress={() => setDefaults(true)} /></Actions>
        {defaults ? <HostSettings /> : chief && <BotConfiguration key={chief.updatedAt} bot={chief} disabled={busy} save={async (patch, startNew) => run(async () => {
          await update({ botId: CHIEF_BOT_ID, patch });
          await refresh();
          if (startNew) await newConversation();
          setPanel(null);
        })} />}</>}
      {panel === 'memories' && <Memories botId={CHIEF_BOT_ID} openAgent={openAgent} />}
    </Modal.Content></Modal>
    <Modal title={detail?.title || '执行详情'} open={detail !== undefined} onOpenChange={open => { if (!open) setDetail(undefined); }}><Modal.Content scrollable={false} style={{ height: Math.max(300, Math.min(640, size.height - 80)), backgroundColor: colors.surface0 }} contentContainerStyle={{ flex: 1, padding: 0, gap: 0 }}>
      {detail && <Chat key={`${host.id}:${detail.agentId}`} botId={detail.owner} hostId={host.id} sessionId={detail.agentId} openAgent={id => openAgent(id, detail.owner)} />}
    </Modal.Content></Modal>
  </UiProvider>;
}

function BotSidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Users" label="总管" active={currentScreen?.screenId === 'bots'} onPress={() => openScreen({ screenId: 'bots' })} />;
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: 'bots', title: '总管', Component: Bots });
  const sidebar = client.addSidebarHeaderItem({ id: 'bots', title: '总管', Component: BotSidebar });
  return () => { sidebar(); screen(); };
}
