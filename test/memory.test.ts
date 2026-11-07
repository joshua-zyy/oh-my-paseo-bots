import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaseoApi } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { rememberExplicit, correctExplicitMemory, forgetExplicitMemory } from '../server/memory.js';
import ts from 'typescript';

test('记忆页编辑保留确认状态，只有明确确认候选才进入上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-memory-edit-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    const source = ts.createSourceFile('memories.tsx', await readFile(new URL('../../client/memories.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const label = attributes.find(item => item.name.getText(source) === 'label')?.initializer;
        const press = attributes.find(item => item.name.getText(source) === 'onPress')?.initializer;
        if (label && ts.isStringLiteral(label) && press && ts.isJsxExpression(press) && press.expression) callbacks.set(label.text, press.expression.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const label of ['编辑', '保存记忆', '确认']) assert.ok(callbacks.has(label));
    const correct = ({ memoryId, ...input }: { memoryId: string; content: string; kind: 'candidate' | 'confirmed' }) => store.updateMemory('chief', memoryId, input);
    let pending: Promise<unknown> = Promise.resolve();
    const run = (action: () => Promise<unknown>) => { pending = action(); return pending; };
    for (const kind of ['candidate', 'confirmed'] as const) {
      const entry = await store.addMemory('chief', { kind, content: `${kind} 旧内容` });
      let editing: { id?: string; content: string; kind: 'candidate' | 'confirmed' } | undefined;
      const setEditing = (value: typeof editing) => { editing = value; };
      new Function('entry', 'setEditing', `return (${callbacks.get('编辑')});`)(entry, setEditing)();
      assert.ok(editing);
      editing.content = `${kind} 新内容`;
      new Function('run', 'correct', 'save', 'setEditing', 'editing', 'botId', `const channelId = undefined; return (${callbacks.get('保存记忆')});`)(run, correct, () => assert.fail('编辑不创建新记忆'), setEditing, editing, 'chief')();
      await pending;
      const saved = (await store.listMemories('chief')).find(item => item.id === entry.id)!;
      assert.equal(saved.kind, kind);
      assert.equal(saved.content, `${kind} 新内容`);
      assert.equal((await store.getContextMemories('chief')).some(item => item.id === entry.id), kind === 'confirmed');
      if (kind === 'candidate') {
        new Function('run', 'correct', 'entry', 'botId', `const channelId = undefined; return (${callbacks.get('确认')});`)(run, correct, saved, 'chief')();
        await pending;
        assert.ok((await store.getContextMemories('chief')).some(item => item.id === entry.id));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('记忆页遗忘、拒绝、恢复和来源按钮调用实际条目，归档分组不混入活跃记忆', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-memory-actions-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.ensureChief();
    const source = ts.createSourceFile('memories.tsx', await readFile(new URL('../../client/memories.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map<string, string>();
    let groups = '';
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'groups') groups = node.initializer!.getText(source);
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const label = attributes.find(item => item.name.getText(source) === 'label')?.initializer;
        const press = attributes.find(item => item.name.getText(source) === 'onPress')?.initializer;
        if (label && press && ts.isJsxExpression(press) && press.expression) callbacks.set(ts.isStringLiteral(label) ? label.text : '归档操作', press.expression.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const label of ['归档操作', '恢复', '打开来源会话']) assert.ok(callbacks.has(label));
    let pending: Promise<unknown> = Promise.resolve();
    const run = (action: () => Promise<unknown>) => { pending = action(); return pending; };
    const forget = ({ botId, memoryId }: { botId: string; memoryId: string }) => store.removeMemory(botId, memoryId);
    const restore = ({ botId, memoryId }: { botId: string; memoryId: string }) => store.restoreMemory(botId, memoryId);
    for (const kind of ['confirmed', 'candidate'] as const) {
      const entry = await store.addMemory('chief', { content: `合成 ${kind}`, kind });
      new Function('run', 'forget', 'botId', 'entry', `const channelId = undefined; return (${callbacks.get('归档操作')});`)(run, forget, 'chief', entry)();
      await pending;
      assert.deepEqual(await store.getContextMemories('chief'), []);
      const entries = await store.listMemories('chief', { includeArchived: true });
      const select = new Function('entries', 'showArchived', `return (${groups});`);
      assert.ok(select(entries, false).every((group: { items: unknown[] }) => group.items.length === 0));
      assert.ok(select(entries, true).find((group: { key: string }) => group.key === 'archived').items.some((item: { id: string }) => item.id === entry.id));
      new Function('run', 'restore', 'botId', 'entry', `const channelId = undefined; return (${callbacks.get('恢复')});`)(run, restore, 'chief', entry)();
      await pending;
      assert.equal((await store.listMemories('chief'))[0].kind, kind);
      assert.equal((await store.getContextMemories('chief')).length, kind === 'confirmed' ? 1 : 0);
      await store.removeMemory('chief', entry.id);
    }
    const opened: string[] = [];
    new Function('origin', 'openAgent', `return (${callbacks.get('打开来源会话')});`)({ type: 'message', agentId: 'source-agent' }, (id: string) => opened.push(id))();
    assert.deepEqual(opened, ['source-agent']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('群记忆页初次读取使用频道作用域，私聊入口继续使用个人作用域', async () => {
  const source = ts.createSourceFile('memories.tsx', await readFile(new URL('../../client/memories.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect = '';
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effect = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(effect);
  for (const channelId of [undefined, 'df36bb2c-837d-4051-8a6b-4ae1e07b6041']) {
    const calls: unknown[] = [];
    const mount = new Function('list', 'botId', 'channelId', 'setEntries', 'setError', `return (${effect});`)(async (input: unknown) => { calls.push(input); return []; }, 'chief', channelId, () => {}, (error: unknown) => assert.fail(String(error)));
    const cleanup = mount(); await new Promise(resolve => setImmediate(resolve)); cleanup();
    assert.deepEqual(calls, [{ botId: 'chief', ...(channelId ? { channelId } : {}), includeArchived: true }]);
  }
});

test('明确记忆回查跨页原生用户依据，伪造依据与跨Bot会话被拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-memory-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行任务' });
    await store.linkSession('chief', { sessionId: 'native-chief' });
    let calls = 0;
    const api = { agents: { ref: () => ({ timeline: { refetch: async (options: { direction: string }) => {
      calls++;
      return { error: null, epoch: 'epoch-1', staleCursor: false, gap: false, hasOlder: options.direction === 'tail', startCursor: { epoch: 'epoch-1', seq: 101 }, entries: options.direction === 'tail' ? [{ item: { type: 'assistant_message', text: '工作中' } }] : [{ item: { type: 'user_message', text: '请记住：默认使用中文。' } }] };
    } } }) } } as unknown as PaseoApi;
    const memory = await rememberExplicit(store, api, 'chief', 'native-chief', { content: '默认使用中文', userQuote: '请记住：默认使用中文。' });
    assert.equal(memory.kind, 'confirmed');
    assert.equal(calls, 2);
    await assert.rejects(() => rememberExplicit(store, api, 'chief', 'native-chief', { content: '凭空推断用户偏好', userQuote: '请记住：默认使用中文。' }), /记忆内容不在原生用户消息中/);
    await assert.rejects(() => rememberExplicit(store, api, 'chief', 'native-chief', { content: '推断偏好', userQuote: '用户没说过的内容' }), /依据与最新原生用户消息不符/);
    await assert.rejects(() => rememberExplicit(store, api, 'expert', 'native-chief', { content: '不得越Bot保存', userQuote: '请记住：默认使用中文。' }), /未关联到此 Bot/);
    assert.equal((await store.listMemories('chief')).length, 1);
    assert.deepEqual(await store.listMemories('expert'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('对话纠正和遗忘核对完整当前消息、旧值和Bot归属，候选不自动确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-correction-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行任务' });
    await store.linkSession('chief', { sessionId: 'native-chief' });
    const memory = await store.addMemory('chief', { content: '默认中文', kind: 'confirmed' });
    const candidate = await store.addMemory('chief', { content: '可能喜欢英文', kind: 'candidate' });
    let message = '请纠正长期记忆：默认英文。';
    const api = { agents: { ref: () => ({ timeline: { refetch: async () => ({ error: null, epoch: 'e1', staleCursor: false, gap: false, hasOlder: false, entries: [{ item: { type: 'user_message', text: message } }] }) } }) } } as unknown as PaseoApi;
    const input = { memoryId: memory.id, currentContent: memory.content, userQuote: message, content: '默认英文' };
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, userQuote: '纠正长期记忆' }), /完整用户消息/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, userQuote: '旧消息' }), /最新原生用户消息不符/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', { ...input, content: candidate.content }), /逐字来自用户/);
    await assert.rejects(() => correctExplicitMemory(store, api, 'expert', 'native-chief', input), /未关联到此 Bot/);
    const corrected = await correctExplicitMemory(store, api, 'chief', 'native-chief', input);
    assert.equal(corrected.id, memory.id);
    assert.equal(corrected.content, '默认英文');
    assert.deepEqual((await new BotStore({ baseDir: directory }).getContextMemories('chief')).map(item => item.content), ['默认英文']);
    await assert.rejects(() => correctExplicitMemory(store, api, 'chief', 'native-chief', input), /记忆已改变/);
    message = '请遗忘默认英文这条长期记忆。';
    const forget = { memoryId: memory.id, currentContent: corrected.content, userQuote: message };
    await assert.rejects(() => forgetExplicitMemory(store, api, 'chief', 'native-chief', { ...forget, currentContent: memory.content }), /记忆已改变/);
    await assert.rejects(() => forgetExplicitMemory(store, api, 'chief', 'native-chief', { ...forget, userQuote: input.userQuote }), /最新原生用户消息不符/);
    assert.equal((await forgetExplicitMemory(store, api, 'chief', 'native-chief', forget)).removed, true);
    assert.deepEqual(await store.getContextMemories('chief'), []);
    assert.equal((await store.listMemories('chief'))[0].kind, 'candidate');
    assert.equal(message, forget.userQuote, '遗忘未改写原生历史');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('原子旧值校验让并发纠正只能成功一次，既有UI更新与幂等删除合同保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-guys-cas-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '负责交付' });
    const memory = await store.addMemory('chief', { content: '旧值', kind: 'confirmed' });
    const results = await Promise.allSettled(['新值一', '新值二'].map(content => store.updateMemory('chief', memory.id, { content }, '旧值')));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected').length, 1);
    await store.updateMemory('chief', memory.id, { content: 'UI纠正' });
    assert.equal(await store.removeMemory('chief', memory.id), true);
    assert.equal(await store.removeMemory('chief', memory.id), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
