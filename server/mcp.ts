import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import nodePath from 'node:path';
import type { McpHttpServerConfig } from '@getpaseo/protocol/agent-types';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BotJournal } from './journal.js';
import type { BotStore } from './store.js';

/**
 * Bot 工具面：插件进程内的回环 HTTP MCP 服务。
 *
 * 只开放 Bot 自己的记忆、候选与工作日志，不提供任意 shell、Provider 调用、原生审批放行或办公动作实现。
 * 协议收发、JSON-RPC 校验与无状态 Streamable HTTP 均由 @modelcontextprotocol/sdk 处理，
 * 本文件只负责接入：回环地址、稳定端口与密钥、Bot/Agent 绑定凭证、跨源校验和工具绑定。
 *
 * 接入模式参考 paseo-bots（MIT，提交 39a700006c204aef25de4e0db11419b6f75ac814 server/relay.ts）：http MCP + 127.0.0.1
 * + Bot/Agent 绑定 bearer。此处未复制其源码，仅按同一思路改用发布的 MCP SDK 与 Paseo 0.12 的 McpHttpServerConfig。
 */

/** 只绑定本机回环地址；不做远程配对、OAuth 或公网入口。 */
const LOOPBACK = '127.0.0.1';
/** 记忆内容上限 8000 字符，64 KiB 足够容纳单次工具调用且留有余量。 */
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MEMORY_ITEMS = 200;
const MAX_JOURNAL_ITEMS = 200;
const DEFAULT_JOURNAL_ITEMS = 50;
const MAX_MEMORY_CHARS = 8000;
const MAX_QUOTE_CHARS = 2000;
const BOT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const AGENT_ID = /^[A-Za-z0-9._:@-]+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SERVER_INFO = { name: 'paseo-guys', version: '0.1.0' } as const;

/** 端点状态（端口 + 签名密钥）存放于 baseDir 子目录，避免被 BotStore 当成 Bot 存档。 */
const ENDPOINT_DIRECTORY = 'mcp';
const ENDPOINT_FILE = 'endpoint.json';

const endpointStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});

type EndpointState = z.infer<typeof endpointStateSchema>;

/** Agent 明确要求保存的长期记忆。宿主按原生最新 user_message 回查后才能落成明确记忆。 */
export interface RememberExplicitInput {
  content: string;
  userQuote: string;
}

/**
 * 由父级实现：核对 `userQuote` 是否确实来自当前用户的最新消息，再决定是否保存为明确记忆。
 * `botId` / `agentId` 来自服务端绑定，不来自工具参数。
 */
export type RememberExplicit = (botId: string, agentId: string, input: RememberExplicitInput) => Promise<{ id: string; content: string; kind: 'confirmed' }>;

export interface BotMcpOptions {
  baseDir: string;
  store: BotStore;
  journal: BotJournal;
  /** 存在时才注册 `remember_explicit`；缺失时该工具不出现，Agent 只能提交候选。 */
  rememberExplicit?: RememberExplicit;
}

export interface BotMcpToolScope {
  botId: string;
  agentId: string;
  store: BotStore;
  journal: BotJournal;
  rememberExplicit?: RememberExplicit;
}

function isBotId(value: string): boolean {
  return value.length <= 64 && BOT_ID.test(value) && !WINDOWS_RESERVED.test(value);
}

function isAgentId(value: string): boolean {
  return value.length <= 200 && AGENT_ID.test(value);
}

/** Bot/Agent 绑定凭证；密钥常驻 baseDir，重启后同一绑定得到同一 token。 */
function tokenFor(secret: string, botId: string, agentId: string): string {
  return createHmac('sha256', secret).update(`paseo-guys-mcp:${botId}:${agentId}`).digest('hex');
}

function bearerMatches(secret: string, botId: string, agentId: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const expected = tokenFor(secret, botId, agentId);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(given, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 拒 DNS rebinding：Host 必须就是本次绑定的回环地址与端口。 */
function hostAllowed(request: IncomingMessage, port: number): boolean {
  return (request.headers.host ?? '').toLowerCase() === `${LOOPBACK}:${port}`;
}

/** 无 Origin 的本机客户端照常放行；带 Origin 的跨源请求一律拒绝。 */
function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin.toLowerCase() === `http://${LOOPBACK}:${port}`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function toolResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** 只回传可判别的错误文本；不包含密钥，也不包含其他 Bot 的数据。 */
function toolFailure(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
}

/**
 * 构造绑定到一个 Bot 的 MCP server（不监听端口）。
 * 工具调用只能看到 `scope.botId` 的数据：工具参数里没有 botId，也没有 source/confirmed。
 */
export function createBotMcpServer(scope: BotMcpToolScope): McpServer {
  const { botId, agentId, store, journal, rememberExplicit } = scope;
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'read_memories',
    {
      title: '读取本 Bot 的明确记忆',
      description: '读取当前 Bot 已被用户确认的长期记忆。候选记忆不会出现在这里，也不要把候选当成用户已确认的事实。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_MEMORY_ITEMS).default(MAX_MEMORY_ITEMS),
        offset: z.number().int().min(0).default(0).describe('从最新记忆开始跳过的条数；用 nextOffset 继续读取更早记录'),
      },
    },
    async ({ limit, offset }) => {
      try {
        const memories = await store.getContextMemories(botId);
        const end = Math.max(0, memories.length - offset);
        const shown = memories.slice(Math.max(0, end - limit), end);
        return toolResult({
          botId,
          total: memories.length,
          offset,
          nextOffset: offset + shown.length < memories.length ? offset + shown.length : null,
          memories: shown.map((memory) => ({
            id: memory.id,
            content: memory.content,
            createdAt: memory.createdAt,
            confirmedAt: memory.confirmedAt,
          })),
          truncated: shown.length < memories.length,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    'propose_memory',
    {
      title: '提交一条候选记忆',
      description:
        '把推断出的长期偏好提交为候选记忆，等待用户在插件界面确认。候选不会注入上下文；本工具无法声明用户已确认。',
      inputSchema: { content: z.string().min(1).max(MAX_MEMORY_CHARS).describe('要记住的候选内容') },
    },
    async ({ content }) => {
      try {
        const memory = await store.addMemory(botId, { kind: 'candidate', content, source: 'agent' });
        return toolResult({
          memoryId: memory.id,
          status: 'candidate',
          confirmed: false,
          needsUserConfirmation: true,
          content: memory.content,
          note: '已保存为待确认候选；用户确认前不会注入上下文，也不代表用户已同意。',
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  if (rememberExplicit) {
    server.registerTool(
      'remember_explicit',
      {
        title: '保存用户明确要求记住的内容',
        description:
          '仅在用户本条消息中明确要求记住某件事时使用；不要用于推断偏好。宿主会按原生最新用户消息核对 userQuote，核对通过才保存为明确记忆。',
        inputSchema: {
          content: z.string().min(1).max(MAX_MEMORY_CHARS).describe('逐字摘录用户明确要求记住的内容；推断或改写使用候选工具'),
          userQuote: z
            .string()
            .min(1)
            .max(MAX_QUOTE_CHARS)
            .describe('用户消息中明确要求记住该内容的原话片段，供宿主回查核对'),
        },
      },
      async ({ content, userQuote }) => {
        try {
          const memory = await rememberExplicit(botId, agentId, { content, userQuote });
          return toolResult({
            status: 'saved',
            kind: 'confirmed',
            memoryId: memory.id,
            botId,
            content: memory.content,
          });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  server.registerTool(
    'read_journal',
    {
      title: '读取本 Bot 工作日志',
      description: '读取当前 Bot 的原生轮次工作日志（只含轮次开始/结束与原生观察到的结果，不代表任务完成）。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_JOURNAL_ITEMS).optional().describe('最多返回最近多少条，默认 50'),
        offset: z.number().int().min(0).default(0).describe('从最新有效记录开始跳过的条数；用 nextOffset 继续读取'),
      },
    },
    async ({ limit, offset }) => {
      try {
        const snapshot = await journal.inspect(botId, { limit: limit ?? DEFAULT_JOURNAL_ITEMS, offset });
        return toolResult({ botId, ...snapshot, truncated: snapshot.entries.length < snapshot.total });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}

/**
 * 插件进程内的回环 HTTP MCP 端点。
 *
 * - 只监听 127.0.0.1；端口与密钥持久化在 baseDir，重启复用同一端口与同一批 token。
 * - 端口被占用时报错而不是静默换端口，避免已挂载的会话指向失效地址。
 * - 每个请求一个无状态 transport + server，响应结束后立即释放。
 */
export class BotMcp {
  private readonly store: BotStore;
  private readonly journal: BotJournal;
  private readonly rememberExplicit?: RememberExplicit;
  private readonly stateFile: string;
  private server: Server | null = null;
  private port: number | null = null;
  private secret: string | null = null;
  private starting: Promise<void> | null = null;
  private readonly transports = new Set<StreamableHTTPServerTransport>();
  private closed = false;

  constructor(options: BotMcpOptions) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') throw new Error('baseDir is required');
    if (!options.store || !options.journal) throw new Error('store and journal are required');
    this.store = options.store;
    this.journal = options.journal;
    this.rememberExplicit = options.rememberExplicit;
    this.stateFile = nodePath.join(nodePath.resolve(baseDir), ENDPOINT_DIRECTORY, ENDPOINT_FILE);
  }

  /** 为一个 Bot/Agent 组合生成挂载配置；地址与 token 由服务端绑定，不接受调用方指定。 */
  async mount(botId: string, agentId: string): Promise<McpHttpServerConfig> {
    if (!isBotId(botId)) throw new Error(`invalid botId: ${botId}`);
    if (!isAgentId(agentId)) throw new Error(`invalid agentId: ${agentId}`);
    const bot = await this.store.getBot(botId);
    if (!bot) throw new Error(`bot ${botId} not found`);
    if (!bot.sessions.some(session => session.sessionId === agentId) && !bot.creationIntents.some(intent => intent.agentId === agentId)) {
      throw new Error('agent is not associated with this bot');
    }
    await this.ensureListening();
    const { port, secret } = this;
    if (port === null || secret === null) throw new Error('mcp endpoint is not listening');
    return {
      type: 'http',
      url: `http://${LOOPBACK}:${port}/bots/${botId}/${agentId}`,
      headers: { Authorization: `Bearer ${tokenFor(secret, botId, agentId)}` },
    };
  }

  /** Restore the saved endpoint even when no client is connected. */
  async restore(): Promise<void> {
    if (await this.readState()) await this.ensureListening();
  }

  /** 仅返回连接状态，不暴露端口凭证，也不重建损坏的状态文件。 */
  async status(): Promise<{ state: 'idle' | 'ready' | 'unavailable'; detail?: string }> {
    try {
      await this.restore();
      return { state: this.server?.listening ? 'ready' : 'idle' };
    } catch (error) {
      return {
        state: 'unavailable',
        detail: `${error instanceof Error ? error.message : String(error)}。请排查端口占用或从备份恢复原端点文件；重建端点会使已有会话的工具配置失效，需要新建会话。`,
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const starting = this.starting;
    this.starting = null;
    if (starting) await starting.catch(() => undefined);

    const server = this.server;
    this.server = null;
    this.port = null;
    this.secret = null;
    for (const transport of this.transports) void transport.close().catch(() => undefined);
    this.transports.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private ensureListening(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('mcp endpoint is closed'));
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const state = await this.readState();
    const secret = state?.secret ?? randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    // 监听成功后的错误与具体请求无关：请求级错误在 handle 内处理，这里避免未处理事件终止进程。
    server.on('error', error => console.error('Bot MCP endpoint error', error.message));

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(state?.port ?? 0, LOOPBACK, () => {
        server.off('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('mcp endpoint has no port'));
          return;
        }
        resolve(address.port);
      });
    }).catch((error: unknown) => {
      if (server.listening) server.close();
      if (state && isErrnoCode(error, 'EADDRINUSE')) {
        throw new Error(`MCP 端口 ${state.port} 已被占用：不静默换端口，否则已挂载的会话会失联`);
      }
      throw error;
    });

    // 只有首次分配端口（或首次生成密钥）时才写状态；之后一律复用。
    if (!state) {
      try { await this.writeState({ port, secret }); }
      catch (error) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
      }
    }

    this.server = server;
    this.port = port;
    this.secret = secret;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const port = this.port;
      const secret = this.secret;
      if (port === null || secret === null) {
        json(response, 503, { error: 'mcp endpoint is not listening' });
        return;
      }
      if (!hostAllowed(request, port)) {
        json(response, 403, { error: 'forbidden host' });
        return;
      }
      if (!originAllowed(request, port)) {
        json(response, 403, { error: 'forbidden origin' });
        return;
      }

      const path = (request.url ?? '').split('?')[0] ?? '';
      const match = /^\/bots\/([^/]+)\/([^/]+)$/.exec(path);
      if (!match) {
        json(response, 404, { error: 'not found' });
        return;
      }
      const botId = match[1]!;
      const agentId = match[2]!;
      if (!isBotId(botId) || !isAgentId(agentId) || !bearerMatches(secret, botId, agentId, request.headers.authorization)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      await this.dispatch(request, response, botId, agentId);
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'internal error' });
      else response.destroy();
    }
  }

  /** 无状态：每个请求一套 server/transport，请求结束即释放连接资源。 */
  private async dispatch(request: IncomingMessage, response: ServerResponse, botId: string, agentId: string): Promise<void> {
    const server = createBotMcpServer({
      botId,
      agentId,
      store: this.store,
      journal: this.journal,
      rememberExplicit: this.rememberExplicit,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    this.transports.add(transport);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.transports.delete(transport);
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    response.on('close', release);

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      release();
      if (!response.headersSent) {
        json(response, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
      } else {
        response.destroy();
      }
    }
  }

  private async readState(): Promise<EndpointState | null> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`MCP 端点状态文件损坏：${this.stateFile}`);
    }
    const result = endpointStateSchema.safeParse(parsed);
    if (!result.success) throw new Error(`MCP 端点状态文件不符合预期：${this.stateFile}`);
    return result.data;
  }

  /** 原子写；POSIX 请求 0600，Windows 文件权限仍由用户目录 ACL 决定。 */
  private async writeState(state: EndpointState): Promise<void> {
    await mkdir(nodePath.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.stateFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
