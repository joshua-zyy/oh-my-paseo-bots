import { useState } from 'react';
import { View } from 'react-native';
import { usePaseo } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/ui';
import type { Channel } from '../shared/channels.js';
import { Chat } from './chat.js';
import { Memories } from './memories.js';
import { Actions, Button, Copy, Notice } from './ui.js';

export function ChannelChat({ channel, hostId }: { channel: Channel; hostId: string }) {
  const api = usePaseo();
  const [memories, setMemories] = useState(false);
  const [source, setSource] = useState<{ botId: string; agentId: string }>();
  const [error, setError] = useState('');
  function openAgent(agentId: string) {
    void api.agents.ref(agentId).refresh().then(snapshot => {
      if (!snapshot || snapshot.agent.labels['paseo-guys.channel'] !== channel.id) throw new Error('来源会话不属于当前频道');
      setSource({ botId: snapshot.agent.labels['paseo-guys.bot'], agentId }); setMemories(false);
    }).catch(failure => setError(String(failure)));
  }
  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ padding: 12, gap: 8 }}>
      <Copy muted small>当前由管理员回应；群记忆仅留本群，个人确认约定只读使用。@成员和团队共享尚未接入。</Copy>
      <Actions>{source && <Button label="返回管理员对话" onPress={() => setSource(undefined)} />}<Button label={memories ? '返回频道对话' : '群记忆'} icon="Brain" onPress={() => setMemories(value => !value)} /></Actions>
      <Notice error={error} />
    </View>
    {memories ? <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}><Memories botId={channel.adminBotId} channelId={channel.id} openAgent={openAgent} /></ScrollView>
      : <Chat key={source?.agentId ?? channel.id} botId={source?.botId ?? channel.adminBotId} hostId={hostId} channelId={channel.id} sessionId={source?.agentId} openAgent={openAgent} />}
  </View>;
}
