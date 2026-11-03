import { useRef, useState } from 'react';
import { usePaseo } from '@getpaseo/plugin/client';
import type { AgentUsage } from '@getpaseo/protocol/agent-types';
import { View } from 'react-native';
import { Button, Copy, Notice, Section } from './ui.js';

export function Usage({ agentId }: { agentId: string }) {
  const paseo = usePaseo();
  const [usage, setUsage] = useState<AgentUsage | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function read() {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try {
      const snapshot = await paseo.agents.ref(agentId).refresh();
      if (!snapshot) throw new Error('未找到原生会话，无法读取用量');
      setUsage(snapshot.agent.lastUsage ?? null);
    } catch (failure) { setUsage(undefined); setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <Section title="会话用量" action={<Button label={usage === undefined ? '读取用量' : '刷新用量'} disabled={busy} onPress={() => void read()} />}>
    <Notice error={error} />
    {usage !== undefined && <><Copy muted small>原生最新上报值，统计口径由 Provider 决定，不代表完整账单。</Copy>{[
      { label: '输入 tokens', value: usage?.inputTokens }, { label: '缓存输入 tokens', value: usage?.cachedInputTokens },
      { label: '输出 tokens', value: usage?.outputTokens }, { label: '上下文已用 tokens', value: usage?.contextWindowUsedTokens },
      { label: '上下文容量 tokens', value: usage?.contextWindowMaxTokens }, { label: '费用（USD）', value: usage?.totalCostUsd },
    ].map(item => <View key={item.label} style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingVertical: 6 }}><Copy muted>{item.label}</Copy><Copy>{item.value === undefined ? '未提供' : String(item.value)}</Copy></View>)}</>}
  </Section>;
}
