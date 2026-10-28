import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execCommand } from '@getpaseo/plugin/server';
import { simpleParser, type ParsedMail } from 'mailparser';
import { createTransport } from 'nodemailer';

/** Approved Gmail scope for one Bot account. Bound by the caller (outbox) as a fingerprint. */
export interface GmailConfig {
  /** gws executable name or path. */
  command: string;
  /** Fixed GOOGLE_WORKSPACE_CLI_CONFIG_DIR; gws owns OAuth state, this module never reads it. */
  configDir: string;
  /** Expected Gmail address, checked against getProfile before every account action. */
  account: string;
  /** Approved Gmail search query; every message read must be visible through it. */
  query: string;
}

/** Published `execCommand` resolves on exit 0 only; a non-zero CLI run rejects with `code`/stdout/stderr. */
export interface GmailExecResult {
  stdout: string;
  stderr: string;
}

export type GmailExecute = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; maxBuffer: number },
) => Promise<GmailExecResult>;

export type GmailErrorCode = 'not_found' | 'unknown';

/** Recognizable failure for callers; never carries gws stderr or credential material. */
export class GmailError extends Error {
  readonly code: GmailErrorCode;

  constructor(code: GmailErrorCode, message: string) {
    super(message);
    this.name = 'GmailError';
    this.code = code;
  }
}

export interface GmailMessageRef {
  id: string;
  threadId?: string;
}

export interface GmailListMessagesResult {
  messages: GmailMessageRef[];
  nextPageToken?: string;
}

/** Gmail resource JSON passed through after validating the identity fields used here. */
export interface GmailMessageJson {
  id: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface GmailMessageDetail {
  id: string;
  labelIds: string[];
  [key: string]: unknown;
}

export interface GmailDraftDetail {
  id: string;
  message: { id?: string; raw: string };
}

const MESSAGES_MAX_RESULTS = 20;
/** Gmail messages can approach 25MB; the default 1MB execFile buffer would truncate them. */
const GWS_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Credential/account overrides documented for gws (README "Environment Variables", `.env.example`):
 * TOKEN outranks every stored credential and CREDENTIALS_FILE outranks the config directory, so both
 * would bypass GOOGLE_WORKSPACE_CLI_CONFIG_DIR. CLIENT_ID/CLIENT_SECRET are removed with them, and
 * GOOGLE_APPLICATION_CREDENTIALS (ADC fallback added in gws 0.6.0) is removed to fail closed.
 */
const GWS_ENV_OVERRIDES = [
  'GOOGLE_WORKSPACE_CLI_TOKEN',
  'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE',
  'GOOGLE_WORKSPACE_CLI_CLIENT_ID',
  'GOOGLE_WORKSPACE_CLI_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** Structured gws exit codes; only used for the error message text. */
const GWS_EXIT_CODES: Record<number, string> = {
  1: 'API 错误',
  2: '认证错误',
  3: '参数校验错误',
  4: 'Discovery 错误',
  5: '内部错误',
};

const MESSAGE_ID_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;
const BASE64URL_TEXT = /^[A-Za-z0-9_\-+/]+={0,2}$/;
const ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads only the public gws/Google API error shape; free-form stderr text is never classified,
 * so a 404 in a message body cannot be turned into "not found".
 */
function structuredError(output: string): { code?: unknown; status?: unknown } | undefined {
  const text = output.trim();
  if (text === '') return undefined;
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.error)) continue;
    return { code: parsed.error.code, status: parsed.error.status };
  }
  return undefined;
}

function safeCodeText(code: unknown): string | undefined {
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  return undefined;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new GmailError('unknown', `${label} 缺失或为空`);
  return value;
}

/** Normalizes an RFC 5322 Message-ID to its bare `local@domain` form for queries and comparison. */
function messageIdValue(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  if (!MESSAGE_ID_PATTERN.test(inner)) throw new Error(`${label} 必须是 RFC 5322 Message-ID（形如 <id@domain>）`);
  return inner;
}

function messageIdHeader(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  return MESSAGE_ID_PATTERN.test(inner) ? inner : undefined;
}

function headerValue(message: GmailMessageJson, name: string): string | undefined {
  const payload = message.payload;
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return undefined;
  for (const header of payload.headers) {
    if (!isRecord(header)) continue;
    if (typeof header.name !== 'string' || header.name.toLowerCase() !== name.toLowerCase()) continue;
    if (typeof header.value === 'string') return header.value;
  }
  return undefined;
}

function messageLabels(message: GmailMessageJson): string[] | undefined {
  const labels = message.labelIds;
  if (labels === undefined) return undefined;
  if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string')) return undefined;
  return labels;
}

/** Gmail raw payloads are base64url; an RFC 5322 message always contains `:` and whitespace. */
function isEncodedRaw(value: string): boolean {
  return BASE64URL_TEXT.test(value.trim());
}

function decodeRaw(value: string): string {
  if (!isEncodedRaw(value)) return value;
  const text = Buffer.from(value.trim(), 'base64url').toString('utf8');
  if (text === '') throw new GmailError('unknown', '草稿 raw 无法解码为文本');
  return text;
}

/**
 * gws CLI adapter for one approved Gmail account. All calls are argv arrays with fixed
 * GOOGLE_WORKSPACE_CLI_CONFIG_DIR; OAuth and HTTP stay inside gws. Draft ids are not tracked:
 * the caller owns persisted action identity, so a restarted process can reuse a stored draftId.
 */
export class GmailClient {
  readonly config: GmailConfig;
  private readonly execute: GmailExecute;

  constructor(config: GmailConfig, execute: GmailExecute = execCommand) {
    for (const [field, value] of [['command', config.command], ['configDir', config.configDir], ['account', config.account], ['query', config.query]] as const) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`GmailConfig.${field} 不能为空`);
    }
    this.config = {
      command: config.command,
      configDir: config.configDir,
      account: config.account.trim(),
      query: config.query.trim(),
    };
    this.execute = execute;
  }

  async listMessages(pageToken?: string): Promise<GmailListMessagesResult> {
    await this.assertAccount();
    return this.listPage('gmail.users.messages.list', this.config.query, pageToken);
  }

  /** Reads a message only after paging the approved query proves the id is visible. */
  async getMessage(id: string): Promise<GmailMessageJson> {
    const messageId = requiredId(id, 'Gmail message id');
    await this.assertAccount();
    const visible = await this.isVisible(messageId);
    if (!visible) throw new GmailError('not_found', '该邮件不在已批准的查询范围内，未读取');
    const payload = await this.call('gmail.users.messages.get', ['gmail', 'users', 'messages', 'get'], {
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    if (!isRecord(payload) || payload.id !== messageId) throw new GmailError('unknown', 'gmail.users.messages.get 返回结构不可识别');
    return payload as GmailMessageJson;
  }

  async createDraft(raw: string): Promise<{ id: string }> {
    const message = requiredId(raw, '草稿 raw');
    const rfc = isEncodedRaw(message) ? decodeRaw(message) : message;
    await this.assertAccount();
    // Gmail drafts.create supports media upload, so the MIME travels as a file instead of argv:
    // Windows caps a command line near 32k (8k through .cmd) and process listings expose argv.
    let directory: string;
    try {
      directory = await mkdtemp(join(this.config.configDir, 'paseo-guys-draft-'));
    } catch {
      throw new GmailError('unknown', '无法在 gws 配置目录下创建临时上传目录');
    }
    const file = join(directory, 'message.eml');
    try {
      try {
        // gws only accepts uploads under its working directory, which this client fixes to configDir.
        await writeFile(file, rfc, { encoding: 'utf8', mode: 0o600 });
      } catch {
        throw new GmailError('unknown', '写入草稿上传文件失败');
      }
      const payload = await this.call('gmail.users.drafts.create', ['gmail', 'users', 'drafts', 'create'], { userId: 'me' }, { message: {} }, [
        '--upload',
        resolve(file),
        '--upload-content-type',
        'message/rfc822',
      ]);
      if (!isRecord(payload)) throw new GmailError('unknown', 'gmail.users.drafts.create 返回结构不可识别');
      const draftId = requiredId(payload.id, 'drafts.create 返回的草稿 id');
      return { id: draftId };
    } finally {
      // Best effort only: a leftover temp file says nothing about the mutation, so cleanup must not
      // turn a possible success into a reported failure. The directory is removed non-recursively.
      await unlink(file).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }

  /** Returns the draft's RFC 5322 text; Gmail's base64url payload is decoded here. */
  async getDraft(id: string): Promise<GmailDraftDetail> {
    const draftId = requiredId(id, 'Gmail draft id');
    await this.assertAccount();
    const payload = await this.call('gmail.users.drafts.get', ['gmail', 'users', 'drafts', 'get'], {
      userId: 'me',
      id: draftId,
      format: 'raw',
    });
    if (!isRecord(payload) || payload.id !== draftId || !isRecord(payload.message)) {
      throw new GmailError('unknown', 'gmail.users.drafts.get 返回结构不可识别');
    }
    const raw = requiredId(payload.message.raw, 'drafts.get 返回的 raw');
    const detail: GmailDraftDetail = { id: draftId, message: { raw: decodeRaw(raw) } };
    const messageId = payload.message.id;
    if (typeof messageId === 'string' && messageId !== '') detail.message.id = messageId;
    return detail;
  }

  /** Mutations are never retried here: an unconfirmed outcome stays unconfirmed for the caller. */
  async sendDraft(id: string): Promise<{ id: string; labelIds: string[] }> {
    const draftId = requiredId(id, 'Gmail draft id');
    await this.assertAccount();
    const payload = await this.call('gmail.users.drafts.send', ['gmail', 'users', 'drafts', 'send'], { userId: 'me' }, { id: draftId });
    if (!isRecord(payload)) throw new GmailError('unknown', 'gmail.users.drafts.send 返回结构不可识别');
    const sent = payload as GmailMessageJson;
    const messageId = requiredId(sent.id, 'drafts.send 返回的邮件 id');
    const labels = messageLabels(sent);
    if (!labels) throw new GmailError('unknown', 'drafts.send 未返回 labelIds，无法确认发送结果');
    return { id: messageId, labelIds: labels };
  }

  /** Fixed rfc822msgid lookup; lets a restarted outbox recover the draft id it persisted. */
  async findDrafts(rfcMessageId: string): Promise<{ id: string }[]> {
    const inner = messageIdValue(rfcMessageId, 'rfcMessageId');
    await this.assertAccount();
    const ids: { id: string }[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const payload = await this.call('gmail.users.drafts.list', ['gmail', 'users', 'drafts', 'list'], {
        userId: 'me', q: `rfc822msgid:${inner}`, maxResults: MESSAGES_MAX_RESULTS,
        ...(pageToken ? { pageToken } : {}),
      });
      if (!isRecord(payload)) throw new GmailError('unknown', 'gmail.users.drafts.list 返回结构不可识别');
      const drafts = payload.drafts ?? [];
      if (!Array.isArray(drafts)) throw new GmailError('unknown', 'gmail.users.drafts.list 的 drafts 不是数组');
      for (const draft of drafts) {
        if (!isRecord(draft)) throw new GmailError('unknown', 'drafts.list 的草稿项结构不可识别');
        ids.push({ id: requiredId(draft.id, 'drafts.list 返回的草稿 id') });
      }
      if (payload.nextPageToken === undefined) break;
      pageToken = requiredId(payload.nextPageToken, 'drafts.list 的 nextPageToken');
      if (seen.has(pageToken)) throw new GmailError('unknown', '草稿分页游标重复，无法确认唯一结果');
      seen.add(pageToken);
    }
    return ids;
  }

  /** Confirms SENT and the actual Message-ID header; list hits are not evidence on their own. */
  async findSent(rfcMessageId: string): Promise<{ id: string; labelIds: string[] }[]> {
    const inner = messageIdValue(rfcMessageId, 'rfcMessageId');
    await this.assertAccount();
    const candidates: GmailMessageRef[] = [];
    for await (const page of this.pages('gmail.users.messages.list', `in:sent rfc822msgid:${inner}`)) {
      candidates.push(...page.messages);
    }
    const sent: { id: string; labelIds: string[] }[] = [];
    for (const candidate of candidates) {
      let message: GmailMessageJson;
      try {
        const payload = await this.call('gmail.users.messages.get', ['gmail', 'users', 'messages', 'get'], {
          userId: 'me',
          id: candidate.id,
          format: 'metadata',
          metadataHeaders: ['Message-ID'],
        });
        if (!isRecord(payload) || payload.id !== candidate.id) throw new GmailError('unknown', 'gmail.users.messages.get 返回结构不可识别');
        message = payload as GmailMessageJson;
      } catch (error) {
        // A vanished candidate proves nothing about sending; only a structured 404 is skipped.
        if (error instanceof GmailError && error.code === 'not_found') continue;
        throw error;
      }
      const labels = messageLabels(message) ?? [];
      if (!labels.includes('SENT')) continue;
      if (messageIdHeader(headerValue(message, 'Message-ID')) !== inner) continue;
      sent.push({ id: candidate.id, labelIds: labels });
    }
    return sent;
  }

  private async assertAccount(): Promise<void> {
    const payload = await this.call('gmail.users.getProfile', ['gmail', 'users', 'getProfile'], { userId: 'me' });
    if (!isRecord(payload) || typeof payload.emailAddress !== 'string' || payload.emailAddress.trim() === '') {
      throw new GmailError('unknown', 'gws 未返回可核对的账户邮箱，未执行操作');
    }
    if (payload.emailAddress.trim().toLowerCase() !== this.config.account.toLowerCase()) {
      throw new GmailError('unknown', '当前 gws 登录账户与配置的 account 不一致，未执行操作');
    }
  }

  private async isVisible(messageId: string): Promise<boolean> {
    for await (const page of this.pages('gmail.users.messages.list', this.config.query)) {
      if (page.messages.some(message => message.id === messageId)) return true;
    }
    return false;
  }

  /** Pages one list call until the CLI stops returning a cursor, refusing to loop on a repeated one. */
  private async *pages(label: string, query: string): AsyncGenerator<GmailListMessagesResult> {
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const page = await this.listPage(label, query, pageToken);
      yield page;
      if (page.nextPageToken === undefined) return;
      if (seen.has(page.nextPageToken)) throw new GmailError('unknown', 'Gmail 分页游标重复，无法完成分页核对');
      seen.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
  }

  private async listPage(label: string, query: string, pageToken?: string): Promise<GmailListMessagesResult> {
    const params: Record<string, unknown> = { userId: 'me', q: query, maxResults: MESSAGES_MAX_RESULTS };
    if (pageToken !== undefined) params.pageToken = requiredId(pageToken, 'Gmail pageToken');
    const payload = await this.call(label, ['gmail', 'users', 'messages', 'list'], params);
    if (!isRecord(payload)) throw new GmailError('unknown', `${label} 返回结构不可识别`);
    const result: GmailListMessagesResult = { messages: [] };
    const raw = payload.messages;
    if (raw !== undefined) {
      if (!Array.isArray(raw)) throw new GmailError('unknown', `${label} 的 messages 不是数组`);
      for (const item of raw) {
        if (!isRecord(item)) throw new GmailError('unknown', `${label} 的 messages 项结构不可识别`);
        const ref: GmailMessageRef = { id: requiredId(item.id, `${label} 的 message id`) };
        if (typeof item.threadId === 'string' && item.threadId !== '') ref.threadId = item.threadId;
        result.messages.push(ref);
      }
    }
    if (payload.nextPageToken !== undefined) {
      result.nextPageToken = requiredId(payload.nextPageToken, `${label} 的 nextPageToken`);
    }
    return result;
  }

  private async call(
    label: string,
    path: string[],
    params: Record<string, unknown>,
    body?: Record<string, unknown>,
    extraArgs: string[] = [],
  ): Promise<unknown> {
    const args = [...path, '--params', JSON.stringify(params)];
    if (body !== undefined) args.push('--json', JSON.stringify(body));
    args.push(...extraArgs, '--format', 'json');
    let result: GmailExecResult;
    try {
      result = await this.execute(this.config.command, args, {
        env: this.isolatedEnv(),
        // gws loads a `.env` through dotenvy relative to the working directory; anchoring it to the
        // account's config dir keeps project files from redirecting the login in use.
        cwd: this.config.configDir,
        maxBuffer: GWS_MAX_BUFFER,
      });
    } catch (error) {
      throw this.describeFailure(label, error);
    }
    const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
    if (stdout === '') throw new GmailError('unknown', `${label} 未返回内容`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch {
      throw new GmailError('unknown', `${label} 返回的 JSON 无法解析`);
    }
    // A structured error is never treated as data, even if the CLI exits 0.
    if (isRecord(parsed) && isRecord(parsed.error)) throw this.describeStructured(label, parsed.error);
    return parsed;
  }

  private isolatedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of GWS_ENV_OVERRIDES) delete env[name];
    env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = this.config.configDir;
    return env;
  }

  private describeFailure(label: string, error: unknown): GmailError {
    const failure = isRecord(error) ? error : {};
    const exitCode = typeof failure.code === 'number' ? failure.code : undefined;
    const spawnCode = typeof failure.code === 'string' ? failure.code : undefined;
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    const structured = structuredError(stdout) ?? structuredError(stderr);
    if (structured !== undefined) return this.describeStructured(label, structured, exitCode);
    const exit = exitCode === undefined ? '' : `（退出码 ${exitCode}${GWS_EXIT_CODES[exitCode] === undefined ? '' : `：${GWS_EXIT_CODES[exitCode]}`}）`;
    const spawn = spawnCode === undefined ? '' : `（无法启动 gws：${spawnCode}）`;
    return new GmailError('unknown', `${label} 失败${exit}${spawn}`);
  }

  private describeStructured(label: string, error: Record<string, unknown>, exitCode?: number): GmailError {
    if (error.code === 404 || error.status === 'NOT_FOUND') {
      return new GmailError('not_found', `${label} 失败：Gmail 结构化错误码 404，目标不存在`);
    }
    const code = safeCodeText(error.code);
    const detail = code === undefined ? '' : `，Gmail 错误码 ${code}`;
    const exit = exitCode === undefined ? '' : `（退出码 ${exitCode}）`;
    return new GmailError('unknown', `${label} 失败${exit}${detail}`);
  }
}

export interface MailInput {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
  date: string;
}

function headerText(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  if (value.trim() === '') throw new Error(`${label} 不能为空`);
  if (/[\u0000\r\n]/.test(value)) throw new Error(`${label} 不能包含换行或控制字符`);
  return value;
}

function bareAddress(value: string, label: string): string {
  const address = headerText(value, label).trim();
  if (!ADDRESS_PATTERN.test(address)) throw new Error(`${label} 必须是单个纯邮箱地址`);
  return address;
}

/** Builds the RFC 5322 message locally; streamTransport generates MIME without any SMTP hop. */
export async function buildMail(input: MailInput): Promise<string> {
  const from = bareAddress(input.from, 'from');
  if (!Array.isArray(input.to) || input.to.length === 0) throw new Error('to 至少需要一个收件人');
  const to = input.to.map((address, index) => bareAddress(address, `to[${index}]`));
  if (new Set(to.map(address => address.toLowerCase())).size !== to.length) throw new Error('to 不能包含重复收件人');
  const subject = headerText(input.subject, 'subject');
  if (typeof input.text !== 'string') throw new Error('text 必须是字符串');
  if (/\u0000/.test(input.text)) throw new Error('text 不能包含 NUL');
  const text = input.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const messageId = `<${messageIdValue(input.messageId, 'messageId')}>`;
  if (typeof input.date !== 'string' || /[\u0000\r\n]/.test(input.date)) throw new Error('date 必须是合法日期字符串');
  const date = new Date(input.date);
  if (Number.isNaN(date.getTime())) throw new Error('date 必须是合法日期字符串');

  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await transport.sendMail({
    from,
    to,
    subject,
    text,
    messageId,
    date,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const message = info.message;
  if (typeof message === 'string') return message;
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  throw new Error('streamTransport 未返回可读的本地 MIME 内容');
}

export interface ExpectedMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
}

function addressList(value: ParsedMail['to']): string[] | undefined {
  if (value === undefined) return [];
  const objects = Array.isArray(value) ? value : [value];
  const addresses: string[] = [];
  for (const object of objects) {
    if (object === undefined) continue;
    for (const entry of object.value) {
      // Group syntax (name: a@x, b@y;) is an unapproved recipient shape.
      if (entry.group !== undefined || typeof entry.address !== 'string' || entry.address === '') return undefined;
      addresses.push(entry.address.trim().toLowerCase());
    }
  }
  return addresses;
}

/**
 * Compares the actual draft's parsed MIME with the approved content. Any unapproved header
 * (cc/bcc/html/replyTo/attachments) fails the match, so a caller cannot send something else.
 */
export async function matchesDraft(raw: string, expected: ExpectedMail): Promise<boolean> {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  let source: string;
  try {
    source = decodeRaw(raw);
  } catch {
    return false;
  }
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(source);
  } catch {
    return false;
  }

  const fromValues = parsed.from?.value ?? [];
  if (fromValues.length !== 1) return false;
  const from = fromValues[0]?.address;
  if (typeof from !== 'string' || from.trim().toLowerCase() !== expected.from.trim().toLowerCase()) return false;

  const to = addressList(parsed.to);
  if (to === undefined) return false;
  const expectedTo = expected.to.map(address => address.trim().toLowerCase());
  if (to.length !== expectedTo.length) return false;
  const actualSet = [...new Set(to)].sort();
  const expectedSet = [...new Set(expectedTo)].sort();
  if (actualSet.length !== expectedSet.length || actualSet.some((address, index) => address !== expectedSet[index])) return false;

  if (parsed.cc !== undefined || parsed.bcc !== undefined) return false;
  if (parsed.replyTo !== undefined) return false;
  if (parsed.html !== undefined && parsed.html !== false) return false;
  if (parsed.attachments.length !== 0) return false;
  if ((parsed.subject ?? '') !== expected.subject) return false;
  if (normalizeText(parsed.text ?? '') !== normalizeText(expected.text)) return false;
  if (messageIdHeader(parsed.messageId) !== messageIdValue(expected.messageId, 'messageId')) return false;
  return true;
}
