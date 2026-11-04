import { useState } from 'react';
import { View } from 'react-native';
import { useSettings } from '@getpaseo/plugin/client';
import { botDetailsSchema, type BotDetails, type BotDetailsInput } from '../shared/bot.js';
import type { McpImport } from '../shared/capabilities.js';
import * as rpc from '../shared/contracts.js';
import { OfficeConfiguration } from './office.js';
import { ExecutionConfiguration } from './execution.js';
import { Skills } from './capabilities.js';
import { Connections } from './connections.js';
import { Actions, Button, Copy, Disclosure, Field } from './ui.js';

export function BotConfiguration({ bot, botId, disabled, save }: { bot: BotDetailsInput; botId: string; disabled: boolean; save(value: BotDetails, startNew?: boolean, imports?: McpImport[]): Promise<unknown> }) {
  const settings = useSettings(rpc.settings);
  const [value, setValue] = useState<BotDetails>(() => botDetailsSchema.parse(bot));
  const [tab, setTab] = useState('同事');
  const [imports, setImports] = useState<McpImport[]>([]);
  const [readingCapability, setReadingCapability] = useState(false);
  const [office, setOffice] = useState(false);
  const blocked = disabled || readingCapability;
  const defaults = settings.status === 'ready' ? settings.values : undefined;
  return <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>{['同事', '模型', '技能', '连接'].map(item => <Button key={item} label={item} primary={tab === item} disabled={blocked} onPress={() => setTab(item)} />)}</View>
      {tab === '同事' && <>
        <Field label="名称" value={value.name} disabled={disabled} maxLength={200} onChangeText={name => setValue(current => ({ ...current, name }))} />
        <Field label="职责" value={value.role} disabled={disabled} maxLength={200} multiline onChangeText={role => setValue(current => ({ ...current, role }))} />
        <Field label="长期工作说明" value={value.instructions} disabled={disabled} multiline onChangeText={instructions => setValue(current => ({ ...current, instructions }))} />
      </>}
      {tab === '模型' && <>
        <ExecutionConfiguration value={value.execution} defaults={defaults} disabled={disabled} onChange={execution => setValue(current => ({ ...current, execution }))} />
        <Copy muted small>新对话使用这些设置。</Copy>
      </>}
      {tab === '技能' && <Skills value={value.capabilities} disabled={disabled} onChange={capabilities => setValue(current => ({ ...current, capabilities }))} onBusyChange={setReadingCapability} />}
      {tab === '连接' && <>
        <Connections value={value.capabilities} imports={imports} cwd={value.execution.cwd ?? defaults?.cwd} disabled={disabled} onChange={capabilities => setValue(current => ({ ...current, capabilities }))} onImports={setImports} onBusyChange={setReadingCapability} />
        <Copy muted small>新任务使用这些连接。</Copy>
        <Disclosure title="Gmail 与飞书资料范围" open={office} onPress={() => setOffice(value => !value)}><OfficeConfiguration botId={botId} /></Disclosure>
      </>}
      <Actions>{tab === '模型' && <Button label="恢复默认" disabled={blocked} onPress={() => setValue(current => ({ ...current, execution: {} }))} />}<Button label="保存" primary={tab === '连接'} disabled={blocked || !botDetailsSchema.safeParse(value).success} onPress={() => void save(value, false, imports)} />{tab !== '连接' && <Button label="保存并开始新对话" primary disabled={blocked || !botDetailsSchema.safeParse(value).success} onPress={() => void save(value, true, imports)} />}</Actions>
  </>;
}
