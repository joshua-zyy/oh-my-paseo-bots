import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { AttentionView } from '../shared/attention.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup() {
  const source = ts.createSourceFile('attention.tsx', await readFile(new URL('../../client/attention.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Attention')!;
  const code = ts.transpileModule(`${declaration.getText(source)}\nreturn Attention;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const values: any[] = [], opened: unknown[] = [];
  let cursor = 0, calls = 0, fail = false, readError = '', subscriptionError = '', value: AttentionView | undefined;
  let result: AttentionView = { entries: [{ id: 'stable', botId: 'helper', botName: '同事', source: 'mail', sourceId: 'mail-id', kind: 'unknown', title: '结果未知', target: { panel: 'work' } }], issues: [], botIds: ['chief', 'helper'], scheduleIds: ['native-routine'] };
  const controller = { refresh: async () => { calls++; if (fail) readError = '读取未确认，保留上次结果'; else { value = result; readError = ''; } } };
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; };
  const Modal = Object.assign(function Modal() {}, { Content: 'Modal.Content' });
  // The screen has no RPC/subscription bindings: installing observation here would fail this test.
  const component = new Function('h', 'Fragment', 'useState', 'useAttentionController', 'useAttentionSnapshot', 'AttentionToast', 'Modal', 'Button', 'Copy', 'Notice', 'Section', code)((type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, () => controller, () => ({ value, error: [readError, subscriptionError].filter(Boolean).join('；') }), 'AttentionToast', Modal, 'Button', 'Copy', 'Notice', 'Section');
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = (compact = false) => { cursor = 0; return nodes(component({ compact, onOpen: (entry: unknown) => opened.push(entry) })); };
  return { render, opened, Modal, refresh: controller.refresh, setResult: (next: AttentionView) => { result = next; }, fail: () => { fail = true; }, subscriptionFailure: () => { subscriptionError = '订阅离线'; }, calls: () => calls };
}

test('集中待办仅消费共享投影，重绘不新建监听或读取；打开未知项只导航', async () => {
  const f = await setup();
  let view = f.render(); assert(view.some(node => node.props.label === '待办 · 读取中')); assert.equal(f.calls(), 0);
  await f.refresh(); view = f.render(); assert(view.some(node => node.props.label === '待办 · 1'));
  const count = f.calls(); f.render(); await tick(); assert.equal(f.calls(), count);
  view.find(node => node.props.label === '待办 · 1').props.onPress(); view = f.render(); assert.equal(view.find(node => node.type === f.Modal).props.open, true);
  view.find(node => node.props.label === '前往原处理入口').props.onPress(); view = f.render();
  assert.equal(view.find(node => node.type === f.Modal).props.open, false); assert.equal(f.opened.length, 1);
  assert.deepEqual((f.opened[0] as any).target, { panel: 'work' }); assert(view.some(node => node.props.label === '待办 · 1'), '打开不移除未知项或标完成');
  assert(f.render(true).some(node => node.type === 'AttentionToast')); assert(!f.render(false).some(node => node.type === 'AttentionToast'));
});

test('共享读取失败保留旧待办，局部空有警告；读取成功不隐藏未恢复的订阅失败', async () => {
  const f = await setup(); await f.refresh(); f.subscriptionFailure(); let view = f.render();
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')));
  view.find(node => node.props.label === '刷新待办').props.onPress(); await tick(); view = f.render();
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')));
  f.fail(); view.find(node => node.props.label === '刷新待办').props.onPress(); await tick(); view = f.render();
  assert(view.some(node => node.props.label === '待办 · 1 · 待核对'));
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('保留上次结果')));
  const partial = await setup(); partial.setResult({ entries: [], issues: [{ source: 'mail', botId: 'helper', detail: '损坏' }], botIds: ['chief'], scheduleIds: [] }); await partial.refresh(); view = partial.render();
  assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('不能确认没有待办')));
  assert(!view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('当前已读取来源没有')));
});

test('集中入口路由能力/工作/例程和原生会话，不触发审批或会话创建', async () => {
  const source = ts.createSourceFile('index.client.tsx', await readFile(new URL('../../index.client.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Attention') {
      const attr = node.attributes.properties.filter(ts.isJsxAttribute).find(attr => attr.name.getText(source) === 'onOpen')!;
      callback = (attr.initializer as ts.JsxExpression).expression!.getText(source);
    }
    ts.forEachChild(node, visit);
  }; visit(source); assert(callback);
  const calls: unknown[][] = [];
  const code = ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const open = new Function('refresh', 'choose', 'setPanel', 'openAgent', 'setError', code)(async () => calls.push(['refresh']), (id: string) => calls.push(['choose', id]), (panel: string) => calls.push(['panel', panel]), (id: string, botId: string) => calls.push(['agent', id, botId]), (error: string) => { throw new Error(error); });
  for (const panel of ['capabilities', 'work', 'routines']) { open({ botId: 'helper', target: { panel } }); await tick(); }
  open({ botId: 'helper', target: { panel: 'agent', agentId: 'permission-agent' } });
  assert.deepEqual(calls, [['refresh'], ['choose', 'helper'], ['panel', 'capabilities'], ['refresh'], ['choose', 'helper'], ['panel', 'work'], ['refresh'], ['choose', 'helper'], ['panel', 'routines'], ['agent', 'permission-agent', 'helper']]);
});
