import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { PaseoApi } from '@getpaseo/client';
import { observeChat, type ChatState } from '../client/chat-state.js';
import { CAPABILITY_TIMELINE, capabilityStatusItem, readCapabilityStatus, capabilityStatusText } from '../shared/capability-timeline.js';

const row = (state: 'pending' | 'applied' | 'rejected', id = 'a'.repeat(64)) => ({ ...capabilityStatusItem('helper', '合成同事', { id, state, sourceAgentId: 'source', summary: 'PRIVATE-SUMMARY', skills: [], mcp: [], createdAt: 'now' }), pluginId: CAPABILITY_TIMELINE.pluginId });

test('能力行契约只发有限可读元数据，精确plugin/kind/version/schema/id识别', () => {
  const item = row('pending'); assert(readCapabilityStatus(item));
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE-SUMMARY|sourceAgentId|fingerprint|headers/);
  for (const changed of [{ ...item, pluginId: 'another' }, { ...item, version: 2 }, { ...item, id: 'wrong' }, { ...item, data: { ...item.data as object, secret: 'not-allowed' } }]) assert.equal(readCapabilityStatus(changed), null);
  assert.match(capabilityStatusText(readCapabilityStatus(item)!).detail, /查看不会批准/);
  assert.match(capabilityStatusText(readCapabilityStatus(row('applied'))!).detail, /后续/);
});

test('能力行同ID更新跨分页只留最新状态，读取更早pending不能覆盖resolved或别的方案', async () => {
  let state!: ChatState;
  let sequence = 1;
  const api = { agents: {
    list: async () => ({ subscription: { subscribe: () => () => {}, release: async () => {} } }),
    ref: () => ({ current: () => null, subscribe: () => () => {}, timeline: {
      subscribe: () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} }),
      refetch: async (options: { direction: string }) => {
        const older = options.direction === 'before';
        const seq = older ? 1 : sequence;
        return { entries: [{ seqStart: seq, seqEnd: seq, item: row(seq === 1 ? 'pending' : 'rejected') }, ...(sequence > 1 && !older ? [{ seqStart: seq + 1, seqEnd: seq + 1, item: row('pending', 'b'.repeat(64)) }] : [])], epoch: 'epoch', startCursor: { epoch: 'epoch', seq }, endCursor: { epoch: 'epoch', seq: seq + 1 }, hasOlder: !older, hasNewer: false, error: null };
      },
    } }),
  } } as unknown as PaseoApi;
  const chat = observeChat(api, 'chief', 'source', next => { state = next; });
  try {
    await chat.ready; sequence = 5; await chat.refresh();
    assert.equal(state.entries.length, 2); assert.equal(readCapabilityStatus(state.entries[0].item)!.state, 'rejected');
    await chat.loadOlder(); assert.equal(state.entries.length, 2); assert.equal(readCapabilityStatus(state.entries[0].item)!.state, 'rejected');
  } finally { await chat.release(); }
});

async function body(path: string, name: string) {
  const source = ts.createSourceFile(path, await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name)!;
  return ts.transpileModule(`return (${node.getText(source).replace(/^export /, '')});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
}
const React = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
const colors = { border: '#123', surface1: '#234', statusWarning: '#345', foreground: '#456', foregroundMuted: '#567' };
const useUi = () => ({ colors, compact: false });

test('真实能力卡在主时间线可见且只导航原入口，不做审批/配置；宿主主题颜色沿用', async () => {
  const render = new Function('React', 'View', 'Text', 'Button', 'useUi', 'capabilityStatusText', await body('client/capability-status.tsx', 'CapabilityStatusCard'))(React, 'View', 'Text', 'Button', useUi, capabilityStatusText);
  const opened: string[] = []; const data = readCapabilityStatus(row('pending'))!;
  const card = render({ data, onOpen: (id: string) => opened.push(id) });
  assert.equal(card.props.style.backgroundColor, colors.surface1);
  assert.match(card.props.children[0].props.children[0], /能力方案待确认/);
  assert.equal(card.props.children[0].props.style.color, colors.statusWarning);
  const button = card.props.children.find((node: any) => node.type === 'Button');
  assert.equal(button.props.label, '查看当前能力方案'); button.props.onPress(); assert.deepEqual(opened, ['helper']);
  assert.equal(render({ data }).props.children[2].props.disabled, true);
  const timeline = new Function('React', 'View', 'Text', 'useUi', 'useContext', 'CapabilityNavigationContext', 'CapabilityStatusCard', 'readCapabilityStatus', 'Activity', await body('client/chat-timeline.tsx', 'ChatTimeline'))(React, 'View', 'Text', useUi, () => () => {}, {}, 'CapabilityStatusCard', readCapabilityStatus, 'Activity');
  const tree = timeline({ entries: [{ seqStart: 1, seqEnd: 1, item: row('pending') }], openAgent() {} });
  assert.equal(tree.props.children[0][0].type, 'CapabilityStatusCard', '不是折叠工作过程中的原始JSON');
});
