import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi, PaseoAgent, PaseoAgentTimelineEvent } from '@getpaseo/client';
import { observeChat, type ChatState } from '../client/chat-state.js';
import { parseQuestions, questionAnswered, questionAnswers } from '../client/chat-question.js';

test('原生聊天补读、流式替换、重连回查和历史分页，不复制消息或遗漏待批准状态', async () => {
  const states: ChatState[] = [];
  let timelineEvent!: (event: PaseoAgentTimelineEvent) => void;
  let agentEvent!: () => void;
  let directorySnapshot!: () => void;
  let agent = { id: 'chat-1', status: 'idle', pendingPermissions: [] } as unknown as PaseoAgent;
  const requests: { direction?: string; cursor?: { epoch: string; seq: number } }[] = [];
  let entries = [{ seqStart: 2, seqEnd: 2, item: { type: 'assistant_message', text: '第一段' } }];
  let epoch = 'epoch-1';
  let nextFetch: (() => void) | undefined;
  const released: string[] = [];
  const api = { agents: {
    list: async (options: unknown) => {
      assert.deepEqual(options, { includeBackground: true, filter: { labels: { 'paseo-guys.bot': 'chief' }, includeArchived: true }, page: { limit: 1 }, subscribe: {} });
      return { subscription: {
        subscribe: (observer: { snapshot(): void }) => { directorySnapshot = observer.snapshot; return () => {}; },
        release: async () => { released.push('directory'); },
      } };
    },
    ref: () => ({
      current: () => agent,
      refresh: async () => ({ agent }),
      subscribe: (callback: (update: { kind: string; agent: PaseoAgent }) => void) => { agentEvent = () => callback({ kind: 'upsert', agent }); return () => { released.push('agent'); }; },
      timeline: {
        subscribe: (callback: (event: PaseoAgentTimelineEvent) => void) => {
          timelineEvent = callback;
          const subscription = Object.assign(() => {}, { ready: Promise.resolve(), release: async () => { released.push('timeline'); } });
          return subscription;
        },
        refetch: async (options: { direction?: string; cursor?: { epoch: string; seq: number } }) => {
          requests.push(options);
          const older = options.direction === 'before';
          const pageEntries = older ? [{ seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: '旧消息' } }] : entries;
          const result = { agent, entries: pageEntries, error: null, gap: false, staleCursor: false, reset: false, epoch, startCursor: { epoch, seq: pageEntries[0].seqStart }, endCursor: { epoch, seq: pageEntries.at(-1)!.seqEnd }, hasOlder: !older, hasNewer: false };
          nextFetch?.(); nextFetch = undefined;
          return result;
        },
      },
    }),
  } } as unknown as PaseoApi;
  const chat = observeChat(api, 'chief', 'chat-1', state => states.push(state));
  try {
    await chat.ready;
    assert.equal(states.at(-1)!.entries[0].item.type, 'assistant_message');
    entries = [{ seqStart: 2, seqEnd: 3, item: { type: 'assistant_message', text: '第一段继续' } }];
    await chat.refresh();
    assert.equal(states.at(-1)!.entries.length, 1);
    assert.equal((states.at(-1)!.entries[0].item as { text: string }).text, '第一段继续');
    await chat.loadOlder();
    assert.deepEqual(states.at(-1)!.entries.map(entry => entry.seqStart), [1, 2]);
    assert.equal(states.at(-1)!.hasOlder, false);
    const missed = new Promise<void>(resolve => { nextFetch = resolve; });
    entries = [{ seqStart: 4, seqEnd: 4, item: { type: 'assistant_message', text: '断线期间的回报' } }];
    timelineEvent({ agentId: 'chat-1', subscriptionId: 'reconnected', event: { type: 'subscription_restored' } });
    await missed;
    await chat.refresh();
    assert.ok(states.at(-1)!.entries.some(entry => entry.seqStart === 4));
    assert.equal(requests.at(-1)!.direction, 'after');
    agent = { ...agent, pendingPermissions: [{ id: 'permission-1', kind: 'tool', provider: 'pi', name: 'read' }] };
    agentEvent();
    assert.equal(states.at(-1)!.agent?.pendingPermissions[0].id, 'permission-1');
    agent = { ...agent, status: 'running' };
    directorySnapshot();
    await chat.refresh();
    assert.equal(states.at(-1)!.agent?.status, 'running');
    epoch = 'epoch-2';
    entries = [{ seqStart: 1, seqEnd: 1, item: { type: 'assistant_message', text: '替换后的历史' } }];
    const replaced = new Promise<void>(resolve => { nextFetch = resolve; });
    timelineEvent({ agentId: 'chat-1', event: { type: 'replacement', epoch } });
    await replaced;
    await chat.refresh();
    assert.equal(states.at(-1)!.entries.length, 1);
    assert.equal(states.at(-1)!.endCursor?.epoch, 'epoch-2');
  } finally { await chat.release(); }
  assert.deepEqual(released.sort(), ['agent', 'directory', 'timeline']);
});

test('问题只在边界解析，选择、自由输入和允许空答沿原生 answers 契约回复', () => {
  const questions = parseQuestions({ questions: [
    { header: '方向', question: '先处理哪项？', options: [{ label: '资料' }, { label: '代码' }], multiSelect: false, allowOther: true },
    { header: '要求', question: '选择要求', options: [{ label: '来源' }, { label: '数字' }], multiSelect: true, allowOther: true },
    { header: '补充', question: '补充意见', options: [], allowEmpty: true },
  ] });
  assert.ok(questions);
  assert.equal(questionAnswered(questions[0], [], ''), false);
  assert.equal(questionAnswered(questions[2], [], ''), true);
  assert.deepEqual(questionAnswers(questions, { 0: [0], 1: [0, 1] }, { 0: '设计', 1: '附图' }), { 方向: '设计', 要求: '来源, 数字, 附图', 补充: '' });
  assert.equal(parseQuestions({ questions: [{ question: '格式不全', options: [] }] }), null);
  assert.equal(parseQuestions({ questions: [{ header: '伪造', question: '格式不全', options: [{ label: 1 }] }] }), null);
});
