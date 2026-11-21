import { useEffect, useRef, useState } from 'react';
import { View, type ScrollView as NativeScrollView } from 'react-native';
import { ScrollView, TextInput } from '@getpaseo/plugin/client/ui';
import { useHosts, usePaseo, useRpc } from '@getpaseo/plugin/client';
import type { RpcInput, RpcOutput } from '@getpaseo/plugin';
import type { PaseoAgentSendOptions } from '@getpaseo/client';
import * as rpc from '../shared/contracts.js';
import { conversationContext, conversationConfiguration, changeConversation } from '../shared/chat.js';
import { EMPTY_CHAT, observeChat, type ChatState } from './chat-state.js';
import { ChatTimeline } from './chat-timeline.js';
import { ChatPermission } from './chat-permission.js';
import { ChatWork } from './chat-work.js';
import { ConversationSettings } from './chat-settings.js';
import { Actions, Button, Copy, Notice, useUi } from './ui.js';

interface Draft { text: string; messageId?: string; attachments?: PaseoAgentSendOptions['attachments']; sending?: boolean; unknown?: boolean; error?: string; stopping?: boolean; stopError?: string }
interface SettingsChange { request: RpcInput<typeof changeConversation>; pending: boolean; error?: string }
const NO_HISTORY: string[] = [];

export function Chat({ botId, hostId, sessionId, openAgent, onConversationChange }: { botId: string; hostId: string; sessionId?: string; openAgent(id: string): void; onConversationChange?(botId: string, previousId: string, agentId: string): void }) {
  const api = usePaseo();
  const hosts = useHosts();
  const open = useRpc(rpc.openConversation);
  const stop = useRpc(rpc.stopReply);
  const prepare = useRpc(conversationContext);
  const readConfiguration = useRpc(conversationConfiguration);
  const switchConversation = useRpc(changeConversation);
  const { colors, compact } = useUi();
  const [opened, setOpened] = useState<{ key: string; agentId?: string; owner: string; error: string }>({ key: '', owner: botId, error: '' });
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [configuration, setConfiguration] = useState<{ agentId: string; value?: RpcOutput<typeof conversationConfiguration>; error: string }>();
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [settingsChanges, setSettingsChanges] = useState<Record<string, SettingsChange | undefined>>({});
  const observer = useRef<ReturnType<typeof observeChat> | undefined>(undefined);
  const scroll = useRef<NativeScrollView>(null);
  const nearBottom = useRef(true);
  const sends = useRef(new Set<string>());
  const stops = useRef(new Set<string>());
  const changing = useRef(new Set<string>());
  const key = `${botId}:${sessionId ?? 'conversation'}`;
  const agentId = opened.key === key ? opened.agentId : undefined;
  const chat = state.agentId === agentId ? state : EMPTY_CHAT;
  const draft = agentId ? drafts[agentId] ?? { text: '' } : { text: '' };
  const connection = hosts.find(host => host.serverId === hostId)?.status;
  const offline = connection !== undefined && connection !== 'online';
  const running = chat.agent?.status === 'running' || chat.agent?.status === 'initializing';
  const isConversation = chat.agent?.labels['paseo-guys.conversation'] === 'true';
  const settings = configuration && configuration.agentId === agentId ? configuration.value : undefined;
  const settingsError = configuration && configuration.agentId === agentId ? configuration.error : '';
  const settingsChange = agentId ? settingsChanges[agentId] : undefined;
  const previousAgentIds = settings?.previousAgentIds ?? NO_HISTORY;
  useEffect(() => {
    let active = true;
    setOpened({ key, owner: botId, error: '' });
    const request = sessionId ? api.agents.ref(sessionId).refresh().then(snapshot => {
      if (!snapshot) throw new Error('原生会话未找到');
      return { agentId: sessionId, owner: snapshot.agent.labels['paseo-guys.bot'] ?? botId };
    }) : open({ botId }).then(result => ({ ...result, owner: botId }));
    void request.then(result => {
      if (!active) return;
      setOpened({ key: !sessionId && onConversationChange ? `${botId}:${result.agentId}` : key, ...result, error: '' });
      if (!sessionId) onConversationChange?.(result.owner, result.agentId, result.agentId);
    }).catch(failure => { if (active) setOpened({ key, owner: botId, error: String(failure) }); });
    return () => { active = false; };
  }, [api, botId, sessionId, open, revision, onConversationChange]);
  useEffect(() => {
    nearBottom.current = true;
    if (!agentId) { setState(EMPTY_CHAT); return; }
    const current = observeChat(api, opened.owner, agentId, setState);
    observer.current = current;
    return () => { observer.current = undefined; void current.release().catch(error => console.error('聊天订阅清理失败', error)); };
  }, [api, agentId, opened.owner, revision]);
  useEffect(() => {
    if (!agentId || !isConversation) { setConfiguration(undefined); return; }
    let active = true;
    setConfiguration({ agentId, error: '' });
    void readConfiguration({ botId: opened.owner, agentId }).then(value => { if (active) setConfiguration({ agentId, value, error: '' }); }).catch(failure => { if (active) setConfiguration({ agentId, error: String(failure) }); });
    return () => { active = false; };
  }, [agentId, isConversation, opened.owner, readConfiguration, configurationRevision, chat.agent?.provider, chat.agent?.model, chat.agent?.cwd, chat.agent?.thinkingOptionId]);
  useEffect(() => {
    if (!agentId || !draft.unknown || !draft.messageId) return;
    if (!chat.entries.some(entry => entry.item.type === 'user_message' && (entry.item.messageId === draft.messageId || entry.item.clientMessageId === draft.messageId))) return;
    setDrafts(current => ({ ...current, [agentId]: { text: '' } }));
  }, [agentId, chat.entries, draft.unknown, draft.messageId]);
  async function send() {
    if (!agentId || sends.current.has(agentId) || stops.current.has(agentId) || changing.current.has(agentId) || !draft.text.trim() || offline || chat.loading || chat.agent?.archivedAt) return;
    const target = agentId;
    const current = observer.current;
    const text = draft.text;
    const messageId = draft.messageId ?? `bots:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let attachments = draft.attachments;
    let dispatched = false;
    sends.current.add(target);
    setDrafts(current => ({ ...current, [target]: { text, messageId, sending: true } }));
    try {
      if (!attachments && chat.agent?.labels['paseo-guys.conversation'] === 'true') attachments = [await prepare({ botId: opened.owner, agentId: target })];
      setDrafts(current => ({ ...current, [target]: { text, messageId, attachments, sending: true } }));
      dispatched = true;
      await api.agents.ref(target).send(text, { messageId, activeTurnBehavior: 'steer', ...(attachments ? { attachments } : {}) });
      setDrafts(current => ({ ...current, [target]: { text: '' } }));
    } catch (failure) {
      setDrafts(current => ({ ...current, [target]: { text, messageId, attachments, unknown: dispatched, error: `${dispatched ? '发送回执未确认' : '准备聊天上下文失败，消息尚未发送'}：${String(failure)}` } }));
    } finally { sends.current.delete(target); }
    void current?.refresh();
  }
  async function interruptReply() {
    if (!agentId || stops.current.has(agentId) || sends.current.has(agentId) || changing.current.has(agentId) || offline || chat.agent?.status !== 'running') return;
    const target = agentId;
    const current = observer.current;
    stops.current.add(target);
    setDrafts(current => ({ ...current, [target]: { ...current[target], text: current[target]?.text ?? '', stopping: true, stopError: undefined } }));
    try { await stop({ botId: opened.owner, agentId: target }); }
    catch (failure) { setDrafts(current => ({ ...current, [target]: { ...current[target], stopError: String(failure) } })); }
    finally {
      stops.current.delete(target);
      setDrafts(current => ({ ...current, [target]: { ...current[target], stopping: false } }));
      void current?.refresh();
    }
  }
  async function changeSettings(execution?: RpcInput<typeof changeConversation>['execution']) {
    if (!agentId || changing.current.has(agentId) || sends.current.has(agentId) || stops.current.has(agentId) || draft.unknown || offline || chat.loading || running || chat.agent?.archivedAt || chat.agent?.pendingPermissions.length) return;
    const target = agentId;
    const owner = opened.owner;
    const current = observer.current;
    const prior = settingsChanges[target];
    let request = prior?.request;
    if (execution && (!request || execution.provider !== request.execution.provider || execution.cwd !== request.execution.cwd || execution.thinkingOptionId !== request.execution.thinkingOptionId)) {
      request = {
        botId: owner, agentId: target, execution,
        requestId: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => { const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16); }),
      };
    }
    if (!request) return;
    changing.current.add(target);
    setSettingsChanges(current => ({ ...current, [target]: { request, pending: true } }));
    try {
      const result = await switchConversation(request);
      if (result.agentId !== target) {
        setDrafts(current => ({ ...current, [target]: { text: '' }, [result.agentId]: { text: current[target]?.text ?? '' } }));
        onConversationChange?.(owner, target, result.agentId);
        setOpened(current => current.agentId === target ? { ...current, key: onConversationChange ? `${owner}:${result.agentId}` : key, agentId: result.agentId, error: '' } : current);
      }
      setSettingsChanges(current => ({ ...current, [target]: undefined }));
    } catch (failure) { setSettingsChanges(current => ({ ...current, [target]: { request, pending: false, error: `切换结果未确认：${String(failure)}` } })); }
    finally { changing.current.delete(target); void current?.refresh(); }
  }
  const error = opened.key === key ? opened.error || chat.error : '';
  const blocked = !agentId || offline || chat.loading || !!error || !!chat.agent?.archivedAt || !!draft.sending || !!draft.stopping || !!settingsChange?.pending;
  return <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView key={agentId} ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 16 : 28, paddingVertical: 20 }} keyboardShouldPersistTaps="handled" scrollEventThrottle={100} onScroll={event => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
    }} onContentSizeChange={() => { if (nearBottom.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      <View style={{ maxWidth: 800, width: '100%', alignSelf: 'center', gap: 18 }}>
        {error && <View><Notice error={error} /><Button label="重试" onPress={() => setRevision(value => value + 1)} /></View>}
        {(chat.loading || (!agentId && !error)) && <Copy muted>读取中…</Copy>}
        {previousAgentIds.map(id => <ChatSegment key={id} botId={opened.owner} agentId={id} openAgent={openAgent} onLoadOlder={() => { nearBottom.current = false; }} />)}
        {chat.hasOlder && <Button label={chat.loadingOlder ? '读取中…' : '更早消息'} disabled={chat.loadingOlder} onPress={() => { nearBottom.current = false; void observer.current?.loadOlder(); }} />}
        <ChatTimeline entries={chat.entries} activeTurnId={chat.agent?.activeTurn?.turnId} openAgent={openAgent} />
        {agentId && isConversation && <ChatWork key={agentId} botId={opened.owner} agentId={agentId} previousAgentIds={previousAgentIds} signal={`${chat.agent?.status}:${chat.agent?.activeTurn?.turnId ?? ''}:${chat.entries.filter(entry => entry.item.type === 'tool_call' && entry.item.status !== 'running').at(-1)?.seqEnd ?? ''}`} openAgent={openAgent} />}
        {chat.agent?.pendingPermissions.map(permission => <ChatPermission key={`${agentId}:${permission.id}`} permission={permission} agent={api.agents.ref(agentId!)} />)}
      </View>
    </ScrollView>
    {!chat.agent?.archivedAt && <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
      <View style={{ maxWidth: 800, width: '100%', alignSelf: 'center', gap: 8 }}>
        {draft.error && <><Notice error={draft.error} /><Actions><Button label="回查消息" disabled={draft.sending || offline} onPress={() => void observer.current?.refresh()} /></Actions></>}
        {draft.stopError && <Notice error={draft.stopError} />}
        {settingsError && <><Notice error={settingsError} /><Actions><Button label="重试读取设置" disabled={offline} onPress={() => setConfigurationRevision(value => value + 1)} /></Actions></>}
        {settingsChange?.error && <><Notice error={settingsChange.error} /><Actions><Button label="重试切换" disabled={blocked || running || draft.unknown || !!chat.agent?.pendingPermissions.length} onPress={() => void changeSettings()} /></Actions></>}
        {offline && <Copy muted>{connection === 'connecting' ? '连接中…' : '连接已断开'}</Copy>}
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 16, paddingTop: compact ? 8 : 16, paddingBottom: compact ? 8 : 12, gap: 12, backgroundColor: colors.surface1 }}>
          <TextInput accessibilityLabel="消息" placeholder="消息" value={draft.text} multiline editable={!blocked && !draft.unknown} placeholderTextColor={colors.foregroundMuted} onChangeText={text => { if (agentId) setDrafts(current => ({ ...current, [agentId]: { text } })); }} onKeyPress={event => {
            const native = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean };
            if (!compact && native.key === 'Enter' && !native.shiftKey && !native.isComposing) { event.preventDefault(); void send(); }
          }} style={{ outlineWidth: 0, color: colors.foreground, fontSize: compact ? 16 : 15, lineHeight: 22, minHeight: 48, maxHeight: 160, padding: 0, textAlignVertical: 'top' }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginHorizontal: -6 }}>
            {isConversation && <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}><ConversationSettings key={agentId} execution={settings?.execution ?? {}} defaultCwd={settings?.defaultCwd} disabled={blocked || !settings || running || draft.unknown || !!chat.agent?.pendingPermissions.length} onChange={value => void changeSettings(value)} /></View>}
            <View style={{ flexDirection: 'row', flexShrink: 0, alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
              {running && <Button label="停止回复" icon="Square" iconOnly size="xs" disabled={offline || draft.stopping || draft.sending || settingsChange?.pending || chat.agent?.status !== 'running'} onPress={() => void interruptReply()} />}
              <Button label={draft.unknown ? '重试发送' : '发送'} icon="ArrowUp" iconOnly={!draft.unknown} primary size="xs" disabled={blocked || !draft.text.trim()} onPress={() => void send()} />
            </View>
          </View>
        </View>
      </View>
    </View>}
  </View>;
}

export function ChatSegment({ botId, agentId, openAgent, onLoadOlder }: { botId: string; agentId: string; openAgent(id: string): void; onLoadOlder(): void }) {
  const api = usePaseo();
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);
  const [revision, setRevision] = useState(0);
  const observer = useRef<ReturnType<typeof observeChat> | undefined>(undefined);
  useEffect(() => {
    const current = observeChat(api, botId, agentId, setState);
    observer.current = current;
    return () => { observer.current = undefined; void current.release().catch(error => console.error('历史订阅清理失败', error)); };
  }, [api, botId, agentId, revision]);
  return <View style={{ gap: 18 }}>
    {state.error && <View><Notice error={state.error} /><Button label="重试" onPress={() => setRevision(value => value + 1)} /></View>}
    {state.loading && <Copy muted>读取中…</Copy>}
    {state.hasOlder && <Button label={state.loadingOlder ? '读取中…' : '更早消息'} disabled={state.loadingOlder} onPress={() => { onLoadOlder(); void observer.current?.loadOlder(); }} />}
    <ChatTimeline entries={state.entries} activeTurnId={state.agent?.activeTurn?.turnId} openAgent={openAgent} />
    {state.agent?.pendingPermissions.map(permission => <ChatPermission key={`${agentId}:${permission.id}`} permission={permission} agent={api.agents.ref(agentId)} />)}
  </View>;
}
