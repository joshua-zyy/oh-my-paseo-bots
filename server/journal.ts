import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import nodePath from 'node:path';
import { createInterface } from 'node:readline';
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

/** 有界读取结果：最新 `limit` 条有效记录，外加全量计数与损坏行号。 */
export interface JournalInspection {
  entries: JournalEntry[];
  /** 文件中全部有效记录数，与 `entries.length` 无关。 */
  total: number;
  corruptCount: number;
  /** 流式读取中最早遇到的至多 20 个损坏行号（从 1 起），完整计数见 `corruptCount`。 */
  corruptLines: number[];
}

export interface InspectOptions {
  /** 返回的最新记录条数，默认 50，上限 200。 */
  limit?: number;
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

const DEFAULT_INSPECT_LIMIT = 50;
const MAX_INSPECT_LIMIT = 200;
const MAX_CORRUPT_LINES = 20;

const inspectOptionsSchema = z.object({
  limit: z.number().int().min(1).max(MAX_INSPECT_LIMIT).optional(),
});

function parseInput<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || field}: ${issue.message}`);
    throw new JournalError('invalid_input', `invalid ${field}: ${issues.join('; ')}`);
  }
  return result.data;
}

/** 一次流式扫描的累积结果；`firstCorrupt` 让严格读取保留原有报错文案。 */
interface ScanOutcome {
  entries: JournalEntry[];
  total: number;
  corruptCount: number;
  corruptLines: number[];
  firstCorrupt: { line: number; reason: string } | null;
}

function recordCorrupt(outcome: ScanOutcome, line: number, reason: string): void {
  outcome.corruptCount += 1;
  if (outcome.corruptLines.length < MAX_CORRUPT_LINES) outcome.corruptLines.push(line);
  outcome.firstCorrupt ??= { line, reason };
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
      await this.appendLine(this.fileFor(id), JSON.stringify(entry));
    });
    return entry;
  }

  /** 读取该 Bot 的全部日志；文件不存在返回空数组，损坏则报错并保留原文件。 */
  async read(botId: string): Promise<JournalEntry[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    return this.serialize(id, async () => {
      const outcome = await this.scan(id, Number.POSITIVE_INFINITY);
      if (outcome.firstCorrupt) {
        throw new JournalError(
          'corrupt_log',
          `line ${outcome.firstCorrupt.line} ${outcome.firstCorrupt.reason}: ${this.fileFor(id)}`,
        );
      }
      return outcome.entries;
    });
  }

  /**
   * 有界查看该 Bot 的日志：流式扫描原文件，只保留最新 `limit` 条有效记录，
   * 损坏行显式计数并给出前若干行号，不修改原文件，也不静默丢弃警告。
   */
  async inspect(botId: string, options?: InspectOptions): Promise<JournalInspection> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const { limit } = parseInput(inspectOptionsSchema, options ?? {}, 'options');
    return this.serialize(id, async () => {
      const outcome = await this.scan(id, limit ?? DEFAULT_INSPECT_LIMIT);
      return {
        entries: outcome.entries,
        total: outcome.total,
        corruptCount: outcome.corruptCount,
        corruptLines: outcome.corruptLines,
      };
    });
  }

  /** 流式逐行解析；内存只保留最新 `limit` 条有效记录，`Infinity` 表示保留全部。 */
  private scan(botId: string, limit: number): Promise<ScanOutcome> {
    const file = this.fileFor(botId);
    const outcome: ScanOutcome = { entries: [], total: 0, corruptCount: 0, corruptLines: [], firstCorrupt: null };
    return new Promise<ScanOutcome>((resolve, reject) => {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      let lineNumber = 0;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        lines.close();
        stream.destroy();
        // readline 会把输入流的错误转发到接口上，因此 ENOENT 在这里统一按“无日志”处理。
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          resolve(outcome);
          return;
        }
        reject(error);
      };
      stream.on('error', fail);
      lines.on('error', fail);
      lines.on('line', (line: string) => {
        lineNumber += 1;
        if (settled || line.trim() === '') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          recordCorrupt(outcome, lineNumber, 'is not valid JSON');
          return;
        }
        const result = entrySchema.safeParse(parsed);
        if (!result.success) {
          recordCorrupt(outcome, lineNumber, 'does not match the journal schema');
          return;
        }
        outcome.total += 1;
        outcome.entries.push(result.data);
        if (outcome.entries.length > limit) outcome.entries.shift();
      });
      lines.on('close', () => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      });
    });
  }

  private async appendLine(file: string, line: string): Promise<void> {
    // 'a+' 只受本进程内的实例锁保护；多进程并发追加仍不在支持范围内。
    const handle = await open(file, 'a+');
    try {
      const { size } = await handle.stat();
      let payload = `${line}\n`;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const { bytesRead } = await handle.read(last, 0, 1, size - 1);
        // 上次写入可能中途崩溃留下半行：先补分隔符并保留原字节，让新记录独立成行。
        if (bytesRead === 1 && last[0] !== 0x0a) payload = `\n${payload}`;
      }
      await handle.appendFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
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
