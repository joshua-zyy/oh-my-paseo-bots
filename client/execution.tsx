import { useEffect, useState } from 'react';
import type { PaseoProviderSnapshotResult } from '@getpaseo/client';
import { usePaseo } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSelect } from '@getpaseo/plugin/client/ui';
import type { BotDetails } from '../shared/bot.js';
import { PathPicker } from './path-picker.js';
import { Button, Copy, Notice } from './ui.js';

export function useModelCatalog(cwd?: string) {
  const api = usePaseo();
  const [entries, setEntries] = useState<PaseoProviderSnapshotResult['entries']>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const accept = (snapshot: PaseoProviderSnapshotResult) => { if (active) setEntries(snapshot.entries); };
    void api.providers.snapshot({ cwd }).then(async snapshot => {
      accept(snapshot);
      if (active) setLoading(false);
      if (snapshot.entries.some(entry => entry.status === 'loading')) accept(await api.providers.waitForReady({ cwd, timeoutMs: 15000 }));
    }).catch(failure => { if (active) setError(String(failure)); }).finally(() => { if (active) setLoading(false); });
    const release = api.providers.subscribe(() => { void api.providers.snapshot({ cwd }).then(accept).catch(failure => { if (active) setError(String(failure)); }); });
    return () => { active = false; release(); };
  }, [api, cwd, revision]);
  const models = entries.filter(entry => entry.enabled && entry.status === 'ready').flatMap(entry => (entry.models ?? []).filter(model => model.isSelectable !== false).map(model => ({ label: model.label, providerLabel: entry.label ?? entry.provider, value: `${entry.provider}/${model.id}` })));
  return { entries, models, error, loading, reload: () => setRevision(value => value + 1) };
}

export function ExecutionConfiguration({ value, defaults, inherit = true, disabled, onChange }: {
  value: BotDetails['execution']; defaults?: BotDetails['execution']; inherit?: boolean; disabled: boolean; onChange(value: BotDetails['execution']): void;
}) {
  const { entries, models: availableModels, error, loading, reload } = useModelCatalog(value.cwd ?? defaults?.cwd);
  const effective = value.provider ?? defaults?.provider ?? '';
  const separator = effective.indexOf('/');
  const provider = entries.find(entry => entry.provider === effective.slice(0, separator));
  const model = provider?.models?.find(model => model.id === effective.slice(separator + 1));
  const models = availableModels.map(model => ({ label: `${model.label} · ${model.providerLabel}`, value: model.value }));
  if (value.provider && !models.some(model => model.value === value.provider)) models.unshift({ label: value.provider, value: value.provider });
  return <>
    <Notice error={error} />
    {error && <Button label="重试读取模型" disabled={disabled || loading} onPress={reload} />}
    <SettingsCard>
      <SettingsSelect label="模型" value={value.provider ?? ''} options={[{ label: inherit ? '默认模型' : loading ? '读取中…' : '选择模型', value: '' }, ...models]} disabled={disabled || loading} onValueChange={provider => onChange({ ...value, provider: provider || undefined, modeId: undefined, thinkingOptionId: undefined })} />
      {(['modeId', 'thinkingOptionId'] as const).map(field => {
        const available = field === 'modeId' ? provider?.modes ?? [] : model?.thinkingOptions ?? [];
        const current = value[field];
        if (!available.length && current === undefined) return null;
        const options = [...(inherit ? [{ label: '默认设置', value: '' }] : []), { label: '模型默认', value: 'native:' }, ...available.map(option => ({ label: option.label, value: `id:${option.id}` }))];
        if (typeof current === 'string' && !available.some(option => option.id === current)) options.push({ label: current, value: `id:${current}` });
        return <SettingsSelect key={field} label={field === 'modeId' ? '模式' : '思考'} value={current === undefined ? inherit ? '' : 'native:' : current === null ? 'native:' : `id:${current}`} options={options} disabled={disabled || loading} onValueChange={next => onChange({ ...value, [field]: next === '' ? undefined : next === 'native:' ? inherit ? null : undefined : next.slice(3) })} />;
      })}
      <PathPicker label="文件夹" value={value.cwd} initialPath={defaults?.cwd} inherit={inherit} disabled={disabled} onChange={cwd => onChange({ ...value, cwd })} />
    </SettingsCard>
    {!loading && !models.length && !error && <Copy muted>没有可用模型，请检查 Paseo 模型配置。</Copy>}
  </>;
}
