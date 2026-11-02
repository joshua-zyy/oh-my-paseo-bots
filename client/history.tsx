import { useRef, useState } from 'react';
import type { RpcInput, RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import { readHistory } from '../shared/history.js';

/** On-demand native pages remain readable when the host's workspace navigation is archived. */
export function History({ botId, agentId }: { botId: string; agentId: string }) {
  const read = useRpc(readHistory);
  const [page, setPage] = useState<RpcOutput<typeof readHistory>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function load(direction: RpcInput<typeof readHistory>['direction'] = 'tail') {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try {
      setPage(await read({ botId, agentId, direction, ...(direction === 'tail' ? {} : { cursor: (direction === 'before' ? page?.startCursor : page?.endCursor) ?? undefined }), limit: 50 }));
    } catch (failure) { setPage(undefined); setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <SettingsSection title="会话历史">
    <SettingsAction label="只读原生历史；归档事项仍可查回" actionLabel={page ? '关闭历史' : '读取历史'} disabled={busy} error={error || null} onPress={() => page ? setPage(undefined) : void load()} />
    {page && <>
      <SettingsAction label="重新读取最新历史" actionLabel="刷新" disabled={busy} onPress={() => void load()} />
      <SettingsAction label="查看更早历史" actionLabel="更早一页" disabled={busy || !page.hasOlder || !page.startCursor} onPress={() => void load('before')} />
      <SettingsAction label="查看更晚历史" actionLabel="更晚一页" disabled={busy || !page.hasNewer || !page.endCursor} onPress={() => void load('after')} />
      {page.entries.map((entry, index) => {
        const item = entry.item;
        const label = item.text ?? (item.type === 'tool_call' ? `${typeof item.name === 'string' ? item.name : '工具调用'} · ${typeof item.status === 'string' ? item.status : '状态未知'}` : item.type);
        return <SettingsRow key={`${page.epoch}:${entry.seqStart}:${index}`} label={label} hint={`${entry.timestamp} · ${item.type}`} />;
      })}
      {!page.entries.length && <SettingsRow label="本页没有历史记录" />}
    </>}
  </SettingsSection>;
}
