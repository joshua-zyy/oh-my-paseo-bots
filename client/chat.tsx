import { useEffect, useRef, useState } from 'react';
import { View, type ScrollView as NativeScrollView } from 'react-native';
import { ScrollView, TextInput } from '@getpaseo/plugin/client/ui';
import { useHosts, usePaseo, useRpc } from '@getpaseo/plugin/client';
import * as rpc from '../shared/contracts.js';
import { EMPTY_CHAT, observeChat, type ChatState } from './chat-state.js';
import { ChatTimeline } from './chat-timeline.js';
import { ChatPermission } from './chat-permission.js';
import { Actions, Button, Copy, Notice, useUi } from './ui.js';

interface Draft { text: string; messageId?: string; sending?: boolean; unknown?: boolean; error?: string }

export function Chat({ botId, hostId, sessionId, openAgent, returnToChat }: { botId: string; hostId: string; sessionId?: string; openAgent(id: string): void; returnToChat(): void }) {
  const api = usePaseo();
  const hosts = useHosts();
  const open = useRpc(rpc.openConversation);
  const { colors, compact } = useUi();
  const [opened, setOpened] = useState<{ key: string; agentId?: string; owner: string; error: string }>({ key: '', owner: botId, error: '' });
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const observer = useRef<ReturnType<typeof observeChat> | undefined>(undefined);
  const scroll = useRef<NativeScrollView>(null);
  const nearBottom = useRef(true);
  const sends = useRef(new Set<string>());
  const key = `${botId}:${sessionId ?? 'conversation'}`;
  const agentId = opened.key === key ? opened.agentId : undefined;
  const chat = state.agentId === agentId ? state : EMPTY_CHAT;
  const draft = agentId ? drafts[agentId] ?? { text: '' } : { text: '' };
  const connection = hosts.find(host => host.serverId === hostId)?.status;
  const offline = connection !== undefined && connection !== 'online';
  const running = chat.agent?.status === 'running' || chat.agent?.status === 'initializing';
  useEffect(() => {
    let active = true;
    setOpened({ key, owner: botId, error: '' });
    const request = sessionId ? api.agents.ref(sessionId).refresh().then(snapshot => {
      if (!snapshot) throw new Error('原生会话未找到');
      return { agentId: sessionId, owner: snapshot.agent.labels['paseo-guys.bot'] ?? botId };
    }) : open({ botId }).then(result => ({ ...result, owner: botId }));
    void request.then(result => { if (active) setOpened({ key, ...result, error: '' }); }).catch(failure => { if (active) setOpened({ key, owner: botId, error: String(failure) }); });
    return () => { active = false; };
  }, [api, botId, sessionId, open, revision]);
  useEffect(() => {
    nearBottom.current = true;
    if (!agentId) { setState(EMPTY_CHAT); return; }
    const current = observeChat(api, opened.owner, agentId, setState);
    observer.current = current;
    return () => { observer.current = undefined; void current.release().catch(error => console.error('聊天订阅清理失败', error)); };
  }, [api, agentId, opened.owner, revision]);
  useEffect(() => {
    if (!agentId || !draft.unknown || !draft.messageId) return;
    if (!chat.entries.some(entry => entry.item.type === 'user_message' && (entry.item.messageId === draft.messageId || entry.item.clientMessageId === draft.messageId))) return;
    setDrafts(current => ({ ...current, [agentId]: { text: '' } }));
  }, [agentId, chat.entries, draft.unknown, draft.messageId]);
  async function send() {
    if (!agentId || sends.current.has(agentId) || !draft.text.trim() || offline || chat.loading || chat.agent?.archivedAt) return;
    const target = agentId;
    const current = observer.current;
    const text = draft.text;
    const messageId = draft.messageId ?? `bots:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    sends.current.add(target);
    setDrafts(current => ({ ...current, [target]: { text, messageId, sending: true } }));
    try {
      await api.agents.ref(target).send(text, { messageId, activeTurnBehavior: 'steer' });
      setDrafts(current => ({ ...current, [target]: { text: '' } }));
    } catch (failure) {
      setDrafts(current => ({ ...current, [target]: { text, messageId, unknown: true, error: `发送回执未确认：${String(failure)}` } }));
    } finally { sends.current.delete(target); }
    void current?.refresh();
  }
  const error = opened.key === key ? opened.error || chat.error : '';
  const blocked = !agentId || offline || chat.loading || !!error || !!chat.agent?.archivedAt || !!draft.sending;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {sessionId && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: compact ? 16 : 28, paddingVertical: 8 }}><Button label="返回聊天" icon="ArrowLeft" onPress={returnToChat} /><View style={{ flex: 1 }}><Copy>{chat.agent?.title}</Copy></View></View>}
    <ScrollView key={agentId} ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 16 : 28, paddingVertical: 20 }} keyboardShouldPersistTaps="handled" scrollEventThrottle={100} onScroll={event => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
    }} onContentSizeChange={() => { if (nearBottom.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      <View style={{ maxWidth: 800, width: '100%', alignSelf: 'center', gap: 18 }}>
        {error && <View><Notice error={error} /><Button label="重试" onPress={() => setRevision(value => value + 1)} /></View>}
        {(chat.loading || (!agentId && !error)) && <Copy muted>读取中…</Copy>}
        {chat.hasOlder && <Button label={chat.loadingOlder ? '读取中…' : '更早消息'} disabled={chat.loadingOlder} onPress={() => { nearBottom.current = false; void observer.current?.loadOlder(); }} />}
        <ChatTimeline entries={chat.entries} activeTurnId={chat.agent?.activeTurn?.turnId} openAgent={openAgent} />
        {chat.agent?.pendingPermissions.map(permission => <ChatPermission key={`${agentId}:${permission.id}`} permission={permission} agent={api.agents.ref(agentId!)} />)}
      </View>
    </ScrollView>
    {!chat.agent?.archivedAt && <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: compact ? 16 : 28, paddingTop: 12, paddingBottom: 16 }}>
      <View style={{ maxWidth: 800, width: '100%', alignSelf: 'center', gap: 8 }}>
        {draft.error && <><Notice error={draft.error} /><Actions><Button label="回查消息" disabled={draft.sending || offline} onPress={() => void observer.current?.refresh()} /></Actions></>}
        {offline && <Copy muted>{connection === 'connecting' ? '连接中…' : '连接已断开'}</Copy>}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 8, backgroundColor: colors.surface1 }}>
          <TextInput accessibilityLabel="消息" placeholder="消息" value={draft.text} multiline editable={!blocked && !draft.unknown} placeholderTextColor={colors.foregroundMuted} onChangeText={text => { if (agentId) setDrafts(current => ({ ...current, [agentId]: { text } })); }} onKeyPress={event => {
            const native = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean };
            if (!compact && native.key === 'Enter' && !native.shiftKey && !native.isComposing) { event.preventDefault(); void send(); }
          }} style={{ color: colors.foreground, fontSize: compact ? 16 : 15, lineHeight: 24, minHeight: 48, maxHeight: 160, paddingHorizontal: 8, paddingVertical: 10, flex: 1, textAlignVertical: 'top' }} />
          <Button label={draft.unknown ? '重试发送' : '发送'} icon="ArrowUp" iconOnly={!draft.unknown} primary disabled={blocked || !draft.text.trim()} onPress={() => void send()} />
        </View>
        {running && <Copy muted small>回复中…</Copy>}
      </View>
    </View>}
  </View>;
}
