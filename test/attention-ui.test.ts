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
  let cursor = 0, calls = 0, fail = false, loading = false, gate: Promise<void> | undefined, release: (() => void) | undefined, readError = '', subscriptionError = '', value: AttentionView | undefined;
  let result: AttentionView = { entries: [{ id: 'stable', botId: 'helper', botName: '同事', source: 'work', sourceId: 'mail-id', kind: 'unknown', title: '结果未知', target: { panel: 'work' } }], issues: [], botIds: ['chief', 'helper'] };
  const controller = { refresh: async () => { calls++; loading = true; await gate; if (fail) readError = '读取未确认，保留上次结果'; else { value = result; readError = ''; } loading = false; } };
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; };
  const Modal = Object.assign(function Modal() {}, { Content: 'Modal.Content' });
  // The screen has no RPC/subscription bindings: installing observation here would fail this test.
  const component = new Function('h', 'Fragment', 'useState', 'useAttentionController', 'useAttentionSnapshot', 'AttentionToast', 'Modal', 'Button', 'Copy', 'Notice', 'Section', code)((type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, () => controller, () => ({ value, loading, error: [readError, subscriptionError].filter(Boolean).join('；') }), 'AttentionToast', Modal, 'Button', 'Copy', 'Notice', 'Section');
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = (compact = false) => { cursor = 0; return nodes(component({ compact, onOpen: (entry: unknown) => opened.push(entry) })); };
  return { render, opened, Modal, refresh: controller.refresh, setResult: (next: AttentionView) => { result = next; }, fail: () => { fail = true; }, subscriptionFailure: () => { subscriptionError = '订阅离线'; }, hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, finish: () => { release?.(); gate = undefined; }, calls: () => calls };
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

test('打开待办主动读取；刷新中保留旧值但不把旧空值当当前无待办', async () => {
  const f = await setup(); f.setResult({ entries: [], issues: [], botIds: ['chief'] }); await f.refresh();
  let view = f.render(); assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('当前已读取来源没有')));
  f.setResult({ entries: [{ id: 'new', botId: 'chief', botName: '主管', source: 'work', sourceId: 'new', kind: 'decision', title: '新决定', target: { panel: 'work' } }], issues: [], botIds: ['chief'] });
  f.hold(); const previous = f.calls(); view.find(node => node.props.label === '待办 · 0').props.onPress(); view = f.render();
  assert.equal(f.calls(), previous + 1); assert.equal(view.find(node => node.type === f.Modal).props.open, true);
  assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('正在刷新')));
  assert(!view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('当前已读取来源没有')));
  f.render(); assert.equal(f.calls(), previous + 1, '渲染不反复读取');
  f.finish(); await tick(); view = f.render(); assert(view.some(node => node.props.label === '待办 · 1'));
  assert(!view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('正在刷新'))); assert.equal(f.opened.length, 0);
});

test('共享读取失败保留旧待办，局部空有警告；读取成功不隐藏未恢复的订阅失败', async () => {
  const f = await setup(); await f.refresh(); f.subscriptionFailure(); let view = f.render();
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')));
  view.find(node => node.props.label === '刷新待办').props.onPress(); await tick(); view = f.render();
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('订阅离线')));
  f.fail(); view.find(node => node.props.label === '刷新待办').props.onPress(); await tick(); view = f.render();
  assert(view.some(node => node.props.label === '待办 · 1 · 待核对'));
  assert(view.some(node => node.type === 'Notice' && node.props.error.includes('保留上次结果')));
  const partial = await setup(); partial.setResult({ entries: [], issues: [{ source: 'work', botId: 'helper', detail: '损坏' }], botIds: ['chief'] }); await partial.refresh(); view = partial.render();
  assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('不能确认没有待办')));
  assert(!view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('当前已读取来源没有')));
});

test('骨架只注册单一主入口和侧栏，不注册旧能力行渲染器或多 Bot 侧栏', async () => {
  const text = await readFile(new URL('../../index.client.tsx', import.meta.url), 'utf8');
  assert.equal((text.match(/client\.addScreen\(/g) ?? []).length, 1);
  assert.equal((text.match(/client\.addSidebarHeaderItem\(/g) ?? []).length, 1);
  assert.doesNotMatch(text, /addTimelineRenderer|CAPABILITY_TIMELINE|CapabilityNavigationContext|setPicker|roster/);
  assert.match(text, /botId=\{CHIEF_BOT_ID\}/);
  for (const label of ['新对话', '配置', '记忆']) assert.ok(text.includes('label="' + label + '"'));
});
