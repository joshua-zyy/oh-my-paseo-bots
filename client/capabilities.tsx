import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import type { BotDetails } from '../shared/bot.js';
import * as rpc from '../shared/files.js';
import { PathPicker } from './path-picker.js';
import { Notice, Section } from './ui.js';

export function Skills({ value, disabled, onChange, onBusyChange }: {
  value: BotDetails['capabilities']; disabled: boolean; onChange(value: BotDetails['capabilities']): void; onBusyChange(busy: boolean): void;
}) {
  const inspectSkill = useRpc(rpc.inspectSkill);
  const listBuiltin = useRpc(rpc.listBuiltinSkills);
  const [skills, setSkills] = useState(value.skills);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  useEffect(() => {
    let active = true;
    void listBuiltin({}).then(builtin => { if (active) setSkills(current => [...new Map([...builtin, ...current].map(skill => [skill.path, skill])).values()]); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [listBuiltin]);
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
  </>;
}
