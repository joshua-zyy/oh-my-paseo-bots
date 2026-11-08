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

test('群消息框点名插入稳定标识，发送原文给解析成员并复用原生快照', async () => {
  const source = ts.createSourceFile('channel-chat.tsx', await readFile(new URL('../../client/channel-chat.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'ChannelChat')!;
  const body = ts.transpileModule(`${declaration.getText(source)}\nreturn ChannelChat;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const helpers = await import('../client/channel-state.js');
  const channel = rpc.channelSchema.parse({ id: '1524b809-dbbd-40f7-91b5-a74cd5764c60', name: '协作群', memberIds: ['chief', 'helper'], adminBotId: 'chief', cwd: '/synthetic/project', instructions: '', createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  const attachment = { type: 'text' as const, mimeType: 'text/plain' as const, title: '本群资料', text: 'GROUP-SNAPSHOT' };
  const calls: { agentId: string; text: string; options: any }[] = [], routes: unknown[] = [], checks: unknown[] = [];
  const api = { agents: { ref: (agentId: string) => ({ send: async (text: string, options: unknown) => { calls.push({ agentId, text, options }); } }) } };
  const targets = [{ botId: 'chief', agentId: 'group-chief', attachment }, { botId: 'helper', agentId: 'group-helper', attachment }];
  let sessions: { botId: string; agentId: string }[] = [];
  const observed: string[] = [], watches: (() => void)[] = [];
  const handlers: Record<string, (input: any) => Promise<any>> = {
    'bots.channels.view': async () => ({ channel, members: bots, sessions }),
    'bots.channels.route': async input => { routes.push(input); return { targets }; },
    'bots.channels.context': async input => { checks.push(input); return attachment; },
    'bots.reply.stop': async () => ({}),
  };
  const values: any[] = [], effects: (() => unknown)[] = []; let cursor = 0;
  const useState = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; };
  const useRef = (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; };
  const useEffect = (work: () => unknown, deps: unknown[]) => { const i = cursor++; if (!values[i] || deps.some((value, index) => value !== values[i][index])) effects.push(work); values[i] = deps; };
  const names = ['View', 'ScrollView', 'Copy', 'Actions', 'Button', 'Notice', 'Memories', 'ChatSegment', 'ChatTimeline', 'ChatPermission', 'TextInput'];
  const component = new Function('h', 'Fragment', 'useState', 'useRef', 'useEffect', 'usePaseo', 'useHosts', 'useRpc', 'useUi', 'rpc', 'stopReply', 'observeChat', 'observeAgentChanges', 'channelTimeline', 'deliverChannelMessage', ...names, body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }), 'Fragment', useState, useRef, useEffect, () => api, () => [{ serverId: 'host', status: 'online' }], (contract: { name: string }) => { assert(handlers[contract.name], contract.name); return handlers[contract.name]; }, () => ({ colors: {}, compact: false }), rpc, { name: 'bots.reply.stop' }, (_api: unknown, botId: string, agentId: string, changed: (state: unknown) => void) => { observed.push(agentId); changed({ entries: [], agent: { labels: { 'paseo-guys.bot': botId }, pendingPermissions: [] } }); return { release: async () => {}, refresh: async () => {} }; }, (_api: unknown, labels: unknown, changed: () => void) => { assert.deepEqual(labels, [{ 'paseo-guys.channel': channel.id }]); watches.push(changed); return { release: async () => {} }; }, helpers.channelTimeline, helpers.deliverChannelMessage, ...names);
  const render = () => { cursor = 0; const nodes = elements(component({ channel, hostId: 'host' })); effects.splice(0).forEach(work => work()); return nodes; };
  render(); await new Promise(resolve => setImmediate(resolve));
  let view = render(); view.find(node => node.type === 'Button' && node.props.label === '@资料同事')!.props.onPress();
  view = render(); assert.equal(view.find(node => node.type === 'TextInput')!.props.value, '@helper ');
  const text = '@helper @chief 请核对\n保留原话'; view.find(node => node.type === 'TextInput')!.props.onChangeText(text);
  view = render(); view.find(node => node.type === 'Button' && node.props.label === '发送')!.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(routes, [{ channelId: channel.id, text }]);
  assert.deepEqual(calls.map(call => call.agentId), ['group-chief', 'group-helper']); assert(calls.every(call => call.text === text));
  assert.equal(calls[0].options.messageId, calls[1].options.messageId); assert.deepEqual(calls[0].options.attachments, [attachment]);
  assert.deepEqual(checks.map((input: any) => input.agentId), ['group-chief', 'group-helper']);
  assert.equal(render().find(node => node.type === 'TextInput')!.props.value, '');
  assert.deepEqual(observed, [], '空群不订阅不存在的来源');
  sessions = targets.map(({ botId, agentId }) => ({ botId, agentId }));
  watches[0](); render(); await new Promise(resolve => setImmediate(resolve)); render();
  assert.deepEqual(observed, ['group-chief', 'group-helper'], '原生新成员状态到达后自动发现来源，无需手动刷新');
});

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
  const names = ['Copy', 'Notice', 'ChannelEditor', 'Actions', 'Button', 'Section', 'Modal', 'ChannelChat'];
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
