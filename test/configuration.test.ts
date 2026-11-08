import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { PaseoApi } from '@getpaseo/client';
import ts from 'typescript';
import contribute from '../index.server.js';
import { BotStore } from '../server/store.js';
import { mcpNameSchema, mcpServerSchema } from '../shared/capabilities.js';

test('配置选择读取宿主目录和技能，只导入明确选择的 MCP，不向目录传递凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-configuration-'));
  const previous = process.env.OH_MY_PASEO_BOTS_DATA_DIR;
  process.env.OH_MY_PASEO_BOTS_DATA_DIR = directory;
  const handlers = new Map<string, { contract: PluginRpcContract; handler(input: unknown, context: unknown): unknown }>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: 'invalid', error: '未配置' }) }),
    handle: (contract: PluginRpcContract, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, { contract, handler }),
    addHook: () => () => {},
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
    await writeFile(mcpPath, JSON.stringify({ mcpServers: {
      chosen: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'SYNTHETIC-NEW-SECRET' } },
      other: { command: 'synthetic-tool', args: ['--read-only'] },
    } }));
    await invoke('bots.update', { botId: created.id, patch: { capabilities: { skills: [{ name: '数字核对', description: '核对合成数字', path: skillPath }], mcpServers: { existing: { type: 'stdio', command: 'existing' } }, disabledMcpServers: ['chosen'] } }, mcpImports: [{ path: mcpPath, names: ['chosen'] }] });
    const saved = (await store.getBot(created.id))!.bot.capabilities;
    assert.deepEqual(Object.keys(saved.mcpServers), ['existing', 'chosen']);
    assert.deepEqual(saved.mcpServers.chosen, { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'SYNTHETIC-NEW-SECRET' } }, '保存时读取当前配置，不沿用预览时的凭据');
    assert.deepEqual(saved.disabledMcpServers, [], '明确导入启用所选名称');
    assert.equal(saved.skills[0].path, skillPath);
    await assert.rejects(() => invoke('bots.update', { botId: created.id, patch: { name: '修改' }, mcpImports: [{ path: mcpPath, names: ['missing'] }] }), /未找到/);
    assert.equal((await store.getBot(created.id))!.bot.name, '核对同事', '导入失败不能部分保存其他字段');
    const { CapabilityGuidance } = await import('../server/capability-guidance.js');
    const plan = await new CapabilityGuidance(store).configure(created.id, 'synthetic-chief-agent', { requestId: 'setup', summary: '用户核对已有连接', skills: [skillPath], mcpImports: [{ path: mcpPath, names: ['chosen'] }] });
    const preview = await invoke('bots.capabilities.inspect', { botId: created.id }) as { request: { state: string } };
    assert.equal(preview.request.state, 'applied', '已绑定且启用的相同连接和普通技能配置无需二次确认'); assert.doesNotMatch(JSON.stringify(preview), /SYNTHETIC-NEW-SECRET|Authorization/);
    assert.equal((await invoke('bots.capabilities.decide', { botId: created.id, requestId: plan.id, decision: 'apply' }) as { state: string }).state, 'applied');
    const list = await invoke('bots.list', {}) as { bots: { id: string; capabilityRequest?: { fingerprint?: string; state: string } }[] };
    assert.equal(list.bots.find(bot => bot.id === created.id)!.capabilityRequest!.state, 'applied');
    assert.equal(list.bots.find(bot => bot.id === created.id)!.capabilityRequest!.fingerprint, undefined, '用户列表只返回公开方案字段');
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

test('连接导入发现本机常见配置和当前项目，只返回名称，单个损坏来源不遮住其他连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-connections-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const home = join(directory, 'home');
  const appData = join(directory, 'roaming');
  const cwd = join(directory, 'project');
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    await mkdir(join(appData, 'Claude'), { recursive: true });
    await mkdir(cwd);
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
      github: { type: 'http', url: 'https://example.test/github', headers: { Authorization: 'SYNTHETIC-GITHUB-SECRET' } },
      notion: { command: 'synthetic-notion', env: { NOTION_TOKEN: 'SYNTHETIC-NOTION-SECRET' } },
    } }));
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { browser: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } }));
    await writeFile(join(appData, 'Claude', 'claude_desktop_config.json'), '{invalid');
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { calendar: { type: 'http', url: 'https://example.test/calendar' } } }));
    const files = await import(new URL('../server/files.js', import.meta.url).href);
    const { sources } = await files.discoverMcpSources({ home, appData, cwd, platform: 'win32' });
    assert.deepEqual(sources.filter((source: { error?: string }) => !source.error).map((source: { label: string; names: string[] }) => [source.label, source.names]), [
      ['当前项目', ['calendar']], ['Claude Code', ['github', 'notion']], ['Cursor', ['browser']],
    ]);
    assert.match(sources.find((source: { label: string }) => source.label === 'Claude Desktop').error, /JSON/);
    assert.doesNotMatch(JSON.stringify(sources), /SYNTHETIC-|Authorization|NOTION_TOKEN|example\.test/);
    assert.deepEqual(await files.discoverMcpSources({ home: join(directory, 'missing'), appData: join(directory, 'missing'), platform: 'win32' }), { sources: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('添加连接提交三种原生 transport，命令参数不经 shell 解释，错误配置不进入选择列表', async () => {
  const source = ts.createSourceFile('connections.tsx', await readFile(new URL('../../client/connections.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      if (attributes.find(attribute => attribute.name.getText(source) === 'label')?.initializer?.getText(source) === '"添加"') {
        const action = attributes.find(attribute => attribute.name.getText(source) === 'onPress')?.initializer;
        if (action && ts.isJsxExpression(action) && action.expression) callback = action.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const submit = new Function('name', 'type', 'url', 'command', 'args', 'variables', 'existing', 'setError', 'add', 'mcpNameSchema', 'mcpServerSchema', ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  let error = '';
  const added: unknown[] = [];
  for (const type of ['http', 'sse', 'stdio']) {
    submit('synthetic', type, 'https://example.test/mcp', 'D:/tools/synthetic tool.exe', '--path\nD:/a folder\n$(not-executed)', [{ name: type === 'stdio' ? 'TOKEN' : 'Authorization', value: 'SYNTHETIC-SECRET' }], [],
      (value: string) => { error = value; }, (name: string, config: unknown) => { added.push({ name, config }); }, mcpNameSchema, mcpServerSchema)();
  }
  assert.deepEqual(added, [
    ...['http', 'sse'].map(type => ({ name: 'synthetic', config: { type, url: 'https://example.test/mcp', headers: { Authorization: 'SYNTHETIC-SECRET' } } })),
    { name: 'synthetic', config: { type: 'stdio', command: 'D:/tools/synthetic tool.exe', args: ['--path', 'D:/a folder', '$(not-executed)'], env: { TOKEN: 'SYNTHETIC-SECRET' } } },
  ]);
  assert.equal(error, '');
  for (const [name, url, existing] of [['paseo', 'https://example.test/mcp', []], ['same-name', 'https://example.test/mcp', ['same-name']], ['valid', 'not-a-url', []]] as const) {
    submit(name, 'http', url, '', '', [], existing, (value: string) => { error = value; }, () => assert.fail('错误配置不能添加'), mcpNameSchema, mcpServerSchema)();
    assert.ok(error);
  }
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
    assert.equal(chief.cwd, join(home, 'oh-my-paseo-bots', 'workspaces', 'chief'));
    assert.equal(helper.cwd, join(home, 'oh-my-paseo-bots', 'workspaces', 'helper'));
    assert.equal((await stat(chief.cwd)).isDirectory(), true);
    assert.equal((await stat(helper.cwd)).isDirectory(), true);
    await invoke('bots.conversation.create', { botId: 'chief' });
    assert.equal(created[0].cwd, chief.cwd);
    await invoke('bots.update', { botId: 'helper', patch: { execution: { cwd: join(directory, 'chosen-project') } } });
    await invoke('bots.conversation.create', { botId: 'helper' });
    assert.equal(created[1].cwd, join(directory, 'chosen-project'));
    delete process.env.PASEO_HOME;
    await invoke('bots.conversation.create', { botId: 'helper' });
    assert.equal(created[2].cwd, join(directory, 'chosen-project'), '显式 Bot 工作目录不依赖托管目录或 home 设置');
    assert.deepEqual(await invoke('bots.configuration.defaults', {}), { cwd: join(directory, 'workspace') });
    await assert.rejects(() => invoke('bots.configuration.defaults', { botId: '../escape' }), /botId|invalid/);
  } finally {
    await cleanup();
    if (previous.data === undefined) delete process.env.OH_MY_PASEO_BOTS_DATA_DIR; else process.env.OH_MY_PASEO_BOTS_DATA_DIR = previous.data;
    if (previous.home === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous.home;
    await rm(directory, { recursive: true, force: true });
  }
});
