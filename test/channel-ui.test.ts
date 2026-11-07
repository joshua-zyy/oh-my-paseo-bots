import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as rpc from '../shared/channels.js';

type Element = { type: string; props: Record<string, any>; children: unknown[] };
const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flatMap(elements)] : [];

async function editor() {
  const root = process.env.BOT_UI_SOURCE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  const source = ts.createSourceFile('channels.tsx', await readFile(resolve(root, 'client/channels.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'ChannelEditor');
  assert.ok(declaration);
  const body = ts.transpileModule(`${declaration.getText(source)}\nreturn ChannelEditor;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText.replace(/export /g, '');
  const values: unknown[] = [];
  let cursor = 0;
  const useState = (initial: any) => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (next: any) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
  };
  const components = ['Section', 'Field', 'SettingsCard', 'SettingsSwitch', 'SettingsSelect', 'Copy', 'PathPicker', 'Actions', 'Button'];
  const render = new Function('h', 'useState', 'rpc', 'CHIEF_BOT_ID', ...components, body)((type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }), useState, rpc, 'chief', ...components);
  return (props: unknown) => { cursor = 0; return elements(render(props)); };
}

const bots = [{ id: 'chief', name: '主同事', execution: { cwd: '/synthetic/project' } }, { id: 'helper', name: '资料同事' }];

test('频道表单选择成员和管理员、保存目录及共同说明，重试沿用创建标识', async () => {
  const render = await editor();
  const saved: unknown[] = [];
  const props = { bots, busy: false, save: async (input: unknown) => { saved.push(input); }, cancel() {} };
  let view = render(props);
  const find = (type: string, label: string) => {
    const node = view.find(node => node.type === type && node.props.label === label);
    assert.ok(node, `${type}: ${label}`);
    return node;
  };
  assert.equal(find('SettingsSwitch', '主同事').props.disabled, true, '不能留下不属于成员的管理员');
  assert.equal(find('SettingsSwitch', '资料同事').props.value, false);
  find('Field', '频道名称').props.onChangeText('交付项目');
  find('SettingsSwitch', '资料同事').props.onValueChange(true);
  view = render(props);
  assert.deepEqual(find('SettingsSelect', '管理员').props.options.map((item: any) => item.value), ['chief', 'helper']);
  find('SettingsSelect', '管理员').props.onValueChange('helper');
  view = render(props);
  assert.equal(find('SettingsSwitch', '主同事').props.disabled, false);
  find('SettingsSwitch', '主同事').props.onValueChange(false);
  find('PathPicker', '频道工作目录').props.onChange('/synthetic/deliverables');
  find('Field', '共同说明').props.onChangeText('先核对输入\n不执行外发');
  view = render(props);
  const save = find('Button', '保存频道');
  assert.equal(save.props.disabled, false);
  save.props.onPress();
  view = render(props);
  find('Button', '保存频道').props.onPress();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], saved[1], '同一表单的未知回执重试不换标识');
  const input = rpc.createChannel.input.parse(saved[0]);
  assert.equal(input.name, '交付项目');
  assert.deepEqual(input.memberIds, ['helper']);
  assert.equal(input.adminBotId, 'helper');
  assert.equal(input.cwd, '/synthetic/deliverables');
  assert.equal(input.instructions, '先核对输入\n不执行外发');
});

test('频道管理默认隐藏归档记录，恢复后返回活动频道', async () => {
  const root = process.env.BOT_UI_SOURCE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  const source = ts.createSourceFile('channels.tsx', await readFile(resolve(root, 'client/channels.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Channels');
  assert.ok(declaration);
  const body = ts.transpileModule(`${declaration.getText(source)}\nreturn Channels;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const base = { memberIds: ['chief'], adminBotId: 'chief', cwd: '/synthetic/project', instructions: '', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' };
  const active = rpc.channelSchema.parse({ ...base, id: '1524b809-dbbd-40f7-91b5-a74cd5764c60', name: '活动项目' });
  const archived = rpc.channelSchema.parse({ ...base, id: 'b87cdc89-d831-4c94-a99d-b62072d4d5f8', name: '旧项目', archivedAt: base.createdAt });
  const values: any[] = [];
  let cursor = 0, mounted = false;
  const effects: (() => unknown)[] = [];
  const guard = { current: false };
  const calls: unknown[] = [];
  const useState = (initial: any) => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (next: any) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; };
  const useRpc = (contract: { name: string }) => contract.name === 'bots.channels.list' ? async () => [active, archived] : async (input: any) => { assert.equal(contract.name, 'bots.channels.archive'); calls.push(input); const { archivedAt: _archivedAt, ...restored } = archived; return restored; };
  const names = ['Copy', 'Notice', 'ChannelEditor', 'Actions', 'Button', 'Section'];
  const component = new Function('h', 'Fragment', 'useRpc', 'useState', 'useRef', 'useEffect', 'rpc', ...names, body)((type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }), 'Fragment', useRpc, useState, () => guard, (effect: () => unknown) => { if (!mounted) effects.push(effect); }, rpc, ...names);
  const render = () => { cursor = 0; return elements(component({ bots })); };
  render(); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
  let view = render();
  assert.deepEqual(view.filter(node => node.type === 'Section').map(node => node.props.title), ['活动项目']);
  view.find(node => node.type === 'Button' && node.props.label === '已归档频道')!.props.onPress();
  view = render();
  assert.deepEqual(view.filter(node => node.type === 'Section').map(node => node.props.title), ['旧项目']);
  view.find(node => node.type === 'Button' && node.props.label === '恢复旧项目')!.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  view = render();
  assert.deepEqual(calls, [{ channelId: archived.id, archived: false }]);
  assert.deepEqual(view.filter(node => node.type === 'Section').map(node => node.props.title), ['活动项目', '旧项目']);
});

test('重新打开频道配置保留标识和成员，忙碌时不能再次保存或移除管理员', async () => {
  const render = await editor();
  const channel = rpc.channelSchema.parse({ id: '1524b809-dbbd-40f7-91b5-a74cd5764c60', name: '旧项目', memberIds: ['helper'], adminBotId: 'helper', cwd: '/synthetic/old', instructions: '原共同说明', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' });
  const saved: unknown[] = [];
  const props = { channel, bots, busy: false, save: async (input: unknown) => { saved.push(input); }, cancel() {} };
  const view = render(props);
  const save = view.find(node => node.type === 'Button' && node.props.label === '保存频道')!;
  save.props.onPress();
  assert.deepEqual(saved[0], { id: channel.id, name: channel.name, memberIds: channel.memberIds, adminBotId: channel.adminBotId, cwd: channel.cwd, instructions: channel.instructions });
  const busy = render({ ...props, busy: true });
  assert(busy.filter(node => ['Field', 'SettingsSwitch', 'SettingsSelect', 'PathPicker', 'Button'].includes(node.type)).every(node => node.props.disabled === true));
});
