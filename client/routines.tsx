import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import * as rpc from '../shared/routines.js';
import { listTasks } from '../shared/tasks.js';

export function Routines({ botId, openAgent }: { botId: string; openAgent?: (id: string) => void }) {
  const list = useRpc(rpc.listRoutines);
  const tasks = useRpc(listTasks);
  const create = useRpc(rpc.createRoutine);
  const pause = useRpc(rpc.pauseRoutine);
  const resume = useRpc(rpc.resumeRoutine);
  const trigger = useRpc(rpc.runRoutine);
  const cancel = useRpc(rpc.cancelRoutine);
  const [items, setItems] = useState<RpcOutput<typeof rpc.listRoutines>>([]);
  const [reports, setReports] = useState<RpcOutput<typeof listTasks>>([]);
  const [name, setName] = useState('固定跟进');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [continuity, setContinuity] = useState(false);
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
    try { await action?.(); await refresh(); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    setItems([]); setReports([]); setError('');
    void Promise.all([list({ botId }), tasks({ botId })]).then(([rows, records]) => {
      if (active) { setItems(rows); setReports(records); }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list, tasks]);
  const statuses: Record<string, string> = { active: '已开启', paused: '已暂停', completed: '原生触发已结束' };
  const outcomes: Record<string, string> = { running: '正在运行', succeeded: '原生运行成功', failed: '原生运行失败' };
  return <SettingsSection title={`独立例程：${botId}`}>
    <SettingsRow label="每次触发使用新的原生会话。只在明确目标与数据范围内开工；创建例程不批准外发、破坏性操作、付款或新增权限。" error={error || null} />
    <SettingsRow label="模型、目录、模式与思考选项在创建时确定。身份、记忆、技能和 MCP 在每次打开时读取；修改 Bot 执行设置后，请新建例程并取消旧例程。" />
    <SettingsInput label="例程名称" initialValue={name} onChangeText={setName} disabled={busy} />
    <SettingsInput label="每次目标、交付物、完成条件及已授权范围" initialValue={prompt} onChangeText={setPrompt} disabled={busy} />
    <SettingsInput label="Cron 时间" initialValue={cron} onChangeText={setCron} disabled={busy} />
    <SettingsInput label="时区" initialValue={timezone} onChangeText={setTimezone} disabled={busy} />
    <SettingsAction label={`上轮结果参考：${continuity ? '开启' : '关闭'}；仅同一例程已报告完成且原生成功的摘要，按需核对产物，不新增授权`} actionLabel={continuity ? '关闭' : '开启'} disabled={busy} onPress={() => setContinuity(value => !value)} />
    <SettingsAction label="按填写的目标与时间登记，不立即运行" actionLabel="创建例程" disabled={busy || !prompt.trim()} onPress={() => void run(() => create({ botId, name, prompt, cron, timezone, continuity }))} />
    <SettingsAction label="读取原生状态与结果" actionLabel="刷新" disabled={busy} onPress={() => void run()} />
    {items.map(({ routine, native, error: nativeError }) => <SettingsSection key={routine.id} title={`${routine.name} · ${routine.state === 'canceled' ? '已取消' : native ? statuses[native.status] : '尚未确认原生状态'}`}>
      <SettingsRow label={routine.prompt} hint={`${native?.cadence.type === 'cron' ? `${native.cadence.expression} · ${native.cadence.timezone || 'UTC'}` : `${routine.cron} · ${routine.timezone}`}；${nativeError || routine.detail || native?.nextRunAt || '查看原生结果核对实际执行'}`} />
      <SettingsAction label="暂停只停止以后触发；当前运行继续" actionLabel={native?.status === 'paused' ? '恢复' : '暂停'} disabled={busy || routine.state === 'canceled' || !native || native.status === 'completed'} onPress={() => void run(() => (native?.status === 'paused' ? resume : pause)({ botId, routineId: routine.id }))} />
      <SettingsAction label="主动触发新的独立运行，不改变周期；未知回执需先查原生结果" actionLabel="新触发一次" disabled={busy || routine.state === 'canceled' || !native} onPress={() => void run(() => trigger({ botId, routineId: routine.id }))} />
      <SettingsAction label="取消未来触发并停止当前关联执行，保留历史与产物" actionLabel={routine.state === 'canceled' ? '核对停止' : '取消例程'} disabled={busy} onPress={() => void run(() => cancel({ botId, routineId: routine.id }))} />
      {native?.runs.slice(-10).reverse().map(execution => {
        const report = reports.find(item => item.agentId === execution.agentId && item.routine?.runId === execution.id);
        return <SettingsSection key={execution.id} title={`${outcomes[execution.status]} · ${execution.startedAt}`}>
          <SettingsRow label={execution.error || execution.output || '尚无原生输出'} hint={report?.status === 'completed' ? '已报告满足交付条件，仍可核对具体产物' : '尚无已确认交付报告；原生成功不等于事项完成'} />
          {report?.summary && <SettingsRow label={report.summary} />}
          {report?.evidence?.map((evidence, index) => <SettingsRow key={index} label={`交付证据：${evidence}`} />)}
          <SettingsAction label="原生会话与实际产物" actionLabel="打开会话" disabled={!openAgent || !execution.agentId || busy} onPress={() => execution.agentId && openAgent?.(execution.agentId)} />
        </SettingsSection>;
      })}
    </SettingsSection>)}
  </SettingsSection>;
}
