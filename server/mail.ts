import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import { z } from 'zod';
import { botIdPattern, type BotStore } from './store.js';

/**
 * Gmail 专用外发登记（不是通用工作流/权限平台）。
 *
 * 只记录一件事的状态：Agent 起草 → 用户确认或固定预授权 → 创建 Gmail 草稿 → 发送。
 * 目标是把「草稿已创建」和「邮件已发送」分开，并在超时/回执丢失时只回查、不盲目重发。
 *
 * - 真实 Gmail 调用全部经 `getClient(botId)` 注入；本模块测试只用 fake client。
 * - 网络调用在文件锁之外，只有状态落盘在锁内：`file:<bot>` 短读改写锁 + `action:<bot>:<id>` 副作用锁。
 * - 存档 `<baseDir>/mail/<bot>.json`，临时文件 + fsync + rename 原子替换；损坏即报错，不回空、不自动修复。
 * - 对外的 `MailAction` 不含 raw；raw 只在存档内固定，用于核对与发送。
 */

const SCHEMA_VERSION = 1;
const MESSAGE_ID_DOMAIN = 'paseo-guys.local';

/** 已验证的 Gmail 客户端接口，由 gmail.ts 实现（真实网络只在那里）。 */
export interface GmailClient {
  readonly config: { command: string; configDir: string; account: string; query: string };
  /** 生成固定 MIME；messageId 不带尖括号，编码由连接器处理。 */
  buildMail(input: MailFields): string | Promise<string>;
  /** 当前草稿 raw 是否与批准内容完全一致。 */
  matchesDraft(raw: string, expected: MailContent): boolean | Promise<boolean>;
  createDraft(raw: string): Promise<{ id: string }>;
  getDraft(id: string): Promise<{ id: string; message: { id?: string; raw: string } }>;
  sendDraft(id: string): Promise<{ id: string; labelIds: string[] }>;
  findDrafts(rfcMessageId: string): Promise<Array<{ id: string }>>;
  /** 只在已证明 SENT 且实际 Message-ID 匹配时返回。 */
  findSent(rfcMessageId: string): Promise<Array<{ id: string; labelIds: string[] }>>;
  /** 先按已批准的 query 确认范围，再取内容；越界必须可判别地失败。 */
  getMessage(id: string): Promise<{ id: string }>;
}

/** 一封信的批准内容；buildMail 再多一个 date。 */
export interface MailContent {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
}

export interface MailFields extends MailContent {
  date: string;
}

export type MailStatus =
  | 'pending_confirmation'
  | 'approved'
  | 'creating_draft'
  | 'draft'
  | 'draft_unknown'
  | 'sending'
  | 'sent'
  | 'send_unknown'
  | 'revoked';

/** 对外可见的外发事项；不含 raw。 */
export interface MailAction {
  id: string;
  requestId: string;
  agentId: string;
  /** 已批准的账户与查询范围，来自 Bot 配置（不来自 Agent 参数）。 */
  account: string;
  query: string;
  to: string[];
  subject: string;
  text: string;
  sourceIds: string[];
  /** RFC Message-ID（固定 UUID@paseo-guys.local），同时是回查凭据。 */
  messageId: string;
  date: string;
  status: MailStatus;
  /** 账户 + 查询 + 收件人 + 主题 + 正文 + 来源 的指纹；固定预授权按它精确匹配。 */
  contentHash: string;
  draftId?: string;
  sentId?: string;
  detail?: string;
  /** 仅用户显式批准时写入；固定预授权批准不写，撤销 grant 后立即失效。 */
  approvedAt?: string;
  grantId?: string;
}

/** 固定预授权：只覆盖这一事项、同账户/查询、完全相同的收件人/主题/正文/来源。 */
export interface MailGrant {
  id: string;
  actionId: string;
  agentId: string;
  account: string;
  query: string;
  to: string[];
  subject: string;
  text: string;
  sourceIds: string[];
  contentHash: string;
  createdAt: string;
  revokedAt?: string;
}

interface StoredMailAction extends MailAction {
  raw: string;
}

interface MailDocument {
  schemaVersion: 1;
  actions: StoredMailAction[];
  grants: MailGrant[];
}

export interface MailProposalInput {
  requestId: string;
  to: string[];
  subject: string;
  text: string;
  /** 允许为空：普通新邮件不强制要求回复来源。 */
  sourceIds?: string[];
}

export interface MailOutboxOptions {
  baseDir: string;
  store: BotStore;
  getClient: (botId: string) => Promise<GmailClient>;
  requireActive?: (botId: string, agentId: string) => Promise<unknown>;
}

export type MailErrorCode =
  | 'invalid_input'
  | 'bot_not_found'
  | 'agent_not_linked'
  | 'action_not_found'
  | 'grant_not_found'
  | 'request_conflict'
  | 'not_approved'
  | 'not_approvable'
  | 'in_flight'
  | 'wrong_agent'
  | 'not_configured'
  | 'source_not_scoped'
  | 'account_mismatch'
  | 'corrupt_store';

/** 可判别的外发错误；服务层按 `code` 分支，不匹配文本。 */
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly details?: { field?: string; issues?: string[] };

  constructor(code: MailErrorCode, message: string, details?: { field?: string; issues?: string[] }) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.details = details;
  }
}

const MAIL_STATUSES = [
  'pending_confirmation',
  'approved',
  'creating_draft',
  'draft',
  'draft_unknown',
  'sending',
  'sent',
  'send_unknown',
  'revoked',
] as const;

const address = z.string().min(3).max(254).regex(/^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/, 'must be an email address');
const subject = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n\u0000-\u001f]/.test(value), 'must be a single header line')
  .transform((value) => value.trim());
const text = z.string().min(1).max(20000).refine((value) => value.trim().length > 0, 'must not be blank');
const sourceId = z.string().min(1).max(400).regex(/^[^\s<>"]+$/, 'must not contain whitespace or quotes');
const id = (max: number) => z.string().min(1).max(max);
const stamp = id(100);
const recipients = z.array(address).min(1).max(20);
const botIdSchema = z.string().max(64).regex(botIdPattern, 'must use only [a-z0-9_-]');
const contentShape = {
  account: address,
  query: z.string().min(1).max(2000),
  to: recipients,
  subject,
  text,
  sourceIds: z.array(sourceId).max(50),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
};

const proposeSchema = z.object({
  requestId: id(200),
  to: recipients,
  subject,
  text,
  sourceIds: z.array(sourceId).max(50).default([]),
});
const storedActionSchema = z.object({
  id: id(64),
  requestId: id(200),
  agentId: id(200),
  ...contentShape,
  messageId: id(400),
  date: id(100),
  status: z.enum(MAIL_STATUSES),
  draftId: id(400).optional(),
  sentId: id(400).optional(),
  detail: z.string().min(1).max(2000).optional(),
  approvedAt: stamp.optional(),
  grantId: id(64).optional(),
  raw: z.string().min(1).max(400000),
});
const grantSchema = z.object({
  id: id(64),
  actionId: id(64),
  agentId: id(200),
  ...contentShape,
  createdAt: stamp,
  revokedAt: stamp.optional(),
});
const documentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  actions: z.array(storedActionSchema),
  grants: z.array(grantSchema),
});

type ActionPatch = Partial<Pick<StoredMailAction, 'status' | 'detail' | 'draftId' | 'sentId' | 'approvedAt' | 'grantId'>>;

/** 补丁语义：`undefined` 表示删除该字段（例如发送成功后清掉 detail）。 */
function applyPatch<T extends MailAction>(action: T, patch: ActionPatch): void {
  // SAFETY: 补丁键都取自 MailAction 自身字段，只按名赋值或删除，不引入新结构。
  const target = action as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || field}: ${issue.message}`);
    throw new MailError('invalid_input', `invalid ${field}: ${issues.join('; ')}`, { field, issues });
  }
  return result.data;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function view(action: StoredMailAction): MailAction {
  const { raw: _raw, ...visible } = action;
  return visible;
}

/** 指纹只覆盖内容与范围；收件人按顺序无关比较，来源按集合比较。 */
function fingerprint(input: { account: string; query: string; to: string[]; subject: string; text: string; sourceIds: string[] }): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        account: input.account,
        query: input.query,
        to: input.to.map((value) => value.toLowerCase()).sort(),
        subject: input.subject,
        text: input.text,
        sourceIds: [...input.sourceIds].sort(),
      }),
    )
    .digest('hex');
}

function requireAction(document: MailDocument, actionId: string, botId: string): StoredMailAction {
  const action = document.actions.find((item) => item.id === actionId);
  if (!action) throw new MailError('action_not_found', `事项 ${actionId} 不属于 Bot ${botId}`);
  return action;
}

function activeGrant(document: MailDocument, action: StoredMailAction): MailGrant | undefined {
  const grant = action.grantId ? document.grants.find((item) => item.id === action.grantId) : undefined;
  if (!grant || grant.revokedAt || grant.agentId !== action.agentId || grant.contentHash !== action.contentHash) {
    return undefined;
  }
  return grant;
}

/** 发送准入：用户显式批准，或仍未撤销的固定预授权。 */
function assertAuthorized(document: MailDocument, action: StoredMailAction): void {
  if (action.approvedAt || activeGrant(document, action)) return;
  const why = action.grantId ? '固定预授权已撤销或已失效，需用户重新确认' : '未获用户批准：先 approve，或为完全相同的内容建立固定预授权';
  throw new MailError('not_approved', `事项 ${action.id} ${why}`);
}

/** 已登记的事项只能在记录中的账户与查询范围上继续；换账户后不静默迁移。 */
function assertSameScope(action: StoredMailAction, config: GmailClient['config']): void {
  const account = config.account?.trim();
  const query = config.query?.trim();
  if (account === action.account && query === action.query) return;
  throw new MailError(
    'account_mismatch',
    `事项 ${action.id} 记录的是 ${action.account} / 「${action.query}」，当前配置是 ${account ?? ''} / 「${query ?? ''}」：不会在新账户或新范围上继续，请先还原原账户与查询范围`,
  );
}

/**
 * 一个数据目录下的外发登记，进程内共享单实例。
 *
 * 网络调用一律在文件锁外进行，所以某个未知或慢动作不会卡住同一 Bot 的其他事项。
 */
export class MailOutbox {
  private readonly baseDir: string;
  private readonly store: BotStore;
  private readonly getClient: (botId: string) => Promise<GmailClient>;
  private readonly requireActive?: MailOutboxOptions['requireActive'];
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: MailOutboxOptions) {
    const baseDir = options?.baseDir;
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new MailError('invalid_input', 'baseDir is required', { field: 'baseDir' });
    }
    this.baseDir = nodePath.resolve(baseDir);
    this.store = options.store;
    this.getClient = options.getClient;
    this.requireActive = options.requireActive;
  }

  /**
   * 登记一次外发提案：只落盘，不调用任何 Gmail 写方法。
   * 同 requestId 同指纹幂等；同指纹的未决提案复用；同 requestId 异输入报 `request_conflict`。
   */
  async propose(botId: string, agentId: string, input: MailProposalInput): Promise<MailAction> {
    await this.requireActive?.(botId, agentId);
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(id200, agentId, 'agentId');
    const value = parseInput(proposeSchema, input, 'mail');
    await this.requireAgent(id, aid);
    const client = await this.clientFor(id);
    const { account, query } = client.config;
    const contentHash = fingerprint({ account, query, ...value, sourceIds: value.sourceIds });

    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const byRequest = document.actions.find((action) => action.requestId === value.requestId);
      if (byRequest) {
        if (byRequest.agentId !== aid || byRequest.contentHash !== contentHash) {
          throw new MailError('request_conflict', `requestId ${value.requestId} 已用于另一个不同的事项`, {
            field: 'requestId',
          });
        }
        return view(byRequest);
      }

      const unresolved = (action: StoredMailAction) => action.status !== 'sent' && action.status !== 'revoked';
      const reusable = document.actions
        .filter((action) => action.agentId === aid && action.contentHash === contentHash && unresolved(action))
        .at(-1);
      if (reusable) return view(reusable);

      const messageId = `${randomUUID()}@${MESSAGE_ID_DOMAIN}`;
      const date = new Date().toUTCString();
      let raw: string;
      try {
        raw = await client.buildMail({ from: account, to: value.to, subject: value.subject, text: value.text, messageId, date });
      } catch (error) {
        throw new MailError('invalid_input', `无法生成邮件内容：${reason(error)}`, { field: 'mail' });
      }

      const action: StoredMailAction = {
        id: `mail_${randomUUID()}`,
        requestId: value.requestId,
        agentId: aid,
        account,
        query,
        to: value.to,
        subject: value.subject,
        text: value.text,
        sourceIds: value.sourceIds,
        messageId,
        date,
        status: 'pending_confirmation',
        contentHash,
        detail: '等待用户确认后才会创建草稿',
        raw,
      };
      const grant = document.grants.find(
        (item) => !item.revokedAt && item.agentId === aid && item.contentHash === contentHash,
      );
      if (grant) {
        action.status = 'approved';
        action.grantId = grant.id;
        action.detail = '已由固定预授权批准，可在 UI 撤销该预授权';
      }
      document.actions.push(action);
      await this.writeDocument(id, document);
      return view(action);
    });
  }

  /** UI 读取：在途状态自带「可回查」说明，重启后的读者不需要自动发起网络调用。 */
  async list(botId: string): Promise<MailAction[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    await this.requireBot(id);
    return this.withFileLock(id, async () => (await this.readDocument(id)).actions.map(view));
  }

  /** 仅用户 RPC 调用（不注册成 MCP 工具）：显式批准这次外发。 */
  async approve(botId: string, actionId: string): Promise<MailAction> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(id64, actionId, 'actionId');
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const action = requireAction(document, mid, id);
      if (action.status === 'approved') return view(action);
      if (action.status !== 'pending_confirmation' && action.status !== 'revoked') {
        throw new MailError('not_approvable', `事项 ${mid} 当前状态为 ${action.status}，不能再批准`);
      }
      action.status = 'approved';
      action.approvedAt = new Date().toISOString();
      delete action.grantId;
      action.detail = action.draftId ? '已由用户重新批准，将核对现有草稿后发送' : '已由用户批准，尚未创建草稿';
      await this.writeDocument(id, document);
      return view(action);
    });
  }

  /** 仅用户 RPC 调用：撤销这次外发，不撤回已在网络中发出的邮件。 */
  async revoke(botId: string, actionId: string): Promise<MailAction> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(id64, actionId, 'actionId');
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const action = requireAction(document, mid, id);
      if (action.status === 'revoked') return view(action);
      if (action.status === 'sent') throw new MailError('not_approvable', `事项 ${mid} 已发送，无法撤销`);
      if (action.status === 'sending' || action.status === 'send_unknown') {
        throw new MailError('in_flight', `事项 ${mid} 发送在途或结果未知：撤销不会撤回已发出的邮件，先用 reconcile 回查`);
      }
      const draftUnknown = action.status === 'creating_draft' || action.status === 'draft_unknown';
      const standingGrant = Boolean(activeGrant(document, action));
      action.status = 'revoked';
      delete action.grantId;
      action.detail = [
        action.draftId
          ? '已撤销，不会再发送；Gmail 中仍有该草稿，可人工删除'
          : draftUnknown
            ? '已撤销；草稿可能已创建，请先人工核对 Gmail'
            : '已撤销，不会再创建草稿或发送',
        ...(standingGrant ? ['固定预授权仍然有效，可在 UI 单独撤销'] : []),
      ].join('；');
      await this.writeDocument(id, document);
      return view(action);
    });
  }

  /**
   * 服务端发送序列：核对批准/预授权 → 核对来源范围 → 固定 raw 落盘 creating_draft → createDraft →
   * 核对草稿实际内容 → 落盘 sending → sendDraft（只调一次）。
   * 回执不确定一律留在 `draft_unknown` / `send_unknown`，只回查，不重发。
   */
  async send(botId: string, agentId: string, actionId: string): Promise<MailAction> {
    await this.requireActive?.(botId, agentId);
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(id200, agentId, 'agentId');
    const mid = parseInput(id64, actionId, 'actionId');
    await this.requireAgent(id, aid);
    const client = await this.clientFor(id);

    return this.withActionLock(id, mid, async () => {
      const start = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const action = requireAction(document, mid, id);
        if (action.agentId !== aid) throw new MailError('wrong_agent', `事项 ${mid} 不属于该 Agent`);
        if (action.status === 'sent') return action;
        assertSameScope(action, client.config);
        if (action.status === 'creating_draft' || action.status === 'draft_unknown') {
          throw new MailError('in_flight', `事项 ${mid} 的草稿创建结果未知：先用 reconcile 回查，不会重复创建`);
        }
        if (action.status === 'sending' || action.status === 'send_unknown') {
          throw new MailError('in_flight', `事项 ${mid} 的发送结果未知：先用 reconcile 回查，不会重发`);
        }
        if (action.status === 'revoked') throw new MailError('not_approved', `事项 ${mid} 已撤销`);
        assertAuthorized(document, action);
        return action;
      });
      if (start.status === 'sent') return view(start);

      await this.assertSourcesScoped(client, start.sourceIds);
      await this.requireActive?.(id, aid);

      let action = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const current = requireAction(document, mid, id);
        assertAuthorized(document, current);
        if (current.draftId) return current;
        current.status = 'creating_draft';
        current.detail = '草稿创建在途；结果未知时用 reconcile 回查，不会重复创建';
        await this.writeDocument(id, document);
        return current;
      });

      if (!action.draftId) {
        let draftId: string;
        try {
          const created = await client.createDraft(action.raw);
          if (typeof created?.id !== 'string' || created.id === '') throw new Error('createDraft 未返回草稿 id');
          draftId = created.id;
        } catch (error) {
          return this.settle(id, mid, action, {
            status: 'draft_unknown',
            detail: `草稿创建结果未知（${reason(error)}）；用 reconcile 回查，绝不重复创建`,
          });
        }
        try {
          action = await this.transition(id, mid, (current) => {
            current.draftId = draftId;
            if (current.status === 'revoked') {
              current.detail = '草稿已创建，但该事项已被撤销；不会发送，可人工删除草稿';
              return;
            }
            current.status = 'draft';
            current.detail = '草稿已创建，发送前会核对实际内容与批准一致';
          });
        } catch (error) {
          if (error instanceof MailError) throw error;
          return {
            ...view(action),
            draftId,
            status: 'draft_unknown',
            detail: `草稿已创建但状态落盘失败（${reason(error)}）；用 reconcile 回查，绝不重复创建`,
          };
        }
        if (action.status === 'revoked') return view(action);
      }

      let draftRaw: string;
      try {
        const draft = await client.getDraft(action.draftId!);
        if (typeof draft?.message?.raw !== 'string' || draft.message.raw === '') throw new Error('getDraft 未返回 raw');
        draftRaw = draft.message.raw;
      } catch (error) {
        return this.settle(id, mid, action, {
          status: 'draft',
          detail: `无法读取草稿内容，未发送（${reason(error)}）`,
        });
      }
      const expected = { from: action.account, to: action.to, subject: action.subject, text: action.text, messageId: action.messageId };
      if (!(await client.matchesDraft(draftRaw, expected))) {
        return this.settle(id, mid, action, {
          status: 'draft',
          detail: '草稿当前内容与批准的收件人/主题/正文/Message-ID 不一致，已拒发',
        });
      }

      await this.requireActive?.(id, aid);
      action = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const current = requireAction(document, mid, id);
        if (current.status === 'revoked') throw new MailError('not_approved', `事项 ${mid} 已撤销`);
        assertAuthorized(document, current);
        current.status = 'sending';
        current.detail = '发送在途；重启后用 reconcile 回查，绝不自动重发';
        await this.writeDocument(id, document);
        return current;
      });

      let receipt: { id: string; labelIds: string[] };
      try {
        receipt = await client.sendDraft(action.draftId!);
      } catch (error) {
        return this.settle(id, mid, action, {
          status: 'send_unknown',
          detail: `发送结果未知（${reason(error)}）；用 reconcile 回查，绝不自动重发`,
        });
      }
      const proven =
        typeof receipt?.id === 'string' && receipt.id !== '' && Array.isArray(receipt.labelIds) && receipt.labelIds.includes('SENT');
      if (!proven) {
        return this.settle(id, mid, action, {
          status: 'send_unknown',
          detail: 'sendDraft 回执未证明 SENT 或缺少实际邮件 id；用 reconcile 回查，绝不自动重发',
        });
      }
      return this.settle(id, mid, action, { status: 'sent', sentId: receipt.id, detail: undefined });
    });
  }

  /**
   * 只回查，不再发起副作用：
   * - 草稿未知：`findDrafts` 恰好一份且 raw 与批准一致才恢复 `draft`；
   * - 发送未知：`findSent` 有正面证据才置 `sent`；草稿存在或找不到草稿都不等于已发送。
   */
  async reconcile(botId: string, agentId: string, actionId: string): Promise<MailAction> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const aid = parseInput(id200, agentId, 'agentId');
    const mid = parseInput(id64, actionId, 'actionId');
    await this.requireAgent(id, aid);

    return this.withActionLock(id, mid, async () => {
      const action = await this.withFileLock(id, async () => {
        const document = await this.readDocument(id);
        const current = requireAction(document, mid, id);
        if (current.agentId !== aid) throw new MailError('wrong_agent', `事项 ${mid} 不属于该 Agent`);
        return current;
      });
      const draftUnknown = action.status === 'creating_draft' || action.status === 'draft_unknown';
      const sendUnknown = action.status === 'sending' || action.status === 'send_unknown';
      if (!draftUnknown && !sendUnknown) return view(action);
      const client = await this.clientFor(id);
      assertSameScope(action, client.config);

      if (draftUnknown) {
        const drafts = await client.findDrafts(action.messageId);
        if (drafts.length !== 1) {
          return this.settle(id, mid, action, {
            status: 'draft_unknown',
            detail:
              drafts.length === 0
                ? '未找到该 Message-ID 的草稿；未重试创建，确认后可重新提交外发请求'
                : `找到 ${drafts.length} 份该 Message-ID 的草稿，无法确认唯一对应，保持未知`,
          });
        }
        const expected = { from: action.account, to: action.to, subject: action.subject, text: action.text, messageId: action.messageId };
        let draftRaw: string;
        try {
          const draft = await client.getDraft(drafts[0]!.id);
          if (typeof draft?.message?.raw !== 'string' || draft.message.raw === '') throw new Error('getDraft 未返回 raw');
          draftRaw = draft.message.raw;
        } catch (error) {
          return this.settle(id, mid, action, {
            status: 'draft_unknown',
            detail: `找到草稿但无法读取内容（${reason(error)}），保持未知`,
          });
        }
        if (!(await client.matchesDraft(draftRaw, expected))) {
          return this.settle(id, mid, action, {
            status: 'draft_unknown',
            detail: '找到的草稿与批准内容不一致，保持未知，不发送',
          });
        }
        return this.settle(id, mid, action, {
          status: 'draft',
          draftId: drafts[0]!.id,
          detail: '已回查确认草稿唯一且内容一致，尚未发送',
        });
      }

      const sent = await client.findSent(action.messageId);
      if (sent.length === 0) {
        return this.settle(id, mid, action, {
          status: 'send_unknown',
          detail: '未找到发送记录；草稿存在也不等于已发送，保持未知，不自动重发',
        });
      }
      return this.settle(id, mid, action, {
        status: 'sent',
        sentId: sent[0]!.id,
        detail: sent.length > 1 ? `回查确认已发送（找到 ${sent.length} 封）` : undefined,
      });
    });
  }

  /** 仅用户 RPC 调用：为这一事项的完全相同内容建立可撤销的固定预授权。 */
  async allowFixed(botId: string, actionId: string): Promise<MailGrant> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const mid = parseInput(id64, actionId, 'actionId');
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const action = requireAction(document, mid, id);
      if (action.status === 'sent' || action.status === 'revoked') {
        throw new MailError('not_approvable', `事项 ${mid} 已 ${action.status === 'sent' ? '发送' : '撤销'}，无法建立预授权`);
      }
      let grant = document.grants.find(
        (item) => !item.revokedAt && item.agentId === action.agentId && item.contentHash === action.contentHash,
      );
      if (!grant) {
        grant = {
          id: `grant_${randomUUID()}`,
          actionId: action.id,
          agentId: action.agentId,
          account: action.account,
          query: action.query,
          to: action.to,
          subject: action.subject,
          text: action.text,
          sourceIds: action.sourceIds,
          contentHash: action.contentHash,
          createdAt: new Date().toISOString(),
        };
        document.grants.push(grant);
      }
      action.grantId = grant.id;
      if (action.status === 'pending_confirmation') action.status = 'approved';
      if (!action.approvedAt) action.detail = '已加入固定预授权（仅同事项、同账户/查询、完全相同内容），可在 UI 撤销';
      await this.writeDocument(id, document);
      return grant;
    });
  }

  /** UI 读取：固定预授权列表（含已撤销的，便于解释历史为什么被拒）。 */
  async listGrants(botId: string): Promise<MailGrant[]> {
    const id = parseInput(botIdSchema, botId, 'botId');
    await this.requireBot(id);
    return this.withFileLock(id, async () => (await this.readDocument(id)).grants);
  }

  /** 仅用户 RPC 调用：撤销预授权；发送准入前再次检查，已经准入的调用无法撤回。 */
  async revokeGrant(botId: string, grantId: string): Promise<MailGrant> {
    const id = parseInput(botIdSchema, botId, 'botId');
    const gid = parseInput(id64, grantId, 'grantId');
    return this.withFileLock(id, async () => {
      const document = await this.readDocument(id);
      const grant = document.grants.find((item) => item.id === gid);
      if (!grant) throw new MailError('grant_not_found', `预授权 ${gid} 不属于 Bot ${id}`);
      if (!grant.revokedAt) grant.revokedAt = new Date().toISOString();

      for (const action of document.actions) {
        if (action.grantId !== grant.id || action.status === 'sent') continue;
        delete action.grantId;
        if (action.status === 'creating_draft' || action.status === 'draft_unknown' || action.status === 'sending' || action.status === 'send_unknown') {
          action.detail = '固定预授权已撤销；在途动作的结果仍需 reconcile 回查';
          continue;
        }
        if (action.approvedAt) continue;
        action.status = 'revoked';
        action.detail = action.draftId
          ? '固定预授权已撤销；不会再发送，Gmail 中仍有该草稿，可人工删除'
          : '固定预授权已撤销，不会再创建草稿或发送';
      }
      await this.writeDocument(id, document);
      return grant;
    });
  }

  private async requireBot(botId: string): Promise<void> {
    if (!(await this.store.getBot(botId))) throw new MailError('bot_not_found', `Bot ${botId} 不存在`);
  }

  /** Bot 与 Agent 的关联来自服务端可信记录，不信任调用方参数。 */
  private async requireAgent(botId: string, agentId: string): Promise<void> {
    const bot = await this.store.getBot(botId);
    if (!bot) throw new MailError('bot_not_found', `Bot ${botId} 不存在`);
    const linked =
      bot.sessions.some((session) => session.sessionId === agentId) ||
      bot.creationIntents.some((intent) => intent.agentId === agentId);
    if (!linked) throw new MailError('agent_not_linked', `Agent ${agentId} 未关联到 Bot ${botId}`);
  }

  /** 只读配置（账户与已批准查询范围），不触发任何 Gmail 写调用。 */
  private async clientFor(botId: string): Promise<GmailClient> {
    let client: GmailClient;
    try {
      client = await this.getClient(botId);
    } catch (error) {
      throw new MailError('not_configured', `Bot ${botId} 没有可用的 Gmail 配置：${reason(error)}`);
    }
    const config = client?.config;
    if (!config || !config.account?.trim() || !config.query?.trim()) {
      throw new MailError('not_configured', `Bot ${botId} 的 Gmail 配置缺少账户或查询范围`);
    }
    return client;
  }

  /** 来源必须是已批准查询范围内的邮件；空 sourceIds 表示普通新邮件，允许。 */
  private async assertSourcesScoped(client: GmailClient, sourceIds: readonly string[]): Promise<void> {
    for (const sourceId of sourceIds) {
      let message: { id: string } | null;
      try {
        message = await client.getMessage(sourceId);
      } catch (error) {
        throw new MailError('source_not_scoped', `来源邮件 ${sourceId} 无法确认在批准的查询范围内：${reason(error)}`);
      }
      if (!message || typeof message.id !== 'string' || message.id === '') {
        throw new MailError('source_not_scoped', `来源邮件 ${sourceId} 不在批准的查询范围内`);
      }
    }
  }

  private withFileLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(`file:${botId}`, task);
  }

  private withActionLock<T>(botId: string, actionId: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(`action:${botId}:${actionId}`, task);
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

  private async transition(
    botId: string,
    actionId: string,
    mutate: (action: StoredMailAction) => void,
  ): Promise<StoredMailAction> {
    return this.withFileLock(botId, async () => {
      const document = await this.readDocument(botId);
      const action = requireAction(document, actionId, botId);
      mutate(action);
      await this.writeDocument(botId, document);
      return action;
    });
  }

  /**
   * 落盘一个已知结论。落盘失败时磁盘仍停在旧状态（如 `creating_draft` / `sending`），
   * 下次按未知处理并只回查；这里如实返回带说明的未知视图，不重试副作用。
   */
  private async settle(botId: string, actionId: string, base: StoredMailAction, patch: ActionPatch): Promise<MailAction> {
    try {
      return view(await this.transition(botId, actionId, (action) => applyPatch(action, patch)));
    } catch (error) {
      if (error instanceof MailError) throw error;
      const merged: MailAction = { ...view(base) };
      applyPatch(merged, {
        ...patch,
        detail: `${patch.detail ?? '结果未落盘'}；状态落盘失败（${reason(error)}），重启后按未知状态回查`,
      });
      return merged;
    }
  }

  private fileFor(botId: string): string {
    const directory = nodePath.join(this.baseDir, 'mail');
    const file = nodePath.join(directory, `${botId}.json`);
    const relative = nodePath.relative(directory, file);
    if (relative !== `${botId}.json` || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
      throw new MailError('invalid_input', `botId escapes the mail directory: ${botId}`, { field: 'botId' });
    }
    return file;
  }

  private async readDocument(botId: string): Promise<MailDocument> {
    const file = this.fileFor(botId);
    let payload: string;
    try {
      payload = await readFile(file, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return { schemaVersion: SCHEMA_VERSION, actions: [], grants: [] };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new MailError('corrupt_store', `外发存档不是合法 JSON：${file}`, { issues: [reason(error)] });
    }
    const result = documentSchema.safeParse(parsed);
    if (!result.success) {
      throw new MailError('corrupt_store', `外发存档结构不符合预期：${file}`, {
        issues: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      });
    }
    return result.data;
  }

  /** 原子写：同目录临时文件 → fsync → rename 覆盖。 */
  private async writeDocument(botId: string, document: MailDocument): Promise<void> {
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

const id64 = id(64);
const id200 = id(200);
