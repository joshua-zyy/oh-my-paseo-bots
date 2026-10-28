import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { SettingsRow, SettingsAction, SettingsInput, SettingsSection, SidebarRow } from '@getpaseo/plugin/client/ui';
import * as rpc from './shared/contracts.js';
import { Office } from './client/office.js';

function Bots({ navigation }: PluginScreenProps) {
  const list = useRpc(rpc.listBots);
  const toolStatus = useRpc(rpc.toolStatus);
  const create = useRpc(rpc.createBot);
  const start = useRpc(rpc.startSession);
  const sessions = useRpc(rpc.listSessions);
  const pendingCreations = useRpc(rpc.pendingCreations);
  const inspectCreation = useRpc(rpc.inspectCreation);
  const acknowledgeCreation = useRpc(rpc.acknowledgeCreation);
  const memories = useRpc(rpc.listMemories);
  const saveMemory = useRpc(rpc.saveMemory);
  const correct = useRpc(rpc.correctMemory);
  const readJournal = useRpc(rpc.readJournal);
  const settings = useSettings(rpc.settings);
  const [bots, setBots] = useState<{ id: string; name: string; role: string }[]>([]);
  const [selected, select] = useState('chief');
  const [newBotId, setNewBotId] = useState('chief');
  const [name, setName] = useState('主 Bot');
  const [role, setRole] = useState('澄清、分工、核对并负责最终交付');
  const [prompt, setPrompt] = useState('');
  const [memory, setMemory] = useState('');
  const [entries, setEntries] = useState<{ id: string; kind: 'confirmed' | 'candidate'; content: string }[]>([]);
  const [links, setLinks] = useState<{ sessionId: string; title: string | null }[]>([]);
  const [observations, setObservations] = useState<{ agentId: string; kind: string; outcome?: string; error?: string; observedAt: string }[]>([]);
  const [journalSummary, setJournalSummary] = useState('');
  const [journalOffset, setJournalOffset] = useState(0);
  const [nextJournalOffset, setNextJournalOffset] = useState<number | null>(null);
  const [pending, setPending] = useState<{ requestId: string; agentId: string; status: 'pending' | 'created' }[]>([]);
  const [cwd, setCwd] = useState('');
  const [provider, setProvider] = useState('');
  const [error, setError] = useState('');
  const [tools, setTools] = useState<RpcOutput<typeof rpc.toolStatus>>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function run(action: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(String(e)); } finally { busyRef.current = false; setBusy(false); }
  }
  async function refreshBots() {
    const result = await list({});
    setBots(result.bots);
    if (result.corrupt.length) setError(`这些 Bot 存档损坏，已保留原文件：${result.corrupt.join('、')}`);
  }
  async function refreshTools() { setTools(await toolStatus({})); }
  function showJournal(snapshot: RpcOutput<typeof rpc.readJournal>) {
    setObservations(snapshot.entries);
    setJournalOffset(snapshot.offset); setNextJournalOffset(snapshot.nextOffset);
    setJournalSummary(`从最新记录跳过 ${snapshot.offset} 条，显示 ${snapshot.entries.length}/${snapshot.total} 条；损坏 ${snapshot.corruptCount} 行${snapshot.corruptLines.length ? `（行号 ${snapshot.corruptLines.join('、')}）` : ''}`);
  }
  useEffect(() => { void refreshBots().catch(e => setError(String(e))); }, [list]);
  useEffect(() => { void refreshTools().catch(e => setError(String(e))); }, [toolStatus]);
  useEffect(() => {
    let active = true;
    setEntries([]); setLinks([]); setObservations([]); setJournalSummary(''); setJournalOffset(0); setNextJournalOffset(null); setPending([]); setMemory('');
    if (bots.some(bot => bot.id === selected)) {
      void Promise.allSettled([memories({ botId: selected }), sessions({ botId: selected }), readJournal({ botId: selected }), pendingCreations({ botId: selected })]).then(([items, linked, journal, unresolved]) => {
        if (!active) return;
        if (items.status === 'fulfilled') setEntries(items.value);
        if (linked.status === 'fulfilled') setLinks(linked.value);
        if (journal.status === 'fulfilled') showJournal(journal.value);
        if (unresolved.status === 'fulfilled') setPending(unresolved.value);
        const failures = [items, linked, journal, unresolved].filter(item => item.status === 'rejected').map(item => String(item.reason));
        if (failures.length) setError(failures.join('；'));
      });
    }
    return () => { active = false; };
  }, [memories, sessions, readJournal, pendingCreations, selected, bots]);
  return <ScrollView>
    <SettingsRow label={error ? `操作未完成：${error}` : '把新事情交给固定 Bot，执行与审批继续使用 Paseo 原生会话。'} />
    <SettingsAction label={`Bot 工具：${tools?.state === 'ready' ? '可连接' : tools?.state === 'idle' ? '首次开始任务时创建' : tools?.state === 'unavailable' ? '不可用' : '读取中'}`} hint={tools?.detail} actionLabel="重新检查" disabled={busy} onPress={() => void run(refreshTools)} />
    <SettingsSection title="宿主配置">
      <SettingsInput label="宿主绝对工作目录" onChangeText={setCwd} />
      <SettingsInput label="已配置的 provider/model" onChangeText={setProvider} />
      <SettingsAction label={settings.status === 'ready' ? `当前：${settings.values.provider} · ${settings.values.cwd}` : `配置：${settings.status}`} actionLabel="保存配置" disabled={busy || settings.status === 'loading' || settings.status === 'error'} onPress={() => void run(async () => {
        if (settings.status === 'ready' || settings.status === 'invalid') {
          const previous = settings.status === 'ready' ? settings.values : undefined;
          if (!await settings.save({ ...previous, cwd: cwd || previous?.cwd || '', provider: provider || previous?.provider || '' }, settings.revision)) throw new Error('保存失败，请查看设置错误并重试');
        }
      })} />
    </SettingsSection>
    <SettingsSection title="固定同事">
      {bots.map(bot => <SettingsAction key={bot.id} label={bot.name} hint={bot.role} actionLabel="选择" disabled={busy} onPress={() => select(bot.id)} />)}
      <SettingsInput label="新 Bot 标识（小写字母、数字、下划线、短横线）" initialValue="chief" onChangeText={setNewBotId} disabled={busy} />
      <SettingsInput label="名称" initialValue={name} onChangeText={setName} />
      <SettingsInput label="职责" initialValue={role} onChangeText={setRole} />
      <SettingsAction label="创建固定 Bot" actionLabel="创建" disabled={busy} onPress={() => void run(async () => { await create({ id: newBotId, name, role }); await refreshBots(); select(newBotId); })} />
      <SettingsInput label={`交给 ${selected} 的新事情`} disabled={busy} onChangeText={setPrompt} />
      {pending.length > 0 && <SettingsRow label="存在未核实创建：先回查原请求；修改任务内容再开始表示独立的新事项，不等于安全重试原工作。" />}
      <SettingsAction label="会话与未决创建请求" actionLabel="刷新" disabled={busy} onPress={() => void run(async () => {
        const [linked, unresolved] = await Promise.all([sessions({ botId: selected }), pendingCreations({ botId: selected })]);
        setLinks(linked); setPending(unresolved);
      })} />
      <SettingsAction label="打开原生会话" actionLabel={pending.length > 0 ? '开始独立新事项' : '开始'} disabled={busy || !navigation || !prompt.trim()} onPress={() => void run(async () => {
        const result = await start({ botId: selected, title: prompt.slice(0, 100), prompt });
        navigation?.openAgent({ agentId: result.agentId });
        await acknowledgeCreation({ botId: selected, requestId: result.requestId });
        setPending(await pendingCreations({ botId: selected }));
        setLinks(await sessions({ botId: selected }));
      })} />
      {pending.map(item => <SettingsAction key={item.requestId} label={`${item.status === 'created' ? '已创建待确认' : '创建结果待核实'}：${item.agentId}`} actionLabel="回查并打开" disabled={busy || !navigation} onPress={() => void run(async () => {
        const result = await inspectCreation({ botId: selected, requestId: item.requestId });
        if (result.status === 'unknown') throw new Error(result.detail || '创建结果未知');
        navigation?.openAgent({ agentId: result.agentId });
        await acknowledgeCreation({ botId: selected, requestId: item.requestId });
        setPending(await pendingCreations({ botId: selected }));
      })} />)}
      {links.map(link => <SettingsAction key={link.sessionId} label={link.title || link.sessionId} actionLabel="回到会话" disabled={busy || !navigation} onPress={() => navigation?.openAgent({ agentId: link.sessionId })} />)}
    </SettingsSection>
    <SettingsSection title={`记忆：${selected}`}>
      <SettingsRow label="纠正只修改当前记忆，不表示已擦除原生历史和备份。候选未经确认不注入新会话。" />
      {entries.map(entry => <SettingsAction key={entry.id} label={`${entry.kind === 'confirmed' ? '明确' : '候选'}：${entry.content}`} hint="填写下方内容后可纠正；候选可直接确认" actionLabel={entry.kind === 'candidate' && !memory ? '确认' : '纠正'} disabled={busy || (entry.kind === 'confirmed' && !memory)} onPress={() => void run(async () => { await correct({ botId: selected, memoryId: entry.id, kind: 'confirmed', content: memory || entry.content }); setEntries(await memories({ botId: selected })); })} />)}
      <SettingsInput label="明确记忆或纠正内容" onChangeText={setMemory} />
      <SettingsAction label="保存用户明确记忆" actionLabel="保存" disabled={busy || !memory.trim()} onPress={() => void run(async () => { await saveMemory({ botId: selected, kind: 'confirmed', content: memory }); setEntries(await memories({ botId: selected })); })} />
    </SettingsSection>
    <SettingsSection title={`工作日志：${selected}`}>
      <SettingsRow label="日志记录原生轮次观察；轮次完成不表示任务完成。" />
      <SettingsRow label={journalSummary || '尚未读取日志'} />
      <SettingsAction label="重新读取日志" actionLabel="刷新" disabled={busy} onPress={() => void run(async () => showJournal(await readJournal({ botId: selected })))} />
      <SettingsAction label="查看更新日志" actionLabel="更新一页" disabled={busy || journalOffset === 0} onPress={() => void run(async () => showJournal(await readJournal({ botId: selected, offset: Math.max(0, journalOffset - 50) })))} />
      <SettingsAction label="查看更早日志" actionLabel="更早一页" disabled={busy || nextJournalOffset === null} onPress={() => void run(async () => showJournal(await readJournal({ botId: selected, offset: nextJournalOffset ?? 0 })))} />
      {observations.map((item, index) => <SettingsRow key={`${item.observedAt}-${index}`} label={`${item.observedAt} · ${item.agentId}`} hint={`${item.kind === 'turn_started' ? '原生轮次开始' : '原生轮次结束'}${item.outcome ? `（${item.outcome}）` : ''}${item.error ? `：${item.error}` : ''}`} />)}
    </SettingsSection>
    {bots.some(bot => bot.id === selected) && <Office key={selected} botId={selected} />}
  </ScrollView>;
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: 'bots', title: '固定同事', Component: Bots });
  const sidebar = client.addSidebarHeaderItem({ id: 'bots', title: '固定同事', Component: ({ openScreen }) => <SidebarRow icon="users" label="固定同事" onPress={() => openScreen({ screenId: 'bots' })} /> });
  return () => { sidebar(); screen(); };
}
