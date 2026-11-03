import { useState } from 'react';
import { View } from 'react-native';
import { botDetailsSchema, type BotDetails, type BotDetailsInput } from '../shared/bot.js';
import { botCapabilitiesSchema } from '../shared/capabilities.js';
import { OfficeConfiguration } from './office.js';
import { Actions, Button, Copy, Field, Notice, Section } from './ui.js';

export function BotConfiguration({ bot, botId, disabled, save }: { bot: BotDetailsInput; botId: string; disabled: boolean; save(value: BotDetails, startNew?: boolean): Promise<unknown> }) {
  const [value, setValue] = useState<BotDetails>(() => botDetailsSchema.parse(bot));
  const [tab, setTab] = useState('同事');
  const [capabilitiesText, setCapabilitiesText] = useState(() => JSON.stringify(value.capabilities, null, 2));
  let capabilities: BotDetails['capabilities'] | undefined;
  try { capabilities = botCapabilitiesSchema.parse(JSON.parse(capabilitiesText)); } catch { /* 无效草稿保留，不能保存。 */ }
  const edited = { ...value, ...(capabilities ? { capabilities } : {}) };
  const execution = value.execution;
  const setExecution = (patch: Partial<BotDetails['execution']>) => setValue(current => ({ ...current, execution: { ...current.execution, ...patch } }));
  return <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>{['同事', '模型', '能力', '连接'].map(item => <Button key={item} label={item} primary={tab === item} disabled={disabled} onPress={() => setTab(item)} />)}</View>
    {tab === '连接' ? <OfficeConfiguration botId={botId} /> : <>
      {tab === '同事' && <>
        <Field label="名称" value={value.name} disabled={disabled} maxLength={200} onChangeText={name => setValue(current => ({ ...current, name }))} />
        <Field label="职责" value={value.role} disabled={disabled} maxLength={200} multiline onChangeText={role => setValue(current => ({ ...current, role }))} />
        <Field label="长期工作说明" value={value.instructions} disabled={disabled} multiline onChangeText={instructions => setValue(current => ({ ...current, instructions }))} />
      </>}
      {tab === '模型' && <>
        <Field label="模型（provider/model）" placeholder="留空继承宿主" value={execution.provider ?? ''} disabled={disabled} onChangeText={text => setExecution({ provider: text.trim() || undefined })} />
        <Field label="宿主工作目录" placeholder="留空继承宿主" value={execution.cwd ?? ''} disabled={disabled} onChangeText={text => setExecution({ cwd: text.trim() || undefined })} />
        {(['modeId', 'thinkingOptionId'] as const).map(field => <Section key={field} title={field === 'modeId' ? '执行模式' : '思考选项'}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>{([['inherit', '继承宿主'], ['native', '原生默认'], ['explicit', '指定标识']] as const).map(([choice, label]) => <Button key={choice} label={label} primary={(execution[field] === undefined ? 'inherit' : execution[field] === null ? 'native' : 'explicit') === choice} disabled={disabled} onPress={() => setExecution({ [field]: choice === 'inherit' ? undefined : choice === 'native' ? null : '' })} />)}</View>
          {typeof execution[field] === 'string' && <Field label={field === 'modeId' ? '模式标识' : '思考选项标识'} value={execution[field]} disabled={disabled} onChangeText={text => setExecution({ [field]: text })} />}
        </Section>)}
        <Copy muted small>仅影响新会话。改选模型后，未指定选项使用该模型的原生默认。</Copy>
      </>}
      {tab === '能力' && <>
        <Field label="技能与 MCP（JSON）" value={capabilitiesText} disabled={disabled} multiline onChangeText={setCapabilitiesText} />
        <Notice error={capabilities ? '' : 'JSON 无效，请检查 skills / mcpServers；草稿未保存。'} />
        <Copy muted small>技能填写已有 SKILL.md 的 name、description、宿主绝对 path。MCP 沿用宿主格式；配置不批准工具与账户，也不移除宿主全局能力。</Copy>
      </>}
      <Actions>{tab === '模型' && <Button label="恢复宿主默认" disabled={disabled || !capabilities} onPress={() => void save({ ...edited, execution: {} })} />}<Button label="保存" disabled={disabled || !capabilities || !botDetailsSchema.safeParse(edited).success} onPress={() => void save(edited)} /><Button label="保存并开始新对话" primary disabled={disabled || !capabilities || !botDetailsSchema.safeParse(edited).success} onPress={() => void save(edited, true)} /></Actions>
    </>}
  </>;
}
