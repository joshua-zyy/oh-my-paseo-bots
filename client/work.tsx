import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import * as rpc from '../shared/contracts.js';
import { Actions, Button, Copy, Disclosure, Field, Notice, Section } from './ui.js';
import { Tasks } from './tasks.js';
import { History } from './history.js';
import { Usage } from './usage.js';
import { Journal } from './journal.js';
import { OfficeActions } from './office.js';

export function Work({ botId, openAgent }: { botId: string; openAgent?: (id: string) => void }) {
  const start = useRpc(rpc.startSession);
  const unresolved = useRpc(rpc.pendingCreations);
  const inspect = useRpc(rpc.inspectCreation);
  const acknowledge = useRpc(rpc.acknowledgeCreation);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<RpcOutput<typeof rpc.pendingCreations>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const guard = useRef(false);
  async function run(action: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(String(failure)); }
    finally {
      try { setPending(await unresolved({ botId })); }
      catch (failure) { setError(current => `${current}${current ? '；' : ''}${String(failure)}`); }
      setRevision(value => value + 1); guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void unresolved({ botId }).then(value => { if (active) setPending(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, unresolved]);
  return <>
    <View style={{ marginBottom: 28 }}>
      <Field label="交办" value={prompt} onChangeText={setPrompt} multiline placeholder="目标、交付物和完成条件" disabled={busy} />
      <Notice error={error} />
      {pending.length > 0 && <Copy muted>存在未核实的创建请求，先回查。再次交办表示独立新事项。</Copy>}
      <Actions><Button label="刷新" disabled={busy} onPress={() => void run(async () => {})} /><Button label={pending.length ? '交办独立新事项' : '交办'} primary icon="ArrowUpRight" disabled={busy || !openAgent || !prompt.trim()} onPress={() => void run(async () => {
        const result = await start({ botId, title: prompt.slice(0, 100), prompt });
        openAgent?.(result.agentId);
        await acknowledge({ botId, requestId: result.requestId });
        setPrompt('');
      })} /></Actions>
      {pending.map(item => <Section key={item.requestId} title={item.status === 'created' ? '已创建，待确认' : '创建结果待核实'}>
        <Copy muted small>{item.agentId}</Copy>
        <Actions><Button label="回查并打开" disabled={busy || !openAgent} onPress={() => void run(async () => {
          const result = await inspect({ botId, requestId: item.requestId });
          if (result.status === 'unknown') throw new Error(result.detail || '创建结果未知');
          openAgent?.(result.agentId);
          await acknowledge({ botId, requestId: item.requestId });
        })} /></Actions>
      </Section>)}
    </View>
    <Tasks botId={botId} openAgent={openAgent} revision={revision} />
    <OfficeActions botId={botId} revision={revision} />
    <Disclosure title="全部会话" open={sessionsOpen} onPress={() => setSessionsOpen(value => !value)}><Sessions botId={botId} openAgent={openAgent} revision={revision} /></Disclosure>
    <Disclosure title="工作日志" open={journalOpen} onPress={() => setJournalOpen(value => !value)}><Journal botId={botId} /></Disclosure>
  </>;
}

function Sessions({ botId, openAgent, revision }: { botId: string; openAgent?: (id: string) => void; revision: number }) {
  const list = useRpc(rpc.listSessions);
  const [links, setLinks] = useState<RpcOutput<typeof rpc.listSessions>>();
  const [opened, setOpened] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void list({ botId }).then(value => { if (active) setLinks(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list, revision]);
  return <><Notice error={error} />{!links && !error && <Copy muted>读取中…</Copy>}{links?.map(link => <Disclosure key={link.sessionId} title={link.title || link.sessionId} open={opened === link.sessionId} onPress={() => setOpened(opened === link.sessionId ? undefined : link.sessionId)}>
    <Actions><Button label="打开会话" disabled={!openAgent} onPress={() => openAgent?.(link.sessionId)} /></Actions>
    <History botId={botId} agentId={link.sessionId} /><Usage agentId={link.sessionId} />
  </Disclosure>)}{links?.length === 0 && <Copy muted>暂无会话</Copy>}</>;
}
