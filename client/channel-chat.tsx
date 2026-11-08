import { useEffect, useRef, useState } from 'react';
import { View, type ScrollView as NativeScrollView } from 'react-native';
import type { RpcOutput } from '@getpaseo/plugin';
import { useHosts, usePaseo, useRpc } from '@getpaseo/plugin/client';
import { ScrollView, TextInput } from '@getpaseo/plugin/client/ui';
import * as rpc from '../shared/channels.js';
import { stopReply } from '../shared/contracts.js';
import type { Channel } from '../shared/channels.js';
import { ChatSegment } from './chat.js';
import { observeChat, type ChatState } from './chat-state.js';
import { observeAgentChanges } from './agent-changes.js';
import { channelTimeline, deliverChannelMessage, type ChannelTarget } from './channel-state.js';
import { ChatTimeline } from './chat-timeline.js';
import { ChatPermission } from './chat-permission.js';
import { Memories } from './memories.js';
import { Actions, Button, Copy, Notice, useUi } from './ui.js';

interface Draft { text: string; messageId?: string; targets?: ChannelTarget[]; sending?: boolean; error?: string }

export function ChannelChat({ channel, hostId }: { channel: Channel; hostId: string }) {
  const api = usePaseo();
  const hosts = useHosts();
  const read = useRpc(rpc.channelView);
  const route = useRpc(rpc.routeChannelMessage);
  const authorize = useRpc(rpc.channelContext);
  const stop = useRpc(stopReply);
  const { colors, compact } = useUi();
  const [view, setView] = useState<RpcOutput<typeof rpc.channelView>>();
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [draft, setDraft] = useState<Draft>({ text: '' });
  const [memories, setMemories] = useState(false);
  const [source, setSource] = useState<{ botId: string; agentId: string }>();
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState<string>();
  const [revision, setRevision] = useState(0);
  const guard = useRef(false);
  const observers = useRef(new Map<string, ReturnType<typeof observeChat>>());
  const scroll = useRef<NativeScrollView>(null);
  const nearBottom = useRef(true);
  const sources = view?.sessions.map(session => session.agentId).join(':') ?? '';
  const offline = hosts.some(host => host.serverId === hostId && host.status !== 'online');
  const locked = draft.sending || !!draft.targets;
  useEffect(() => {
    let active = true;
    void read({ channelId: channel.id }).then(value => { if (active) { setView(value); setError(''); } }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [read, channel.id, revision]);
  useEffect(() => {
    const changes = observeAgentChanges(api, [{ 'paseo-guys.channel': channel.id }], () => setRevision(value => value + 1), error => setError(String(error)));
    return () => { void changes.release().catch(error => console.error('频道状态订阅清理失败', error)); };
  }, [api, channel.id]);
  useEffect(() => {
    setChats({});
    const handles = (view?.sessions ?? []).map(session => {
      const observer = observeChat(api, session.botId, session.agentId, state => setChats(current => ({ ...current, [session.agentId]: state })));
      observers.current.set(session.agentId, observer); return observer;
    });
    return () => { observers.current.clear(); void Promise.all(handles.map(handle => handle.release())).catch(error => console.error('频道历史订阅清理失败', error)); };
  }, [api, sources]);
  useEffect(() => {
    if (!draft.targets || draft.sending || !draft.messageId) return;
    const targets = draft.targets.map(target => target.sent || !chats[target.agentId]?.entries.some(entry => entry.item.type === 'user_message' && (entry.item.clientMessageId === draft.messageId || entry.item.messageId === draft.messageId)) ? target : { ...target, sent: true, unknown: false, error: undefined });
    if (targets.every(target => target.sent)) setDraft({ text: '' });
    else if (targets.some((target, index) => target !== draft.targets![index])) setDraft({ ...draft, targets });
  }, [chats, draft]);
  async function send() {
    if (guard.current || offline || !draft.text.trim() || !view || source || memories) return;
    guard.current = true;
    const messageId = draft.messageId ?? `channel:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let targets = draft.targets;
    setDraft({ ...draft, messageId, sending: true, error: undefined });
    try {
      targets ??= (await route({ channelId: channel.id, text: draft.text })).targets;
      setDraft({ ...draft, messageId, targets, sending: true });
      setView(await read({ channelId: channel.id }));
      targets = await deliverChannelMessage(api, authorize, { channelId: channel.id, text: draft.text, messageId, targets });
      setDraft(targets.every(target => target.sent) ? { text: '' } : { text: draft.text, messageId, targets });
    } catch (failure) { setDraft({ ...draft, messageId, targets, error: `准备频道消息失败：${String(failure)}` }); }
    finally { guard.current = false; for (const observer of observers.current.values()) void observer.refresh(); }
  }
  async function interrupt(botId: string, agentId: string) {
    if (stopping || guard.current || offline) return;
    setStopping(agentId);
    try { await stop({ botId, agentId }); }
    catch (failure) { setError(String(failure)); }
    finally { setStopping(undefined); void observers.current.get(agentId)?.refresh(); }
  }
  function openAgent(agentId: string) {
    void api.agents.ref(agentId).refresh().then(snapshot => {
      if (!snapshot || snapshot.agent.labels['paseo-guys.channel'] !== channel.id) throw new Error('来源会话不属于当前频道');
      setSource({ botId: snapshot.agent.labels['paseo-guys.bot'], agentId }); setMemories(false);
    }).catch(failure => setError(String(failure)));
  }
  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ padding: 12, gap: 8 }}>
      <Copy muted small>普通消息由管理员回应；@姓名或标识可点名多位成员，@all点名全群。群记忆仅留本群，个人确认约定只读。管理员可交办本群成员并核对回报；显式团队共享记忆尚未接入。</Copy>
      <Actions>{source && <Button label="返回频道" onPress={() => setSource(undefined)} />}<Button label={memories ? '返回频道对话' : '群记忆'} icon="Brain" disabled={!!draft.sending} onPress={() => { setMemories(value => !value); setSource(undefined); }} /><Button label="刷新频道" disabled={!!draft.sending || offline} onPress={() => setRevision(value => value + 1)} /></Actions>
      <Notice error={error} />
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, gap: 14 }} keyboardShouldPersistTaps="handled" scrollEventThrottle={100} onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80; }} onContentSizeChange={() => { if (nearBottom.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {memories ? <Memories botId={view?.channel.adminBotId ?? channel.adminBotId} channelId={channel.id} openAgent={openAgent} /> : source ? <ChatSegment botId={source.botId} agentId={source.agentId} openAgent={openAgent} onLoadOlder={() => { nearBottom.current = false; }} /> : <>
        {!view && !error && <Copy muted>读取频道中…</Copy>}
        {channelTimeline(chats).map(({ agentId, entry }) => <View key={`${agentId}:${entry.seqStart}`} style={{ gap: 6 }}>
          {entry.item.type !== 'user_message' && <Copy muted small>{view?.members.find(member => member.id === chats[agentId]?.agent?.labels['paseo-guys.bot'])?.name ?? chats[agentId]?.agent?.labels['paseo-guys.bot'] ?? '群同事'}</Copy>}
          <ChatTimeline entries={[entry]} activeTurnId={chats[agentId]?.agent?.activeTurn?.turnId} openAgent={openAgent} />
        </View>)}
        {view?.sessions.map(session => <View key={session.agentId} style={{ gap: 8 }}>
          {chats[session.agentId]?.error && <Notice error={`${session.botId}：${chats[session.agentId].error}`} />}
          {chats[session.agentId]?.hasOlder && <Button label={`读取${view.members.find(member => member.id === session.botId)?.name ?? session.botId}的更早消息`} disabled={chats[session.agentId]?.loadingOlder} onPress={() => { nearBottom.current = false; void observers.current.get(session.agentId)?.loadOlder(); }} />}
          {chats[session.agentId]?.agent?.status === 'running' && <Actions><Copy muted small>{view.members.find(member => member.id === session.botId)?.name ?? session.botId}正在回应…</Copy><Button label="停止此回复" icon="Square" size="xs" disabled={offline || !!stopping || !!draft.sending} onPress={() => void interrupt(session.botId, session.agentId)} /></Actions>}
          {chats[session.agentId]?.agent?.pendingPermissions.map(permission => <ChatPermission key={`${session.agentId}:${permission.id}`} permission={permission} agent={api.agents.ref(session.agentId)} />)}
        </View>)}
      </>}
    </ScrollView>
    {!memories && !source && <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
      <Notice error={draft.error ?? ''} />
      {draft.targets?.map(target => <Copy key={target.agentId} muted small>{view?.members.find(member => member.id === target.botId)?.name ?? target.botId}：{target.sent ? '消息已送达（不等于已完成）' : target.error ?? '待发送'}</Copy>)}
      {offline && <Copy muted>连接已断开</Copy>}
      <Actions>{view?.members.map(member => <Button key={member.id} label={`@${member.name}`} size="xs" disabled={!!locked || offline} onPress={() => setDraft({ text: `${draft.text}${draft.text && !draft.text.endsWith(' ') ? ' ' : ''}@${member.id} ` })} />)}</Actions>
      <TextInput accessibilityLabel="频道消息" placeholder="发给管理员，或 @同事" value={draft.text} multiline editable={!locked && !offline && !!view} onChangeText={text => setDraft({ text })} placeholderTextColor={colors.foregroundMuted} onKeyPress={event => { const native = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean }; if (!compact && native.key === 'Enter' && !native.shiftKey && !native.isComposing) { event.preventDefault(); void send(); } }} style={{ color: colors.foreground, minHeight: 48, maxHeight: 150, padding: 8, fontSize: compact ? 16 : 15 }} />
      <Actions><Button label={draft.targets ? '重试未确认收件人' : '发送'} primary disabled={offline || !view || !!draft.sending || !draft.text.trim()} onPress={() => void send()} /></Actions>
    </View>}
  </View>;
}
