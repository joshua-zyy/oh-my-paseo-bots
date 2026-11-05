// Adapted from Paseo v0.14.0 CombinedModelSelector/ModelBrowser/Combobox.
// Modified: public SDK catalog/icons/theme, RN Modal positioning instead of host stores/portals.
// Apache-2.0; see THIRD_PARTY_NOTICES.md and licenses/Paseo-Apache-2.0.txt.
import { useEffect, useRef, useState } from 'react';
import { Modal as NativeModal, Platform, Pressable, Text, View, useWindowDimensions, type PressableStateCallbackType } from 'react-native';
import { Icon, Modal, ScrollView, TextInput } from '@getpaseo/plugin/client/ui';
import { useModelCatalog } from './execution.js';
import { Button, Copy, Notice, useUi } from './ui.js';
import { PROVIDER_ICONS } from './provider-icons.js';

type Catalog = ReturnType<typeof useModelCatalog>;
type Anchor = { x: number; y: number; width: number; height: number };

function modelPopoverFrame(anchor: Anchor, window: { width: number; height: number }, rows: number) {
  const width = Math.min(400, window.width - 16);
  const above = anchor.y - 13;
  const below = window.height - anchor.y - anchor.height - 13;
  const height = Math.min(Math.max(220, 80 + rows * 40), 400, Math.max(above, below));
  return { position: 'absolute' as const, width, height, left: Math.max(8, Math.min(anchor.x, window.width - width - 8)), top: above >= height ? anchor.y - height - 5 : anchor.y + anchor.height + 5 };
}

function ProviderGlyph({ entry, size = 16 }: { entry?: Catalog['entries'][number]; size?: number }) {
  const { colors } = useUi();
  // Use the native glyph for built-ins and the host snapshot SVG for custom providers.
  const svg = entry?.iconSvg;
  const builtin = PROVIDER_ICONS[entry?.provider ?? ''];
  return <Icon icon={builtin ? { svg: builtin } : svg?.startsWith('<') ? { svg } : 'Bot'} size={size} color={colors.foregroundMuted} />;
}

export function ModelSelector({ catalog, value, disabled, onSelect }: { catalog: Catalog; value?: string; disabled: boolean; onSelect(value: string): void }) {
  const { colors, compact } = useUi();
  const window = useWindowDimensions();
  const anchor = useRef<View>(null);
  const scroll = useRef<import('react-native').ScrollView>(null);
  const [position, setPosition] = useState<Anchor>();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(-1);
  const current = catalog.models.find(model => model.value === value);
  const selectedProvider = value?.split('/')[0];
  const providers = catalog.entries.filter(entry => entry.enabled);
  const entry = providers.find(item => item.provider === provider);
  const query = search.trim().toLowerCase();
  const models = catalog.models.filter(model => (!provider || model.value.startsWith(`${provider}/`)) && `${model.label} ${model.providerLabel} ${model.value}`.toLowerCase().includes(query));
  const browseProviders = !provider && !query;
  const options = browseProviders ? providers.map(item => ({ value: item.provider, label: item.label ?? item.provider, description: item.description, entry: item })) : models.map(model => ({ ...model, description: model.value.slice(model.value.indexOf('/') + 1), entry: providers.find(item => model.value.startsWith(`${item.provider}/`)) }));
  const label = current?.label ?? (value ? value.slice(value.indexOf('/') + 1) : '选择模型');
  const desktop = Platform.OS === 'web' && !compact;
  useEffect(() => {
    if (open && desktop) anchor.current?.measureInWindow((x, y, width, height) => setPosition({ x, y, width, height }));
  }, [open, desktop, window.width, window.height]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function show() {
    if (disabled) return;
    setProvider(providers.some(item => item.provider === selectedProvider) ? selectedProvider : providers.length === 1 ? providers[0].provider : undefined);
    setSearch(''); setActive(-1); setPosition(undefined); setOpen(true);
  }
  function choose(next: string) {
    if (disabled) return;
    if (browseProviders) { setProvider(next); setSearch(''); setActive(-1); }
    else { onSelect(next); setOpen(false); }
  }
  const content = <View style={{ flex: 1, minHeight: 0 }}>
    {desktop && <View style={{ minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {provider && providers.length > 1 && <Button label="全部 Provider" icon="ArrowLeft" iconOnly size="xs" onPress={() => { setProvider(undefined); setSearch(''); setActive(-1); }} />}
      {entry && <ProviderGlyph entry={entry} />}
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 14, fontWeight: '500' }}>{entry?.label ?? entry?.provider ?? '选择模型'}</Text>
      <Button label="关闭模型选择" icon="X" iconOnly size="xs" onPress={() => setOpen(false)} />
    </View>}
    {!desktop && provider && providers.length > 1 && <Button label="全部 Provider" icon="ArrowLeft" onPress={() => { setProvider(undefined); setSearch(''); setActive(-1); }} />}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: desktop ? 12 : 24, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Icon name="Search" size={16} color={colors.foregroundMuted} />
      <TextInput key={provider ?? 'all'} accessibilityLabel="搜索模型" placeholder={provider ? '搜索模型…' : '搜索所有模型…'} value={search} autoFocus={desktop} onChangeText={text => { setSearch(text); setActive(-1); scroll.current?.scrollTo({ y: 0, animated: false }); }} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.foregroundMuted} onKeyPress={event => {
        const key = event.nativeEvent.key;
        if (key === 'Escape') { event.preventDefault(); setOpen(false); }
        if ((key === 'ArrowDown' || key === 'ArrowUp') && options.length) {
          event.preventDefault();
          const next = active < 0 ? key === 'ArrowDown' ? 0 : options.length - 1 : (active + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          setActive(next); scroll.current?.scrollTo({ y: Math.max(0, (next - 3) * 40), animated: false });
        }
        if (key === 'Enter' && active >= 0 && options[active]) { event.preventDefault(); choose(options[active].value); }
      }} style={{ outlineWidth: 0, flex: 1, minWidth: 0, color: colors.foreground, fontSize: compact ? 16 : 14, padding: 0 }} />
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
      {catalog.error && <View style={{ padding: 16 }}><Notice error={catalog.error} /><Button label="重试读取模型" disabled={catalog.loading} onPress={catalog.reload} /></View>}
      {(catalog.loading || entry?.status === 'loading') && <View style={{ padding: 16 }}><Copy muted>读取中…</Copy></View>}
      {entry?.error && <View style={{ padding: 16 }}><Notice error={entry.error} /><Button label="重试读取模型" disabled={catalog.loading} onPress={catalog.reload} /></View>}
      {!catalog.loading && !catalog.error && !entry?.error && entry?.status !== 'loading' && !options.length && <View style={{ padding: 16 }}><Copy muted>{query ? '没有匹配的模型' : '没有可用模型，请检查 Paseo 模型配置。'}</Copy></View>}
      {options.map((option, index) => <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={`${option.label}${option.description ? `，${option.description}` : ''}`} accessibilityState={{ selected: !browseProviders && option.value === value, disabled }} disabled={disabled} onPress={() => choose(option.value)} style={({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => ({ minHeight: compact ? 44 : 40, paddingVertical: 8, paddingHorizontal: desktop ? 12 : 24, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: hovered || pressed || active === index ? colors.surface1 : 'transparent' })}>
        <ProviderGlyph entry={option.entry} size={14} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 14 }}>{option.label}</Text>
          {option.description && <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 12 }}>{option.description}</Text>}
        </View>
        {browseProviders ? <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} /> : option.value === value && <Icon name="Check" size={14} color={colors.foregroundMuted} />}
      </Pressable>)}
    </ScrollView>
  </View>;
  return <>
    <Pressable ref={anchor} collapsable={false} accessibilityRole="button" accessibilityLabel={`模型：${value ?? '未选择'}`} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={show} style={({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => ({ height: compact ? 44 : 28, minWidth: 0, flexShrink: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderRadius: 16, gap: 4, backgroundColor: pressed || open ? colors.surface0 : hovered ? colors.surface2 : 'transparent', opacity: disabled ? 0.5 : 1 })}>
      <ProviderGlyph entry={providers.find(item => item.provider === selectedProvider)} />
      <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, color: colors.foregroundMuted, fontSize: 14 }}>{label}</Text>
      <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
    </Pressable>
    {desktop ? <NativeModal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1 }}>
        <Pressable accessibilityLabel="关闭模型选择" onPress={() => setOpen(false)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
        {position && <View accessibilityViewIsModal style={{ ...modelPopoverFrame(position, window, options.length), borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, overflow: 'hidden' }}>{content}</View>}
      </View>
    </NativeModal> : <Modal title={entry?.label ?? entry?.provider ?? '选择模型'} open={open} onOpenChange={setOpen}><Modal.Content scrollable={false} style={{ minHeight: 300 }} contentContainerStyle={{ padding: 0, gap: 0 }}>{content}</Modal.Content></Modal>}
  </>;
}

