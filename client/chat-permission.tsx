// Native permission/question presentation adapted from paseo-bots. See THIRD_PARTY_NOTICES.md.
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Markdown, TextInput } from '@getpaseo/plugin/client/ui';
import type { PaseoAgent, PaseoAgentHandle, PaseoAgentPermissionResponse } from '@getpaseo/client';
import { parseQuestions, questionAnswered, questionAnswers } from './chat-question.js';
import { ToolDetails } from './chat-timeline.js';
import { Actions, Button, Copy, Notice, useUi } from './ui.js';

export function ChatPermission({ permission, agent }: { permission: PaseoAgent['pendingPermissions'][number]; agent: PaseoAgentHandle }) {
  const { colors, compact } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [texts, setTexts] = useState<Record<number, string>>({});
  const questions = useMemo(() => permission.kind === 'question' ? parseQuestions(permission.input) : null, [permission.kind, permission.input]);
  const plan = permission.metadata?.planText ?? permission.input?.plan;
  const actions = permission.actions?.length ? permission.actions : [{ label: '拒绝', behavior: 'deny' as const }, { label: '允许', behavior: 'allow' as const }];
  async function respond(response: PaseoAgentPermissionResponse) {
    if (busy) return;
    setBusy(true); setError('');
    try { await agent.respondToPermission({ requestId: permission.id, response }); }
    catch (failure) { setBusy(false); setError(`回应回执未确认：${String(failure)}`); }
  }
  return <View style={{ gap: 14, padding: 18, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1 }}>
    <Notice error={error} />
    {permission.kind === 'question' ? questions ? <>
      {questions.map((question, index) => <View key={question.header} style={{ gap: 10 }}>
        <Markdown>{question.question}</Markdown>
        {question.options.map((option, optionIndex) => {
          const checked = selected[index]?.includes(optionIndex) ?? false;
          return <Pressable key={optionIndex} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked }} disabled={busy} onPress={() => {
            const previous = selected[index] ?? [];
            setSelected(current => ({ ...current, [index]: checked ? previous.filter(value => value !== optionIndex) : question.multiSelect ? [...previous, optionIndex] : [optionIndex] }));
            if (!question.multiSelect) setTexts(current => ({ ...current, [index]: '' }));
          }} style={{ padding: 12, borderRadius: 6, backgroundColor: checked ? colors.surface2 : 'transparent', borderWidth: 1, borderColor: checked ? colors.foregroundMuted : colors.border, gap: 4 }}>
            <Text style={{ color: colors.foreground, fontSize: 14 }}>{checked ? '✓ ' : ''}{option.label}</Text>
            {option.description && <Copy muted>{option.description}</Copy>}
          </Pressable>;
        })}
        {(question.options.length === 0 || question.allowOther) && <TextInput accessibilityLabel={question.question} value={texts[index] ?? ''} placeholder={question.placeholder ?? '输入回答'} editable={!busy} onChangeText={text => {
          setTexts(current => ({ ...current, [index]: text }));
          if (!question.multiSelect && text) setSelected(current => ({ ...current, [index]: [] }));
        }} placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, fontSize: compact ? 16 : 14, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 6 }} />}
      </View>)}
      <Actions><Button label={questions.find(question => question.dismissLabel)?.dismissLabel || '跳过'} disabled={busy} onPress={() => void respond(questions.every(question => question.allowEmpty && !question.options.length)
        ? { behavior: 'allow', updatedInput: { ...permission.input, answers: questionAnswers(questions, {}, {}) } }
        : { behavior: 'deny', message: '用户跳过本次提问' })} />
        <Button label="提交回答" primary disabled={busy || !questions.every((question, index) => questionAnswered(question, selected[index] ?? [], texts[index] ?? ''))} onPress={() => void respond({ behavior: 'allow', updatedInput: { ...permission.input, answers: questionAnswers(questions, selected, texts) } })} /></Actions>
    </> : <><Notice error="原生问题数据不完整" /><Copy>{JSON.stringify(permission.input, null, 2)}</Copy><Button label="拒绝" disabled={busy} onPress={() => void respond({ behavior: 'deny', message: '问题数据不完整' })} /></> : <>
      <Copy>{permission.title || '需要批准'}</Copy>
      {permission.description && <Markdown>{permission.description}</Markdown>}
      {permission.kind === 'plan' && typeof plan === 'string' ? <Markdown>{plan}</Markdown> : permission.detail ? <ToolDetails detail={permission.detail} /> : permission.input && <Copy>{JSON.stringify(permission.input, null, 2)}</Copy>}
      <Actions>{actions.map((action, index) => <Button key={index} label={action.label} primary={action.behavior === 'allow'} disabled={busy} onPress={() => {
        const selectedAction = 'id' in action ? { selectedActionId: action.id } : {};
        void respond(action.behavior === 'allow' ? { behavior: 'allow', ...selectedAction } : { behavior: 'deny', ...selectedAction, message: '用户拒绝此次请求' });
      }} />)}</Actions>
    </>}
  </View>;
}
