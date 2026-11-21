import { useState } from 'react';
import { useSettings } from '@getpaseo/plugin/client';
import { botDetailsSchema, type BotDetails, type BotDetailsInput } from '../shared/bot.js';
import * as rpc from '../shared/contracts.js';
import { ExecutionConfiguration } from './execution.js';
import { Actions, Button, Copy, Field } from './ui.js';

/** 主总管最小配置；专长列表与自由偏好字段不在 Phase 1 新增。 */
export function BotConfiguration({ bot, disabled, save }: { bot: BotDetailsInput; disabled: boolean; save(value: BotDetails, startNew?: boolean): Promise<unknown> }) {
  const settings = useSettings(rpc.settings);
  const [value, setValue] = useState<BotDetails>(() => botDetailsSchema.parse(bot));
  const defaults = settings.status === 'ready' ? settings.values : undefined;
  return <>
    <Field label="名称" value={value.name} disabled={disabled} maxLength={200} onChangeText={name => setValue(current => ({ ...current, name }))} />
    <Field label="职责" value={value.role} disabled={disabled} maxLength={200} multiline onChangeText={role => setValue(current => ({ ...current, role }))} />
    <Field label="长期工作说明" value={value.instructions} disabled={disabled} multiline onChangeText={instructions => setValue(current => ({ ...current, instructions }))} />
    <ExecutionConfiguration value={value.execution} defaults={defaults} disabled={disabled} onChange={execution => setValue(current => ({ ...current, execution }))} />
    <Copy muted small>配置只影响新对话，不重载当前原生会话；既有技能/MCP 覆盖保留，执行权限仍由 Paseo 与 Provider 决定。</Copy>
    <Actions>
      <Button label="恢复默认" disabled={disabled} onPress={() => setValue(current => ({ ...current, execution: {} }))} />
      <Button label="保存" disabled={disabled || !botDetailsSchema.safeParse(value).success} onPress={() => void save(value)} />
      <Button label="保存并开始新对话" primary disabled={disabled || !botDetailsSchema.safeParse(value).success} onPress={() => void save(value, true)} />
    </Actions>
  </>;
}
