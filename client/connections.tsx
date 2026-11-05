import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { Modal, SettingsCard, SettingsSelect, SettingsSwitch, TextInput } from '@getpaseo/plugin/client/ui';
import type { RpcOutput } from '@getpaseo/plugin';
import type { BotDetails } from '../shared/bot.js';
import { mcpNameSchema, mcpServerSchema, type McpImport } from '../shared/capabilities.js';
import * as rpc from '../shared/files.js';
import { PathPicker } from './path-picker.js';
import { Actions, Button, Copy, Field, Notice, Section, useUi } from './ui.js';

export function Connections({ value, imports, cwd, disabled, onChange, onImports, onBusyChange }: {
  value: BotDetails['capabilities']; imports: McpImport[]; cwd?: string; disabled: boolean;
  onChange(value: BotDetails['capabilities']): void; onImports(value: McpImport[]): void; onBusyChange(busy: boolean): void;
}) {
  const inspect = useRpc(rpc.inspectMcp);
  const discover = useRpc(rpc.listMcpSources);
  const [sources, setSources] = useState<RpcOutput<typeof rpc.listMcpSources>['sources']>([]);
  const [dialog, setDialog] = useState<'add' | 'import'>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const blocked = disabled || busy;
  async function run(action: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); onBusyChange(true); setError('');
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); onBusyChange(false); }
  }
  function selectImported(path: string, name: string, enabled: boolean) {
    const names = imports.find(selection => selection.path === path)?.names ?? [];
    const next = enabled ? [...names, name] : names.filter(selected => selected !== name);
    onImports([
      ...imports.filter(selection => selection.path !== path).map(selection => ({ ...selection, names: enabled ? selection.names.filter(selected => selected !== name) : selection.names })).filter(selection => selection.names.length),
      ...(next.length ? [{ path, names: next }] : []),
    ]);
    if (enabled && value.mcpServers[name] && !value.disabledMcpServers?.includes(name)) onChange({ ...value, disabledMcpServers: [...(value.disabledMcpServers ?? []), name] });
  }
  return <>
    {!dialog && <Notice error={error} />}
    <Section title="MCP 连接" action={<Button label="添加连接" icon="Plus" disabled={blocked} onPress={() => { setError(''); setDialog('add'); }} />}>
      <SettingsCard>
        {Object.keys(value.mcpServers).filter(name => !imports.some(selection => selection.names.includes(name))).map(name => <SettingsSwitch key={name} label={name} value={!value.disabledMcpServers?.includes(name)} disabled={blocked} onValueChange={enabled => {
          const disabledMcpServers = new Set(value.disabledMcpServers ?? []);
          if (enabled) disabledMcpServers.delete(name); else disabledMcpServers.add(name);
          onChange({ ...value, disabledMcpServers: [...disabledMcpServers] });
        }} />)}
        {imports.flatMap(selection => selection.names.map(name => <SettingsSwitch key={`${selection.path}:${name}`} label={name} value disabled={blocked} onValueChange={enabled => selectImported(selection.path, name, enabled)} />))}
      </SettingsCard>
      {!Object.keys(value.mcpServers).length && !imports.length && <Copy muted>尚未添加连接</Copy>}
      <Actions><Button label="从本机导入" icon="Import" disabled={blocked} onPress={() => { setDialog('import'); void run(async () => { setSources((await discover({ cwd })).sources); }); }} /></Actions>
    </Section>
    <Modal title={dialog === 'import' ? '导入连接' : '添加连接'} open={dialog !== undefined} onOpenChange={open => { if (!open && !busy) setDialog(undefined); }}><Modal.Content>
      <Notice error={error} />
      {dialog === 'add' && <NewConnection disabled={blocked} existing={[...Object.keys(value.mcpServers), ...imports.flatMap(selection => selection.names)]} add={(name, config) => {
        onChange({ ...value, mcpServers: { ...value.mcpServers, [name]: config } });
        setDialog(undefined);
      }} />}
      {dialog === 'import' && <>
        {busy && <Copy muted>读取配置中…</Copy>}
        {sources.map(source => <Section key={source.path} title={source.label}><Notice error={source.error ?? ''} /><SettingsCard>{source.names.map(name => <SettingsSwitch key={name} label={name} value={imports.some(selection => selection.path === source.path && selection.names.includes(name))} disabled={blocked} onValueChange={enabled => selectImported(source.path, name, enabled)} />)}</SettingsCard></Section>)}
        {!busy && !sources.length && <Copy muted>没有发现已配置的 MCP</Copy>}
        <PathPicker label="选择配置文件" kind="mcp" initialPath={cwd} disabled={blocked} onChange={path => { if (path) void run(async () => {
          const file = await inspect({ path });
          if (!file.names.length) throw new Error('配置中没有可添加的 MCP');
          setSources(current => [...current.filter(source => source.path !== path), { label: path.replace(/\\/g, '/').split('/').at(-1)!, path, names: file.names }]);
        }); }} />
        <Actions><Button label="完成选择" primary disabled={blocked} onPress={() => setDialog(undefined)} /></Actions>
      </>}
    </Modal.Content></Modal>
  </>;
}

function NewConnection({ disabled, existing, add }: { disabled: boolean; existing: string[]; add(name: string, config: BotDetails['capabilities']['mcpServers'][string]): void }) {
  const { colors, compact } = useUi();
  const [name, setName] = useState('');
  const [type, setType] = useState<'http' | 'sse' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [variables, setVariables] = useState<{ name: string; value: string }[]>([]);
  const [error, setError] = useState('');
  return <>
    <Notice error={error} />
    <Field label="名称" value={name} onChangeText={setName} disabled={disabled} maxLength={64} placeholder="github、notion…" />
    <SettingsSelect label="连接方式" value={type} options={[{ label: 'HTTP', value: 'http' }, { label: 'SSE', value: 'sse' }, { label: '本机命令', value: 'stdio' }]} disabled={disabled} onValueChange={value => { setType(value as 'http' | 'sse' | 'stdio'); setVariables([]); }} />
    {type === 'stdio' ? <><Field label="命令" value={command} onChangeText={setCommand} disabled={disabled} placeholder="npx、uvx 或程序路径" /><Field label="参数（每行一个）" value={args} onChangeText={setArgs} disabled={disabled} multiline /></> : <Field label="地址" value={url} onChangeText={setUrl} disabled={disabled} placeholder="https://…/mcp" />}
    <Section title={type === 'stdio' ? '环境变量' : '请求头'} action={<Button label={type === 'stdio' ? '添加环境变量' : '添加请求头'} icon="Plus" disabled={disabled} onPress={() => setVariables(current => [...current, { name: '', value: '' }])} />}>
      {variables.map((variable, index) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {(['name', 'value'] as const).map(field => <TextInput key={field} accessibilityLabel={field === 'name' ? '变量名称' : '变量值'} placeholder={field === 'name' ? type === 'stdio' ? 'API_KEY' : 'Authorization' : '值'} value={variable[field]} secureTextEntry={field === 'value'} editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.foregroundMuted} onChangeText={value => setVariables(current => current.map((entry, i) => i === index ? { ...entry, [field]: value } : entry))} style={{ outlineWidth: 0, flex: 1, minWidth: 0, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 10, fontSize: compact ? 16 : 14 }} />)}
        <Button label="移除变量" icon="X" iconOnly disabled={disabled} onPress={() => setVariables(current => current.filter((_, i) => i !== index))} />
      </View>)}
    </Section>
    <Actions><Button label="添加" primary disabled={disabled || !name.trim() || !(type === 'stdio' ? command.trim() : url.trim())} onPress={() => {
      const key = mcpNameSchema.safeParse(name.trim());
      if (!key.success) { setError('名称仅支持字母、数字、横线和下划线，且不能覆盖 Paseo 与 Bot 工具'); return; }
      if (existing.includes(key.data)) { setError('该名称已存在，请使用不同名称'); return; }
      if (variables.some(variable => !variable.name.trim() || !variable.value.trim())) { setError('请填写变量名称和值，或移除空行'); return; }
      const values = Object.fromEntries(variables.map(variable => [variable.name.trim(), variable.value]));
      const config = mcpServerSchema.safeParse(type === 'stdio'
        ? { type, command: command.trim(), args: args.split(/\r?\n/).map(arg => arg.trim()).filter(Boolean), ...(variables.length ? { env: values } : {}) }
        : { type, url: url.trim(), ...(variables.length ? { headers: values } : {}) });
      if (!config.success) { setError('连接配置无效，请检查地址或命令'); return; }
      add(key.data, config.data);
    }} /></Actions>
  </>;
}
