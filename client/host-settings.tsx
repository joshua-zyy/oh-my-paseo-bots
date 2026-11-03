import { useRef, useState } from 'react';
import type { z } from 'zod';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import * as rpc from '../shared/contracts.js';
import { Actions, Button, Copy, Field, Notice, Section } from './ui.js';

export function HostSettings() {
  const settings = useSettings(rpc.settings);
  return settings.status === 'ready' || settings.status === 'invalid'
    ? <Configuration key={settings.revision} initial={settings.status === 'ready' ? settings.values : undefined} save={async values => {
      if (!await settings.save(values, settings.revision)) throw new Error('保存失败，请刷新并检查配置');
    }} /> : <Copy muted>{settings.status === 'loading' ? '读取配置中…' : '配置读取失败'}</Copy>;
}

function Configuration({ initial, save }: { initial?: z.output<typeof rpc.settings.schema>; save(values: z.output<typeof rpc.settings.schema>): Promise<void> }) {
  const check = useRpc(rpc.toolStatus);
  const [values, setValues] = useState({ cwd: initial?.cwd ?? '', provider: initial?.provider ?? '', paseoCommand: initial?.paseoCommand ?? '', paseoHome: initial?.paseoHome ?? '' });
  const [tools, setTools] = useState<RpcOutput<typeof rpc.toolStatus>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    <Notice error={error} />
    <Section title="默认执行配置">
      {([['cwd', '宿主工作目录'], ['provider', '模型（provider/model）'], ['paseoCommand', 'Paseo CLI 路径'], ['paseoHome', '当前 daemon 的 home 目录']] as const).map(([key, label]) => <Field key={key} label={label} value={values[key]} onChangeText={value => setValues(current => ({ ...current, [key]: value }))} disabled={busy} />)}
      <Actions><Button label="保存配置" primary disabled={busy || !values.cwd.trim() || !values.provider.trim()} onPress={() => void run(() => save({ ...initial, cwd: values.cwd, provider: values.provider, ...(values.paseoCommand ? { paseoCommand: values.paseoCommand } : { paseoCommand: undefined }), ...(values.paseoHome ? { paseoHome: values.paseoHome } : { paseoHome: undefined }) }))} /></Actions>
    </Section>
    <Section title="Bot 工具" action={<Button label="检查连接" disabled={busy} onPress={() => void run(async () => { setTools(await check({})); })} />}>
      {tools && <Copy>{tools.state === 'ready' ? '可连接' : tools.state === 'idle' ? '首次交办时创建' : '不可用'}</Copy>}{tools?.detail && <Copy muted>{tools.detail}</Copy>}
    </Section>
  </>;
}
