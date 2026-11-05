import { useState } from 'react';
import { View } from 'react-native';
import { Modal, TextInput } from '@getpaseo/plugin/client/ui';
import type { BotDetails } from '../shared/bot.js';
import { useModelCatalog } from './execution.js';
import { PathPicker } from './path-picker.js';
import { Button, Copy, Notice, PickerRow, Section, useUi } from './ui.js';

export function ConversationSettings({ execution, defaultCwd, disabled, onChange }: {
  execution: BotDetails['execution']; defaultCwd?: string; disabled: boolean; onChange(value: Pick<BotDetails['execution'], 'provider' | 'cwd'>): void;
}) {
  const { colors, compact } = useUi();
  const catalog = useModelCatalog(execution.cwd);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const current = catalog.models.find(model => model.value === execution.provider);
  const separator = execution.provider?.indexOf('/') ?? -1;
  const label = current?.label ?? (separator >= 0 ? execution.provider!.slice(separator + 1) : '选择模型');
  const models = catalog.models.filter(model => `${model.label} ${model.providerLabel} ${model.value}`.toLowerCase().includes(search.toLowerCase()));
  const groups = catalog.entries.map(entry => ({ provider: entry.provider, label: entry.label ?? entry.provider, models: models.filter(model => model.value.startsWith(`${entry.provider}/`)) })).filter(group => group.models.length);
  return <>
    <View style={{ flexShrink: 1, minWidth: 0 }}><PathPicker label="工作区" inline value={execution.cwd} defaultLocation={defaultCwd ? { path: defaultCwd, label: 'Bot 工作区' } : undefined} disabled={disabled} onChange={cwd => { if (cwd) onChange({ cwd }); }} /></View>
    <View style={{ flexShrink: 1, minWidth: 0 }}><Button label={label} accessibilityLabel={`模型：${execution.provider ?? '未选择'}`} trailingIcon="ChevronDown" size="xs" selected={open} disabled={disabled} onPress={() => { setSearch(''); setOpen(true); }} /></View>
    <Modal title="选择模型" open={open} onOpenChange={setOpen}><Modal.Content>
      <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, fontSize: compact ? 16 : 14, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 12 }} />
      <Notice error={catalog.error} />
      {catalog.error && <Button label="重试" disabled={catalog.loading} onPress={catalog.reload} />}
      {catalog.loading && <Copy muted>读取中…</Copy>}
      {!catalog.loading && !catalog.error && !models.length && <Copy muted>{search ? '没有匹配的模型' : '没有可用模型，请检查 Paseo 模型配置。'}</Copy>}
      {groups.map(group => <Section key={group.provider} title={group.label}>
        <View>{group.models.map(model => <PickerRow key={model.value} label={model.label} selected={model.value === execution.provider} disabled={disabled} onPress={() => { onChange({ provider: model.value }); setOpen(false); }} />)}</View>
      </Section>)}
    </Modal.Content></Modal>
  </>;
}
