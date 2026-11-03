import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { View } from 'react-native';
import * as rpc from '../shared/office.js';
import { Actions, Button, Copy, Disclosure, Field, Notice, Section } from './ui.js';

const labels: Record<string, string> = {
  pending_confirmation: '待确认', approved: '已确认，尚未外发', creating_draft: '草稿创建在途，需回查',
  draft: '草稿已创建，尚未发送', draft_unknown: '草稿结果不确定', sending: '发送在途，需回查',
  send_unknown: '发送结果不确定', sent: '已发送', revoked: '已撤销',
};

export function OfficeActions({ botId, revision = 0, inlineActions, onChanged }: { botId: string; revision?: number; inlineActions?: RpcOutput<typeof rpc.listMail>; onChanged?(): Promise<void> }) {
  const inline = inlineActions !== undefined;
  const list = useRpc(rpc.listMail);
  const grants = useRpc(rpc.listMailGrants);
  const send = useRpc(rpc.sendMail);
  const reconcile = useRpc(rpc.reconcileMail);
  const revoke = useRpc(rpc.revokeMail);
  const notify = useRpc(rpc.notifyMail);
  const allow = useRpc(rpc.allowFixedMail);
  const revokeGrant = useRpc(rpc.revokeMailGrant);
  const [actions, setActions] = useState<RpcOutput<typeof rpc.listMail>>([]);
  const [allowed, setAllowed] = useState<RpcOutput<typeof rpc.listMailGrants>>([]);
  const [opened, setOpened] = useState<string>();
  const [pastOpen, setPastOpen] = useState(false);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  async function refresh() {
    const [a, g] = await Promise.all([list({ botId }), grants({ botId })]);
    setActions(a); setAllowed(g);
  }
  async function run(work: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(String(failure)); }
    finally {
      try { if (inline) await onChanged?.(); else await refresh(); } catch (failure) { setError(current => `${current}${current ? '；' : ''}${String(failure)}`); }
      guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    if (inlineActions) { setActions(inlineActions); return; }
    let active = true;
    void Promise.all([list({ botId }), grants({ botId })]).then(([a, g]) => { if (active) { setActions(a); setAllowed(g); } }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [botId, list, grants, revision, inlineActions]);
  function row(action: RpcOutput<typeof rpc.listMail>[number]) {
    async function receive(result: RpcOutput<typeof rpc.sendMail>) {
      setActions(current => current.map(item => item.id === result.id ? result : item));
      try { await notify({ botId, actionId: result.id }); }
      catch (failure) { throw new Error(`邮件状态已保存，同事通知未确认：${String(failure)}`); }
    }
    return <Disclosure key={action.id} title={action.subject} status={labels[action.status] ?? action.status} open={opened === action.id || (inline && !['sent', 'revoked'].includes(action.status))} onPress={() => setOpened(opened === action.id ? undefined : action.id)}>
      <Copy>{action.account} → {action.to.join('、')}</Copy>
      <Copy>{action.text}</Copy>
      <Copy muted small>来源邮件：{action.sourceIds.join('、') || '无'}{'\n'}资料范围：{action.query}</Copy>
      {action.detail && <Copy muted>{action.detail}</Copy>}
      {!inline && <Copy muted small>事项：{action.agentId}{'\n'}登记：{action.id}{action.sentId ? `\n已发送邮件：${action.sentId}` : action.draftId ? `\n草稿：${action.draftId}` : ''}{action.approvedAt ? `\n用户确认于 ${action.approvedAt}` : action.grantId ? `\n固定预授权：${action.grantId}` : ''}</Copy>}
      {!['sent', 'revoked'].includes(action.status) && <Copy muted small>按以上完整内容确认。未知结果先回查，撤销不收回已准入或已发出的邮件。</Copy>}
      <Actions>
        {['pending_confirmation', 'approved', 'draft', 'revoked'].includes(action.status) && <Button label={action.status === 'draft' ? '继续发送' : '确认并发送'} primary disabled={busy} onPress={() => void run(async () => receive(await send({ botId, actionId: action.id })))} />}
        {['creating_draft', 'draft_unknown', 'sending', 'send_unknown'].includes(action.status) && <Button label="回查" primary disabled={busy} onPress={() => void run(async () => receive(await reconcile({ botId, actionId: action.id })))} />}
        {!['sent', 'revoked', 'sending', 'send_unknown'].includes(action.status) && <Button label="撤销" disabled={busy} onPress={() => void run(async () => receive(await revoke({ botId, actionId: action.id })))} />}
      </Actions>
      {!inline && !['creating_draft', 'draft_unknown', 'sending', 'send_unknown', 'sent', 'revoked'].includes(action.status) && <>
        <Copy muted small>固定预授权只允许本事项以后发送完全相同的账户、查询、收件人、主题、正文与来源组合。</Copy>
        <Actions><Button label="批准固定动作" disabled={busy} onPress={() => void run(() => allow({ botId, actionId: action.id }))} /></Actions>
      </>}
    </Disclosure>;
  }
  const current = actions.filter(action => !['sent', 'revoked'].includes(action.status));
  const past = actions.filter(action => ['sent', 'revoked'].includes(action.status));
  return <>
    <Notice error={error} />
    {inline ? actions.map(row) : (actions.length > 0 || allowed.length > 0) && <Section title="办公动作" action={<Button label="刷新外发" disabled={busy} onPress={() => void run(async () => {})} />}>
      {current.map(row)}
      {past.length > 0 && <Disclosure title="外发历史" status={String(past.length)} open={pastOpen} onPress={() => setPastOpen(value => !value)}>{past.map(row)}</Disclosure>}
      {allowed.length > 0 && <Disclosure title="固定预授权" status={String(allowed.length)} open={grantsOpen} onPress={() => setGrantsOpen(value => !value)}>{allowed.map(grant => <View key={grant.id} style={{ gap: 8 }}>
        <Copy>{grant.subject} · {grant.revokedAt ? '已撤销' : '有效'}</Copy><Copy muted small>{grant.account} → {grant.to.join('、')}{'\n'}仅事项 {grant.agentId}，正文及来源必须完全一致。</Copy>
        <Actions><Button label="撤销预授权" disabled={busy || Boolean(grant.revokedAt)} onPress={() => void run(() => revokeGrant({ botId, grantId: grant.id }))} /></Actions>
      </View>)}</Disclosure>}
    </Section>}
  </>;
}

export function OfficeConfiguration({ botId }: { botId: string }) {
  const settings = useSettings(rpc.officeSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useRef(false);
  return <><Notice error={error} />{settings.status === 'ready' ? <Configuration key={`${botId}:${settings.revision}`} initial={settings.values.bots[botId] ?? {}} disabled={busy} save={async value => {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    try {
      if (!await settings.save({ bots: { ...settings.values.bots, [botId]: rpc.botOffice.parse(value) } }, settings.revision)) throw new Error('办公配置保存失败，请刷新并检查配置');
    } catch (failure) { setError(String(failure)); }
    finally { guard.current = false; setBusy(false); }
  }} /> : <Copy muted>办公配置：{settings.status}</Copy>}</>;
}

function Configuration({ initial, disabled, save }: { initial: rpc.BotOffice; disabled: boolean; save(value: unknown): Promise<void> }) {
  const [gmail, setGmail] = useState(Boolean(initial.gmail));
  const [feishu, setFeishu] = useState(Boolean(initial.feishu));
  const [values, setValues] = useState({
    gmailCommand: initial.gmail?.command ?? 'gws', configDir: initial.gmail?.configDir ?? '', account: initial.gmail?.account ?? '', query: initial.gmail?.query ?? '',
    feishuCommand: initial.feishu?.command ?? 'lark-mcp', appId: initial.feishu?.appId ?? '', secretEnv: initial.feishu?.secretEnv ?? 'APP_SECRET', secretFile: initial.feishu?.secretFile ?? '',
    documents: initial.feishu?.documentIds.join(',') ?? '', wiki: initial.feishu?.wikiTokens.join(',') ?? '',
  });
  const ids = (value: string) => value.split(/[\s,，]+/).filter(Boolean);
  return <>
    <Section title="Gmail" action={<Button label={gmail ? '关闭 Gmail' : '配置 Gmail'} disabled={disabled} onPress={() => setGmail(value => !value)} />}>
      {gmail && ([['gmailCommand', 'gws 命令或宿主路径'], ['configDir', '现有登录目录（宿主绝对路径）'], ['account', 'Gmail 邮箱'], ['query', '允许读取的固定查询']] as const).map(([key, label]) => <Field key={key} label={label} value={values[key]} multiline={key === 'query'} disabled={disabled} onChangeText={text => setValues(current => ({ ...current, [key]: text }))} />)}
    </Section>
    <Section title="飞书" action={<Button label={feishu ? '关闭飞书' : '配置飞书'} disabled={disabled} onPress={() => setFeishu(value => !value)} />}>
      {feishu && <>{([['feishuCommand', 'lark-mcp 命令或宿主路径'], ['appId', '应用标识'], ['secretEnv', '密钥环境变量名'], ['secretFile', '密钥文件（宿主绝对路径）'], ['documents', '允许读取的文档标识（逗号分隔）'], ['wiki', '允许读取的知识库节点（逗号分隔）']] as const).map(([key, label]) => <Field key={key} label={label} value={values[key]} multiline={key === 'documents' || key === 'wiki'} disabled={disabled} onChangeText={text => setValues(current => ({ ...current, [key]: text }))} />)}<Copy muted small>指定密钥文件时优先使用，失败不回退环境变量。密钥内容保留在宿主。</Copy></>}
    </Section>
    <Copy muted small>保存仅声明本同事的账户与资料范围。沿用既有登录，不验证连接或新增权限。</Copy>
    <Actions><Button label="保存办公配置" primary disabled={disabled} onPress={() => void save({
      ...(gmail ? { gmail: { command: values.gmailCommand, configDir: values.configDir, account: values.account, query: values.query } } : {}),
      ...(feishu ? { feishu: { command: values.feishuCommand, args: initial.feishu?.args ?? [], appId: values.appId, secretEnv: values.secretEnv, ...(values.secretFile.trim() ? { secretFile: values.secretFile.trim() } : {}), documentIds: ids(values.documents), wikiTokens: ids(values.wiki) } } : {}),
    })} /></Actions>
  </>;
}
