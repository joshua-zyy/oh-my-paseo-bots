import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, Modal, TextInput } from '@getpaseo/plugin/client/ui';
import type { BotDetails } from '../shared/bot.js';
import { useModelCatalog } from './execution.js';
import { PathPicker } from './path-picker.js';
import { Button, Copy, Notice, useUi } from './ui.js';

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
  return <>
    <View style={{ flex: 1, minWidth: 0 }}><PathPicker label="工作区" inline value={execution.cwd} defaultLocation={defaultCwd ? { path: defaultCwd, label: 'Bot 工作区' } : undefined} disabled={disabled} onChange={cwd => { if (cwd) onChange({ cwd }); }} /></View>
    <View style={{ flex: 1, minWidth: 0 }}><Pressable accessibilityRole="button" accessibilityLabel={`模型：${execution.provider ?? '未选择'}`} disabled={disabled} onPress={() => { setSearch(''); setOpen(true); }} style={({ pressed }) => ({ minHeight: compact ? 44 : 36, paddingHorizontal: 8, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: pressed ? colors.surface2 : 'transparent', opacity: disabled ? 0.4 : 1 })}>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>{label}</Text>
      <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
    </Pressable></View>
    <Modal title="选择模型" open={open} onOpenChange={setOpen}><Modal.Content>
      <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型" value={search} onChangeText={setSearch} placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, fontSize: compact ? 16 : 14, backgroundColor: colors.surface1, borderRadius: 6, padding: 10 }} />
      <Notice error={catalog.error} />
      {catalog.error && <Button label="重试" disabled={catalog.loading} onPress={catalog.reload} />}
      {catalog.loading && <Copy muted>读取中…</Copy>}
      {!catalog.loading && !catalog.error && !models.length && <Copy muted>{search ? '没有匹配的模型' : '没有可用模型，请检查 Paseo 模型配置。'}</Copy>}
      {models.map(model => <Pressable key={model.value} accessibilityRole="button" accessibilityLabel={`${model.label} · ${model.providerLabel}`} accessibilityState={{ selected: model.value === execution.provider }} disabled={disabled} onPress={() => { onChange({ provider: model.value }); setOpen(false); }} style={({ pressed }) => ({ minHeight: 44, padding: 12, gap: 10, flexDirection: 'row', alignItems: 'center', borderRadius: 6, backgroundColor: model.value === execution.provider || pressed ? colors.surface2 : 'transparent' })}>
        <Text style={{ color: colors.foreground, fontSize: 14, flex: 1 }}>{model.label}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{model.providerLabel}</Text>
        {model.value === execution.provider && <Icon name="Check" size={16} color={colors.foregroundMuted} />}
      </Pressable>)}
    </Modal.Content></Modal>
  </>;
}
