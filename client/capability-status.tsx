import { createContext } from 'react';
import { Text, View } from 'react-native';
import type { CapabilityStatus } from '../shared/capability-timeline.js';
import { capabilityStatusText } from '../shared/capability-timeline.js';
import { Button, useUi } from './ui.js';

export const CapabilityNavigationContext = createContext<((botId: string) => void) | undefined>(undefined);
/** Historical status is read-only; navigation rereads the original decision entry. */
export function CapabilityStatusCard({ data, onOpen }: { data: CapabilityStatus; onOpen?: (botId: string) => void }) {
  const { colors } = useUi();
  const { title, detail } = capabilityStatusText(data);
  return <View style={{ padding: 14, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1 }}>
    <Text selectable style={{ color: data.state === 'pending' ? colors.statusWarning : colors.foreground, fontSize: 14, fontWeight: '600' }}>{title}</Text>
    <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{detail}</Text>
    <Button label="查看当前能力方案" disabled={!onOpen} onPress={() => onOpen?.(data.botId)} />
  </View>;
}
