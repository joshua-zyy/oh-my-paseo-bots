import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BotStore, StoreError } from '../server/store.js';
import { botCapabilitiesSchema } from '../shared/capabilities.js';

const createdDirs: string[] = [];

async function makeStore(): Promise<{ baseDir: string; store: BotStore }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'paseo-guys-store-'));
  createdDirs.push(baseDir);
  return { baseDir, store: new BotStore({ baseDir }) };
}

function assertStoreError(error: unknown, code: string): void {
  assert.ok(error instanceof StoreError, `期望 StoreError，实际为 ${String(error)}`);
  assert.equal((error as StoreError).code, code);
}

after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('固定 Bot 身份', () => {
  it('首次并发打开只建立一个 Chief，重连不改已有名称、说明、配置或存档', async () => {
    const { baseDir, store } = await makeStore();
    const created = await Promise.all([store.ensureChief(), store.ensureChief(), store.ensureChief()]);
    assert.deepEqual(created.map(bot => bot.id), ['chief', 'chief', 'chief']);
    assert.equal((await store.listBots()).length, 1);
    await store.updateBot('chief', { name: '我的协调同事', instructions: '保留工作方式', execution: { provider: 'known/model' } });
    const file = path.join(baseDir, 'chief.json');
    const before = await readFile(file, 'utf8');
    assert.equal((await new BotStore({ baseDir }).ensureChief()).name, '我的协调同事');
    assert.equal(await readFile(file, 'utf8'), before);
    await writeFile(file, '{broken');
    await assert.rejects(() => store.ensureChief(), (error: unknown) => error instanceof StoreError && error.code === 'corrupt_store');
    assert.equal(await readFile(file, 'utf8'), '{broken', '损坏不是缺失，不覆盖重建');
  });

  it('身份写入后可被新实例读回（模拟重启）', async () => {
    const { baseDir, store } = await makeStore();
    const created = await store.createBot({ id: 'chief', name: '主 Bot', role: '负责澄清与分工' });

    assert.equal(created.schemaVersion, 1);
    assert.equal(created.bot.id, 'chief');
    assert.equal(created.bot.name, '主 Bot');
    assert.equal(created.bot.role, '负责澄清与分工');
    assert.match(created.bot.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(created.sessions, []);
    assert.deepEqual(created.memories, []);

    const restarted = new BotStore({ baseDir });
    const reloaded = await restarted.getBot('chief');
    assert.deepEqual(reloaded, created);
  });

  it('未知 Bot 返回 null，重复创建报 bot_exists', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getBot('missing'), null);

    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await assert.rejects(
      () => store.createBot({ id: 'chief', name: '别的名字', role: '别的角色' }),
      (error: unknown) => {
        assertStoreError(error, 'bot_exists');
        return true;
      },
    );
    // 失败不覆盖已有身份
    const current = await store.getBot('chief');
    assert.equal(current?.bot.name, '主 Bot');
  });

  it('listBots 只列出有效 Bot 文件', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await store.createBot({ id: 'writer', name: '写作专家', role: '写文档' });
    await writeFile(path.join(baseDir, 'notes.txt'), 'ignored', 'utf8');

    const bots = await store.listBots();
    assert.deepEqual(
      bots.map((bot) => bot.id),
      ['chief', 'writer'],
    );
  });
  it('辅助Gmail和团队记忆文件不作为Bot枚举或损坏身份，不能由Bot写入覆盖', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    const auxiliary = {
      'gmail-checks': JSON.stringify({ version: 1, checks: [] }),
      'team-memories': JSON.stringify({ version: 1, memories: [] }),
    };
    for (const [id, raw] of Object.entries(auxiliary)) await writeFile(path.join(baseDir, id + '.json'), raw);
    const corrupt: string[] = [];
    assert.deepEqual((await store.listBots()).map(bot => bot.id), ['chief']);
    assert.deepEqual((await store.listBots(id => corrupt.push(id))).map(bot => bot.id), ['chief']);
    assert.deepEqual(corrupt, []);
    for (const [id, raw] of Object.entries(auxiliary)) {
      await assert.rejects(() => store.createBot({ id, name: '冲突身份', role: '不得覆盖辅助存档' }), (error: unknown) => error instanceof StoreError && error.code === 'invalid_input');
      await assert.rejects(() => store.getBot(id), (error: unknown) => error instanceof StoreError && error.code === 'invalid_input');
      assert.equal(await readFile(path.join(baseDir, id + '.json'), 'utf8'), raw);
    }
    // 已知辅助文件即使坏了也由自身模块报告；不变成另一个Bot或被重建。
    await writeFile(path.join(baseDir, 'gmail-checks.json'), '{broken');
    assert.deepEqual((await store.listBots()).map(bot => bot.id), ['chief']);
    assert.equal(await readFile(path.join(baseDir, 'gmail-checks.json'), 'utf8'), '{broken');
    await assert.rejects(() => new BotStore({ baseDir }).createBot({ id: 'gmail-checks', name: '冲突', role: '不得重建' }), (error: unknown) => error instanceof StoreError && error.code === 'invalid_input');
    assert.equal(await readFile(path.join(baseDir, 'gmail-checks.json'), 'utf8'), '{broken');
  });

  it('聚合可报告损坏存档并继续列出其他 Bot，单独读取仍严格报错', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.createBot({ id: 'expert', name: '专家', role: '执行' });
    await writeFile(path.join(baseDir, 'broken.json'), '{');
    const corrupt: string[] = [];
    assert.deepEqual((await store.listBots(id => corrupt.push(id))).map(bot => bot.id), ['chief', 'expert']);
    assert.deepEqual(corrupt, ['broken']);
    await assert.rejects(() => store.getBot('broken'), (error: unknown) => error instanceof StoreError && error.code === 'corrupt_store');
    assert.equal(await readFile(path.join(baseDir, 'broken.json'), 'utf8'), '{');
  });
});

describe('Bot 独立配置兼容', () => {
  it('能力按Bot持久化、保留和显式清空，拒绝覆盖系统MCP或夹带权限字段', async () => {
    const { baseDir, store } = await makeStore();
    const capabilities = botCapabilitiesSchema.parse({ skills: [{ name: 'check', path: '/synthetic/SKILL.md' }], mcpServers: {
      local: { type: 'stdio', command: 'synthetic-command', args: ['--test'], env: { SYNTHETIC: '1' } },
      remote: { type: 'http', url: 'https://synthetic.invalid/mcp', headers: { 'X-Synthetic': '1' }, alwaysLoad: true },
      events: { type: 'sse', url: 'https://synthetic.invalid/sse' },
    } });
    await store.createBot({ id: 'reader', name: '资料', role: '核对', capabilities });
    await store.createBot({ id: 'writer', name: '写作', role: '写作' });
    await store.updateBot('reader', { name: '资料核对' });
    assert.deepEqual((await new BotStore({ baseDir }).getBot('reader'))!.bot.capabilities, capabilities);
    assert.deepEqual((await store.getBot('writer'))!.bot.capabilities, { skills: [], mcpServers: {} });
    for (const mcpServers of [
      { 'paseo-guys': { type: 'http', url: 'https://synthetic.invalid' } },
      { paseo: { type: 'stdio', command: 'synthetic' } },
      { extra: { type: 'stdio', command: 'synthetic', toolPolicy: { preapproved: [] } } },
    ]) assert.equal(botCapabilitiesSchema.safeParse({ mcpServers }).success, false);
    assert.deepEqual((await store.updateBot('reader', { capabilities: {} })).capabilities, { skills: [], mcpServers: {} });
  });

  it('配置可持久化和整体清除覆盖，只改名称不会清空说明、记忆或会话', async () => {
    const { baseDir, store } = await makeStore();
    const execution = { provider: 'pi/model', cwd: baseDir, modeId: 'configured-mode', thinkingOptionId: 'high' };
    await store.createBot({ id: 'researcher', name: '资料同事', role: '核对', instructions: '每项结论附来源', execution });
    await store.linkSession('researcher', { sessionId: 'research-native' });
    await store.addMemory('researcher', { kind: 'confirmed', content: '中文交付' });
    const restarted = new BotStore({ baseDir });
    await restarted.updateBot('researcher', { name: '研究同事' });
    const saved = (await restarted.getBot('researcher'))!;
    assert.equal(saved.bot.instructions, '每项结论附来源');
    assert.deepEqual(saved.bot.execution, execution);
    assert.equal(saved.bot.name, '研究同事');
    assert.equal(saved.memories[0].content, '中文交付');
    assert.equal(saved.sessions[0].sessionId, 'research-native');
    const reset = await restarted.updateBot('researcher', { execution: {}, instructions: '' });
    assert.deepEqual(reset.execution, {});
    assert.equal(reset.instructions, '');
    const before = await readFile(path.join(baseDir, 'researcher.json'), 'utf8');
    await assert.rejects(() => restarted.updateBot('researcher', {}), (error: unknown) => error instanceof StoreError && error.code === 'invalid_input');
    await assert.rejects(() => restarted.updateBot('researcher', { execution: { provider: 'invalid' } }), (error: unknown) => error instanceof StoreError && error.code === 'invalid_input');
    assert.equal(await readFile(path.join(baseDir, 'researcher.json'), 'utf8'), before);
  });

  it('旧存档补空说明和执行覆盖，不改写原文件，记忆和会话保留', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'legacy', name: '旧同事', role: '整理资料' });
    await store.linkSession('legacy', { sessionId: 'legacy-native' });
    await store.addMemory('legacy', { kind: 'confirmed', content: '保留旧记忆' });
    const legacy = JSON.parse(await readFile(path.join(baseDir, 'legacy.json'), 'utf8'));
    delete legacy.bot.instructions;
    delete legacy.bot.execution;
    delete legacy.bot.capabilities;
    const before = JSON.stringify(legacy);
    await writeFile(path.join(baseDir, 'legacy.json'), before);
    const reloaded = await new BotStore({ baseDir }).getBot('legacy');
    assert.deepEqual(reloaded?.bot, { ...legacy.bot, instructions: '', execution: {}, capabilities: { skills: [], mcpServers: {} } });
    assert.equal(reloaded?.sessions[0].sessionId, 'legacy-native');
    assert.equal(reloaded?.memories[0].content, '保留旧记忆');
    assert.equal(await readFile(path.join(baseDir, 'legacy.json'), 'utf8'), before);
  });
});

describe('原生会话关联', () => {
  it('原生空标题和长标题不阻断会话关联', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.linkSession('chief', { sessionId: 'native-empty', title: '' });
    await store.linkSession('chief', { sessionId: 'native-long', title: '原生标题'.repeat(100) });
    assert.equal((await store.listSessions('chief'))[1].title, '原生标题'.repeat(100));
  });
  it('同一 Bot 可关联多个会话，重连后可读回', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });

    await store.linkSession('chief', { sessionId: 'sess-1', title: '跨应用跟进' });
    await store.linkSession('chief', { sessionId: 'sess-2', workspaceId: 'ws-9' });

    const reloaded = await new BotStore({ baseDir }).getBot('chief');
    assert.equal(reloaded?.sessions.length, 2);
    assert.deepEqual(
      reloaded?.sessions.map((session) => session.sessionId),
      ['sess-1', 'sess-2'],
    );
    const first = reloaded?.sessions[0];
    assert.equal(first?.title, '跨应用跟进');
    assert.equal(first?.workspaceId, null);
    assert.match(first?.linkedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('重复关联同一会话是幂等的，并更新传入的标题', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await store.linkSession('chief', { sessionId: 'sess-1', title: '旧标题' });
    await store.linkSession('chief', { sessionId: 'sess-1', title: '新标题' });

    const doc = await store.getBot('chief');
    assert.equal(doc?.sessions.length, 1);
    assert.equal(doc?.sessions[0]?.title, '新标题');
  });

  it('解除关联返回是否真的删除过', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await store.linkSession('chief', { sessionId: 'sess-1' });

    assert.equal(await store.unlinkSession('chief', 'sess-1'), true);
    assert.equal(await store.unlinkSession('chief', 'sess-1'), false);
    assert.deepEqual((await store.getBot('chief'))?.sessions, []);
  });

  it('给未知 Bot 关联会话报 bot_not_found', async () => {
    const { store } = await makeStore();
    await assert.rejects(
      () => store.linkSession('ghost', { sessionId: 'sess-1' }),
      (error: unknown) => {
        assertStoreError(error, 'bot_not_found');
        return true;
      },
    );
  });
});

describe('记忆与候选记忆', () => {
  it('明确记忆与推断候选分开保存，只有已确认记忆可注入上下文', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });

    const confirmed = await store.addMemory('chief', {
      kind: 'confirmed',
      content: '汇报用中文，先给结论',
      source: 'user',
    });
    const candidate = await store.addMemory('chief', {
      kind: 'candidate',
      content: '用户可能偏好英文邮件',
      source: 'inferred',
    });

    assert.equal(confirmed.kind, 'confirmed');
    assert.match(confirmed.confirmedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(candidate.kind, 'candidate');
    assert.equal(candidate.confirmedAt, null);

    // 候选不能冒充事实进入上下文
    const injectable = await store.getContextMemories('chief');
    assert.deepEqual(
      injectable.map((memory) => memory.id),
      [confirmed.id],
    );

    // 但用户必须能看见候选
    const all = await new BotStore({ baseDir }).listMemories('chief');
    assert.deepEqual(
      all.map((memory) => memory.content),
      ['汇报用中文，先给结论', '用户可能偏好英文邮件'],
    );
    assert.deepEqual(
      (await store.listMemories('chief', { kind: 'candidate' })).map((memory) => memory.id),
      [candidate.id],
    );
  });

  it('候选记忆被确认后才可注入，纠正内容后上下文同步更新', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const candidate = await store.addMemory('chief', {
      kind: 'candidate',
      content: '用户可能偏好英文邮件',
    });
    assert.deepEqual(await store.getContextMemories('chief'), []);

    const confirmed = await store.updateMemory('chief', candidate.id, { kind: 'confirmed' });
    assert.equal(confirmed.kind, 'confirmed');
    assert.match(confirmed.confirmedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await store.getContextMemories('chief')).length, 1);

    const corrected = await store.updateMemory('chief', candidate.id, {
      content: '邮件默认用中文，仅对外英文客户用英文',
    });
    assert.equal(corrected.content, '邮件默认用中文，仅对外英文客户用英文');
    assert.equal(corrected.createdAt, candidate.createdAt);
    const injectable = await store.getContextMemories('chief');
    assert.equal(injectable[0]?.content, '邮件默认用中文，仅对外英文客户用英文');

    // 降级回候选后不再注入
    const demoted = await store.updateMemory('chief', candidate.id, { kind: 'candidate' });
    assert.equal(demoted.confirmedAt, null);
    assert.deepEqual(await store.getContextMemories('chief'), []);
  });

  it('记忆可删除，删除后不可注入', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const memory = await store.addMemory('chief', { kind: 'confirmed', content: '默认本地工作区' });

    assert.equal(await store.removeMemory('chief', memory.id), true);
    assert.equal(await store.removeMemory('chief', memory.id), false);
    assert.deepEqual(await store.listMemories('chief'), []);
    assert.deepEqual(await store.getContextMemories('chief'), []);
  });

  it('对未知记忆报 memory_not_found，删除未知记忆则幂等返回 false', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await assert.rejects(
      () => store.updateMemory('chief', 'mem_unknown', { content: '新内容' }),
      (error: unknown) => {
        assertStoreError(error, 'memory_not_found');
        return true;
      },
    );
    assert.equal(await store.removeMemory('chief', 'mem_unknown'), false);
  });
});

describe('输入校验与路径穿越', () => {
  it('非法 Bot 标识被拒绝且不落盘', async () => {
    const { baseDir, store } = await makeStore();
    for (const botId of [
      '',
      '..',
      '../escape',
      'a/b',
      'a\\b',
      ' lead',
      '-leading-dash',
      'x'.repeat(65),
      // 正则终端换行不得被当作合法标识
      'chief\n',
      'chief\r',
      // Windows 设备名即使带扩展名仍会被解析成设备，必须拒绝
      'CON',
      'nul',
      'com1',
      'LPT9',
      'Chief',
      'chief.',
      'con.txt',
    ]) {
      await assert.rejects(
        () => store.createBot({ id: botId, name: '主 Bot', role: '澄清' }),
        (error: unknown) => {
          assertStoreError(error, 'invalid_input');
          return true;
        },
        `botId ${JSON.stringify(botId)} 应被拒绝`,
      );
    }
    const escaped = path.join(path.dirname(baseDir), 'escape.json');
    assert.equal(existsSync(escaped), false);
    assert.deepEqual(existsSync(baseDir) ? (await readdir(baseDir)).filter((name) => name.endsWith('.json')) : [], []);
  });

  it('空内容、超长内容与非法 kind/source 被拒绝', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const invalid: unknown[] = [
      { kind: 'confirmed', content: '   ' },
      { kind: 'confirmed', content: 'x'.repeat(8001) },
      { kind: 'maybe', content: '合法文本' },
      { kind: 'confirmed', content: '合法文本', source: 'guess' },
    ];
    for (const input of invalid) {
      await assert.rejects(
        () => store.addMemory('chief', input as { kind: 'confirmed'; content: string }),
        (error: unknown) => {
          assertStoreError(error, 'invalid_input');
          return true;
        },
        `输入 ${JSON.stringify(input).slice(0, 40)} 应被拒绝`,
      );
    }
    assert.deepEqual(await store.listMemories('chief'), []);
  });

  it('updateMemory 需要至少一个可纠正字段', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const memory = await store.addMemory('chief', { kind: 'confirmed', content: '默认本地工作区' });
    await assert.rejects(
      () => store.updateMemory('chief', memory.id, {}),
      (error: unknown) => {
        assertStoreError(error, 'invalid_input');
        return true;
      },
    );
  });

  it('损坏或不兼容的存档报 corrupt_store，且不静默清空', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const file = path.join(baseDir, 'chief.json');

    await writeFile(file, '{ this is not json', 'utf8');
    await assert.rejects(
      () => store.getBot('chief'),
      (error: unknown) => {
        assertStoreError(error, 'corrupt_store');
        return true;
      },
    );
    assert.equal(await readFile(file, 'utf8'), '{ this is not json');

    // 写入路径同样不覆盖损坏文件
    await assert.rejects(
      () => store.addMemory('chief', { kind: 'confirmed', content: '默认本地工作区' }),
      (error: unknown) => {
        assertStoreError(error, 'corrupt_store');
        return true;
      },
    );
    assert.equal(await readFile(file, 'utf8'), '{ this is not json');

    // 结构不兼容（未来版本）同样拒绝，而不是当成空存档
    await writeFile(file, JSON.stringify({ schemaVersion: 99, bot: {}, sessions: [], memories: [] }), 'utf8');
    await assert.rejects(
      () => store.getBot('chief'),
      (error: unknown) => {
        assertStoreError(error, 'corrupt_store');
        return true;
      },
    );
    assert.match(await readFile(file, 'utf8'), /"schemaVersion":99/);
  });
});

describe('持久化形态', () => {
  it('并发写入串行化，不丢更新', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.addMemory('chief', { kind: 'confirmed', content: `约定 ${index}` }),
      ),
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, index) => store.linkSession('chief', { sessionId: `sess-${index}` })),
    );

    const doc = await new BotStore({ baseDir }).getBot('chief');
    assert.equal(doc?.memories.length, 20);
    assert.equal(doc?.sessions.length, 5);
    assert.equal(new Set(doc?.memories.map((memory) => memory.id)).size, 20);

    const raw = await readFile(path.join(baseDir, 'chief.json'), 'utf8');
    assert.equal(JSON.parse(raw).memories.length, 20);
  });

  it('原子写不残留临时文件，且只存业务元数据不存聊天历史', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await store.linkSession('chief', { sessionId: 'sess-1' });
    await store.addMemory('chief', { kind: 'confirmed', content: '默认本地工作区' });

    const entries = await readdir(baseDir);
    assert.deepEqual(entries, ['chief.json']);

    const parsed = JSON.parse(await readFile(path.join(baseDir, 'chief.json'), 'utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), ['bot', 'creationIntents', 'memories', 'schemaVersion', 'sessions']);
    assert.deepEqual(Object.keys(parsed.bot).sort(), ['capabilities', 'createdAt', 'execution', 'id', 'instructions', 'name', 'role', 'updatedAt']);
    assert.deepEqual(Object.keys(parsed.sessions[0]).sort(), ['linkedAt', 'sessionId', 'title', 'workspaceId']);
    assert.deepEqual(Object.keys(parsed.memories[0]).sort(), [
      'confirmedAt',
      'content',
      'createdAt',
      'history',
      'id',
      'kind',
      'source',
      'updatedAt',
    ]);
  });

  it('缺少数据目录时按需创建', async () => {
    const { baseDir } = await makeStore();
    const nested = path.join(baseDir, 'nested', 'store');
    const store = new BotStore({ baseDir: nested });
    assert.equal(await store.getBot('chief'), null);
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    assert.equal((await new BotStore({ baseDir: nested }).getBot('chief'))?.bot.id, 'chief');
  });
});

describe('原生创建意图', () => {
  const f = (seed: string) => `${seed}${'0'.repeat(16)}`.slice(0, 16);

  it('未 ack 的同输入重试复用原意图，complete 后只返回已知 agentId', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });

    const first = await store.prepareCreation('chief', { requestId: 'r1', fingerprint: f('a') });
    assert.equal(first.action, 'create');
    assert.deepEqual(
      [first.intent.requestId, first.intent.status, first.intent.acknowledged],
      ['r1', 'pending', false],
    );
    assert.match(first.intent.agentId, /^[0-9a-f-]{36}$/);

    // UI 丢 requestId：同输入新 requestId 复用原意图与原 agentId
    const reused = await new BotStore({ baseDir }).prepareCreation('chief', { requestId: 'r2', fingerprint: f('a') });
    assert.equal(reused.action, 'retry_pending');
    assert.equal(reused.intent.requestId, 'r1');
    assert.equal(reused.intent.agentId, first.intent.agentId);

    const done = await store.completeCreation('chief', 'r1', { sessionId: first.intent.agentId, title: '核对资料' });
    assert.equal(done.intent.status, 'created');
    const settled = await new BotStore({ baseDir }).getBot('chief');
    assert.equal(settled?.creationIntents.length, 1);
    assert.deepEqual(settled?.sessions.map((session) => session.sessionId), [first.intent.agentId]);

    // created 且未 ack：同输入只返回已知 agentId
    for (const requestId of ['r3', 'r1']) {
      const known = await store.prepareCreation('chief', { requestId, fingerprint: f('a') });
      assert.equal(known.action, 'known');
      assert.equal(known.intent.agentId, first.intent.agentId);
    }
  });

  it('同一 requestId 改输入被拒绝，不同输入登为独立意图且旧未决仍可见', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const first = await store.prepareCreation('chief', { requestId: 'r1', fingerprint: f('a') });

    await assert.rejects(
      () => store.prepareCreation('chief', { requestId: 'r1', fingerprint: f('b') }),
      (error: unknown) => {
        assertStoreError(error, 'request_conflict');
        return true;
      },
    );

    const independent = await store.prepareCreation('chief', { requestId: 'r2', fingerprint: f('b') });
    assert.equal(independent.action, 'create');
    assert.notEqual(independent.intent.agentId, first.intent.agentId);

    // A07：未决旧创建不阻挡其他独立请求，两者都可见
    assert.deepEqual(
      (await new BotStore({ baseDir }).listPendingCreations('chief')).map((intent) => [intent.requestId, intent.status]),
      [
        ['r1', 'pending'],
        ['r2', 'pending'],
      ],
    );
    // 各自输入仍归各自意图
    assert.equal((await store.prepareCreation('chief', { requestId: 'r9', fingerprint: f('a') })).intent.requestId, 'r1');
    assert.equal((await store.prepareCreation('chief', { requestId: 'r8', fingerprint: f('b') })).intent.requestId, 'r2');
  });

  it('ack 只需用户显式调用：ack 后同输入新请求允许新会话，未知意图报 creation_not_found', async () => {
    const { store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    const first = await store.prepareCreation('chief', { requestId: 'r1', fingerprint: f('a') });
    await store.completeCreation('chief', 'r1', { sessionId: first.intent.agentId });
    await store.acknowledgeCreation('chief', 'r1');
    assert.deepEqual(await store.listPendingCreations('chief'), []);

    const again = await store.prepareCreation('chief', { requestId: 'r2', fingerprint: f('a') });
    assert.equal(again.action, 'create');
    assert.notEqual(again.intent.agentId, first.intent.agentId);

    await assert.rejects(
      () => store.acknowledgeCreation('chief', 'missing'),
      (error: unknown) => {
        assertStoreError(error, 'creation_not_found');
        return true;
      },
    );
  });

  it('意图只存业务元数据字段，旧存档缺字段按空数组读取', async () => {
    const { baseDir, store } = await makeStore();
    await store.createBot({ id: 'chief', name: '主 Bot', role: '澄清' });
    await store.prepareCreation('chief', { requestId: 'r1', fingerprint: f('a') });

    const parsed = JSON.parse(await readFile(path.join(baseDir, 'chief.json'), 'utf8'));
    assert.deepEqual(Object.keys(parsed.creationIntents[0]).sort(), ['acknowledged', 'agentId', 'fingerprint', 'requestId', 'status']);

    const legacy = {
      schemaVersion: 1,
      bot: parsed.bot,
      sessions: parsed.sessions,
      memories: parsed.memories,
    };
    await writeFile(path.join(baseDir, 'chief.json'), JSON.stringify(legacy), 'utf8');
    const readBack = await new BotStore({ baseDir }).getBot('chief');
    assert.deepEqual(readBack?.creationIntents, []);
    assert.equal((await store.prepareCreation('chief', { requestId: 'r2', fingerprint: f('a') })).action, 'create');
  });
});
