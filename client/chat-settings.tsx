import { View } from 'react-native';
import type { BotDetails } from '../shared/bot.js';
import { useModelCatalog } from './execution.js';
import { ModelSelector, ThinkingSelector } from './model-selector.js';
import { PathPicker } from './path-picker.js';

export function ConversationSettings({ execution, defaultCwd, disabled, onChange }: {
  execution: BotDetails['execution']; defaultCwd?: string; disabled: boolean; onChange(value: Pick<BotDetails['execution'], 'provider' | 'cwd' | 'thinkingOptionId'>): void;
}) {
  const catalog = useModelCatalog(execution.cwd);
  const separator = execution.provider?.indexOf('/') ?? -1;
  const provider = catalog.entries.find(entry => entry.provider === execution.provider?.slice(0, separator) && entry.enabled && entry.status === 'ready');
  const model = provider?.models?.find(model => model.id === execution.provider?.slice(separator + 1));
  return <>
    <View style={{ flexShrink: 1, minWidth: 0 }}><ModelSelector catalog={catalog} value={execution.provider} disabled={disabled} onSelect={provider => onChange({ provider })} /></View>
    <ThinkingSelector options={model?.thinkingOptions ?? []} value={execution.thinkingOptionId} disabled={disabled} onSelect={thinkingOptionId => onChange({ thinkingOptionId })} />
    <View style={{ flexShrink: 1, minWidth: 0 }}><PathPicker label="工作区" inline value={execution.cwd} defaultLocation={defaultCwd ? { path: defaultCwd, label: 'Bot 工作区' } : undefined} disabled={disabled} onChange={cwd => { if (cwd) onChange({ cwd }); }} /></View>
  </>;
}
