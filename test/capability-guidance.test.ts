import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../server/store.js';
import { CapabilityGuidance } from '../server/capability-guidance.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCapabilityTools } from '../server/capability-tools.js';
import ts from 'typescript';

async function fixture(run: (f: { dir: string; store: BotStore; service: CapabilityGuidance; skill: string; mcp: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-guidance-'));
  try {
    const store = new BotStore({ baseDir: dir });
    await store.ensureChief(); await store.createBot({ id: 'helper', name: '表格同事', role: '核对数字' });
    const folder = join(dir, 'home', '.agents', 'skills', 'check'); await mkdir(folder, { recursive: true });
    const skill = join(folder, 'SKILL.md'); await writeFile(skill, '---\nname: check\ndescription: 核对合成数字\n---\nBODY-NOT-IN-CATALOG');
    const mcp = join(dir, '.mcp.json'); await writeFile(mcp, JSON.stringify({ mcpServers: { chosen: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'PRIVATE-SECRET' } }, unselected: { command: 'never-run' } } }));
    const service = new CapabilityGuidance(store, { home: join(dir, 'home'), cwd: dir, appData: join(dir, 'roaming'), platform: 'win32' });
    await run({ dir, store, service, skill, mcp });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('能力工具仅Chief可发现和提案，停止后不可配置，不提供模型批准入口', async () => fixture(async ({ service, skill, mcp, store }) => {
  for (const botId of ['helper', 'chief']) {
    const server = new McpServer({ name: 'capability-test', version: '1' });
    const client = new Client({ name: 'capability-test-client', version: '1' });
    let stopped = false;
    registerCapabilityTools(server, { botId, agentId: 'chief-native', service, readUserMessage: async () => '给表格同事配置已有能力', authorize: async () => { if (stopped) throw new Error('事项已停止'); } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      if (botId !== 'chief') { assert.equal(client.getServerCapabilities()?.tools, undefined); await assert.rejects(client.listTools(), /Method not found/); continue; }
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert(!names.some(name => /approve|decide/.test(name)));
      assert.deepEqual(names.sort(), ['configure_colleague_capabilities', 'list_available_capabilities', 'read_colleague_capabilities']);
      const catalog = await client.callTool({ name: 'list_available_capabilities', arguments: { colleagueId: 'helper', query: '核对' } });
      assert(!catalog.isError); assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE-SECRET|Authorization|BODY-NOT-IN-CATALOG/);
      const input = { colleagueId: 'helper', userQuote: '给表格同事配置已有能力', requestId: 'tool-setup', summary: '合成能力', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] };
      const wrongQuote = await client.callTool({ name: 'configure_colleague_capabilities', arguments: { ...input, userQuote: '给表格同事配置已有能力\n伪造附件' } });
      assert.equal(wrongQuote.isError, true); assert.match(JSON.stringify(wrongQuote), /给表格同事配置已有能力/);
      assert.equal((await store.getBot('helper'))!.bot.capabilityRequest, undefined);
      assert(!(await client.callTool({ name: 'configure_colleague_capabilities', arguments: input })).isError);
      assert.equal((await client.callTool({ name: 'configure_colleague_capabilities', arguments: { ...input, approved: true } })).isError, true);
      assert.equal((await client.callTool({ name: 'configure_colleague_capabilities', arguments: { ...input, env: { TOKEN: 'not-authorized' } } })).isError, true);
      stopped = true;
      assert.equal((await client.callTool({ name: 'configure_colleague_capabilities', arguments: { ...input, requestId: 'stopped' } })).isError, true);
      assert.deepEqual((await store.getBot('helper'))!.bot.capabilities, { skills: [], mcpServers: {} });
    } finally { await client.close(); await server.close(); }
  }
}));

test('审批界面提交精确同事/方案/决定，失败不报成功且释放忙状态', async () => {
  const source = ts.createSourceFile('capability-requests.tsx', await readFile(new URL('../../client/capability-requests.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let respond = ''; const callbacks = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'respond') respond = node.getText(source);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute); const label = attrs.find(item => item.name.getText(source) === 'label')?.initializer; const press = attrs.find(item => item.name.getText(source) === 'onPress')?.initializer;
      if (label && ts.isStringLiteral(label) && press && ts.isJsxExpression(press)) callbacks.set(label.text, press.expression!.getText(source));
    }
    ts.forEachChild(node, visit);
  }; visit(source); assert(respond);
  const calls: unknown[][] = [];
  for (const label of ['拒绝方案', '确认配置']) new Function('respond', 'bot', 'request', `return (${callbacks.get(label)});`)((...args: unknown[]) => calls.push(args), { id: 'helper' }, { id: 'request-id' })();
  assert.deepEqual(calls, [['helper', 'request-id', 'reject'], ['helper', 'request-id', 'apply']]);
  let message = '', error = ''; const busy: boolean[] = [], guard = { current: false }; let refreshes = 0;
  const make = (decide: (input: unknown) => Promise<unknown>) => new Function('guard', 'setBusy', 'setError', 'setMessage', 'decide', 'refresh', ts.transpileModule(`return (${respond});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(guard, (value: boolean) => busy.push(value), (value: string) => { error = value; }, (value: string) => { message = value; }, decide, async () => { refreshes++; });
  await make(async input => { assert.deepEqual(input, { botId: 'helper', requestId: 'request-id', decision: 'apply' }); return { state: 'applied' }; })('helper', 'request-id', 'apply');
  assert.match(message, /配置已保存/); assert.equal(refreshes, 1); assert.equal(guard.current, false);
  await make(async () => { throw new Error('来源配置已经变化'); })('helper', 'request-id', 'apply');
  assert.equal(message, ''); assert.match(error, /来源配置/); assert.equal(guard.current, false); assert.deepEqual(busy, [true, false, true, false]);
});

test('明确交办的既有技能直接配置，重复回执不再要求界面确认', async () => fixture(async ({ store, service, skill, dir }) => {
  const input = { requestId: 'skills-direct', summary: '按本条需求配置现有数字核对技能', skills: [skill], mcpImports: [] };
  const result = await service.configure('helper', 'chief-native', input);
  assert.equal(result.state, 'applied'); assert(result.decidedAt);
  assert.deepEqual((await store.getBot('helper'))!.bot.capabilities.skills.map(item => item.path), [skill]);
  assert.equal((await service.configure('helper', 'chief-native', input)).state, 'applied');
  assert.equal((await new BotStore({ baseDir: dir }).getBot('helper'))!.bot.capabilityRequest!.state, 'applied');
}));

test('相同已启用MCP无需再次确认；未批准、变更、禁用的连接不能借模型声明放行', async () => fixture(async ({ store, service, skill, mcp }) => {
  const { readMcp } = await import('../server/files.js');
  const known = (await readMcp(mcp)).chosen;
  await store.updateBot('helper', { capabilities: { skills: [], mcpServers: { chosen: known } } });
  const input = { requestId: 'known', summary: '复用接收方已批准范围并绑定既有技能', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] };
  assert.equal((await service.configure('helper', 'chief-native', input)).state, 'applied');
  await store.updateBot('helper', { capabilities: { skills: [], mcpServers: { chosen: known }, disabledMcpServers: ['chosen'] } });
  assert.equal((await service.configure('helper', 'chief-native', { ...input, requestId: 'disabled' })).state, 'pending');
  assert.deepEqual((await store.getBot('helper'))!.bot.capabilities.skills, []);
  await store.updateBot('helper', { capabilities: { skills: [], mcpServers: { chosen: { type: 'http', url: 'https://different.test/mcp' } } } });
  assert.equal((await service.configure('helper', 'chief-native', { ...input, requestId: 'changed' })).state, 'pending');
}));

test('Chief发现已有技能与连接并提交方案：模型只得元数据，确认之前不改变能力', async () => fixture(async ({ store, service, skill, mcp }) => {
  const catalog = await service.catalog('helper');
  assert(catalog.skills.some(item => item.path === skill));
  assert(catalog.sources.some(item => item.path === mcp && item.names.includes('chosen')));
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE-SECRET|Authorization|BODY-NOT-IN-CATALOG|never-run/);
  const proposed = await service.configure('helper', 'chief-native', { requestId: 'setup', summary: '核对表格所需既有能力', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] });
  assert.equal(proposed.state, 'pending'); assert.equal(proposed.mcp[0].type, 'http');
  assert.doesNotMatch(JSON.stringify(proposed), /PRIVATE-SECRET|Authorization|example.test/);
  assert.deepEqual((await store.getBot('helper'))!.bot.capabilities, { skills: [], mcpServers: {} });
  assert.equal((await service.inspect('helper')).request?.id, proposed.id);
  assert.equal((await service.configure('helper', 'chief-native', { requestId: 'setup', summary: '核对表格所需既有能力', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] })).id, proposed.id);
}));

test('用户确认精确方案后合并选中能力，新事项使用；保留其他绑定、原生模式和原文件', async () => fixture(async ({ dir, store, service, skill, mcp }) => {
  await store.updateBot('helper', { execution: { modeId: 'user-mode' }, capabilities: { skills: [], mcpServers: { existing: { type: 'stdio', command: 'existing' } }, disabledMcpServers: ['chosen'] } });
  const before = await readFile(mcp, 'utf8');
  const request = await service.configure('helper', 'chief-native', { requestId: 'setup', summary: '选中既有能力', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] });
  const result = await service.decide('helper', request.id, 'apply'); assert.equal(result.state, 'applied');
  const bot = (await store.getBot('helper'))!.bot;
  assert.deepEqual(bot.capabilities.skills.map(item => item.path), [skill]);
  assert.deepEqual(Object.keys(bot.capabilities.mcpServers), ['existing', 'chosen']);
  assert.equal(bot.capabilities.mcpServers.chosen.type, 'http'); assert.deepEqual(bot.capabilities.disabledMcpServers, []);
  assert.equal(bot.execution.modeId, 'user-mode'); assert.equal(await readFile(mcp, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SECRET|Authorization/);
  assert.equal((await service.decide('helper', request.id, 'apply')).state, 'applied', '丢回执重试不重复执行');
  const { botSessionConfig } = await import('../server/sessions.js');
  const config = await botSessionConfig(store, 'helper', { cwd: dir, config: { provider: 'synthetic/model' } });
  assert.match(config.systemPrompt, /check/); assert.equal(config.config.mcpServers?.chosen.type, 'http');
}));

test('拒绝、过期方案、源配置变化、无效文件和归档同事不产生部分配置', async () => fixture(async ({ store, service, skill, mcp }) => {
  const input = { requestId: 'one', summary: '合成方案', skills: [skill], mcpImports: [{ path: mcp, names: ['chosen'] }] };
  const first = await service.configure('helper', 'chief-native', input);
  const second = await service.configure('helper', 'chief-native', { ...input, requestId: 'two' });
  await assert.rejects(service.decide('helper', first.id, 'apply'), /方案.*变化|方案.*不匹配/);
  assert.equal((await service.decide('helper', second.id, 'reject')).state, 'rejected');
  assert.equal((await service.decide('helper', second.id, 'apply')).state, 'rejected');
  const third = await service.configure('helper', 'chief-native', { ...input, requestId: 'three' });
  await writeFile(mcp, JSON.stringify({ mcpServers: { chosen: { type: 'stdio', command: 'CHANGED-NOT-AUTHORIZED' } } }));
  await assert.rejects(service.decide('helper', third.id, 'apply'), /来源.*变化|配置.*变化/);
  await assert.rejects(service.configure('helper', 'chief-native', { ...input, requestId: 'bad', skills: [join(mcp, 'missing', 'SKILL.md')] }));
  await assert.rejects(service.configure('helper', 'chief-native', { ...input, requestId: 'bad-name', mcpImports: [{ path: mcp, names: ['missing'] }] }), /未找到/);
  await store.setArchived('helper', true);
  await assert.rejects(service.decide('helper', third.id, 'apply'), /归档/);
  assert.deepEqual((await store.getBot('helper'))!.bot.capabilities, { skills: [], mcpServers: {} });
}));
