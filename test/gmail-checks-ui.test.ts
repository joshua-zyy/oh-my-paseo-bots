import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import * as rpc from '../shared/gmail-checks.js';

test('Gmail检查页面默认不启用，说明费用/基线；显式操作才保存或停用，失效仍可停用', async () => {
  const source = ts.createSourceFile('gmail-checks.tsx', await readFile(new URL('../../client/gmail-checks.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'GmailRoutineCheck')!;
  const code = ts.transpileModule(`${declaration.getText(source)}\nreturn GmailRoutineCheck;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const routineId = randomUUID(), writes: any[] = [], values: any[] = [], effects: (() => unknown)[] = [];
  let cursor = 0, item: rpc.GmailCheckView | null = null;
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; };
  const useRef = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; };
  const useEffect = (work: () => unknown, deps: unknown[]) => { const i = cursor++; if (!values[i] || deps.some((value, index) => value !== values[i][index])) effects.push(work); values[i] = deps; };
  const handlers: Record<string, (input: any) => Promise<any>> = {
    'bots.gmail_check': async () => item,
    'bots.gmail_check.enable': async input => { writes.push(rpc.enableGmailCheck.input.parse(input)); item = { ...input, enabled: true, account: 'chief@example.test', query: 'label:synthetic', state: 'needs_sync' }; return item; },
    'bots.gmail_check.disable': async input => { writes.push(rpc.disableGmailCheck.input.parse(input)); item = { ...item!, enabled: false }; return item; },
  };
  const names = ['Actions', 'Button', 'Copy', 'Field', 'Notice', 'Section'];
  const component = new Function('h', 'Fragment', 'useState', 'useRef', 'useEffect', 'useRpc', 'rpc', ...names, code)((type: string, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, useRef, useEffect, (contract: { name: string }) => handlers[contract.name], rpc, ...names);
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = (disabled = false) => { cursor = 0; const view = nodes(component({ botId: 'chief', routineId, disabled })); effects.splice(0).forEach(work => work()); return view; };
  render(); await new Promise(resolve => setImmediate(resolve)); let view = render();
  assert.equal(writes.length, 0); assert(view.some(node => node.type === 'Copy' && JSON.stringify(node.children).includes('每次检查会运行模型')));
  assert(view.find(node => node.type === 'Button').props.disabled);
  view.find(node => node.type === 'Field').props.onChangeText('核对邮件，交付本地摘要'); view = render();
  const button = view.find(node => node.type === 'Button'); assert(!button.props.disabled); button.props.onPress(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [{ botId: 'chief', routineId, prompt: '核对邮件，交付本地摘要' }]); view = render();
  assert(view.find(node => node.type === 'Field').props.disabled); const stop = view.find(node => node.type === 'Button'); assert.equal(stop.props.label, '停用Gmail检查'); assert(!stop.props.disabled, '游标失效仍应允许停用');
  stop.props.onPress(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(writes[1], { botId: 'chief', routineId });
  view = render(); assert(view.find(node => node.type === 'Button').props.disabled, '停用的失效游标不能直接重设');
  view = render(true); assert(view.find(node => node.type === 'Button').props.disabled);
});
