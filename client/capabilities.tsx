import { useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import type { BotDetails } from '../shared/bot.js';
import type { McpImport } from '../shared/capabilities.js';
import * as rpc from '../shared/files.js';
import { PathPicker } from './path-picker.js';
import { Notice, Section } from './ui.js';

export function Capabilities({ value, imports, disabled, cwd, onChange, onImports, onBusyChange }: {
  value: BotDetails['capabilities']; imports: McpImport[]; disabled: boolean; cwd?: string; onChange(value: BotDetails['capabilities']): void; onImports(value: McpImport[]): void; onBusyChange(busy: boolean): void;
}) {
  const inspectSkill = useRpc(rpc.inspectSkill);
  const inspectMcp = useRpc(rpc.inspectMcp);
  const [skills, setSkills] = useState(value.skills);
  const [servers] = useState(value.mcpServers);
  const [files, setFiles] = useState<{ path: string; names: string[] }[]>(imports);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); onBusyChange(true); setError('');
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); onBusyChange(false); }
  }
  return <>
    <Notice error={error} />
    <Section title="技能"><SettingsCard>
      {skills.map(skill => <SettingsSwitch key={skill.path} label={skill.name} value={value.skills.some(selected => selected.path === skill.path)} disabled={disabled || busy} onValueChange={enabled => onChange({ ...value, skills: enabled ? [...value.skills, skill] : value.skills.filter(selected => selected.path !== skill.path) })} />)}
      <PathPicker label="添加技能" kind="skill" disabled={disabled || busy} onChange={path => { if (path) void run(async () => {
        const skill = await inspectSkill({ path });
        setSkills(current => [...current.filter(entry => entry.path !== path), skill]);
        onChange({ ...value, skills: [...value.skills.filter(entry => entry.path !== path), skill] });
      }); }} />
    </SettingsCard></Section>
    <Section title="MCP"><SettingsCard>
      {Object.entries(servers).map(([name, config]) => <SettingsSwitch key={name} label={name} value={!!value.mcpServers[name]} disabled={disabled || busy} onValueChange={enabled => {
        const mcpServers = { ...value.mcpServers };
        if (enabled) mcpServers[name] = config; else delete mcpServers[name];
        onChange({ ...value, mcpServers });
        if (enabled) onImports(imports.map(selection => ({ ...selection, names: selection.names.filter(selected => selected !== name) })).filter(selection => selection.names.length));
      }} />)}
      {files.flatMap(file => file.names.map(name => <SettingsSwitch key={`${file.path}:${name}`} label={name} value={imports.some(selection => selection.path === file.path && selection.names.includes(name))} disabled={disabled || busy} onValueChange={enabled => {
        const chosen = imports.find(selection => selection.path === file.path)?.names ?? [];
        const names = enabled ? [...chosen, name] : chosen.filter(selected => selected !== name);
        onImports([...imports.filter(selection => selection.path !== file.path).map(selection => ({ ...selection, names: enabled ? selection.names.filter(selected => selected !== name) : selection.names })).filter(selection => selection.names.length), ...(names.length ? [{ path: file.path, names }] : [])]);
        if (enabled && value.mcpServers[name]) {
          const mcpServers = { ...value.mcpServers }; delete mcpServers[name]; onChange({ ...value, mcpServers });
        }
      }} />))}
      <PathPicker label="从配置添加" kind="mcp" initialPath={cwd} disabled={disabled || busy} onChange={path => { if (path) void run(async () => {
        const file = await inspectMcp({ path });
        if (!file.names.length) throw new Error('配置中没有可添加的 MCP');
        setFiles(current => [...current.filter(entry => entry.path !== path), { path, ...file }]);
      }); }} />
    </SettingsCard></Section>
  </>;
}
