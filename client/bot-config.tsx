import { useState } from 'react';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { botDetailsSchema, type BotDetails, type BotDetailsInput } from '../shared/bot.js';

/** 仅编辑固定身份与新会话配置，沿用宿主控件，不另建聊天界面。 */
export function BotConfiguration({ bot, disabled, save }: { bot: BotDetailsInput; disabled: boolean; save: (value: BotDetails) => Promise<unknown> }) {
  const [value, setValue] = useState<BotDetails>({ name: bot.name, role: bot.role, instructions: bot.instructions ?? '', execution: bot.execution ?? {} });
  const execution = value.execution;
  const setExecution = (patch: Partial<BotDetails['execution']>) => setValue(current => ({ ...current, execution: { ...current.execution, ...patch } }));
  return <SettingsSection title={`同事配置：${bot.name}`}>
    <SettingsRow label="仅影响之后开始或委派的新会话，不修改正在执行的会话。模型和目录留空继承宿主配置；改选模型后不继承另一模型的模式和思考选项。" />
    <SettingsInput label="同事名称" initialValue={value.name} disabled={disabled} onChangeText={name => setValue(current => ({ ...current, name }))} />
    <SettingsInput label="职责" initialValue={value.role} disabled={disabled} onChangeText={role => setValue(current => ({ ...current, role }))} />
    <SettingsInput label="长期工作说明" initialValue={value.instructions} disabled={disabled} onChangeText={instructions => setValue(current => ({ ...current, instructions }))} />
    <SettingsInput label="已有 provider/model（留空继承）" initialValue={execution.provider ?? ''} disabled={disabled} onChangeText={text => setExecution({ provider: text.trim() || undefined })} />
    <SettingsInput label="宿主绝对工作目录（留空继承）" initialValue={execution.cwd ?? ''} disabled={disabled} onChangeText={text => setExecution({ cwd: text.trim() || undefined })} />
    {(['modeId', 'thinkingOptionId'] as const).map(field => <SettingsSection key={field} title={field === 'modeId' ? '执行模式' : '思考选项'}>
      <SettingsSelect label="选项来源" value={execution[field] === undefined ? 'inherit' : execution[field] === null ? 'native' : 'explicit'} options={[
        { value: 'inherit', label: '继承匹配模型的宿主默认' },
        { value: 'native', label: '使用 Provider 原生默认' },
        { value: 'explicit', label: '指定已有选项标识' },
      ]} disabled={disabled} onValueChange={choice => setExecution({ [field]: choice === 'inherit' ? undefined : choice === 'native' ? null : '' })} />
      {typeof execution[field] === 'string' && <SettingsInput label="已有选项标识" initialValue={execution[field]} disabled={disabled} onChangeText={text => setExecution({ [field]: text })} />}
    </SettingsSection>)}
    <SettingsAction label="保存同事配置" actionLabel="保存" disabled={disabled || !value.name.trim() || !value.role.trim() || !botDetailsSchema.safeParse(value).success} onPress={() => void save(value)} />
    <SettingsAction label="保留身份与长期说明，清除全部执行覆盖" actionLabel="恢复宿主默认" disabled={disabled} onPress={() => void save({ ...value, execution: {} })} />
  </SettingsSection>;
}
