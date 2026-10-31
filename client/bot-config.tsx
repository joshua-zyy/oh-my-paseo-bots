import { useState } from 'react';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { botDetailsSchema, type BotDetails, type BotDetailsInput } from '../shared/bot.js';
import { botCapabilitiesSchema } from '../shared/capabilities.js';

/** 仅编辑固定身份与新会话配置，沿用宿主控件，不另建聊天界面。 */
export function BotConfiguration({ bot, disabled, save }: { bot: BotDetailsInput; disabled: boolean; save: (value: BotDetails) => Promise<unknown> }) {
  const [value, setValue] = useState<BotDetails>(() => botDetailsSchema.parse(bot));
  const [capabilitiesText, setCapabilitiesText] = useState(() => JSON.stringify(value.capabilities));
  let capabilities: BotDetails['capabilities'] | undefined;
  try { capabilities = botCapabilitiesSchema.parse(JSON.parse(capabilitiesText)); } catch { /* 保留无效草稿，不提交或静默清空。 */ }
  const edited = { ...value, ...(capabilities ? { capabilities } : {}) };
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
    <SettingsRow label="能力由用户配置：skills 填已有 SKILL.md 的 name/description/宿主绝对 path；mcpServers 沿用宿主 stdio/http/sse 格式。MCP 可运行程序或访问服务，配置不自动批准工具和账户。宿主全局能力不因此移除，目录不是安全沙箱。" />
    <SettingsInput label="已有技能与 MCP（JSON）" initialValue={capabilitiesText} disabled={disabled} onChangeText={setCapabilitiesText} />
    {!capabilities && <SettingsRow label="能力 JSON 无效，请检查 skills/mcpServers 结构与保留名称；草稿尚未保存。" />}
    <SettingsAction label="保存同事配置" actionLabel="保存" disabled={disabled || !capabilities || !value.name.trim() || !value.role.trim() || !botDetailsSchema.safeParse(edited).success} onPress={() => void save(edited)} />
    <SettingsAction label="保留身份、长期说明与能力，清除全部执行覆盖" actionLabel="恢复宿主默认" disabled={disabled || !capabilities} onPress={() => void save({ ...edited, execution: {} })} />
  </SettingsSection>;
}
