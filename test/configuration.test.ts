import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi } from '@getpaseo/client';
import ts from 'typescript';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';

test('配置选择读取宿主目录和技能，只导入明确选择的 MCP，不向目录传递凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-configuration-'));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: 'invalid', error: '未配置' }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    on: () => () => {}, before: () => () => {},
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  async function invoke(name: string, input: unknown) {
    const entry = handlers.get(name);
    assert.ok(entry, `RPC ${name} must be registered`);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo: {} as PaseoApi }));
  }
  try {
    await mkdir(join(directory, 'b-skill'));
    await mkdir(join(directory, 'a-folder'));
    const skillPath = join(directory, 'b-skill', 'SKILL.md');
    await writeFile(skillPath, '---\nname: "数字核对"\ndescription: 核对合成数字\n---\n不要把技能正文传给选择器。');
    const mcpPath = join(directory, '.mcp.json');
    await writeFile(mcpPath, JSON.stringify({ mcpServers: {
      chosen: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'SYNTHETIC-SECRET' } },
      other: { command: 'synthetic-tool', args: ['--read-only'] },
    } }));
    await writeFile(join(directory, 'ordinary.txt'), '不读取普通文件');
    const listing = await invoke('bots.directory.list', { path: directory, kind: 'skill' }) as { path: string; parent: string | null; entries: { name: string; kind: string }[] };
    assert.equal(listing.path, directory);
    assert.deepEqual(listing.entries.map(entry => entry.name), ['a-folder', 'b-skill']);
    assert.ok(listing.parent);
    const inside = await invoke('bots.directory.list', { path: join(directory, 'b-skill'), kind: 'skill' }) as { entries: { name: string; kind: string }[] };
    assert.deepEqual(inside.entries, [{ name: 'SKILL.md', path: skillPath, kind: 'file' }]);
    assert.deepEqual(await invoke('bots.skill.inspect', { path: skillPath }), { name: '数字核对', description: '核对合成数字', path: skillPath });
    assert.deepEqual(await invoke('bots.mcp.inspect', { path: mcpPath }), { names: ['chosen', 'other'] });
    await assert.rejects(() => invoke('bots.directory.list', { path: 'relative', kind: 'directory' }), /绝对路径/);
    await assert.rejects(() => invoke('bots.skill.inspect', { path: join(directory, 'ordinary.txt') }), /SKILL.md/);
    const created = await invoke('bots.create', { name: '核对同事', role: '核对结果' }) as { id: string };
    assert.match(created.id, /^bot-[a-f0-9-]+$/);
    const store = new BotStore({ baseDir: directory });
    await store.updateBot(created.id, { capabilities: { skills: [], mcpServers: { existing: { type: 'stdio', command: 'existing' } } } });
    await invoke('bots.update', { botId: created.id, patch: { capabilities: { skills: [{ name: '数字核对', description: '核对合成数字', path: skillPath }], mcpServers: { existing: { type: 'stdio', command: 'existing' } } } }, mcpImports: [{ path: mcpPath, names: ['chosen'] }] });
    const saved = (await store.getBot(created.id))!.bot.capabilities;
    assert.deepEqual(Object.keys(saved.mcpServers), ['existing', 'chosen']);
    assert.deepEqual(saved.mcpServers.chosen, { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'SYNTHETIC-SECRET' } });
    assert.equal(saved.skills[0].path, skillPath);
    await assert.rejects(() => invoke('bots.update', { botId: created.id, patch: { name: '修改' }, mcpImports: [{ path: mcpPath, names: ['missing'] }] }), /未找到/);
    assert.equal((await store.getBot(created.id))!.bot.name, '核对同事', '导入失败不能部分保存其他字段');
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { paseo: { command: 'forbidden' } } }));
    await assert.rejects(() => invoke('bots.mcp.inspect', { path: mcpPath }), /MCP/);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
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
