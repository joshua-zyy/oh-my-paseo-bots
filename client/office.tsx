import { useEffect, useRef, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import * as rpc from '../shared/office.js';

const labels: Record<string, string> = {
  pending_confirmation: '待用户确认', approved: '已确认，尚未外发', creating_draft: '草稿创建在途，需回查',
  draft: '草稿已创建，尚未发送', draft_unknown: '草稿创建结果不确定', sending: '发送在途，需回查',
  send_unknown: '发送结果不确定', sent: '已发送', revoked: '已撤销',
};

export function Office({ botId }: { botId: string }) {
  const settings = useSettings(rpc.officeSettings);
  const list = useRpc(rpc.listMail);
  const grants = useRpc(rpc.listMailGrants);
  const send = useRpc(rpc.sendMail);
  const reconcile = useRpc(rpc.reconcileMail);
  const revoke = useRpc(rpc.revokeMail);
  const allow = useRpc(rpc.allowFixedMail);
  const revokeGrant = useRpc(rpc.revokeMailGrant);
  const [actions, setActions] = useState<RpcOutput<typeof rpc.listMail>>([]);
  const [allowed, setAllowed] = useState<RpcOutput<typeof rpc.listMailGrants>>([]);
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
    try { await work(); } catch (e) { setError(String(e)); }
    finally {
      try { await refresh(); } catch (e) { setError(current => `${current}${current ? '；' : ''}${String(e)}`); }
      guard.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([list({ botId }), grants({ botId })]).then(([a, g]) => { if (active) { setActions(a); setAllowed(g); } }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [botId, list, grants]);
  return <SettingsSection title={`办公动作：${botId}`}>
    <SettingsRow label="沿用已安装的 gws 与飞书官方连接器登录。保存配置仅声明允许范围，不代表连接和续期已验证。" error={error || null} />
    {settings.status === 'ready' ? <Configuration key={`${botId}:${settings.revision}`} initial={settings.values.bots[botId] ?? {}} disabled={busy} save={value => run(async () => {
      if (!await settings.save({ bots: { ...settings.values.bots, [botId]: rpc.botOffice.parse(value) } }, settings.revision)) throw new Error('办公配置保存失败，请检查设置状态');
    })} /> : <SettingsRow label={`办公配置：${settings.status}`} />}
    <SettingsAction label="外发事项与预授权" actionLabel="刷新" disabled={busy} onPress={() => void run(async () => {})} />
    <SettingsRow label="确认只针对下方完整收件人、主题、正文和来源。未知结果先回查；新操作不等于安全重试。撤销不会收回已经准入或已发出的邮件。" />
    {actions.map(action => <SettingsSection key={action.id} title={`${labels[action.status] ?? action.status} · ${action.subject}`}>
      <SettingsRow label={`账户：${action.account}；收件人：${action.to.join('、')}`} hint={`事项会话：${action.agentId}；来源邮件：${action.sourceIds.join('、') || '无'}；批准查询：${action.query}`} />
      <SettingsRow label={action.text} hint={action.detail} />
      <SettingsRow label={`登记：${action.id}`} hint={action.sentId ? `已发送邮件：${action.sentId}` : action.draftId ? `草稿：${action.draftId}` : undefined} />
      <SettingsRow label={action.approvedAt ? `用户确认于 ${action.approvedAt}` : action.grantId ? `使用固定预授权 ${action.grantId}` : '尚无用户确认或有效固定预授权'} />
      <SettingsAction label="按显示内容确认外发" actionLabel={action.status === 'draft' ? '继续已确认的发送' : '确认并发送'} disabled={busy || !['pending_confirmation', 'approved', 'draft', 'revoked'].includes(action.status)} onPress={() => void run(() => send({ botId, actionId: action.id }))} />
      <SettingsAction label="结果不确定时核对实际状态" actionLabel="只回查" disabled={busy || !['creating_draft', 'draft_unknown', 'sending', 'send_unknown'].includes(action.status)} onPress={() => void run(() => reconcile({ botId, actionId: action.id }))} />
      <SettingsAction label="撤销后续发送；不收回已准入或已发出的邮件" actionLabel="撤销" disabled={busy || ['sent', 'revoked', 'sending', 'send_unknown'].includes(action.status)} onPress={() => void run(() => revoke({ botId, actionId: action.id }))} />
      <SettingsAction label="允许本事项以后发送完全相同的账户、查询范围、收件人、主题、正文和来源组合" actionLabel="批准固定动作" disabled={busy || ['creating_draft', 'draft_unknown', 'sending', 'send_unknown', 'sent', 'revoked'].includes(action.status)} onPress={() => void run(() => allow({ botId, actionId: action.id }))} />
    </SettingsSection>)}
    {allowed.map(grant => <SettingsAction key={grant.id} label={`${grant.revokedAt ? '已撤销' : '有效'}固定动作：${grant.subject}`} hint={`${grant.account} → ${grant.to.join('、')}；仅会话 ${grant.agentId}，正文和来源须与所批准内容完全一致`} actionLabel="撤销预授权" disabled={busy || Boolean(grant.revokedAt)} onPress={() => void run(() => revokeGrant({ botId, grantId: grant.id }))} />)}
  </SettingsSection>;
}

function Configuration({ initial, disabled, save }: { initial: rpc.BotOffice; disabled: boolean; save: (value: unknown) => Promise<void> }) {
  const [gmail, setGmail] = useState(Boolean(initial.gmail));
  const [feishu, setFeishu] = useState(Boolean(initial.feishu));
  const [values, setValues] = useState({
    gmailCommand: initial.gmail?.command ?? 'gws', configDir: initial.gmail?.configDir ?? '', account: initial.gmail?.account ?? '', query: initial.gmail?.query ?? '',
    feishuCommand: initial.feishu?.command ?? 'lark-mcp', appId: initial.feishu?.appId ?? '', secretEnv: initial.feishu?.secretEnv ?? 'APP_SECRET',
    documents: initial.feishu?.documentIds.join(',') ?? '', wiki: initial.feishu?.wikiTokens.join(',') ?? '',
  });
  const fields = [
    ['gmailCommand', 'gws 命令或宿主路径'], ['configDir', 'gws 现有登录目录（宿主绝对路径）'], ['account', '预期 Gmail 邮箱'], ['query', '允许读取的固定 Gmail 查询'],
    ['feishuCommand', '飞书 lark-mcp 命令或宿主路径'], ['appId', '飞书应用标识'], ['secretEnv', '宿主中保存应用密钥的环境变量名'], ['documents', '允许读取的 docx 文档标识（逗号分隔）'], ['wiki', '允许读取的知识库节点（逗号分隔）'],
  ] as const;
  const ids = (value: string) => value.split(/[\s,，]+/).filter(Boolean);
  return <>
    <SettingsSwitch label="为本 Bot 配置 Gmail 范围" value={gmail} disabled={disabled} onValueChange={setGmail} />
    <SettingsSwitch label="为本 Bot 配置飞书范围" value={feishu} disabled={disabled} onValueChange={setFeishu} />
    {fields.filter((_, index) => index < 4 ? gmail : feishu).map(([key, label]) => <SettingsInput key={key} label={label} initialValue={values[key]} disabled={disabled} onChangeText={text => setValues(current => ({ ...current, [key]: text }))} />)}
    <SettingsAction label="只保存本 Bot 的账户与允许范围；应用密钥留在宿主环境，插件不执行登录" actionLabel="保存办公配置" disabled={disabled} onPress={() => void save({
      ...(gmail ? { gmail: { command: values.gmailCommand, configDir: values.configDir, account: values.account, query: values.query } } : {}),
      ...(feishu ? { feishu: { command: values.feishuCommand, args: initial.feishu?.args ?? [], appId: values.appId, secretEnv: values.secretEnv, documentIds: ids(values.documents), wikiTokens: ids(values.wiki) } } : {}),
    })} />
  </>;
}
