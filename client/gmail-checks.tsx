import { useEffect, useRef, useState } from 'react';
import { useBotRpc as useRpc } from './attention-state.js';
import * as rpc from '../shared/gmail-checks.js';
import { Actions, Button, Copy, Field, Notice, Section } from './ui.js';

export function GmailRoutineCheck({ botId, routineId, disabled }: { botId: string; routineId: string; disabled: boolean }) {
  const inspect = useRpc(rpc.inspectGmailCheck), enable = useRpc(rpc.enableGmailCheck), disable = useRpc(rpc.disableGmailCheck);
  const [item, setItem] = useState<rpc.GmailCheckView | null>();
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const guard = useRef(false);
  useEffect(() => { let active = true; void inspect({ botId, routineId }).then(value => { if (active) { setItem(value); setPrompt(value?.prompt ?? ''); } }).catch(error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [botId, routineId, inspect]);
  async function change(on: boolean) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { setItem(await (on ? enable({ botId, routineId, prompt }) : disable({ botId, routineId }))); }
    catch (error) { setError(String(error)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <Section title="Gmail新邮件检查">
    <Notice error={error} />
    <Copy muted small>复用本例程频率，每次检查会运行模型，并非实时推送。仅使用本同事已配置的邮箱／查询范围及必要的新邮件ID元数据；启用时读取当前基线，不补跑启用前的邮件，不授予发送或新增账户权限。</Copy>
    {item && <><Copy>{item.account} · {item.query}</Copy><Copy muted>{item.enabled ? '已启用' : '已停用'} · {item.state === 'needs_sync' ? '游标失效，需用户核对' : item.state === 'dispatch_unknown' ? '事项派发待确认' : '已登记'}</Copy>{item.detail && <Copy muted>{item.detail}</Copy>}</>}
    <Field label="新邮件到达后要做的事" value={prompt} onChangeText={setPrompt} multiline maxLength={1500} disabled={disabled || busy || Boolean(item)} placeholder="资料核对、交付物及完成条件；不要把触发视为新增外发授权" />
    {item && <Copy muted small>更换账户、范围或工作要求请另建例程，原游标与未确认事项不自动重置。停用检查不停止本例程其他工作或已派发事项；暂停／取消例程仍用原生操作。</Copy>}
    <Actions><Button label={item?.enabled ? '停用Gmail检查' : '确认启用Gmail检查'} disabled={disabled || busy || item === undefined || !prompt.trim() || (!item?.enabled && item?.state === 'needs_sync')} onPress={() => void change(!item?.enabled)} /></Actions>
  </Section>;
}
