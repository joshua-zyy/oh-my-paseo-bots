import { useRef, useState } from 'react';
import { usePaseo } from '@getpaseo/plugin/client';
import type { AgentUsage } from '@getpaseo/protocol/agent-types';
import { SettingsAction, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';

/** Read the selected linked session in place; native reports are not a Bot ledger. */
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
  return <SettingsSection title="会话用量">
    <SettingsAction label="查看最新原生上报值" hint="不同 Provider 的统计口径可能不同；这些值不代表完整账单。" actionLabel={usage === undefined ? '读取用量' : '刷新'} disabled={busy} error={error || null} onPress={() => void read()} />
    {usage !== undefined && [
      { label: '输入 tokens', value: usage?.inputTokens },
      { label: '缓存输入 tokens', value: usage?.cachedInputTokens },
      { label: '输出 tokens', value: usage?.outputTokens },
      { label: '上下文已用 tokens', value: usage?.contextWindowUsedTokens },
      { label: '上下文容量 tokens', value: usage?.contextWindowMaxTokens },
      { label: 'Provider 报告费用（USD）', value: usage?.totalCostUsd },
    ].map(item => <SettingsRow key={item.label} label={item.label} hint={item.value === undefined ? '未提供' : String(item.value)} />)}
  </SettingsSection>;
}
