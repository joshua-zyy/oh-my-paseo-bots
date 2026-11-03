import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import * as rpc from '../shared/contracts.js';
import { configurationDefaults } from '../shared/files.js';
import type { BotDetails } from '../shared/bot.js';
import { ExecutionConfiguration } from './execution.js';
import { Actions, Button, Copy, Disclosure, Field, Notice, Section } from './ui.js';

export function HostSettings() {
  const settings = useSettings(rpc.settings);
  return settings.status === 'ready' || settings.status === 'invalid'
    ? <Configuration key={settings.revision} initial={settings.status === 'ready' ? settings.values : undefined} save={async values => {
      if (!await settings.save(values, settings.revision)) throw new Error('保存失败，请刷新并检查配置');
    }} /> : <Copy muted>{settings.status === 'loading' ? '读取配置中…' : '配置读取失败'}</Copy>;
}

function Configuration({ initial, save }: { initial?: z.output<typeof rpc.settings.schema>; save(values: z.output<typeof rpc.settings.schema>): Promise<void> }) {
  const check = useRpc(rpc.toolStatus);
  const readDefaults = useRpc(configurationDefaults);
  const [execution, setExecution] = useState<BotDetails['execution']>(() => ({ cwd: initial?.cwd, provider: initial?.provider, modeId: initial?.modeId, thinkingOptionId: initial?.thinkingOptionId }));
  const [values, setValues] = useState({ paseoCommand: initial?.paseoCommand ?? '', paseoHome: initial?.paseoHome ?? '' });
  const [defaultCwd, setDefaultCwd] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [tools, setTools] = useState<RpcOutput<typeof rpc.toolStatus>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  useEffect(() => {
    let active = true;
    void readDefaults({}).then(({ cwd }) => { if (active) { setDefaultCwd(cwd); if (!initial?.cwd) setExecution(current => ({ ...current, cwd })); } }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [readDefaults]);
  async function run(action: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    <Notice error={error} />
    <Section title="默认执行">
      <ExecutionConfiguration value={execution} inherit={false} disabled={busy} onChange={setExecution} />
      <Actions><Button label="使用默认文件夹" disabled={busy || !defaultCwd} onPress={() => setExecution(current => ({ ...current, cwd: defaultCwd }))} /></Actions>
    </Section>
    <Disclosure title="高级" open={advanced} onPress={() => setAdvanced(value => !value)}>
      {([['paseoCommand', 'Paseo CLI'], ['paseoHome', 'Daemon 目录']] as const).map(([key, label]) => <Field key={key} label={label} value={values[key]} onChangeText={value => setValues(current => ({ ...current, [key]: value }))} disabled={busy} />)}
      <Button label="检查连接" disabled={busy} onPress={() => void run(async () => { setTools(await check({})); })} />
      {tools && <Copy>{tools.state === 'ready' ? '可连接' : tools.state === 'idle' ? '首次交办时创建' : '不可用'}</Copy>}{tools?.detail && <Copy muted>{tools.detail}</Copy>}
    </Disclosure>
    <Actions><Button label="保存" primary disabled={busy || !execution.cwd || !execution.provider} onPress={() => void run(() => save({ cwd: execution.cwd!, provider: execution.provider!, modeId: execution.modeId ?? undefined, thinkingOptionId: execution.thinkingOptionId ?? undefined, paseoCommand: values.paseoCommand.trim() || undefined, paseoHome: values.paseoHome.trim() || undefined }))} /></Actions>
  </>;
}
