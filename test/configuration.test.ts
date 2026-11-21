import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi } from '@getpaseo/client';
import ts from 'typescript';
import contribute from '../index.server.js';

test('Bot栏直接配置图标打开既有设置，不创建或切换对话', async () => {
  const source = ts.createSourceFile('index.client.tsx', await readFile(new URL('../../index.client.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let button: ts.JsxSelfClosingElement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button' && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(source) === 'label' && p.initializer?.getText(source) === '"配置"')) button = node;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(button);
  const props = button.attributes.properties.filter(ts.isJsxAttribute);
  assert.equal(props.find(p => p.name.getText(source) === 'icon')?.initializer?.getText(source), '"Settings"');
  assert(props.some(p => p.name.getText(source) === 'iconOnly'));
  const callback = props.find(p => p.name.getText(source) === 'onPress')!.initializer as ts.JsxExpression;
  const panels: string[] = [];
  new Function('setPanel', 'setDefaults', `return (${callback.expression!.getText(source)});`)((panel: string) => panels.push(panel), () => {})();
  assert.deepEqual(panels, ['settings']);
});

test('模型选择执行实际回调，换模型清除不兼容的模式和思考选项', async () => {
  const source = ts.createSourceFile('execution.tsx', await readFile(new URL('../../client/execution.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'SettingsSelect') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const label = attributes.find(item => item.name.getText(source) === 'label')?.initializer;
      const change = attributes.find(item => item.name.getText(source) === 'onValueChange')?.initializer;
      if (label && ts.isStringLiteral(label) && label.text === '模型' && change && ts.isJsxExpression(change) && change.expression) callback = change.expression.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  let changed: unknown;
  const value = { provider: 'pi/vendor/old', cwd: 'D:/work', modeId: 'old-mode', thinkingOptionId: 'old-thinking' };
  const select = new Function('value', 'onChange', `return (${callback});`)(value, (next: unknown) => { changed = next; });
  select('pi/vendor/new');
  assert.deepEqual(changed, { provider: 'pi/vendor/new', cwd: 'D:/work', modeId: undefined, thinkingOptionId: undefined });
  select('');
  assert.deepEqual(changed, { provider: undefined, cwd: 'D:/work', modeId: undefined, thinkingOptionId: undefined });
});

test('Bot 默认工作区自动创建在当前 Paseo home 下，显式工作目录和既有配置仍生效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-managed-workspaces-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const home = join(directory, 'paseo');
  const previous = { data: process.env.OH_MY_PASEO_BOTS_DATA_DIR, home: process.env.PASEO_HOME };
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = directory;
  process.env.PASEO_HOME = home;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const created: { cwd: string; config: unknown }[] = [];
  const paseo = { workspaces: { create: async (input: { source: { path: string }; background: boolean }) => {
    assert.equal(input.background, true);
    return { agents: { create: async (options: { agentId: string; config: unknown }) => { created.push({ cwd: input.source.path, config: options.config }); return { id: options.agentId }; } } };
  } } } as unknown as PaseoApi;
  const cleanup = contribute({
    registerSettings: () => ({ read: async () => ({ status: 'ready', values: { cwd: join(directory, 'workspace'), provider: 'synthetic/model' } }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    addHook: () => () => {},
  } as unknown as PluginServerContext);
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name)!;
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  }
  try {
    await invoke('bots.list', {});
    await invoke('bots.create', { id: 'helper', name: '资料同事', role: '核对资料' });
    const chief = await invoke('bots.configuration.defaults', { botId: 'chief' }) as { cwd: string };
    const helper = await invoke('bots.configuration.defaults', { botId: 'helper' }) as { cwd: string };
    assert.equal(chief.cwd, join(directory, 'v2', 'workspace', 'chief'));
    assert.equal(helper.cwd, join(directory, 'v2', 'workspace', 'helper'));
    assert.equal((await stat(chief.cwd)).isDirectory(), true);
    assert.equal((await stat(helper.cwd)).isDirectory(), true);
    await invoke('bots.conversation.create', { botId: 'chief' });
    assert.equal(created[0].cwd, chief.cwd);
    await invoke('bots.update', { botId: 'helper', patch: { execution: { cwd: join(directory, 'chosen-project') } } });
    await invoke('bots.start', { botId: 'helper', title: '合成子事项', prompt: '仅合成核对' });
    assert.equal(created[1].cwd, join(directory, 'chosen-project'));
    delete process.env.PASEO_HOME;
    await invoke('bots.start', { botId: 'helper', title: '另一合成子事项', prompt: '仅合成核对' });
    assert.equal(created[2].cwd, join(directory, 'chosen-project'), '显式 Bot 工作目录不依赖托管目录或 home 设置');
    assert.deepEqual(await invoke('bots.configuration.defaults', {}), { cwd: join(directory, 'v2', 'workspace', 'chief') });
    await assert.rejects(() => invoke('bots.configuration.defaults', { botId: '../escape' }), /botId|invalid/);
  } finally {
    await cleanup();
    if (previous.data === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous.data;
    if (previous.home === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous.home;
    await rm(directory, { recursive: true, force: true });
  }
});
