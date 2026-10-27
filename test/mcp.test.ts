import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BotJournal } from '../server/journal.js';
import { BotMcp, createBotMcpServer, type BotMcpToolScope } from '../server/mcp.js';
import { BotStore } from '../server/store.js';

/**
 * 离线契约测试：只用临时目录、随机回环端口和本组件自身。
 * 不连接 Paseo daemon、不调用模型、不连接任何真实账户，也不是宿主 E2E。
 */

interface Workspace {
  dir: string;
  store: BotStore;
  journal: BotJournal;
}

async function withWorkspace(task: (workspace: Workspace) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-guys-mcp-'));
  try {
    await task({ dir, store: new BotStore({ baseDir: dir }), journal: new BotJournal({ baseDir: join(dir, 'journal') }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 优先用 SDK 的 InMemoryTransport 验证工具契约，不占端口。 */
async function connectInMemory(scope: BotMcpToolScope) {
  const server = createBotMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'paseo-guys-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const content = (result as { content?: unknown }).content;
  const block = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
  return typeof block?.text === 'string' ? block.text : '';
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

function toolNames(tools: Awaited<ReturnType<Client['listTools']>>): string[] {
  return tools.tools.map((tool) => tool.name).sort();
}

/** 低层 request/response：只在需要伪造 Host / Origin 等请求头时使用。 */
function rawRequest(
  port: number,
  options: { path: string; headers: Record<string, string>; body?: string; method?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: options.path, method: options.method ?? 'POST', headers: options.headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
});

test('端点状态可见且不泄露凭证，损坏文件保留原字节并提示恢复影响', async () => {
  await withWorkspace(async ({ dir, store, journal }) => {
    const endpoint = new BotMcp({ baseDir: dir, store, journal });
    try {
      assert.deepEqual(await endpoint.status(), { state: 'idle' });
      await mkdir(join(dir, 'mcp'), { recursive: true });
      const file = join(dir, 'mcp', 'endpoint.json');
      const corrupted = '{"secret":"do-not-return-this"';
      await writeFile(file, corrupted);
      const status = await endpoint.status();
      assert.equal(status.state, 'unavailable');
      assert.match(status.detail!, /已有会话.*失效/);
      assert.equal(JSON.stringify(status).includes('do-not-return-this'), false);
      assert.equal(await readFile(file, 'utf8'), corrupted);
    } finally { await endpoint.close(); }
  });
});

test('propose_memory 只写候选，Agent 无法自填 confirmed 或 source', async () => {
  await withWorkspace(async ({ store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    const { client, close } = await connectInMemory({ botId: 'chief', agentId: 'agent-1', store, journal });
    try {
      const proposal = await client.callTool({ name: 'propose_memory', arguments: { content: '用户偏好简洁回复' } });
      const payload = parse<{ memoryId: string; status: string; confirmed: boolean; needsUserConfirmation: boolean }>(textOf(proposal));
      assert.equal(payload.status, 'candidate');
      assert.equal(payload.confirmed, false);
      assert.equal(payload.needsUserConfirmation, true);

      const [stored] = await store.listMemories('chief');
      assert.equal(stored?.id, payload.memoryId);
      assert.equal(stored?.kind, 'candidate');
      assert.equal(stored?.source, 'agent');
      assert.equal(stored?.confirmedAt, null);
      // 候选绝不注入上下文。
      assert.deepEqual(await store.getContextMemories('chief'), []);

      // 额外参数不能绕过绑定：kind/source/confirmed/botId 都会被丢弃。
      const forged = await client.callTool({
        name: 'propose_memory',
        arguments: { content: '自填确认的假记忆', kind: 'confirmed', source: 'user', confirmed: true, botId: 'other' },
      });
      assert.notEqual(forged.isError, true);
      const memories = await store.listMemories('chief');
      assert.equal(memories.length, 2);
      assert.deepEqual(
        memories.map((memory) => [memory.kind, memory.source]),
        [
          ['candidate', 'agent'],
          ['candidate', 'agent'],
        ],
      );

      const read = await client.callTool({ name: 'read_memories', arguments: {} });
      assert.deepEqual(parse<{ memories: unknown[] }>(textOf(read)).memories, []);
    } finally {
      await close();
    }
  });
});

test('read_memories 只返回本 Bot 的已确认记忆，不含候选或其他 Bot 数据', async () => {
  await withWorkspace(async ({ store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.createBot({ id: 'other', name: '其他 Bot', role: '专家' });
    const confirmed = await store.addMemory('chief', { kind: 'confirmed', content: '用户明确记忆', source: 'user' });
    await store.addMemory('chief', { kind: 'candidate', content: '推断候选内容' });
    await store.addMemory('other', { kind: 'confirmed', content: '其他 Bot 的机密记忆' });

    const { client, close } = await connectInMemory({ botId: 'chief', agentId: 'agent-1', store, journal });
    try {
      const result = await client.callTool({ name: 'read_memories', arguments: {} });
      const text = textOf(result);
      const payload = parse<{ botId: string; memories: { id: string; content: string }[]; truncated: boolean }>(text);
      assert.equal(payload.botId, 'chief');
      assert.deepEqual(payload.memories, [
        { id: confirmed.id, content: '用户明确记忆', createdAt: confirmed.createdAt, confirmedAt: confirmed.confirmedAt },
      ]);
      assert.equal(payload.truncated, false);
      assert.equal(text.includes('推断候选内容'), false);
      assert.equal(text.includes('其他 Bot 的机密记忆'), false);
    } finally {
      await close();
    }
  });
});

test('read_journal 只读本 Bot 日志，默认返回最近若干条', async () => {
  await withWorkspace(async ({ store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.createBot({ id: 'other', name: '其他 Bot', role: '专家' });
    await journal.append('chief', { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started' });
    await journal.append('chief', { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_ended', outcome: 'completed' });
    await journal.append('other', { agentId: 'agent-9', turnId: null, kind: 'turn_started' });

    const { client, close } = await connectInMemory({ botId: 'chief', agentId: 'agent-1', store, journal });
    try {
      const all = parse<{ entries: { agentId: string; kind: string }[]; truncated: boolean }>(
        textOf(await client.callTool({ name: 'read_journal', arguments: {} })),
      );
      assert.deepEqual(
        all.entries.map((entry) => [entry.agentId, entry.kind]),
        [
          ['agent-1', 'turn_started'],
          ['agent-1', 'turn_ended'],
        ],
      );
      assert.equal(all.truncated, false);

      const last = parse<{ entries: { kind: string }[]; truncated: boolean }>(
        textOf(await client.callTool({ name: 'read_journal', arguments: { limit: 1 } })),
      );
      assert.deepEqual(last.entries.map((entry) => entry.kind), ['turn_ended']);
      assert.equal(last.truncated, true);
      const older = parse<{ entries: { kind: string }[]; nextOffset: number | null; offset: number }>(
        textOf(await client.callTool({ name: 'read_journal', arguments: { limit: 1, offset: 1 } })),
      );
      assert.deepEqual(older.entries.map(entry => entry.kind), ['turn_started']);
      assert.equal(older.offset, 1);
      assert.equal(older.nextOffset, null);
    } finally {
      await close();
    }
  });
});

test('明确记忆超过 200 条后可继续读取旧页，候选不占分页位置', async () => {
  await withWorkspace(async ({ dir, store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    const sample = await store.addMemory('chief', { kind: 'confirmed', content: 'fixture' });
    const record = (await store.getBot('chief'))!;
    record.memories = Array.from({ length: 201 }, (_, index) => ({ ...sample, id: `m-${index}`, content: `明确-${index}` }));
    record.memories.push({ ...sample, id: 'candidate', content: '候选秘密', kind: 'candidate', source: 'agent', confirmedAt: null });
    await writeFile(join(dir, 'chief.json'), JSON.stringify(record));
    const { client, close } = await connectInMemory({ botId: 'chief', agentId: 'agent-1', store, journal });
    try {
      const first = parse<{ total: number; memories: { content: string }[]; nextOffset: number }>(textOf(await client.callTool({ name: 'read_memories', arguments: {} })));
      assert.equal(first.total, 201);
      assert.equal(first.memories.length, 200);
      assert.equal(first.memories[0].content, '明确-1');
      assert.equal(first.nextOffset, 200);
      const older = parse<{ memories: { content: string }[]; nextOffset: number | null }>(textOf(await client.callTool({ name: 'read_memories', arguments: { offset: first.nextOffset } })));
      assert.deepEqual(older.memories.map(item => item.content), ['明确-0']);
      assert.equal(older.nextOffset, null);
      for (const name of ['read_memories', 'read_journal']) {
        assert.equal((await client.callTool({ name, arguments: { offset: -1 } })).isError, true);
      }
    } finally { await close(); }
  });
});

test('remember_explicit 仅在有宿主回调时注册，绑定与回执由服务端决定', async () => {
  await withWorkspace(async ({ store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });

    const withoutCallback = await connectInMemory({ botId: 'chief', agentId: 'agent-1', store, journal });
    try {
      assert.deepEqual(toolNames(await withoutCallback.client.listTools()), ['propose_memory', 'read_journal', 'read_memories']);
    } finally {
      await withoutCallback.close();
    }

    const calls: { botId: string; agentId: string; input: unknown }[] = [];
    const withCallback = await connectInMemory({
      botId: 'chief',
      agentId: 'agent-1',
      store,
      journal,
      rememberExplicit: async (botId, agentId, input) => {
        calls.push({ botId, agentId, input });
        const memory = await store.addMemory(botId, { kind: 'confirmed', content: input.content, source: 'user' });
        return { id: memory.id, content: memory.content, kind: 'confirmed' as const };
      },
    });
    try {
      assert.deepEqual(toolNames(await withCallback.client.listTools()), [
        'propose_memory',
        'read_journal',
        'read_memories',
        'remember_explicit',
      ]);
      const result = await withCallback.client.callTool({
        name: 'remember_explicit',
        arguments: { content: '用户要求记住 X', userQuote: '记住 X', botId: 'other', source: 'user', confirmed: true },
      });
      const payload = parse<{ status: string; botId: string; kind: string; memoryId: string }>(textOf(result));
      assert.equal(payload.status, 'saved');
      assert.equal(payload.botId, 'chief');
      assert.equal(payload.kind, 'confirmed');
      assert.equal(payload.memoryId, (await store.listMemories('chief'))[0].id);
      assert.deepEqual(calls, [{ botId: 'chief', agentId: 'agent-1', input: { content: '用户要求记住 X', userQuote: '记住 X' } }]);
      assert.equal((await store.listMemories('chief')).length, 1);
    } finally {
      await withCallback.close();
    }
  });
});

test('回环 HTTP 端点可供标准 MCP 客户端挂载并调用工具', async () => {
  await withWorkspace(async ({ dir, store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.linkSession('chief', { sessionId: 'agent-1' });
    await store.addMemory('chief', { kind: 'confirmed', content: '用户明确记忆', source: 'user' });
    const mcp = new BotMcp({ baseDir: dir, store, journal });
    try {
      const config = await mcp.mount('chief', 'agent-1');
      assert.equal(config.type, 'http');
      assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/bots\/chief\/agent-1$/);
      assert.match(config.headers?.Authorization ?? '', /^Bearer [a-f0-9]{64}$/);

      const client = new Client({ name: 'paseo-guys-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
      await client.connect(transport);
      try {
        assert.deepEqual(toolNames(await client.listTools()), ['propose_memory', 'read_journal', 'read_memories']);
        const payload = parse<{ memories: { content: string }[] }>(
          textOf(await client.callTool({ name: 'read_memories', arguments: {} })),
        );
        assert.deepEqual(payload.memories.map((memory) => memory.content), ['用户明确记忆']);
      } finally {
        await client.close();
      }

      // 未注册的 Bot 不能挂载。
      await assert.rejects(() => mcp.mount('ghost', 'agent-1'), /not found/);
    } finally {
      await mcp.close();
    }
  });
});

test('回环 HTTP 端点拒绝错误 token、跨 Bot token、跨源请求与非法 Host', async () => {
  await withWorkspace(async ({ dir, store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.createBot({ id: 'other', name: '其他 Bot', role: '专家' });
    await store.linkSession('chief', { sessionId: 'agent-1' });
    await store.linkSession('other', { sessionId: 'agent-1' });
    const mcp = new BotMcp({ baseDir: dir, store, journal });
    try {
      const config = await mcp.mount('chief', 'agent-1');
      const otherConfig = await mcp.mount('other', 'agent-1');
      const port = Number(new URL(config.url).port);
      const path = new URL(config.url).pathname;
      const authorization = config.headers?.Authorization ?? '';
      const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

      const wrongToken = await rawRequest(port, { path, headers: { ...base, authorization: 'Bearer 00' }, body: initializeBody });
      assert.equal(wrongToken.status, 401);

      const missingToken = await rawRequest(port, { path, headers: base, body: initializeBody });
      assert.equal(missingToken.status, 401);

      // 另一个 Bot 的有效 token 不能用于本 Bot 的路径。
      const crossBot = await rawRequest(port, {
        path,
        headers: { ...base, authorization: otherConfig.headers?.Authorization ?? '' },
        body: initializeBody,
      });
      assert.equal(crossBot.status, 401);

      const crossOrigin = await rawRequest(port, {
        path,
        headers: { ...base, authorization, origin: 'http://evil.example' },
        body: initializeBody,
      });
      assert.equal(crossOrigin.status, 403);

      const rebindingHost = await rawRequest(port, {
        path,
        headers: { ...base, authorization, host: 'evil.example' },
        body: initializeBody,
      });
      assert.equal(rebindingHost.status, 403);

      const accepted = await rawRequest(port, { path, headers: { ...base, authorization }, body: initializeBody });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.includes(authorization.slice('Bearer '.length)), false);

      const notAllowed = await rawRequest(port, { path, method: 'GET', headers: { ...base, authorization } });
      assert.equal(notAllowed.status, 405);

      // 请求体超过最小够用限额时由 SDK transport 直接拒绝。
      const tooLarge = await rawRequest(port, {
        path,
        headers: { ...base, authorization },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose_memory', arguments: { content: 'x'.repeat(70_000) } } }),
      });
      assert.equal(tooLarge.status, 413);
    } finally {
      await mcp.close();
    }
  });
});

test('端口与密钥持久化：重启复用同一地址与 token，端口被占用时报错而不静默换端口', async () => {
  await withWorkspace(async ({ dir, store, journal }) => {
    await store.createBot({ id: 'chief', name: '主 Bot', role: '核对' });
    await store.linkSession('chief', { sessionId: 'agent-1' });
    const first = new BotMcp({ baseDir: dir, store, journal });
    const config = await first.mount('chief', 'agent-1');
    const port = Number(new URL(config.url).port);
    await first.close();

    const state = parse<{ port: number; secret: string }>(await readFile(join(dir, 'mcp', 'endpoint.json'), 'utf8'));
    assert.equal(state.port, port);
    assert.match(state.secret, /^[a-f0-9]{64}$/);
    // 端点状态不落在 Bot 存档命名空间里，Bot 列表不受影响。
    assert.deepEqual((await store.listBots()).map((bot) => bot.id), ['chief']);

    const second = new BotMcp({ baseDir: dir, store, journal });
    try {
      const reused = await second.mount('chief', 'agent-1');
      assert.equal(reused.url, config.url);
      assert.deepEqual(reused.headers, config.headers);
    } finally {
      await second.close();
    }

    // 端口被占用时必须显式失败：换端口会让已挂载会话失联。
    const occupier = createServer();
    await new Promise<void>((resolve, reject) => {
      occupier.once('error', reject);
      occupier.listen(port, '127.0.0.1', () => {
        occupier.off('error', reject);
        resolve();
      });
    });
    try {
      const third = new BotMcp({ baseDir: dir, store, journal });
      await assert.rejects(() => third.mount('chief', 'agent-1'), /已被占用/);
      await third.close();
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });
});
