import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import { execCommand } from '@getpaseo/plugin/server';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { botIdPattern, type BotStore } from './store.js';

/**
 * A06/A08 的最小原生跟进关联：只记录「这个 Bot 事项」与原生会话、原生 heartbeat 的对应关系，
 * 不实现调度器、队列、Provider runner 或协作总线。
 *
 * - 例程一律通过公开 CLI 的 `heartbeat create` 建立，绑定到本事项的 Agent；不由插件保存
 *   原生 schedules，也不私造 RPC。
 * - 创建前先落盘意图（固定 --name），回执丢失只标 unknown；CLI 不提供 upsert，不盲重试。
 * - 停止先落盘 stopping（立刻拒绝新推进），再 `agents.ref(agentId).archive()`；archive 会把
 *   包括 ID 未知的 heartbeat 一并完成，随后尽量 delete 已知原生 id。
 * - 「创建成功」「轮次结束」都不等于任务完成；完成只能由主 Bot 显式上报交付证据。
 */

const SCHEMA_VERSION = 1;

export type TaskStatus = 'active' | 'stopping' | 'canceled' | 'completed';
export type FollowupStatus = 'pending' | 'active' | 'unknown' | 'inactive' | 'deleted';

/** 一条原生 heartbeat 例程。`key` 同时是 `--name`，用于事项内的本地幂等关联。 */
export interface TaskFollowup {
  key: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  nativeId?: string;
  status: FollowupStatus;
  detail?: string;
}

/** 一个 Paseo 原生会话承载的 Bot 事项。 */
export interface TaskRecord {
  agentId: string;
  title: string;
  goal?: string;
  status: TaskStatus;
  summary?: string;
  evidence?: string[];
  detail?: string;
  followups: TaskFollowup[];
  /** 只记录原生父子 id 关系，不复制专家历史或记忆。 */
  specialists: string[];
}

export interface TaskDocument {
  schemaVersion: 1;
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
  /** 可直接给值，也可给回调：宿主设置可能晚于插件启动。 */
  cli: TaskCliProvider;
  /** 默认使用已发布的 execCommand（argv 数组，不拼 shell 字符串）。 */
  execute?: TaskExecute;
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

const TASK_STATUSES = ['active', 'stopping', 'canceled', 'completed'] as const;
const FOLLOWUP_STATUSES = ['pending', 'active', 'unknown', 'inactive', 'deleted'] as const;
const CLI_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const botIdSchema = z.string().max(64).regex(botIdPattern, 'must use only [a-z0-9_-]');
const agentIdSchema = text(200);
const cronSchema = text(200).refine((value) => value.split(/\s+/).length >= 5, 'must be a cron expression');
const timezoneSchema = text(100).refine(
  (value) => /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value),
  'must be an IANA time zone',
);
const evidenceSchema = z.array(text(500)).max(20);

const titleSchema = z.string().trim().min(1);
const ensureSchema = z.object({ title: titleSchema, goal: text(2000).optional() });
const followSchema = z.object({
  name: text(120),
  prompt: text(8000),
  cron: cronSchema,
  timezone: timezoneSchema,
});
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

const followupSchema = z.object({
  key: text(200),
  name: text(120),
  cron: cronSchema,
  timezone: timezoneSchema,
  prompt: text(8000),
  nativeId: text(400).optional(),
  status: z.enum(FOLLOWUP_STATUSES),
  detail: text(2000).optional(),
});
const taskSchema = z.object({
  agentId: agentIdSchema,
  title: titleSchema,
  goal: text(2000).optional(),
  status: z.enum(TASK_STATUSES),
  summary: text(4000).optional(),
  evidence: evidenceSchema.optional(),
  detail: text(2000).optional(),
  followups: z.array(followupSchema),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 稳定原生名：只由 Bot 与用户给的例程名决定，参数变化会冲突而不是悄悄换名字。 */
function followupKey(botId: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'followup';
  const digest = createHash('sha256').update(`${botId}:${name.toLowerCase()}`).digest('hex').slice(0, 8);
  return `paseo-guys-${slug}-${digest}`;
}

/** 原生 CLI 回执的 id 只在明确字段上取，不猜结构。 */
function receiptId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return isRecord(parsed) && typeof parsed.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : undefined;
}

/** 只有发布 CLI 回执 `{id, status: 'deleted'}` 才算真的删除；退出码 0 不够。 */
function deleteConfirmed(stdout: string, nativeId: string): boolean {
  const trimmed = stdout.trim();
  if (trimmed === '') return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) && parsed.id === nativeId && parsed.status === 'deleted';
  } catch {
    return false;
  }
}

/** 对外只返回副本，调用方改不到存档里的对象。 */
function view(task: TaskRecord): TaskRecord {
  return {
    ...task,
    evidence: task.evidence ? [...task.evidence] : undefined,
    followups: task.followups.map((followup) => ({ ...followup })),
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
    const task: TaskRecord = { agentId, title: `会话 ${agentId}`, status: 'active', followups: [], specialists: [] };
    document.tasks.push(task);
    return task;
  }
  return requireActiveTask(document, agentId, botId);
}

/**
 * 一个数据目录下的事项追踪器，进程内共享单实例。
 *
 * 锁：`file:<bot>` 保护短读改写；`follow:<bot>:<agent>:<key>` 让同一例程的创建序列单飞，
 * 但 CLI 调用不在文件锁内，因此慢的原生调用不会卡住其他事项。
 */
export class TaskTracker {
  private readonly baseDir: string;
  private readonly store: BotStore;
  private readonly getPaseo: () => PaseoApi;
  private readonly cliOption: TaskCliProvider;
  private readonly execute: TaskExecute;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: TaskTrackerOptions) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new TaskError('invalid_input', 'baseDir is required');
    }
    this.baseDir = nodePath.resolve(baseDir);
    this.store = options.store;
    this.getPaseo = options.getPaseo;
    this.cliOption = options.cli;
    this.execute = options.execute ?? execCommand;
  }

  /** 幂等关联已存在的 Bot 会话（或创建意图）；不会创建会话，也不复制记忆。 */
  async ensure(botId: string, agentId: string, input: { title: string; goal?: string }): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    const value = parseInput(ensureSchema, input, 'task');
    await this.requireAgent(id, aid);

    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const existing = document.tasks.find((task) => task.agentId === aid);
      if (existing) return view(existing);
      const task: TaskRecord = { agentId: aid, title: value.title, status: 'active', followups: [], specialists: [] };
      if (value.goal !== undefined) task.goal = value.goal;
      document.tasks.push(task);
      await this.writeDocument(id, document);
      return view(task);
    });
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
   * 为这个事项登记（或复用）一条原生 heartbeat，绑定到本事项的 Agent。
   * 同 key 同参数幂等；同 key 不同 cron/时区/prompt 显式冲突。
   */
  async follow(
    botId: string,
    agentId: string,
    input: { name: string; prompt: string; cron: string; timezone: string },
  ): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    const value = parseInput(followSchema, input, 'followup');
    await this.requireAgent(id, aid);
    // 缺命令/工作目录时先报未配置，不留下待创建的意图。
    const cli = await this.resolveCli();
    const key = followupKey(id, value.name);

    return this.withActionLock(`follow:${id}:${aid}:${key}`, async () => {
      const planned = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const task = adoptActiveTask(document, aid, id);
        const existing = task.followups.find((item) => item.key === key);
        if (existing) {
          if (existing.cron !== value.cron || existing.timezone !== value.timezone || existing.prompt !== value.prompt) {
            throw new TaskError(
              'follow_conflict',
              `例程 ${key} 已用另一组 cron/时区/prompt 登记；不静默刷新已批准的动作范围`,
            );
          }
          if (existing.status === 'active' && existing.nativeId) return view(task);
          existing.status = 'unknown';
          existing.detail = '创建结果未知；原生 CLI 不支持同名幂等创建或列出 heartbeat，请人工核对。不会重复创建；取消事项仍可归档停止跟进';
          await this.writeDocument(id, document);
          return view(task);
        } else {
          task.followups.push({
            key,
            name: value.name,
            cron: value.cron,
            timezone: value.timezone,
            prompt: value.prompt,
            status: 'pending',
            detail: '已登记创建意图，等待原生 heartbeat 回执',
          });
        }
        await this.writeDocument(id, document);
        return null;
      });
      if (planned) return planned;

      let nativeId: string | undefined;
      try {
        const result = await this.run([...this.createArgs(value, key, cli)], aid, cli);
        nativeId = receiptId(result.stdout);
        if (!nativeId) throw new Error('原生回执缺少 heartbeat id');
      } catch (error) {
        return this.settleFollowup(id, aid, key, {
          detail: `原生回执未知（${reason(error)}）；请人工核对，不会重复创建。取消事项仍可归档停止跟进`,
        });
      }
      return this.settleFollowup(id, aid, key, { nativeId });
    });
  }

  /**
   * 停止事项：先持久 stopping，再 archive 原生会话（会中断轮次并完成该 Agent 全部 heartbeat），
   * 最后尽量删除已知原生 id。archive 失败留在 stopping，可幂等重试。
   */
  async stop(
    botId: string,
    agentId: string,
    input: { outcome: 'canceled' | 'completed'; summary: string; evidence?: string[] },
  ): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(agentIdSchema, agentId, 'agentId');
    const value = parseInput(stopSchema, input, 'stop');
    await this.requireAgent(id, aid);

    return this.withActionLock(`stop:${id}:${aid}`, async () => {
      const prepared = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const task = requireTask(document, aid, id);
        if (task.status === 'canceled' || task.status === 'completed') return task;
        task.status = 'stopping';
        task.detail = '正在停止：原生 archive 进行中，期间不再接受新的推进';
        // 先把用户上报的结果落盘，避免 archive 之后的写入失败丢掉交付证据。
        task.summary = value.summary;
        if (value.evidence) task.evidence = value.evidence;
        await this.writeDocument(id, document);
        return task;
      });
      if (prepared.status === 'canceled' || prepared.status === 'completed') return view(prepared);

      try {
        await this.getPaseo().agents.ref(aid).archive();
      } catch (error) {
        const detail = `原生 archive 失败（${reason(error)}）；事项停在 stopping，可重试 stop`;
        await this.updateTaskDetail(id, aid, detail).catch(() => undefined);
        throw new TaskError('archive_failed', detail);
      }

      const knownIds = prepared.followups.flatMap((followup) => (followup.nativeId ? [followup.nativeId] : []));
      const failures: string[] = [];
      const deleted = new Set<string>();
      const cli = await this.resolveCli().catch(() => null);
      if (knownIds.length > 0 && !cli) {
        failures.push(`宿主未配置原生 CLI，未删除已知例程：${knownIds.join(', ')}`);
      }
      for (const nativeId of cli ? knownIds : []) {
        try {
          const result = await this.run(this.deleteArgs(nativeId, cli!), aid, cli!);
          if (deleteConfirmed(result.stdout, nativeId)) deleted.add(nativeId);
          else failures.push(`${nativeId}: 删除回执未确认 deleted`);
        } catch (error) {
          failures.push(`${nativeId}: ${reason(error)}`);
        }
      }

      return this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const current = requireTask(document, aid, id);
        current.status = value.outcome;
        current.summary = value.summary;
        if (value.evidence) current.evidence = value.evidence;
        for (const followup of current.followups) {
          if (followup.status === 'deleted' || followup.status === 'inactive') continue;
          // archive 只完成/禁止执行，不等于删除；只有 CLI 回执确认才算 deleted。
          if (followup.nativeId && deleted.has(followup.nativeId)) {
            followup.status = 'deleted';
            followup.detail = 'CLI 已确认删除该原生 heartbeat';
          } else {
            followup.status = 'inactive';
            followup.detail = followup.nativeId
              ? '已随任务归档停止；删除未确认，可人工核对该原生 id'
              : '已随任务归档停止；无已确认的原生 id，删除未确认';
          }
        }
        current.detail = failures.length
          ? `任务已${value.outcome === 'canceled' ? '取消' : '完成'}；以下原生例程删除未确认（archive 已使其不再执行）：${failures.join('；')}`
          : undefined;
        await this.writeDocument(id, document);
        return view(current);
      });
    });
  }

  /** 原生父子归属由 root hook 验证后调用；这里只记录 id 关系。 */
  async observeSpecialist(botId: string, rootAgentId: string, childId: string): Promise<TaskRecord> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const root = parseInput(agentIdSchema, rootAgentId, 'rootAgentId');
    const child = parseInput(agentIdSchema, childId, 'childId');
    if (root === child) throw new TaskError('invalid_input', '专家 id 不能等于本事项的 Agent id');

    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const task = adoptActiveTask(document, root, id);
      if (task.specialists.includes(child)) return view(task);
      task.specialists.push(child);
      await this.writeDocument(id, document);
      return view(task);
    });
  }

  /**
   * 落盘一次创建结论。若事项已停止，迟到回执只登记 id 并标记 inactive（确认删除后才置 deleted），
   * 绝不把任务或例程复活。
   */
  private async settleFollowup(
    botId: string,
    agentId: string,
    key: string,
    patch: { nativeId?: string; detail?: string },
  ): Promise<TaskRecord> {
    const settled = await this.withFileLock(botId, async () => {
      const document = await this.readDocument(botId);
      const task = requireTask(document, agentId, botId);
      const followup = task.followups.find((item) => item.key === key);
      if (!followup) throw new TaskError('task_not_found', `例程 ${key} 不在事项 ${agentId} 上`);

      if (task.status !== 'active') {
        if (patch.nativeId) followup.nativeId = patch.nativeId;
        followup.status = 'inactive';
        followup.detail = patch.nativeId
          ? '任务已停止：迟到回执已登记 id，删除未确认'
          : '任务已停止：放弃该例程';
        await this.writeDocument(botId, document);
        return { record: view(task), late: patch.nativeId };
      }

      if (patch.nativeId) {
        followup.nativeId = patch.nativeId;
        followup.status = 'active';
        delete followup.detail;
      } else {
        followup.status = 'unknown';
        followup.detail = patch.detail;
      }
      await this.writeDocument(botId, document);
      return { record: view(task), late: undefined };
    });
    if (!settled.late) return settled.record;

    const detail = await this.deleteLate(botId, settled.late, agentId, key);
    return detail ?? settled.record;
  }

  /** 迟到 id 的删除与结果回写都是尽力而为；只有回执确认才算 deleted。 */
  private async deleteLate(botId: string, nativeId: string, agentId: string, key: string): Promise<TaskRecord | null> {
    let confirmed = false;
    let detail: string;
    const cli = await this.resolveCli().catch(() => null);
    if (!cli) {
      detail = `宿主未配置原生 CLI，迟到的原生 heartbeat ${nativeId} 未删除，需人工核对`;
    } else {
      try {
        const result = await this.run(this.deleteArgs(nativeId, cli), agentId, cli);
        confirmed = deleteConfirmed(result.stdout, nativeId);
        detail = confirmed
          ? '迟到回执的原生 heartbeat 已确认删除'
          : `迟到回执的原生 heartbeat 删除未确认，需人工核对 ${nativeId}`;
      } catch (error) {
        detail = `迟到回执的原生 heartbeat 删除失败（${reason(error)}），需人工核对 ${nativeId}`;
      }
    }
    return this.withFileLock(botId, async () => {
      const document = await this.readDocument(botId);
      const task = requireTask(document, agentId, botId);
      const followup = task.followups.find((item) => item.key === key);
      if (followup) {
        followup.status = confirmed ? 'deleted' : 'inactive';
        followup.detail = detail;
      }
      await this.writeDocument(botId, document);
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

  private createArgs(value: { prompt: string; cron: string; timezone: string }, key: string, cli: TaskCli): string[] {
    return [
      'heartbeat',
      'create',
      value.prompt,
      '--cron',
      value.cron,
      '--timezone',
      value.timezone,
      '--name',
      key,
      ...(cli.home ? ['--home', cli.home] : []),
      '--json',
    ];
  }

  private deleteArgs(nativeId: string, cli: TaskCli): string[] {
    return ['schedule', 'delete', nativeId, ...(cli.home ? ['--home', cli.home] : []), '--json'];
  }

  /** 宿主设置通常晚于插件启动写入；缺命令/目录时只拦住需要 CLI 的例程操作。 */
  private async resolveCli(): Promise<TaskCli> {
    let cli: TaskCli | undefined;
    try {
      cli = typeof this.cliOption === 'function' ? await this.cliOption() : this.cliOption;
    } catch (error) {
      throw new TaskError('not_configured', `无法读取宿主 CLI 配置：${reason(error)}`);
    }
    const command = typeof cli?.command === 'string' ? cli.command.trim() : '';
    const cwd = typeof cli?.cwd === 'string' ? cli.cwd.trim() : '';
    if (command === '' || cwd === '') {
      throw new TaskError('not_configured', '宿主未配置原生 paseo CLI 的命令或工作目录，无法登记例程');
    }
    return { command, cwd, ...(cli?.home ? { home: cli.home } : {}) };
  }

  /** 宿主 CLI：argv 数组 + 固定 Agent 绑定；指定 home 时清掉 PASEO_HOST 以免目标歧义。 */
  private envFor(agentId: string, cli: TaskCli): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PASEO_AGENT_ID: agentId, PASEO_AGENT_CWD: cli.cwd };
    if (cli.home) delete env.PASEO_HOST;
    return env;
  }

  private async run(args: string[], agentId: string, cli: TaskCli): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.execute(cli.command, args, {
        env: this.envFor(agentId, cli),
        cwd: cli.cwd,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
      });
    } catch (error) {
      throw new TaskError('native_error', `原生 CLI ${args.slice(0, 2).join(' ')} 失败：${reason(error)}`);
    }
  }

  private async requireBot(botId: string): Promise<void> {
    if (!(await this.store.getBot(botId))) throw new TaskError('bot_not_found', `Bot ${botId} 不存在`);
  }

  /** 关联来自服务端可信记录：本 Bot 的原生会话或创建意图。 */
  private async requireAgent(botId: string, agentId: string): Promise<void> {
    const bot = await this.store.getBot(botId);
    if (!bot) throw new TaskError('bot_not_found', `Bot ${botId} 不存在`);
    const linked =
      bot.sessions.some((session) => session.sessionId === agentId) ||
      bot.creationIntents.some((intent) => intent.agentId === agentId);
    if (!linked) throw new TaskError('agent_not_linked', `Agent ${agentId} 未关联到 Bot ${botId}`);
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
