import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { listAttention, type AttentionView } from '../shared/attention.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup() {
  const source = ts.createSourceFile('attention.tsx', await readFile(new URL('../../client/attention.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Attention')!;
  const code = ts.transpileModule(`${declaration.getText(source)}\nreturn Attention;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const values: any[] = [], effects: (() => void)[] = [], cleanups: (() => unknown)[] = [], opened: unknown[] = [], subscriptions: { labels: unknown[]; changed(): void; failed(error: unknown): void }[] = [];
  let cursor = 0, calls = 0, fail = false;
  let result: AttentionView = { entries: [{ id: 'stable', botId: 'helper', botName: '同事', source: 'mail', sourceId: 'mail-id', kind: 'unknown', title: '结果未知', target: { panel: 'work' } }], issues: [], botIds: ['chief', 'helper'], scheduleIds: ['native-routine'] };
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; };
  const useEffect = (work: () => unknown, deps: unknown[]) => {
    const i = cursor++; if (!values[i] || deps.some((dep, index) => dep !== values[i][index])) effects.push(() => { cleanups[i]?.(); const cleanup = work(); cleanups[i] = typeof cleanup === 'function' ? cleanup as () => unknown : () => {}; }); values[i] = deps;
  };
  const api = {};
  const rpcRead = async (input: unknown) => { calls++; assert.deepEqual(input, {}); if (fail) throw new Error('读取离线'); return result; };
  const observe = (_api: unknown, labels: unknown[], changed: () => void, failed: (error: unknown) => void) => { subscriptions.push({ labels, changed, failed }); return { release: async () => {} }; };
  const Modal = Object.assign(function Modal() {}, { Content: 'Modal.Content' });
  const component = new Function('h', 'Fragment', 'useState', 'useEffect', 'useRpc', 'usePaseo', 'listAttention', 'observeAgentChanges', 'Modal', 'Button', 'Copy', 'Notice', 'Section', code)((type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, useEffect, (contract: { name: string }) => { assert.equal(contract.name, 'bots.attention', '没有批准/清除/重派RPC'); return rpcRead; }, () => api, listAttention, observe, Modal, 'Button', 'Copy', 'Notice', 'Section');
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = () => { cursor = 0; const view = nodes(component({ bots: [{ id: 'chief', updatedAt: 'same' }], onOpen: (entry: unknown) => opened.push(entry) })); effects.splice(0).forEach(work => work()); return view; };
  return { render, subscriptions, opened, Modal, setResult: (value: AttentionView) => { result = value; }, fail: () => { fail = true; }, calls: () => calls, close: () => cleanups.forEach(cleanup => cleanup?.()) };
}

test('集中待办只读订阅跨Bot/原生例程，打开未知项只导航原入口、不自动处理', async () => {
  const f = await setup();
  try {
    let view = f.render(); assert(view.some(node => node.props.label === '待办 · 读取中')); await tick(); view = f.render(); await tick(); view = f.render();
    assert(view.some(node => node.props.label === '待办 · 1'));
    assert(f.subscriptions.some(s => JSON.stringify(s.labels).includes('helper') && JSON.stringify(s.labels).includes('native-routine')));
    const count = f.calls(); f.render(); await tick(); assert.equal(f.calls(), count, '普通重绘不轮询，元数据签名稳定');
    view.find(node => node.props.label === '待办 · 1').props.onPress(); view = f.render(); assert.equal(view.find(node => node.type === f.Modal).props.open, true);
    view.find(node => node.props.label === '前往原处理入口').props.onPress(); view = f.render();
    assert.equal(view.find(node => node.type === f.Modal).props.open, false); assert.equal(f.opened.length, 1);
    assert.deepEqual((f.opened[0] as any).target, { panel: 'work' }); assert(view.some(node => node.props.label === '待办 · 1'), '打开不移除未知项或标完成');
  } finally { f.close(); }
});

test('刷新失败保留旧待办，局部空有警告；读取成功不抹掉订阅失败', async () => {
  const f = await setup();
  try {
    f.render(); await tick(); f.render(); await tick(); let view = f.render();
    f.subscriptions.at(-1)!.failed(new Error('订阅离线')); view = f.render(); assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')));
    view.find(node => node.props.label === '刷新待办').props.onPress(); f.render(); await tick(); view = f.render();
    assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')), 'RPC成功不证明订阅恢复');
    f.fail(); view.find(node => node.props.label === '刷新待办').props.onPress(); f.render(); await tick(); view = f.render();
    assert(view.some(node => node.props.label === '待办 · 1 · 待核对'));
    assert(view.some(node => node.type === 'Notice' && node.props.error.includes('未判定已清空')));
  } finally { f.close(); }
  const partial = await setup();
  try {
    partial.setResult({ entries: [], issues: [{ source: 'mail', botId: 'helper', detail: '损坏' }], botIds: ['chief'], scheduleIds: [] });
    partial.render(); await tick(); const view = partial.render();
    assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('不能确认没有待办')));
    assert(!view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('当前已读取来源没有')));
  } finally { partial.close(); }
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
