import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import * as rpc from '../shared/contracts.js';
import { Actions, Button, Copy, Disclosure, Notice } from './ui.js';
import { Tasks } from './tasks.js';
import { History } from './history.js';
import { Usage } from './usage.js';
import { Journal } from './journal.js';
import { OfficeActions } from './office.js';

export function Work({ botId, openAgent }: { botId: string; openAgent?: (id: string) => void }) {
  const unresolved = useRpc(rpc.pendingCreations);
  const inspect = useRpc(rpc.inspectCreation);
  const acknowledge = useRpc(rpc.acknowledgeCreation);
  const [pending, setPending] = useState<RpcOutput<typeof rpc.pendingCreations>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const guard = useRef(false);
  async function recover(requestId: string) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try {
      const result = await inspect({ botId, requestId });
      if (result.status === 'unknown') throw new Error(result.detail || '创建结果未知');
      openAgent?.(result.agentId);
      await acknowledge({ botId, requestId });
    }
    catch (failure) { setError(String(failure)); }
    finally {
      try { setPending((await unresolved({ botId })).filter(item => item.status === 'pending')); }
      catch (failure) { setError(current => `${current}${current ? '；' : ''}${String(failure)}`); }
      setRevision(value => value + 1); guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void unresolved({ botId }).then(value => { if (active) setPending(value.filter(item => item.status === 'pending')); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, unresolved]);
  return <>
    <Notice error={error} />
    <Tasks botId={botId} openAgent={openAgent} revision={revision} />
    <OfficeActions botId={botId} revision={revision} />
    {pending.length > 0 && <Disclosure title="创建回查" open={requestsOpen} onPress={() => setRequestsOpen(value => !value)}>{pending.map(item => <Actions key={item.requestId}><Copy muted>{item.agentId}</Copy><Button label="回查并打开" disabled={busy || !openAgent} onPress={() => void recover(item.requestId)} /></Actions>)}</Disclosure>}
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
