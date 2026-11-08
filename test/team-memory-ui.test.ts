import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as rpc from '../shared/contracts.js';

test('从群记忆发布须预览确认，只发布可见内容且团队读取不带原频道或私聊来源', async () => {
  const source = ts.createSourceFile('memories.tsx', await readFile(new URL('../../client/memories.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Memories')!;
  const body = ts.transpileModule(`${declaration.getText(source)}\nreturn Memories;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const channelId = 'df36bb2c-837d-4051-8a6b-4ae1e07b6041';
  const own = [{ id: 'original', content: '本群原约定', kind: 'confirmed', createdAt: 'now', history: [], origin: { type: 'message', agentId: 'private-source', userQuote: 'PRIVATE-QUOTE-DO-NOT-SHARE' } }];
  const shared: any[] = [], writes: unknown[] = [], reads: any[] = [];
  const handlers: Record<string, (input: any) => Promise<any>> = {
    'bots.memories': async input => { reads.push(input); return input.team ? [...shared] : own; },
    'bots.memory.save': async input => { writes.push(rpc.saveMemory.input.parse(input)); const entry = { id: 'shared', ...input, history: [], createdAt: 'now', origin: { type: 'manual' } }; shared.push(entry); return entry; },
    'bots.memory.correct': async () => assert.fail('发布不修改原条'),
    'bots.memory.forget': async () => assert.fail('发布不删除原条'),
    'bots.memory.restore': async () => assert.fail('本用例不恢复'),
  };
  const values: any[] = [], effects: (() => unknown)[] = []; let cursor = 0;
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (next: any) => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; };
  const useRef = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; };
  const useEffect = (work: () => unknown, deps: unknown[]) => { const i = cursor++; if (!values[i] || deps.some((value, index) => value !== values[i][index])) effects.push(work); values[i] = deps; };
  const names = ['View', 'Actions', 'Button', 'Copy', 'Notice', 'Field', 'Section', 'Disclosure', 'MemoryOriginView'];
  const component = new Function('h', 'Fragment', 'useState', 'useRef', 'useEffect', 'useRpc', 'useUi', 'useBotUpdates', 'rpc', ...names, body)(
    (type: string, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, useRef, useEffect, (contract: { name: string }) => handlers[contract.name], () => ({ colors: {} }), () => ({ revision: 0, error: '' }), rpc, ...names);
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = () => { cursor = 0; const result = nodes(component({ botId: 'chief', channelId })); effects.splice(0).forEach(work => work()); return result; };
  const press = (view: any[], label: string) => { const button = view.find(node => node.type === 'Button' && node.props.label === label); assert(button, label); assert(!button.props.disabled); button.props.onPress(); };
  render(); await new Promise(resolve => setImmediate(resolve));
  let view = render(); press(view, '发布到团队'); view = render();
  assert.equal(writes.length, 0); assert.equal(view.find(node => node.type === 'Field').props.value, '本群原约定');
  assert.equal(view.find(node => node.type === 'Button' && node.props.label === '团队共享记忆').props.disabled, true);
  press(view, '取消'); assert.equal(writes.length, 0);
  view = render(); press(view, '发布到团队'); view = render();
  view.find(node => node.type === 'Field').props.onChangeText('用户预览后选择公开的约定');
  view = render(); press(view, '确认发布给全团队'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [{ botId: 'chief', team: true, kind: 'confirmed', content: '用户预览后选择公开的约定' }]);
  assert.equal(own[0].content, '本群原约定'); assert(!JSON.stringify(writes).includes('PRIVATE-QUOTE'));
  view = render(); press(view, '团队共享记忆'); await new Promise(resolve => setImmediate(resolve));
  render(); await new Promise(resolve => setImmediate(resolve)); view = render();
  assert.deepEqual(reads.at(-1), { botId: 'chief', team: true, includeArchived: true });
  assert(!view.some(node => node.type === 'Button' && node.props.label === '发布到团队'));
  assert(view.filter(node => node.type === 'MemoryOriginView').every(node => node.props.origin.type === 'manual'));
});
