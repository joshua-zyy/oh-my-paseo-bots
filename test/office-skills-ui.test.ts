import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as rpc from '../shared/files.js';

test('内置Office技能可见但默认关闭，只有用户选择才加入当前同事配置', async () => {
  const source = ts.createSourceFile('capabilities.tsx', await readFile(new URL('../../client/capabilities.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Skills')!;
  const body = ts.transpileModule(`${declaration.getText(source)}\nreturn Skills;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const builtin = { name: 'paseo-office-xlsx', description: 'Excel制作修改检查', path: '/builtin/paseo-office-xlsx/SKILL.md' };
  const existing = { name: 'existing', description: '既有技能', path: '/existing/SKILL.md' };
  let value = { skills: [existing], mcpServers: {} }, changes = 0, cursor = 0;
  const values: any[] = [], effects: (() => unknown)[] = [];
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (next: any) => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; };
  const useRef = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; };
  const useEffect = (work: () => unknown, deps: unknown[]) => { const i = cursor++; if (!values[i] || deps.some((item, index) => item !== values[i][index])) effects.push(work); values[i] = deps; };
  const handlers: Record<string, (input: any) => Promise<any>> = { 'bots.skills.builtin': async () => [builtin], 'bots.skill.inspect': async () => assert.fail('无需选择磁盘路径') };
  const names = ['SettingsCard', 'SettingsSwitch', 'PathPicker', 'Notice', 'Section'];
  const component = new Function('h', 'Fragment', 'useState', 'useRef', 'useEffect', 'useRpc', 'rpc', ...names, body)(
    (type: string, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, useRef, useEffect, (contract: { name: string }) => handlers[contract.name], rpc, ...names);
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && 'type' in tree ? [tree, ...tree.children.flatMap(nodes)] : [];
  const render = (disabled = false) => { cursor = 0; const view = nodes(component({ value, disabled, onChange: (next: typeof value) => { value = next; changes++; }, onBusyChange: () => {} })); effects.splice(0).forEach(work => work()); return view; };
  render(); await new Promise(resolve => setImmediate(resolve));
  let view = render(); const office = () => view.find(node => node.type === 'SettingsSwitch' && node.props.label === builtin.name);
  assert.equal(changes, 0); assert.equal(office().props.value, false);
  assert(view.some(node => node.type === 'SettingsSwitch' && node.props.label === existing.name && node.props.value));
  office().props.onValueChange(true); assert.deepEqual(value.skills, [existing, builtin]);
  view = render(); assert.equal(office().props.value, true);
  office().props.onValueChange(false); assert.deepEqual(value.skills, [existing]);
  view = render(true); assert(office().props.disabled);
});
