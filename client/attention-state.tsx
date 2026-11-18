import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { useRpc as useNativeRpc } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { ZodType } from 'zod';
import type { AttentionEntry } from '../shared/attention.js';
import { attentionMutation, type AttentionController } from './attention-controller.js';

export const AttentionContext = createContext<AttentionController | null>(null);
export function useAttentionController() {
  const controller = useContext(AttentionContext);
  if (!controller) throw new Error('Attention requires its installed client controller');
  return controller;
}
export function useAttentionSnapshot() {
  const controller = useAttentionController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
const mutations = new Set([
  'bots.create', 'bots.update', 'bots.archive', 'bots.restore', 'bots.start',
  'bots.conversation.open', 'bots.conversation.create', 'bots.conversation.change', 'bots.reply.stop',
  'bots.creation.acknowledge', 'bots.creation.inspect', 'bots.capabilities.decide', 'bots.task.cancel',
  'bots.mail.confirm_send', 'bots.mail.reconcile', 'bots.mail.revoke', 'bots.mail.notify', 'bots.mail.allow_fixed', 'bots.mail.revoke_grant',
  'bots.routine.create', 'bots.routine.pause', 'bots.routine.resume', 'bots.routine.run', 'bots.routine.cancel',
  'bots.gmail_check.enable', 'bots.gmail_check.disable',
]);

/** Only this client's known actions invalidate this view; this is not a server push channel. */
export function useBotRpc<Input extends ZodType, Output extends ZodType>(contract: PluginRpcContract<Input, Output>) {
  const call = useNativeRpc(contract), controller = useContext(AttentionContext);
  return useCallback((input: Parameters<typeof call>[0]) => mutations.has(contract.name)
    ? attentionMutation(controller, () => call(input)) : call(input), [call, controller, contract.name]);
}
const reasons: Record<NonNullable<AttentionEntry['notice']>['reason'], string> = {
  native_permission: '原生请求待核对', native_error: '运行异常', capability: '能力方案待确认', task_review: '交付待核对', task_stop: '停止未确认', task_unreported: '工作结果未确认', followup_unknown: '跟进结果未知', mail_decision: '外发待处理', mail_unknown: '外发结果未知', routine_unknown: '例程结果未知', routine_failed: '例程失败', gmail_unknown: '邮件检查异常', inflight: '在途',
};
export function attentionMessage(entries: AttentionEntry[]) {
  return `${entries.length}项重要工作需核对：${entries.slice(0, 2).map(entry => `${entry.botName} · ${reasons[entry.notice!.reason]}`).join('；')}${entries.length > 2 ? '等' : ''}。请打开同事→待办；提醒不等于批准或完成。`;
}

/** Native hook presentation while mounted. No OS push or retained UI handle after unmount. */
export function AttentionToast() {
  const controller = useAttentionController(), toast = useToast();
  useEffect(() => controller.present(entries => toast.show(attentionMessage(entries), { variant: entries.some(entry => entry.kind === 'failure') ? 'error' : 'warning', durationMs: 8000 })), [controller, toast]);
  return null;
}
