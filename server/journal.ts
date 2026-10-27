import { appendFile, mkdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { z } from 'zod';
import { botIdPattern } from './store.js';

/**
 * Bot 工作日志：只记录 Paseo 原生 agent 轮次事件的业务关联，每 Bot 一个 JSONL 文件。
 * 不存聊天内容，也不把原生轮次结束判定为任务完成；outcome 保留原生观察到的结果。
 */

export type JournalEventKind = 'turn_started' | 'turn_ended';
export type TurnOutcome = 'completed' | 'failed' | 'canceled';

/** 调用方提供的最小观察事实，`observedAt` 由本模块生成。 */
export interface Observation {
  agentId: string;
  turnId: string | null;
  kind: JournalEventKind;
  /** 仅在 `turn_ended` 时可选填写，原始轮次结果，不代表任务完成。 */
  outcome?: TurnOutcome;
  error?: string;
}

export interface JournalEntry extends Observation {
  observedAt: string;
}

export type JournalErrorCode = 'invalid_input' | 'corrupt_log';

export class JournalError extends Error {
  readonly code: JournalErrorCode;

  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

const nativeId = z.string().max(200).regex(/^[A-Za-z0-9._:@-]+$/, 'must use only [A-Za-z0-9._:@-]');
const errorText = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' })
  .transform((value) => value.trim());
/** 与 store 的 Bot 标识规则一致：小写标识，且不能是 Windows 设备名。 */
const botIdSchema = z
  .string()
  .max(64)
  .regex(botIdPattern, 'must start with [a-z0-9], use only [a-z0-9_-]')
  .refine((value) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value), { message: 'must not be a Windows device name' });

const observationSchema = z
  .object({
    agentId: nativeId,
    turnId: nativeId.nullable(),
    kind: z.enum(['turn_started', 'turn_ended']),
    outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
    error: errorText.optional(),
  })
  .refine((value) => value.kind === 'turn_ended' || (value.outcome === undefined && value.error === undefined), {
    message: 'outcome and error are only allowed on turn_ended',
  });

const entrySchema = z.object({
  agentId: nativeId,
  turnId: nativeId.nullable(),
  kind: z.enum(['turn_started', 'turn_ended']),
  outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
  error: errorText.optional(),
  observedAt: z.string().min(1).max(64),
});

function parseInput<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || field}: ${issue.message}`);
    throw new JournalError('invalid_input', `invalid ${field}: ${issues.join('; ')}`);
  }
  return result.data;
}

/**
 * 追加式工作日志。同一实例内按文件串行读写；多进程或多实例并发追加不在支持范围内，
 * 也不引入文件锁框架（产品约定单 Paseo daemon 内的单一写入方）。
 */
export class BotJournal {
  private readonly baseDir: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: { baseDir: string }) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new JournalError('invalid_input', 'baseDir is required');
    }
    this.baseDir = nodePath.resolve(baseDir);
  }

  /** 追加一条观察事实并返回实际写入的条目。 */
  async append(botId: string, observation: Observation): Promise<JournalEntry> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const entry: JournalEntry = {
      ...parseInput(observationSchema, observation, 'observation'),
      observedAt: new Date().toISOString(),
    };
    await this.serialize(id, async () => {
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(this.fileFor(id), `${JSON.stringify(entry)}\n`, 'utf8');
    });
    return entry;
  }

  /** 读取该 Bot 的全部日志；文件不存在返回空数组，损坏则报错并保留原文件。 */
  async read(botId: string): Promise<JournalEntry[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    return this.serialize(id, () => this.readFile(id));
  }

  private async readFile(botId: string): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(botId), 'utf8');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return [];
      throw error;
    }

    const entries: JournalEntry[] = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new JournalError('corrupt_log', `line ${index + 1} is not valid JSON: ${this.fileFor(botId)}`);
      }
      const result = entrySchema.safeParse(parsed);
      if (!result.success) {
        throw new JournalError('corrupt_log', `line ${index + 1} does not match the journal schema: ${this.fileFor(botId)}`);
      }
      entries.push(result.data);
    }
    return entries;
  }

  private fileFor(botId: string): string {
    return nodePath.join(this.baseDir, `${botId}.jsonl`);
  }

  private async serialize<T>(botId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(botId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(botId, settled);
    try {
      return await result;
    } finally {
      if (this.tails.get(botId) === settled) this.tails.delete(botId);
    }
  }
}
