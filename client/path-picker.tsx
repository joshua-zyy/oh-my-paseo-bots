import { useEffect, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Modal, SettingsRow, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { View } from 'react-native';
import * as rpc from '../shared/files.js';
import { Actions, Button, Copy, Field, Notice } from './ui.js';

export function PathPicker({ label, value, initialPath, kind = 'directory', inherit = false, disabled = false, onChange }: {
  label: string; value?: string; initialPath?: string; kind?: 'directory' | 'skill' | 'mcp'; inherit?: boolean; disabled?: boolean; onChange(path: string | undefined): void;
}) {
  const list = useRpc(rpc.listDirectory);
  const api = usePaseo();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<RpcOutput<typeof rpc.listDirectory>>();
  const [known, setKnown] = useState<{ label: string; value: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  async function browse(path?: string) {
    setBusy(true); setError('');
    try { setListing(await list({ path, kind })); setTyping(false); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    void browse(value ?? initialPath);
    void api.workspaces.list().then(result => {
      if (active) setKnown(result.entries.map(workspace => ({ label: workspace.title || workspace.name, value: workspace.workspaceDirectory ?? workspace.projectRootPath })));
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [open, api, list]);
  function choose(path?: string) { onChange(path); setOpen(false); }
  const name = value?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
  const options = listing ? [{ label: listing.path, value: listing.path }, { label: '主目录', value: listing.home }, ...known].filter((option, i, rows) => rows.findIndex(row => row.value === option.value) === i) : [];
  return <>
    <SettingsRow label={label}><Button label={name || (inherit ? '默认文件夹' : '选择…')} icon={kind === 'directory' ? 'Folder' : 'Plus'} disabled={disabled} onPress={() => { setListing(undefined); setTyping(false); setOpen(true); }} /></SettingsRow>
    <Modal title={kind === 'skill' ? '选择技能' : kind === 'mcp' ? '选择 MCP 配置' : '选择文件夹'} open={open} onOpenChange={setOpen}>
      <Modal.Content>
        <Notice error={error} />
        {inherit && <Button label="默认文件夹" disabled={busy} onPress={() => choose()} />}
        {listing && <>
          <SettingsSelect label="位置" value={listing.path} options={options} disabled={busy} onValueChange={path => void browse(path)} />
          {listing.parent && <Button label="上一级" icon="ArrowUp" disabled={busy} onPress={() => void browse(listing.parent!)} />}
          {listing.entries.map(entry => <View key={entry.path} style={{ alignItems: 'flex-start' }}><Button label={entry.name} icon={entry.kind === 'directory' ? 'Folder' : 'FileText'} disabled={busy} onPress={() => entry.kind === 'directory' ? void browse(entry.path) : choose(entry.path)} /></View>)}
          {!listing.entries.length && <Copy muted>文件夹为空</Copy>}
          {kind === 'directory' && <Actions><Button label="使用此文件夹" primary disabled={busy} onPress={() => choose(listing.path)} /></Actions>}
        </>}
        {busy && <Copy muted>读取中…</Copy>}
        {typing ? <><Field label="绝对路径" value={draft} disabled={busy} onChangeText={setDraft} /><Actions><Button label="打开" disabled={busy || !draft.trim()} onPress={() => void browse(draft.trim())} /></Actions></> : <Button label="输入路径" icon="Pencil" disabled={busy} onPress={() => { setDraft(listing?.path ?? value ?? initialPath ?? ''); setTyping(true); }} />}
      </Modal.Content>
    </Modal>
  </>;
}
