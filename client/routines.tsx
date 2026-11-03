import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { View } from 'react-native';
import * as rpc from '../shared/routines.js';
import { listTasks } from '../shared/tasks.js';
import { History } from './history.js';
import { Usage } from './usage.js';
import { Actions, Button, Copy, Disclosure, Field, Notice, Section } from './ui.js';
import { useBotUpdates } from './use-bot-updates.js';
import { describeRoutineCron, WEEKDAYS } from './routine-time.js';

export function Routines({ botId, openAgent }: { botId: string; openAgent?: (id: string) => void }) {
  const list = useRpc(rpc.listRoutines);
  const tasks = useRpc(listTasks);
  const create = useRpc(rpc.createRoutine);
  const pause = useRpc(rpc.pauseRoutine);
  const resume = useRpc(rpc.resumeRoutine);
  const trigger = useRpc(rpc.runRoutine);
  const cancel = useRpc(rpc.cancelRoutine);
  const [items, setItems] = useState<RpcOutput<typeof rpc.listRoutines>>();
  const updates = useBotUpdates(botId, items?.flatMap(item => item.routine.nativeId ? [item.routine.nativeId] : []) ?? []);
  const [reports, setReports] = useState<RpcOutput<typeof listTasks>>([]);
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<string>();
  const [runOpened, setRunOpened] = useState<string>();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekdays' | 'weekly' | 'custom'>('daily');
  const [hour, setHour] = useState('09');
  const [minute, setMinute] = useState('00');
  const [weekday, setWeekday] = useState('1');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [continuity, setContinuity] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function refresh() {
    const [rows, records] = await Promise.all([list({ botId }), tasks({ botId })]);
    setItems(rows); setReports(records);
  }
  async function run(action?: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action?.(); }
    catch (failure) { setError(String(failure)); }
    finally {
      try { await refresh(); } catch (failure) { setError(current => `${current}${current ? '；' : ''}${String(failure)}`); }
      guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([list({ botId }), tasks({ botId })]).then(([rows, records]) => { if (active) { setItems(rows); setReports(records); } }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list, tasks, updates.revision]);
  const statuses: Record<string, string> = { active: '已开启', paused: '已暂停', completed: '触发已结束' };
  const outcomes: Record<string, string> = { running: '运行中', succeeded: '原生成功', failed: '原生失败' };
  const cadence = frequency === 'custom' ? cron : `${Number(minute)} ${Number(hour)} * * ${frequency === 'daily' ? '*' : frequency === 'weekdays' ? '1-5' : weekday}`;
  const timezones = [...new Set(['Asia/Shanghai', 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, timezone])].map(value => ({ value, label: value === 'Asia/Shanghai' ? '北京时间' : value }));
  return <>
    <Notice error={error || updates.error} />
    <Actions><Button label="刷新例程" disabled={busy} onPress={() => void run()} /><Button label="新建例程" icon="Plus" disabled={busy} onPress={() => setCreating(true)} /></Actions>
    {creating && <Section title="新建例程">
      <Field label="名称" value={name} onChangeText={setName} maxLength={120} disabled={busy} />
      <Field label="要做的事" value={prompt} onChangeText={setPrompt} multiline placeholder="交付物、完成条件和允许读取的资料" maxLength={1500} disabled={busy} />
      <SettingsSelect label="重复" value={frequency} options={[{ label: '每天', value: 'daily' }, { label: '工作日', value: 'weekdays' }, { label: '每周', value: 'weekly' }, { label: '自定义 Cron', value: 'custom' }]} disabled={busy} onValueChange={value => { if (value === 'custom' && frequency !== 'custom') setCron(cadence); setFrequency(value); }} />
      {frequency === 'custom' ? <Field label="Cron" value={cron} onChangeText={setCron} maxLength={200} disabled={busy} /> : <>
        {frequency === 'weekly' && <SettingsSelect label="日期" value={weekday} options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value: String(value), label: WEEKDAYS[value] }))} disabled={busy} onValueChange={setWeekday} />}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}><SettingsSelect label="时" value={hour} options={Array.from({ length: 24 }, (_, value) => ({ value: String(value).padStart(2, '0'), label: String(value).padStart(2, '0') }))} disabled={busy} onValueChange={setHour} /></View>
          <View style={{ flex: 1 }}><SettingsSelect label="分" value={minute} options={Array.from({ length: 60 }, (_, value) => ({ value: String(value).padStart(2, '0'), label: String(value).padStart(2, '0') }))} disabled={busy} onValueChange={setMinute} /></View>
        </View>
      </>}
      <SettingsSelect label="时区" value={timezone} options={timezones} disabled={busy} onValueChange={setTimezone} />
      <Disclosure title="高级" open={advanced} onPress={() => setAdvanced(value => !value)}>
        <Field label="其他时区" value={timezone} onChangeText={setTimezone} maxLength={100} disabled={busy} />
        <SettingsSwitch label="参考上次结果" value={continuity} disabled={busy} onValueChange={setContinuity} />
        {continuity && <Copy muted small>仅参考同一例程已完成报告的摘要。</Copy>}
        <Copy muted small>执行配置在创建时确定；修改模型后需新建并取消旧例程。</Copy>
      </Disclosure>
      <Actions><Button label="取消新建" disabled={busy} onPress={() => setCreating(false)} /><Button label="创建例程" primary disabled={busy || !name.trim() || !prompt.trim() || !cadence.trim() || !timezone.trim()} onPress={() => void run(async () => {
        const result = await create({ botId, name, prompt, cron: cadence, timezone, continuity });
        setCreating(false); setName(''); setPrompt(''); setOpened(result.id);
      })} /></Actions>
    </Section>}
    {!items && !error && <Copy muted>读取例程中…</Copy>}
    {items?.length === 0 && !creating && <Copy muted>暂无例程</Copy>}
    {items?.map(({ routine, native, error: nativeError }) => <Disclosure key={routine.id} title={routine.name} status={routine.state === 'canceled' ? '已取消' : native ? statuses[native.status] : '原生状态待确认'} open={opened === routine.id} onPress={() => setOpened(opened === routine.id ? undefined : routine.id)}>
      <Copy>{routine.prompt}</Copy>
      <Copy muted>{native?.cadence.type === 'cron' ? `${describeRoutineCron(native.cadence.expression)} · ${native.cadence.timezone || 'UTC'}` : `${describeRoutineCron(routine.cron)} · ${routine.timezone}`}</Copy>
      <Notice error={nativeError || ''} />
      {routine.detail && <Copy muted small>{routine.detail}</Copy>}
      {native?.nextRunAt && <Copy muted small>下次：{new Date(native.nextRunAt).toLocaleString('zh-CN', { hour12: false })}</Copy>}
      {routine.runRequest?.state !== undefined && routine.runRequest.state !== 'acknowledged' && <Copy muted>触发回执待核实，先刷新回查，不能将新触发当作安全重试。</Copy>}
      <Actions>
        <Button label={native?.status === 'paused' ? '恢复' : '暂停'} disabled={busy || routine.state === 'canceled' || !native || native.status === 'completed'} onPress={() => void run(() => (native?.status === 'paused' ? resume : pause)({ botId, routineId: routine.id }))} />
        <Button label="新触发一次" disabled={busy || routine.state === 'canceled' || !native || (routine.runRequest !== undefined && routine.runRequest.state !== 'acknowledged')} onPress={() => void run(() => trigger({ botId, routineId: routine.id }))} />
        <Button label={routine.state === 'canceled' ? '核对停止' : '取消例程'} disabled={busy} onPress={() => void run(() => cancel({ botId, routineId: routine.id }))} />
      </Actions>
      <Copy muted small>暂停只停止以后触发，当前运行继续。取消还停止关联执行，保留历史和产物。</Copy>
      {native?.runs.slice(-10).reverse().map(execution => {
        const report = reports.find(item => item.agentId === execution.agentId && item.routine?.runId === execution.id);
        return <Disclosure key={execution.id} title={new Date(execution.startedAt).toLocaleString('zh-CN', { hour12: false })} status={report?.status === 'completed' ? '已报告完成' : `${outcomes[execution.status]} · 待核对交付`} open={runOpened === execution.id} onPress={() => setRunOpened(runOpened === execution.id ? undefined : execution.id)}>
          <Copy>{execution.error || execution.output || '尚无原生输出'}</Copy>
          <Copy muted small>{report?.status === 'completed' ? '按交付报告核对实际产物。' : '尚无完成报告；原生成功不等于事项完成。'}</Copy>
          {report?.summary && <Copy>{report.summary}</Copy>}{report?.evidence?.map((evidence, index) => <Copy key={index}>{evidence}</Copy>)}
          <Actions><Button label="打开会话" disabled={!openAgent || !execution.agentId || busy} onPress={() => execution.agentId && openAgent?.(execution.agentId)} /></Actions>
          {execution.agentId && <View><History botId={botId} agentId={execution.agentId} /><Usage agentId={execution.agentId} /></View>}
        </Disclosure>;
      })}
    </Disclosure>)}
  </>;
}
