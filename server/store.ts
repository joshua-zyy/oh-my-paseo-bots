import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { writeJsonFile } from './storage.js';
import { StoreError } from './store-errors.js';
import { addMemoryEntry, updateMemoryEntry, archiveMemoryEntry, restoreMemoryEntry } from './memory-entries.js';
import nodePath from 'node:path';
import { z } from 'zod';
import { CHIEF_BOT_ID, botDetailsSchema, botPatchSchema, type BotDetails, type BotDetailsInput, type BotPatch } from '../shared/bot.js';
import { memoryContentSchema, memoryEntrySchema, memoryKindSchema, memoryOriginSchema, type MemoryEntry, type MemoryKind, type MemoryOrigin, type MemorySource } from '../shared/memory.js';
export type { MemoryEntry, MemoryKind, MemorySource } from '../shared/memory.js';

/**
 * Bot 业务元数据存储。
 *
 * 只持久化 Paseo 原生能力之外的少量业务元数据：
 * - 固定 Bot 身份、长期说明与可选执行配置（宿主默认之上的覆盖）
 * - Bot 关联的原生 agent 会话 id 及最小标注
 * - 记忆条目，区分「明确记忆」与「推断候选」
 *
 * 不存聊天历史、不复制会话库、不做状态同步；会话内容与运行状态以 Paseo 原生能力为准。
 * 每个 Bot 一个 JSON 文件，写入为「临时文件 + rename」的原子替换。
 */

const SCHEMA_VERSION = 2;
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;

/** 小写标识避免 Windows 大小写文件别名；不允许点号与设备名。 */
export const botIdPattern = BOT_ID_PATTERN;

/** 固定 Bot 身份，独立于任何一次执行会话。 */
export interface BotIdentity extends BotDetails {
  id: string;
  createdAt: string;
  updatedAt: string;

}

/** Bot 关联的一个 Paseo 原生会话。只存标识与最小标注，不存会话内容。 */
export interface SessionLink {
  sessionId: string;
  title: string | null;
  workspaceId: string | null;
  linkedAt: string;
}

/**
 * 一次「原生创建意图」的业务元数据：在调用原生 create 之前先落盘，使重试可复用同一 agentId 与幂等键。
 * 不存用户 prompt、注入内容或聊天记录。
 */
export interface CreationIntent {
  requestId: string;
  /** 输入 + 配置 + 注入记忆的哈希；同 fingerprint 的重试才可复用。 */
  fingerprint: string;
  /** 预先生成、作为原生 create 的 agentId 使用。 */
  agentId: string;
  status: 'pending' | 'created';
  /** 仅在用户 RPC 显式确认后为 true；原生回执不等于用户已看见。 */
  acknowledged: boolean;
}

/** 一个 Bot 的完整业务元数据快照。 */
export interface BotRecord {
  schemaVersion: 2;
  bot: BotIdentity;
  sessions: SessionLink[];
  memories: MemoryEntry[];
  /** v2 记录缺失该字段时按 `[]` 读取；不读取根层旧存档。 */
  creationIntents: CreationIntent[];
}

export interface PrepareCreationInput {
  requestId: string;
  fingerprint: string;
}

/**
 * `prepareCreation` 的结论：
 * - `create`：新意图已落盘，可直接创建原生会话；
 * - `retry_pending`：复用既有 pending 意图，先回查再用同一 agentId / 幂等键创建；
 * - `known`：已 created 且未 ack、输入相同，只能返回已知 agentId，不再创建。
 */
export type CreationProposal =
  | { action: 'create'; intent: CreationIntent }
  | { action: 'retry_pending'; intent: CreationIntent }
  | { action: 'known'; intent: CreationIntent };

export interface CreateBotInput extends BotDetailsInput {
  id: string;
}

export interface LinkSessionInput {
  sessionId: string;
  title?: string | null;
  workspaceId?: string | null;
}

export interface AddMemoryInput {
  kind: MemoryKind;
  content: string;
  /** 缺省为 `confirmed` → `user`，`candidate` → `inferred`。 */
  source?: MemorySource;
  origin?: MemoryOrigin;
}

export interface UpdateMemoryInput {
  content?: string;
  kind?: MemoryKind;
  origin?: MemoryOrigin;
}

export interface ListMemoriesFilter {
  kind?: MemoryKind;
  includeArchived?: boolean;
}

export interface BotStoreOptions {
  /** 数据目录；不存在时按需创建。 */
  baseDir: string;
}

export { StoreError, type StoreErrorCode } from './store-errors.js';

/** Windows 设备名即使带 `.json` 扩展名仍会被当作设备，不能作为存档文件名。 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export const botIdSchema = z
  .string()
  .max(64)
  .regex(BOT_ID_PATTERN, 'must start with [a-z0-9], use only [a-z0-9_-]')
  .refine((value) => !WINDOWS_RESERVED_NAME.test(value), { message: 'must not be a Windows device name' });
const sessionIdSchema = z.string().max(200).regex(SESSION_ID_PATTERN, 'must use only [A-Za-z0-9._:@-]');
const labelSchema = z.string().min(1).max(200);
const timestampSchema = z.string().min(1).max(64);
const fingerprintSchema = z.string().min(16).max(128).regex(/^[a-f0-9]+$/);
const requestIdSchema = z.string().min(1).max(200);

const botIdentitySchema = botDetailsSchema.extend({
  id: botIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,

});

const sessionLinkSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string().nullable(),
  workspaceId: labelSchema.nullable(),
  linkedAt: timestampSchema,
});

const creationIntentSchema = z.object({
  requestId: requestIdSchema,
  fingerprint: fingerprintSchema,
  agentId: z.string().min(1).max(200),
  status: z.enum(['pending', 'created']),
  acknowledged: z.boolean(),
});

const botRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  bot: botIdentitySchema,
  sessions: z.array(sessionLinkSchema),
  memories: z.array(memoryEntrySchema),
  creationIntents: z.array(creationIntentSchema).default([]),
});

const createBotSchema = botDetailsSchema.extend({ id: botIdSchema });

const linkSessionSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string().nullable().optional(),
  workspaceId: z.string().min(1).max(200).nullable().optional(),
});

const prepareCreationSchema = z.object({
  requestId: requestIdSchema,
  fingerprint: fingerprintSchema,
});

export const addMemorySchema = z.object({
  kind: memoryKindSchema,
  content: memoryContentSchema,
  source: memoryEntrySchema.shape.source.optional(),
  origin: memoryOriginSchema.optional(),
});

export const updateMemorySchema = z
  .object({
    content: memoryContentSchema.optional(),
    kind: memoryKindSchema.optional(),
    origin: memoryOriginSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.kind !== undefined, {
    message: 'at least one of content or kind is required',
  });

function parseInput<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || field}: ${issue.message}`);
    throw new StoreError('invalid_input', `invalid ${field}: ${issues.join('; ')}`, { field, issues });
  }
  return result.data;
}

/** 从一组记忆中筛出允许注入上下文的条目：只保留用户已确认的记忆。 */
export function selectInjectableMemories(memories: readonly MemoryEntry[]): MemoryEntry[] {
  return memories.filter((memory) => memory.kind === 'confirmed' && !memory.archivedAt);
}

function propose(intent: CreationIntent): CreationProposal {
  return intent.status === 'created' ? { action: 'known', intent } : { action: 'retry_pending', intent };
}

/** 同一 sessionId 只更新显式传入的标注，不改变 linkedAt。 */
function upsertSession(document: BotRecord, value: LinkSessionInput, now: string): SessionLink {
  const existing = document.sessions.find(session => session.sessionId === value.sessionId);
  if (existing) {
    if (value.title !== undefined) existing.title = value.title;
    if (value.workspaceId !== undefined) existing.workspaceId = value.workspaceId;
    return existing;
  }
  const link: SessionLink = { sessionId: value.sessionId, title: value.title ?? null, workspaceId: value.workspaceId ?? null, linkedAt: now };
  document.sessions.push(link);
  return link;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * 一个数据目录下的多 Bot 业务元数据存储。
 *
 * 约定：
 * - 同一实例内的写入按 botId 串行，避免读-改-写丢更新。
 * - 存档损坏或结构不兼容时报 `corrupt_store`，绝不回退成空存档。
 * - 多进程同时写同一 Bot 不受保护：产品约定为单 Paseo daemon 内的单一写入方。
 */
export class BotStore {
  private readonly baseDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: BotStoreOptions) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new StoreError('invalid_input', 'baseDir is required', { field: 'baseDir' });
    }
    this.baseDir = nodePath.resolve(baseDir, 'v2');
  }

  /** 首次打开即有固定主入口；不改写已有身份，也不启动执行 Agent。 */
  async ensureChief(): Promise<BotIdentity> {
    const existing = await this.getBot(CHIEF_BOT_ID);
    if (existing) return existing.bot;
    try {
      return (await this.createBot({ id: CHIEF_BOT_ID, name: 'Chief', role: '澄清、分工、跟进、核对并负责最终交付' })).bot;
    } catch (error) {
      // 并发首次打开由现有原子 create 决定唯一创建者。
      if (error instanceof StoreError && error.code === 'bot_exists') return (await this.getBot(CHIEF_BOT_ID))!.bot;
      throw error;
    }
  }

  async createBot(input: CreateBotInput): Promise<BotRecord> {
    const value = parseInput(createBotSchema, input, 'bot');
    return this.withLock(value.id, async () => {
      if (await this.readDocument(value.id)) {
        throw new StoreError('bot_exists', `bot ${value.id} already exists`);
      }
      const now = new Date().toISOString();
      const document: BotRecord = {
        schemaVersion: SCHEMA_VERSION,
        bot: { ...value, createdAt: now, updatedAt: now },
        sessions: [],
        memories: [],
        creationIntents: [],
      };
      await this.writeDocument(value.id, document);
      return document;
    });
  }

  /** execution 出现时整体替换；函数 patch 在已有写锁内基于最新配置计算。 */
  async updateBot(botId: string, input: BotPatch | ((current: BotIdentity) => BotPatch)): Promise<BotIdentity> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const supplied = typeof input === 'function' ? input : parseInput(botPatchSchema, input, 'bot');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const patch = typeof supplied === 'function' ? parseInput(botPatchSchema, supplied(document.bot), 'bot') : supplied;
      for (const key of Object.keys(patch) as (keyof BotPatch)[]) {
        if (patch[key] === undefined) delete patch[key];
      }
      document.bot = { ...document.bot, ...patch, updatedAt: new Date().toISOString() };
      await this.writeDocument(id, document);
      return document.bot;
    });
  }

  async getBot(botId: string): Promise<BotRecord | null> {
    const id = parseInput(botIdSchema, botId, 'botId');
    return this.withLock(id, () => this.readDocument(id));
  }

  async listBots(onCorrupt?: (id: string, error: StoreError) => void): Promise<BotIdentity[]> {
    const names = await this.listStoreFiles();
    const bots: BotIdentity[] = [];
    for (const id of names) {
      try {
        const document = await this.getBot(id);
        if (document) bots.push(document.bot);
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'corrupt_store' || !onCorrupt) throw error;
        onCorrupt(id, error);
      }
    }
    return bots;
  }

  /** 仅从 v2 注册会话/创建意图定位所有者；旧标签不能自动创建或认领记录。 */
  async findSessionOwner(agentId: string): Promise<BotRecord | null> {
    const id = parseInput(sessionIdSchema, agentId, 'sessionId');
    for (const botId of await this.listStoreFiles()) {
      const document = await this.getBot(botId);
      if (document && (document.sessions.some(session => session.sessionId === id) || document.creationIntents.some(intent => intent.agentId === id))) return document;
    }
    return null;
  }

  /** 相同参数重复调用不更新时间、不写盘；显式新标注仍可更新。 */
  async linkSession(botId: string, input: LinkSessionInput): Promise<SessionLink> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const value = parseInput(linkSessionSchema, input, 'session');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const previous = document.sessions.find(session => session.sessionId === value.sessionId);
      const before = previous ? { ...previous } : undefined;
      const now = new Date().toISOString();
      const link = upsertSession(document, value, now);
      if (isDeepStrictEqual(before, link)) return link;
      document.bot.updatedAt = now;
      await this.writeDocument(id, document);
      return link;
    });
  }

  /** 解除会话关联；返回是否真的删除过。 */
  async unlinkSession(botId: string, sessionId: string): Promise<boolean> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const sid = parseInput(sessionIdSchema, sessionId, 'sessionId');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const remaining = document.sessions.filter((session) => session.sessionId !== sid);
      if (remaining.length === document.sessions.length) return false;
      document.sessions = remaining;
      document.bot.updatedAt = new Date().toISOString();
      await this.writeDocument(id, document);
      return true;
    });
  }

  async listSessions(botId: string): Promise<SessionLink[]> {
    const document = await this.getBot(botId);
    if (!document) throw new StoreError('bot_not_found', `bot ${botId} not found`);
    return document.sessions;
  }

  /** 新增记忆：`kind` 决定它是明确记忆还是推断候选。 */
  async addMemory(botId: string, input: AddMemoryInput): Promise<MemoryEntry> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const value = parseInput(addMemorySchema, input, 'memory');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const result = addMemoryEntry(document.memories, value);
      if (result.changed) await this.writeDocument(id, document);
      return result.entry;
    });
  }

  /**
   * 纠正记忆：改内容、确认候选（`kind: 'confirmed'`）或降级回候选。
   * 纠正只改动本存储中的业务元数据，不触及 Paseo 原生历史或任何外部备份。
   */
  async updateMemory(botId: string, memoryId: string, input: UpdateMemoryInput, expectedContent?: string): Promise<MemoryEntry> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(z.string().min(1).max(64), memoryId, 'memoryId');
    const value = parseInput(updateMemorySchema, input, 'memory');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const result = updateMemoryEntry(document.memories, mid, value, expectedContent);
      if (result.changed) await this.writeDocument(id, document);
      return result.entry;
    });
  }

  /** 遗忘／拒绝以可恢复归档实现；默认读取及上下文不再包含该条目。 */
  async removeMemory(botId: string, memoryId: string, expectedContent?: string, origin?: MemoryOrigin): Promise<boolean> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(z.string().min(1).max(64), memoryId, 'memoryId');
    const actor = parseInput(memoryOriginSchema.optional(), origin, 'origin');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const removed = archiveMemoryEntry(document.memories, mid, expectedContent, actor);
      if (removed) await this.writeDocument(id, document);
      return removed;
    });
  }

  /** 只恢复原确认状态，不把被拒绝的候选隐式确认为事实。 */
  async restoreMemory(botId: string, memoryId: string): Promise<MemoryEntry> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(z.string().min(1).max(64), memoryId, 'memoryId');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const result = restoreMemoryEntry(document.memories, mid);
      if (result.changed) await this.writeDocument(id, document);
      return result.entry;
    });
  }

  /** 查看记忆，含未被确认的候选。`kind` 可只取一类。 */
  async listMemories(botId: string, filter: ListMemoriesFilter = {}): Promise<MemoryEntry[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const kind = filter.kind === undefined ? undefined : parseInput(memoryKindSchema, filter.kind, 'kind');
    const includeArchived = parseInput(z.boolean().optional(), filter.includeArchived, 'includeArchived');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      return document.memories.filter(memory => (includeArchived || !memory.archivedAt) && (kind === undefined || memory.kind === kind));
    });
  }

  /** 上下文注入入口：只返回用户已确认的记忆，推断候选永不注入。 */
  async getContextMemories(botId: string): Promise<MemoryEntry[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    return this.withLock(id, async () => selectInjectableMemories((await this.requireDocument(id)).memories));
  }

  /**
   * 原生 create 之前调用：在实例锁内决定是否新建意图，并把意图原子落盘。
   * 同 fingerprint 的未 ack 意图被复用（即使 requestId 变了）；
   * 不同输入登为独立新意图，不阻挡其他工作，旧未决保留可见；仅同一 requestId 改输入报 `request_conflict`。
   */
  async prepareCreation(botId: string, input: PrepareCreationInput): Promise<CreationProposal> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const value = parseInput(prepareCreationSchema, input, 'creation');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);

      const byRequest = document.creationIntents.find((intent) => intent.requestId === value.requestId);
      if (byRequest) {
        if (byRequest.fingerprint !== value.fingerprint) {
          throw new StoreError('request_conflict', `requestId ${value.requestId} was already used for a different input`, {
            field: 'requestId',
          });
        }
        return propose(byRequest);
      }

      const reusable = document.creationIntents
        .filter((intent) => !intent.acknowledged && intent.fingerprint === value.fingerprint)
        .at(-1);
      if (reusable) return propose(reusable);

      const intent: CreationIntent = {
        requestId: value.requestId,
        fingerprint: value.fingerprint,
        agentId: randomUUID(),
        status: 'pending',
        acknowledged: false,
      };
      document.creationIntents.push(intent);
      document.bot.updatedAt = new Date().toISOString();
      await this.writeDocument(id, document);
      return { action: 'create', intent };
    });
  }

  /** 原生创建成功后调用：把意图标为 created 并在同一次写入中关联会话。 */
  async completeCreation(
    botId: string,
    requestId: string,
    session: LinkSessionInput & { sessionId: string },
  ): Promise<{ intent: CreationIntent; session: SessionLink }> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const rid = parseInput(requestIdSchema, requestId, 'requestId');
    const value = parseInput(linkSessionSchema, session, 'session');
    return this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const intent = document.creationIntents.find((item) => item.requestId === rid);
      if (!intent) throw new StoreError('creation_not_found', `creation ${rid} not found on bot ${id}`);

      const now = new Date().toISOString();
      intent.status = 'created';
      const link = upsertSession(document, value, now);
      document.bot.updatedAt = now;
      await this.writeDocument(id, document);
      return { intent, session: link };
    });
  }

  /** 用户确认已收到创建结果，或已创建事项已由原生归档收尾；单纯创建回执不能代替。 */
  async acknowledgeCreation(botId: string, requestId: string): Promise<void> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const rid = parseInput(requestIdSchema, requestId, 'requestId');
    await this.withLock(id, async () => {
      const document = await this.requireDocument(id);
      const intent = document.creationIntents.find((item) => item.requestId === rid);
      if (!intent) throw new StoreError('creation_not_found', `creation ${rid} not found on bot ${id}`);
      if (intent.acknowledged) return;
      intent.acknowledged = true;
      document.bot.updatedAt = new Date().toISOString();
      await this.writeDocument(id, document);
    });
  }

  /** 供 UI 展示尚未确认收到结果或归档收尾的创建意图（含 pending 与 created）。 */
  async listPendingCreations(botId: string): Promise<CreationIntent[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    return this.withLock(id, async () => (await this.requireDocument(id)).creationIntents.filter((intent) => !intent.acknowledged));
  }

  private async requireDocument(botId: string): Promise<BotRecord> {
    const document = await this.readDocument(botId);
    if (!document) throw new StoreError('bot_not_found', `bot ${botId} not found`);
    return document;
  }

  private async withLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(botId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(botId, settled);
    try {
      return await result;
    } finally {
      if (this.locks.get(botId) === settled) this.locks.delete(botId);
    }
  }

  /**
   * Bot 标识 → 存档路径。标识本身已由 schema 限制，这里再做一次目录包含校验，
   * 保证任何输入都无法读写 baseDir 之外的文件。
   */
  private fileFor(botId: string): string {
    const name = botId === CHIEF_BOT_ID ? 'chief.json' : nodePath.join('specialists', `${botId}.json`);
    const file = nodePath.join(this.baseDir, name);
    const relative = nodePath.relative(this.baseDir, file);
    if (relative !== name || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
      throw new StoreError('invalid_input', `botId escapes the store directory: ${botId}`, { field: 'botId' });
    }
    return file;
  }

  private async readDocument(botId: string): Promise<BotRecord | null> {
    const file = this.fileFor(botId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StoreError('corrupt_store', `store file is not valid JSON: ${file}`, {
        issues: [error instanceof Error ? error.message : String(error)],
      });
    }

    const result = botRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new StoreError('corrupt_store', `store file does not match the expected schema: ${file}`, {
        issues: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      });
    }
    const document: BotRecord = result.data;
    if (document.bot.id !== botId) throw new StoreError('corrupt_store', `store identity does not match filename: ${file}`);
    return document;
  }

  /** 原子写：同目录临时文件 → fsync → rename 覆盖。 */
  private async writeDocument(botId: string, document: BotRecord): Promise<void> {
    await writeJsonFile(this.fileFor(botId), document);
  }

  private async listStoreFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(nodePath.join(this.baseDir, 'specialists'));
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return [CHIEF_BOT_ID];
      throw error;
    }
    return [CHIEF_BOT_ID, ...names
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => id !== CHIEF_BOT_ID && botIdSchema.safeParse(id).success)
      .sort()];
  }
}
