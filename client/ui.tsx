import { createContext, useContext, type ReactNode } from 'react';
import type { PluginTheme } from '@getpaseo/plugin';
import { Pressable, Text, View } from 'react-native';
import { Icon, TextInput } from '@getpaseo/plugin/client/ui';

const Appearance = createContext<{ colors: PluginTheme['colors']; compact: boolean } | null>(null);
export const UiProvider = Appearance.Provider;
export function useUi() {
  const value = useContext(Appearance);
  if (!value) throw new Error('Bot UI requires its screen appearance');
  return value;
}

export function Copy({ children, muted = false, small = false }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  const { colors } = useUi();
  return <Text selectable style={{ color: muted ? colors.foregroundMuted : colors.foreground, fontSize: small ? 12 : 14, lineHeight: small ? 18 : 22 }}>{children}</Text>;
}

export function Button({ label, icon, iconOnly = false, primary = false, disabled = false, onPress }: { label: string; icon?: string; iconOnly?: boolean; primary?: boolean; disabled?: boolean; onPress(): void }) {
  const { colors, compact } = useUi();
  const color = primary ? colors.surface0 : colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: compact ? 44 : 36, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: primary ? colors.foreground : pressed ? colors.surface2 : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.8 : 1 })}>
    {icon && <Icon name={icon} size={16} color={color} />}
    {!iconOnly && <Text style={{ color, fontSize: 14, fontWeight: '500', flexShrink: 1 }}>{label}</Text>}
  </Pressable>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>{children}</View>;
}

export function Field({ label, value, onChangeText, multiline = false, placeholder, disabled = false, maxLength }: { label: string; value: string; onChangeText(text: string): void; multiline?: boolean; placeholder?: string; disabled?: boolean; maxLength?: number }) {
  const { colors, compact } = useUi();
  return <View style={{ gap: 8, marginBottom: 18 }}>
    <Copy>{label}</Copy>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline={multiline} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} editable={!disabled} maxLength={maxLength} autoCapitalize="none" autoCorrect={false} style={{ minHeight: multiline ? 120 : compact ? 44 : 38, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, color: colors.foreground, fontSize: compact ? 16 : 14, textAlignVertical: multiline ? 'top' : 'center', opacity: disabled ? 0.5 : 1 }} />
  </View>;
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const { colors } = useUi();
  return <View style={{ marginBottom: 28 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>{title}</Text>
      {action}
    </View>
    {children}
  </View>;
}

export function Notice({ error }: { error: string }) {
  const { colors } = useUi();
  return error ? <Text accessibilityRole="alert" selectable style={{ color: colors.statusDanger, fontSize: 14, lineHeight: 22, marginBottom: 16 }}>{error}</Text> : null;
}

export function Disclosure({ title, status, open, onPress, children }: { title: string; status?: string; open: boolean; onPress(): void; children: ReactNode }) {
  const { colors, compact } = useUi();
  return <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: compact ? 16 : 14, backgroundColor: pressed ? colors.surface1 : 'transparent' })}>
      <View style={{ flex: 1, gap: 4 }}><Copy>{title}</Copy>{compact && status && <Copy muted small>{status}</Copy>}</View>
      {!compact && status && <Copy muted small>{status}</Copy>}
      <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={16} color={colors.foregroundMuted} />
    </Pressable>
    {open && <View style={{ gap: 14, padding: 16, marginBottom: 16, borderRadius: 8, backgroundColor: colors.surface1 }}>{children}</View>}
  </View>;
}
