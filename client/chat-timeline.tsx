import { useState } from 'react';
import { Text, View } from 'react-native';
import { Markdown, StreamedText } from '@getpaseo/plugin/client/ui';
import type { ToolCallDetail } from '@getpaseo/protocol/agent-types';
import type { ChatEntry } from './chat-state.js';
import { Button, Copy, Disclosure, Notice, useUi } from './ui.js';

export function ToolDetails({ detail }: { detail: ToolCallDetail }) {
  if (detail.type === 'plain_text' || detail.type === 'plan') return detail.text ? <Markdown>{detail.text}</Markdown> : null;
  if (detail.type === 'shell') return <Copy>{detail.command}{detail.output ? `\n${detail.output}` : ''}</Copy>;
  if (detail.type === 'read' || detail.type === 'write') return <Copy>{detail.filePath}{detail.content ? `\n${detail.content}` : ''}</Copy>;
  if (detail.type === 'edit') return <Copy>{detail.filePath}{detail.unifiedDiff ? `\n${detail.unifiedDiff}` : ''}</Copy>;
  if (detail.type === 'fetch') return <Copy>{detail.url}{detail.result ? `\n${detail.result}` : ''}</Copy>;
  if (detail.type === 'search') return <Copy>{detail.query}{detail.content ? `\n${detail.content}` : ''}</Copy>;
  if (detail.type === 'sub_agent') return <Copy>{detail.description}{detail.log ? `\n${detail.log}` : ''}</Copy>;
  return <Copy>{JSON.stringify(detail, null, 2)}</Copy>;
}

function Activity({ entries, openAgent }: { entries: ChatEntry[]; openAgent(id: string): void }) {
  const [open, setOpen] = useState(false);
  const { colors } = useUi();
  return <Disclosure title="工作过程" open={open} onPress={() => setOpen(value => !value)}>
    {entries.map(({ seqStart, item }) => <View key={seqStart} style={{ gap: 6 }}>
      {item.type === 'tool_call' && item.agentMessage ? <>
        <Copy>{item.agentMessage.sender.title || '同事消息'}</Copy>
        <Markdown>{item.agentMessage.text}</Markdown>
        <Button label="查看事项" onPress={() => openAgent(item.agentMessage!.sender.id)} />
      </> : item.type === 'tool_call' ? <>
        <Text style={{ color: item.status === 'failed' ? colors.statusDanger : colors.foreground, fontSize: 13 }}>{item.name}</Text>
        <ToolDetails detail={item.detail} />
        {item.status === 'failed' && <Notice error={String(item.error)} />}
      </> : item.type === 'reasoning' ? <Copy muted>{item.text}</Copy>
        : item.type === 'todo' ? item.items.map((task, index) => <Copy key={index}>{task.completed ? '✓' : '○'} {task.text}</Copy>)
        : item.type === 'compaction' ? <Copy muted>{item.status === 'loading' ? '整理上下文…' : '上下文已整理'}</Copy>
        : item.type === 'notification' ? <Copy muted small>{item.message}</Copy>
        : item.type === 'plugin' ? <Copy>{JSON.stringify(item.data, null, 2)}</Copy> : null}
    </View>)}
  </Disclosure>;
}

export function ChatTimeline({ entries, activeTurnId, openAgent }: { entries: ChatEntry[]; activeTurnId?: string; openAgent(id: string): void }) {
  const { colors, compact } = useUi();
  const rows: ({ entry: ChatEntry } | { activity: ChatEntry[] })[] = [];
  let activity: ChatEntry[] = [];
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'error' || (item.type === 'notification' && item.level !== 'info')) {
      if (activity.length) { rows.push({ activity }); activity = []; }
      rows.push({ entry });
    } else activity.push(entry);
  }
  if (activity.length) rows.push({ activity });
  return <>{rows.map(row => {
    if ('activity' in row) return <Activity key={`activity:${row.activity[0].seqStart}`} entries={row.activity} openAgent={openAgent} />;
    const { entry } = row;
    const { item } = entry;
    if (item.type === 'error') return <Notice key={entry.seqStart} error={item.message} />;
    if (item.type === 'notification') return <Text key={entry.seqStart} selectable style={{ color: item.level === 'error' ? colors.statusDanger : colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{item.message}</Text>;
    if (item.type === 'user_message') return <View key={entry.seqStart} style={{ alignSelf: 'flex-end', maxWidth: compact ? '92%' : '85%', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.surface2 }}><Text selectable style={{ color: colors.foreground, fontSize: compact ? 16 : 15, lineHeight: 24 }}>{item.text}</Text></View>;
    if (item.type === 'assistant_message') return <View key={entry.seqStart} style={{ paddingVertical: 4 }}>
      {entry.turnId && entry.turnId === activeTurnId ? <StreamedText text={item.text} phase="streaming" style={{ color: colors.foreground, fontSize: compact ? 16 : 15, lineHeight: 24 }} /> : <Markdown>{item.text}</Markdown>}
    </View>;
    return null;
  })}</>;
}
