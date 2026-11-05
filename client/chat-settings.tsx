import { View } from 'react-native';
import type { BotDetails } from '../shared/bot.js';
import { useModelCatalog } from './execution.js';
import { ModelSelector } from './model-selector.js';
import { PathPicker } from './path-picker.js';

export function ConversationSettings({ execution, defaultCwd, disabled, onChange }: {
  execution: BotDetails['execution']; defaultCwd?: string; disabled: boolean; onChange(value: Pick<BotDetails['execution'], 'provider' | 'cwd'>): void;
}) {
  const catalog = useModelCatalog(execution.cwd);
  return <>
    <View style={{ flexShrink: 1, minWidth: 0 }}><ModelSelector catalog={catalog} value={execution.provider} disabled={disabled} onSelect={provider => onChange({ provider })} /></View>
    <View style={{ flexShrink: 1, minWidth: 0 }}><PathPicker label="工作区" inline value={execution.cwd} defaultLocation={defaultCwd ? { path: defaultCwd, label: 'Bot 工作区' } : undefined} disabled={disabled} onChange={cwd => { if (cwd) onChange({ cwd }); }} /></View>
  </>;
}
