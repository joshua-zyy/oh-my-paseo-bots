import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useBotRpc as useRpc } from './attention-state.js';
import type { RpcOutput } from '@getpaseo/plugin';
import { decideCapabilities } from '../shared/capability-guidance.js';
import type { listBots } from '../shared/contracts.js';
import { Actions, Button, Copy, Notice, Section } from './ui.js';

export function CapabilityRequests({ bots, refresh }: { bots: RpcOutput<typeof listBots>['bots']; refresh(): Promise<void> }) {
  const decide = useRpc(decideCapabilities);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const guard = useRef(false);
  const pending = bots.filter(bot => bot.capabilityRequest?.state === 'pending');
  async function respond(botId: string, requestId: string, decision: 'apply' | 'reject') {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await decide({ botId, requestId, decision });
      setMessage(result.state === 'applied' ? '能力配置已保存，仅之后的新对话/新任务使用；原生执行权限和审批不变。返回Chief可继续交办工作。' : '方案已拒绝，能力绑定未改变。');
      await refresh();
    } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    <Notice error={error} />{message && <Copy>{message}</Copy>}
    <Copy muted small>Chief仅提出方案，尚未配置。请核对接收同事、技能路径和MCP来源；确认后按来源的现有账户/工具范围保存，不安装、不登录、不修改宿主权限，不启动任务。技能仍引用原文件，不冻结或改写其内容。</Copy>
    {!pending.length && <Copy muted>暂无待确认能力方案</Copy>}
    {pending.map(bot => {
      const request = bot.capabilityRequest!;
      return <Section key={`${bot.id}:${request.id}`} title={`${bot.name} · 能力待确认`}>
        <Copy>{request.summary}</Copy>
        {request.skills.map(skill => <View key={skill.path}><Copy>{skill.name}</Copy><Copy muted small>{skill.description}</Copy><Copy muted small>{skill.path}</Copy></View>)}
        {request.mcp.map(server => <View key={server.name}><Copy>{`MCP ${server.name} · ${server.type}（新增或替换同名绑定）`}</Copy><Copy muted small>{server.path}</Copy></View>)}
        <Copy muted small>来源变化会拒绝应用，须重新核对；不向模型或本页提供连接密钥。已运行会话不会自动切换。</Copy>
        <Actions><Button label="拒绝方案" disabled={busy} onPress={() => void respond(bot.id, request.id, 'reject')} /><Button label="确认配置" primary disabled={busy} onPress={() => void respond(bot.id, request.id, 'apply')} /></Actions>
      </Section>;
    })}
  </>;
}
