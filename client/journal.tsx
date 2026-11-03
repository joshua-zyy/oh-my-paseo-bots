import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import { readJournal } from '../shared/contracts.js';
import { Actions, Button, Copy, Notice } from './ui.js';

export function Journal({ botId }: { botId: string }) {
  const read = useRpc(readJournal);
  const [page, setPage] = useState<RpcOutput<typeof readJournal>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function load(offset = 0) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { setPage(await read({ botId, offset })); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void read({ botId }).then(value => { if (active) setPage(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, read]);
  const outcomes = { completed: '轮次结束', failed: '轮次失败', canceled: '轮次已取消' };
  return <>
    <Notice error={error} />
    <Copy muted small>日志记录原生轮次，轮次结束不等于事项完成。</Copy>
    <Actions><Button label="刷新" disabled={busy} onPress={() => void load()} /><Button label="更新一页" disabled={busy || !page?.offset} onPress={() => void load(Math.max(0, (page?.offset ?? 0) - 50))} /><Button label="更早一页" disabled={busy || page?.nextOffset == null} onPress={() => void load(page?.nextOffset ?? 0)} /></Actions>
    {!page && !error && <Copy muted>读取中…</Copy>}
    {page && <>
      {page.entries.length > 0 && <Copy muted small>{page.offset + 1}–{page.offset + page.entries.length} / {page.total}</Copy>}
      {page.corruptCount > 0 && <Notice error={`损坏 ${page.corruptCount} 行（${page.corruptLines.join('、')}），原文件保留。`} />}
      {page.entries.map((item, index) => <View key={`${item.observedAt}:${index}`} style={{ gap: 4, paddingVertical: 10 }}>
        <Copy>{item.kind === 'turn_started' ? '轮次开始' : item.outcome ? outcomes[item.outcome] : '轮次结束'} · {new Date(item.observedAt).toLocaleString('zh-CN', { hour12: false })}</Copy>
        <Copy muted small>{item.agentId}</Copy>{item.error && <Notice error={item.error} />}
      </View>)}
      {!page.entries.length && <Copy muted>暂无日志</Copy>}
    </>}
  </>;
}
