import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import type { RpcOutput } from '@getpaseo/plugin';
import * as rpc from '../shared/contracts.js';
import { Actions, Button, Copy, Field, Notice, Section, useUi } from './ui.js';

export function Memories({ botId }: { botId: string }) {
  const list = useRpc(rpc.listMemories);
  const save = useRpc(rpc.saveMemory);
  const correct = useRpc(rpc.correctMemory);
  const { colors } = useUi();
  const [entries, setEntries] = useState<RpcOutput<typeof rpc.listMemories>>([]);
  const [editing, setEditing] = useState<{ id?: string; content: string; kind: 'candidate' | 'confirmed' }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function run(action?: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await action?.(); setEntries(await list({ botId })); }
    catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void list({ botId }).then(value => { if (active) setEntries(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list]);
  return <>
    <Notice error={error} />
    <Actions><Button label="刷新" disabled={busy} onPress={() => void run()} /><Button label="添加记忆" icon="Plus" disabled={busy} onPress={() => setEditing({ content: '', kind: 'confirmed' })} /></Actions>
    {editing && <View style={{ padding: 16, marginVertical: 16, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <Field label={editing.id ? '纠正记忆' : '记忆内容'} value={editing.content} maxLength={8000} multiline disabled={busy} onChangeText={content => setEditing({ ...editing, content })} />
      <Actions><Button label="取消" disabled={busy} onPress={() => setEditing(undefined)} /><Button label="保存记忆" primary disabled={busy || !editing.content.trim()} onPress={() => void run(async () => {
        if (editing.id) await correct({ botId, memoryId: editing.id, kind: editing.kind, content: editing.content });
        else await save({ botId, kind: 'confirmed', content: editing.content });
        setEditing(undefined);
      })} /></Actions>
      {editing.id && <Copy muted small>只修改当前记忆，历史和备份保留。</Copy>}
    </View>}
    {(['candidate', 'confirmed'] as const).map(kind => {
      const items = entries.filter(item => item.kind === kind);
      return (items.length > 0 || kind === 'confirmed') && <Section key={kind} title={kind === 'candidate' ? '待确认' : '已确认'}>
        {items.map(entry => <View key={entry.id} style={{ paddingVertical: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Copy>{entry.content}</Copy>
          <Actions>{kind === 'candidate' && <Button label="确认" disabled={busy} onPress={() => void run(() => correct({ botId, memoryId: entry.id, kind: 'confirmed', content: entry.content }))} />}<Button label="编辑" disabled={busy} onPress={() => setEditing({ id: entry.id, content: entry.content, kind: entry.kind })} /></Actions>
        </View>)}
        {!items.length && <Copy muted>暂无记忆</Copy>}
      </Section>;
    })}
  </>;
}
