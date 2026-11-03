import { useRef, useState } from 'react';
import type { RpcInput, RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { View } from 'react-native';
import { readHistory } from '../shared/history.js';
import { Actions, Button, Copy, Notice, Section } from './ui.js';

export function History({ botId, agentId }: { botId: string; agentId: string }) {
  const read = useRpc(readHistory);
  const [page, setPage] = useState<RpcOutput<typeof readHistory>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function load(direction: RpcInput<typeof readHistory>['direction'] = 'tail') {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { setPage(await read({ botId, agentId, direction, ...(direction === 'tail' ? {} : { cursor: (direction === 'before' ? page?.startCursor : page?.endCursor) ?? undefined }), limit: 50 })); }
    catch (failure) { setPage(undefined); setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <Section title="会话历史" action={<Button label={page ? '关闭历史' : '读取历史'} disabled={busy} onPress={() => page ? setPage(undefined) : void load()} />}>
    <Notice error={error} />
    {page && <>
      <Actions><Button label="刷新历史" disabled={busy} onPress={() => void load()} /><Button label="更早一页" disabled={busy || !page.hasOlder || !page.startCursor} onPress={() => void load('before')} /><Button label="更晚一页" disabled={busy || !page.hasNewer || !page.endCursor} onPress={() => void load('after')} /></Actions>
      {page.entries.map((entry, index) => {
        const item = entry.item;
        const label = item.text ?? (item.type === 'tool_call' ? `${typeof item.name === 'string' ? item.name : '工具调用'} · ${typeof item.status === 'string' ? item.status : '状态未知'}` : item.type);
        return <View key={`${page.epoch}:${entry.seqStart}:${index}`} style={{ gap: 4, paddingVertical: 10 }}><Copy muted small>{new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false })} · {item.type}</Copy><Copy>{label}</Copy></View>;
      })}
      {!page.entries.length && <Copy muted>本页没有历史记录</Copy>}
    </>}
  </Section>;
}
