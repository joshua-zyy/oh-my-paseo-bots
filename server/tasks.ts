import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { botIdSchema, type BotRecord, type BotStore } from './store.js';

/** 原生事项关联索引；仅保留既有完成/取消链路，不创建例程或实现 Phase 2 中枢。 */
const SCHEMA_VERSION = 2;
export const TASK_STOPPING_IN_FLIGHT = '正在停止：原生 archive 进行中，期间不再接受新的推进';

export type TaskStatus = 'active' | 'stopping' | 'canceled' | 'completed' | 'awaiting_review';
/** 一个 Paseo 原生会话承载的 Bot 事项。 */
export interface TaskRecord {
  agentId: string;
  /** 用户持续聊天的控制记录；不作为可完成的事项。 */
  conversation?: true;
  title: string;
  goal?: string;
  status: TaskStatus;
  summary?: string;
  evidence?: string[];
  /** 交付已保存，等待原生轮次结束后归档；不是新的交付或运行许可。 */
  completionPending?: true;
  detail?: string;
  /** 只记录原生父子 id 关系，不复制专家历史或记忆。 */
  specialists: string[];
}

export interface TaskDocument {
  schemaVersion: 2;
  tasks: TaskRecord[];
}

export interface TaskCli {
  /** 宿主配置的 bundled CLI 绝对路径或命令名；不在这里另装 daemon。 */
  command: string;
  /** 指定时传 `--home` 并清掉 PASEO_HOST，避免 TARGET_AMBIGUOUS。 */
  home?: string;
  /** 原生 CLI 的工作目录，同时作为 PASEO_AGENT_CWD。 */
  cwd: string;
}

/** 宿主设置通常在插件启动后才写入，所以允许延迟读取。 */
export type TaskCliProvider = TaskCli | (() => Promise<TaskCli>);

export type TaskExecute = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeout?: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TaskTrackerOptions {
  baseDir: string;
  store: BotStore;
  getPaseo: () => PaseoApi;
}

export type TaskErrorCode =
  | 'invalid_input'
  | 'bot_not_found'
  | 'agent_not_linked'
  | 'task_not_found'
  | 'task_not_active'
  | 'follow_conflict'
  | 'not_configured'
  | 'native_error'
  | 'archive_failed'
  | 'corrupt_store';

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

const TASK_STATUSES = ['active', 'stopping', 'canceled', 'completed', 'awaiting_review'] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const agentIdSchema = text(200);
const evidenceSchema = z.array(text(500)).max(20);

const titleSchema = z.string().trim().min(1);
const ensureSchema = z.object({ title: titleSchema, goal: text(2000).optional(), conversation: z.literal(true).optional() });
const stopSchema = z
  .object({
    outcome: z.enum(['canceled', 'completed']),
    summary: text(4000),
    evidence: evidenceSchema.optional(),
  })
  .refine((value) => value.outcome !== 'completed' || (value.evidence?.length ?? 0) > 0, {
    message: 'completed 必须给出至少一条交付证据；轮次结束或例程创建成功不等于任务完成',
    path: ['evidence'],
  });

const taskSchema = z.object({
  agentId: agentIdSchema,
  conversation: z.literal(true).optional(),
  title: titleSchema,
  goal: text(2000).optional(),
  status: z.enum(TASK_STATUSES),
  summary: text(4000).optional(),
  evidence: evidenceSchema.optional(),
  completionPending: z.literal(true).optional(),
  detail: text(2000).optional(),
  specialists: z.array(agentIdSchema),
});
const documentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  tasks: z.array(taskSchema),
});

function parseInput<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || field}: ${issue.message}`);
    throw new TaskError('invalid_input', `invalid ${field}: ${issues.join('; ')}`);
  }
  return result.data;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 对外只返回副本，调用方改不到存档里的对象。 */
function view(task: TaskRecord): TaskRecord {
  return {
    ...task,
    evidence: task.evidence ? [...task.evidence] : undefined,
    specialists: [...task.specialists],
  };
}

function requireTask(document: TaskDocument, agentId: string, botId: string): TaskRecord {
  const task = document.tasks.find((item) => item.agentId === agentId);
  if (!task) throw new TaskError('task_not_found', `Agent ${agentId} 在 Bot ${botId} 上没有登记事项`);
  return task;
}

function requireActiveTask(document: TaskDocument, agentId: string, botId: string): TaskRecord {
  const task = requireTask(document, agentId, botId);
  if (task.status !== 'active') {
    throw new TaskError('task_not_active', `事项 ${agentId} 当前状态为 ${task.status}，不再接受新的推进`);
  }
  return task;
}

/** 升级前就存在的会话没有任务记录：按 active 惰性补登，不因缺记录卡住已有 Bot 操作。 */
function adoptActiveTask(document: TaskDocument, agentId: string, botId: string): TaskRecord {
  if (!document.tasks.some((item) => item.agentId === agentId)) {
    const task: TaskRecord = { agentId, title: `会话 ${agentId}`, status: 'active', specialists: [] };
    document.tasks.push(task);
    return task;
  }
  return requireActiveTask(document, agentId, botId);
}

/** 文件读改写与同一 stop 复用原有锁；原生调用不在文件锁内。 */
export class TaskTracker {
  private readonly baseDir: string;
  private readonly store: BotStore;
  private readonly getPaseo: () => PaseoApi;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: TaskTrackerOptions) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new TaskError('invalid_input', 'baseDir is required');
    }
    this.baseDir = nodePath.resolve(baseDir, 'v2');
    this.store = options.store;
    this.getPaseo = options.getPaseo;
  }

  /** 幂等关联已存在的 Bot 会话（或创建意图）；不会创建会话，也不复制记忆。 */
  async ensure(botId: string, agentId: string, input: { title: string; goal?: string; conversation?: true }): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    const value = parseInput(ensureSchema, input, 'task');
    await this.requireAgent(id, aid);

    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const existing = document.tasks.find((task) => task.agentId === aid);
      if (existing) {
        return view(existing);
      }
      const task: TaskRecord = { agentId: aid, title: value.title, status: 'active', specialists: [] };
      if (value.conversation) task.conversation = true;
      if (value.goal !== undefined) task.goal = value.goal;
      document.tasks.push(task);
      await this.writeDocument(id, document);
      return view(task);
    });
  }

  /** 只读现有 v2 关联；用于原生临时专家的所属判定，不恢复任何 Agent。 */
  async findSpecialistOwner(agentId: string): Promise<{ botId: string; rootAgentId: string } | null> {
    const id = parseInput(agentIdSchema, agentId, 'agentId');
    for (const bot of await this.store.listBots()) {
      const root = (await this.list(bot.id)).find(task => task.status === 'active' && task.specialists.includes(id));
      if (root && await this.store.findSessionOwner(root.agentId)) return { botId: bot.id, rootAgentId: root.agentId };
    }
    return null;
  }

  async get(botId: string, agentId: string): Promise<TaskRecord | null> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    return this.withFileLock(id, async () => {
      const task = (await this.readDocument(id)).tasks.find((item) => item.agentId === aid);
      return task ? view(task) : null;
    });
  }

  async list(botId: string): Promise<TaskRecord[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    await this.requireBot(id);
    return this.withFileLock(id, async () => (await this.readDocument(id)).tasks.map(view));
  }

  /** 原生归档（含 Chief 级联归档）已发生，只同步业务停止状态，不再次执行归档或删除。 */
  async observeArchived(botId: string, agentId: string): Promise<TaskRecord | null> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    await this.requireAgent(id, aid);
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const task = document.tasks.find(item => item.agentId === aid);
      if (!task) return null;
      // stop() 自己归档时已是 stopping，其最终完成/取消结论仍由原请求写入。
      if (task.status !== 'active') return view(task);
      task.status = 'canceled';
      task.detail = '原生会话已归档，本事项已停止推进';
      await this.writeDocument(id, document);
      return view(task);
    });
  }

  /** 服务端推进入口：非 active 一律拒绝（stopping 后立即生效）。
   * 升级前已存在、还没有任务记录的会话按 active 惰性补登，避免卡住已有 Bot 的办公操作。 */
  async requireActive(
    botId: string,
    agentId: string,
  ): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    await this.requireAgent(id, aid);
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const existing = document.tasks.find((task) => task.agentId === aid);
      if (!existing) {
        const task = adoptActiveTask(document, aid, id);
        await this.writeDocument(id, document);
        return view(task);
      }
      return view(requireActiveTask(document, aid, id));
    });
  }

  /**
   * 停止事项：先持久 stopping，再 archive 原生会话，最后尽量删除已知原生 id。
   * complete_task 自上报时只保存完成报告；延至 turn.after 收尾，避免中断自己的工具回执。
   * archive 失败保留原结果与待收尾状态，可幂等重试。
   */
  async stop(
    botId: string,
    agentId: string,
    input: { outcome: 'canceled' | 'completed'; summary: string; evidence?: string[] },
    options: { deferArchive?: boolean } = {},
  ): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    let value = parseInput(stopSchema, input, 'stop');
    await this.requireAgent(id, aid);

    return this.withActionLock(`stop:${id}:${aid}`, async () => {
      const prepared = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const task = requireTask(document, aid, id);
        if (task.conversation) throw new TaskError('invalid_input', '持续聊天不能按事项完成或取消；请操作具体子事项');
        if (task.status === 'canceled' || task.status === 'completed') return task;
        task.status = 'stopping';
        task.detail = TASK_STOPPING_IN_FLIGHT;
        // 先把用户上报的结果落盘，避免 archive 之后的写入失败丢掉交付证据。
        task.summary = value.summary;
        if (value.evidence) task.evidence = value.evidence;
        await this.writeDocument(id, document);
        return task;
      });
      if (prepared.status === 'canceled' || (prepared.status === 'completed' && !prepared.completionPending)) return view(prepared);
      if (prepared.completionPending) {
        // 后续停止只收尾，不覆盖已保存的交付；重复工具调用不提前中断当前轮次。
        if (options.deferArchive) return view(prepared);
        value = parseInput(stopSchema, { outcome: 'completed', summary: prepared.summary, evidence: prepared.evidence }, 'completion');
      } else if (value.outcome === 'completed') {
        await this.reportToParent(id, prepared, 'completed');
        if (options.deferArchive) return this.withFileLock(id, async () => {
          const document = await this.readDocument(id);
          const current = requireTask(document, aid, id);
          current.status = 'completed';
          current.completionPending = true;
          current.detail = '交付报告已保存并回报；当前轮次结束后归档并停止原生跟进';
          await this.writeDocument(id, document);
          return view(current);
        });
      }

      try {
        await this.getPaseo().agents.ref(aid).archive();
      } catch (error) {
        const detail = `原生 archive 失败（${reason(error)}）；${prepared.completionPending ? '交付已保存但归档未确认' : '事项停在 stopping'}，可重试 stop`;
        await this.updateTaskDetail(id, aid, detail).catch(() => undefined);
        throw new TaskError('archive_failed', detail);
      }

      const stopped = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const current = requireTask(document, aid, id);
        current.status = value.outcome;
        delete current.completionPending;
        current.summary = value.summary;
        if (value.evidence) current.evidence = value.evidence;
        delete current.detail;
        await this.writeDocument(id, document);
        return view(current);
      });
      if (value.outcome === 'canceled') await this.reportToParent(id, stopped, 'canceled');
      return stopped;
    });
  }

  /** 仅收尾已上报的普通事项；成功、失败或取消的轮次结束都不改写交付证据。 */
  async settleCompletion(botId: string, agentId: string): Promise<void> {
    const task = await this.get(botId, agentId);
    if (!task?.completionPending || task.status !== 'completed') return;
    await this.stop(botId, agentId, { outcome: 'completed', summary: task.summary!, evidence: task.evidence });
  }

  /** SDK parent 只建立归属；通过原生通信回报实际登记且仍在进行的父事项或聊天。 */
  private async reportToParent(botId: string, task: TaskRecord, outcome: 'completed' | 'canceled'): Promise<void> {
    const paseo = this.getPaseo();
    const child = await paseo.agents.ref(task.agentId).refresh();
    const parentId = child?.agent.labels?.['paseo.parent-agent-id'];
    if (!parentId) return;
    const parent = await paseo.agents.ref(parentId).refresh();
    const parentBotId = (await this.store.findSessionOwner(parentId))?.bot.id;
    const parentTask = parentBotId ? await this.get(parentBotId, parentId) : null;
    if (parentTask?.status !== 'active' || parent?.agent.archivedAt || !parentTask.specialists.includes(task.agentId)) return;
    const message = outcome === 'completed'
      ? `固定同事 ${botId} 已保存子事项交付报告。请核对实际产物和主事项的完成条件，不把回报当成整个主事项完成。`
      : `固定同事 ${botId} 的子事项已取消，原生归档已确认停止。请向用户如实汇报；其他独立事项和持续聊天继续。`;
    await paseo.agents.ref(parentId).send(
      `${message}\n${JSON.stringify({ agentId: task.agentId, title: task.title, summary: task.summary, evidence: task.evidence })}`,
      { sourceAgentId: task.agentId, activeTurnBehavior: 'steer', messageId: `paseo-guys:${outcome === 'completed' ? 'delivery' : 'canceled'}:${task.agentId}` },
    );
  }

  /** 原生父子归属由 root hook 验证后调用；这里只记录 id 关系。 */
  async observeSpecialist(botId: string, rootAgentId: string, childId: string): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const root = parseInput(agentIdSchema, rootAgentId, 'rootAgentId');
    const child = parseInput(agentIdSchema, childId, 'childId');
    if (root === child) throw new TaskError('invalid_input', '专家 id 不能等于本事项的 Agent id');
    await this.requireAgent(id, root);

    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const task = adoptActiveTask(document, root, id);
      if (task.specialists.includes(child)) return view(task);
      task.specialists.push(child);
      await this.writeDocument(id, document);
      return view(task);
    });
  }

  private async updateTaskDetail(botId: string, agentId: string, detail: string): Promise<void> {
    await this.withFileLock(botId, async () => {
      const document = await this.readDocument(botId);
      requireTask(document, agentId, botId).detail = detail;
      await this.writeDocument(botId, document);
    });
  }

  private async requireBot(botId: string): Promise<void> {
    if (!(await this.store.getBot(botId))) throw new TaskError('bot_not_found', `Bot ${botId} 不存在`);
  }

  /** 关联来自服务端可信记录：本 Bot 的原生会话或创建意图。 */
  private async requireAgent(botId: string, agentId: string): Promise<BotRecord> {
    const bot = await this.store.getBot(botId);
    if (!bot) throw new TaskError('bot_not_found', `Bot ${botId} 不存在`);
    const linked =
      bot.sessions.some((session) => session.sessionId === agentId) ||
      bot.creationIntents.some((intent) => intent.agentId === agentId);
    if (!linked) throw new TaskError('agent_not_linked', `Agent ${agentId} 未关联到 Bot ${botId}`);
    return bot;
  }

  private withFileLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(`file:${botId}`, task);
  }

  private withActionLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(key, task);
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    try {
      return await result;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  private fileFor(botId: string): string {
    const directory = nodePath.join(this.baseDir, 'tasks');
    const file = nodePath.join(directory, `${botId}.json`);
    const relative = nodePath.relative(directory, file);
    if (relative !== `${botId}.json` || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
      throw new TaskError('invalid_input', `botId escapes the tasks directory: ${botId}`);
    }
    return file;
  }

  private async readDocument(botId: string): Promise<TaskDocument> {
    const file = this.fileFor(botId);
    let payload: string;
    try {
      payload = await readFile(file, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return { schemaVersion: SCHEMA_VERSION, tasks: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new TaskError('corrupt_store', `事项存档不是合法 JSON：${file}（${reason(error)}）`);
    }
    const result = documentSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      throw new TaskError('corrupt_store', `事项存档结构不符合预期：${file}（${issues.join('; ')}）`);
    }
    return result.data;
  }

  /** 原子写：同目录临时文件 → fsync → rename 覆盖。 */
  private async writeDocument(botId: string, document: TaskDocument): Promise<void> {
    const target = this.fileFor(botId);
    await mkdir(nodePath.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
