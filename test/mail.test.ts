import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { MailError, MailOutbox, type GmailClient, type MailErrorCode } from '../server/mail.js';
import { BotStore } from '../server/store.js';
import { TaskTracker } from '../server/tasks.js';
import type { PaseoApi } from '@getpaseo/client';

/**
 * 离线测试：只用临时目录和 fake Gmail。
 * 不连接真实 Gmail、不调用模型、不涉及宿主 E2E。
 */

const createdDirs: string[] = [];

after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeBehavior {
  createDraft?(raw: string, fake: FakeGmail): Promise<{ id: string }>;
  getDraft?(id: string, fake: FakeGmail): Promise<{ id: string; message: { id?: string; raw: string }; rfcMessageId?: string }>;
  sendDraft?(id: string, fake: FakeGmail): Promise<{ id: string; labelIds: string[] }>;
  findDrafts?(messageId: string, fake: FakeGmail): Promise<Array<{ id: string }>>;
  findSent?(messageId: string, fake: FakeGmail): Promise<Array<{ id: string; labelIds: string[] }>>;
  getMessage?(id: string, fake: FakeGmail): Promise<{ id: string }>;
}

/** 以不透明的 base64url JSON 替代 MIME；真实 MIME 的生成与核对另由 gmail/office 测试覆盖。 */
class FakeGmail implements GmailClient {
  readonly config = {
    command: 'gmail-fake',
    configDir: '/tmp/gmail-fake',
    account: 'owner@example.com',
    query: 'from:lark.example OR subject:跟进',
  };
  readonly draftStore = new Map<string, { raw: string; messageId: string }>();
  readonly sentStore = new Map<string, string[]>();
  readonly scoped = new Set<string>();
  readonly calls = {
    buildMail: 0,
    createDraft: 0,
    getDraft: 0,
    sendDraft: 0,
    findDrafts: 0,
    findSent: 0,
    getMessage: 0,
  };
  behavior: FakeBehavior = {};
  private seq = 0;

  encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  decode(raw: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  putDraft(raw: string): string {
    const id = `draft_${++this.seq}`;
    this.draftStore.set(id, { raw, messageId: String(this.decode(raw).messageId) });
    return id;
  }

  markSent(raw: string): string {
    const id = `sent_${++this.seq}`;
    const messageId = String(this.decode(raw).messageId);
    this.sentStore.set(messageId, [...(this.sentStore.get(messageId) ?? []), id]);
    return id;
  }

  buildMail(input: { from: string; to: string[]; subject: string; text: string; messageId: string; date: string }): string {
    this.calls.buildMail += 1;
    return this.encode(input);
  }

  matchesDraft(
    raw: string,
    expected: { from: string; to: string[]; subject: string; text: string; messageId: string },
  ): boolean | Promise<boolean> {
    try {
      const parsed = this.decode(raw);
      return (
        parsed.from === expected.from &&
        parsed.messageId === expected.messageId &&
        parsed.subject === expected.subject &&
        parsed.text === expected.text &&
        JSON.stringify(parsed.to) === JSON.stringify(expected.to)
      );
    } catch {
      return false;
    }
  }

  async createDraft(raw: string): Promise<{ id: string }> {
    this.calls.createDraft += 1;
    if (this.behavior.createDraft) return this.behavior.createDraft(raw, this);
    return { id: this.putDraft(raw) };
  }

  async getDraft(id: string): Promise<{ id: string; message: { id?: string; raw: string }; rfcMessageId?: string }> {
    this.calls.getDraft += 1;
    if (this.behavior.getDraft) return this.behavior.getDraft(id, this);
    const record = this.draftStore.get(id);
    if (!record) throw Object.assign(new Error('draft not found'), { status: 404 });
    return { id, message: { id, raw: record.raw }, rfcMessageId: record.messageId };
  }

  async sendDraft(id: string): Promise<{ id: string; labelIds: string[] }> {
    this.calls.sendDraft += 1;
    if (this.behavior.sendDraft) return this.behavior.sendDraft(id, this);
    const record = this.draftStore.get(id);
    if (!record) throw Object.assign(new Error('draft not found'), { status: 404 });
    return { id: this.markSent(record.raw), labelIds: ['SENT'] };
  }

  async findDrafts(messageId: string): Promise<Array<{ id: string }>> {
    this.calls.findDrafts += 1;
    if (this.behavior.findDrafts) return this.behavior.findDrafts(messageId, this);
    return [...this.draftStore].filter(([, record]) => record.messageId === messageId).map(([id]) => ({ id }));
  }

  async findSent(messageId: string): Promise<Array<{ id: string; labelIds: string[] }>> {
    this.calls.findSent += 1;
    if (this.behavior.findSent) return this.behavior.findSent(messageId, this);
    return (this.sentStore.get(messageId) ?? []).map((id) => ({ id, labelIds: ['SENT'] }));
  }

  async getMessage(id: string): Promise<{ id: string }> {
    this.calls.getMessage += 1;
    if (this.behavior.getMessage) return this.behavior.getMessage(id, this);
    if (!this.scoped.has(id)) throw Object.assign(new Error('message not in approved query scope'), { status: 404 });
    return { id };
  }
}

interface Harness {
  dir: string;
  mailFile: string;
  store: BotStore;
  gmail: FakeGmail;
  outbox: MailOutbox;
  restart(): MailOutbox;
}

async function setup(gmail: FakeGmail = new FakeGmail()): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'paseo-guys-mail-'));
  createdDirs.push(dir);
  const store = new BotStore({ baseDir: path.join(dir, 'store') });
  await store.createBot({ id: 'chief', name: '主 Bot', role: '跟进与核对' });
  await store.linkSession('chief', { sessionId: 'agent-chief' });
  await store.linkSession('chief', { sessionId: 'agent-second' });
  await store.createBot({ id: 'other', name: '另一个 Bot', role: '其他事项' });
  await store.linkSession('other', { sessionId: 'agent-other' });
  const getClient = async (botId: string): Promise<GmailClient> => {
    if (botId !== 'chief') throw new Error('未配置 Gmail 账户');
    return gmail;
  };
  return {
    dir,
    mailFile: path.join(dir, 'mail', 'chief.json'),
    store,
    gmail,
    outbox: new MailOutbox({ baseDir: dir, store, getClient }),
    restart: () => new MailOutbox({ baseDir: dir, store, getClient }),
  };
}

function proposal(requestId: string, overrides: Partial<Parameters<MailOutbox['propose']>[2]> = {}) {
  return {
    requestId,
    to: ['lin@example.com'],
    subject: '关于跨应用跟进的时间确认',
    text: '你好，想确认一下本周的跟进时间。',
    sourceIds: [] as string[],
    ...overrides,
  };
}

async function expectMailError(task: () => Promise<unknown>, code: MailErrorCode): Promise<void> {
  await assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof MailError, `期望 MailError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function noSideEffects(gmail: FakeGmail): void {
  assert.equal(gmail.calls.createDraft, 0, '未批准时不得创建草稿');
  assert.equal(gmail.calls.sendDraft, 0, '未批准时不得发送');
}

async function breakWrites(target: string): Promise<void> {
  await rm(target, { force: true });
  await mkdir(path.join(target, 'blocker'), { recursive: true });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Gmail 专用外发登记', () => {
  it('来源核对期间撤销单次批准，不创建草稿或发送，保留批准历史', { timeout: 5000 }, async () => {
    const { outbox, gmail } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('revoke-during-source', { sourceIds: ['source-1'] }));
    const approved = await outbox.approve('chief', action.id);
    const entered = deferred();
    const gate = deferred();
    gmail.behavior.getMessage = async id => {
      entered.resolve();
      await gate.promise;
      return { id };
    };
    const sending = Promise.allSettled([outbox.send('chief', 'agent-chief', action.id)]);
    await entered.promise;
    const revoked = await outbox.revoke('chief', action.id);
    assert.equal(revoked.status, 'revoked');
    gate.resolve();
    const [result] = await sending;
    if (result.status === 'fulfilled') assert.equal(result.value.status, 'revoked');
    else assert.ok(result.reason instanceof MailError && result.reason.code === 'not_approved');
    const [stored] = await outbox.list('chief');
    assert.equal(stored.status, 'revoked');
    assert.equal(stored.approvedAt, approved.approvedAt, '历史确认时间不能代替当前授权');
    noSideEffects(gmail);
  });

  for (const stage of ['read', 'match'] as const) {
    for (const valid of [true, false]) {
      it(`已有草稿的${stage === 'read' ? '读取' : '内容核对'}期间撤销，迟到${valid ? '成功' : '失败'}不恢复发送资格`, { timeout: 5000 }, async () => {
        const { outbox, gmail } = await setup();
        const action = await outbox.propose('chief', 'agent-chief', proposal(`revoke-draft-${stage}-${valid}`));
        const approved = await outbox.approve('chief', action.id);
        gmail.behavior.getDraft = async () => { throw new Error('temporary read failure'); };
        const draft = await outbox.send('chief', 'agent-chief', action.id);
        assert.equal(draft.status, 'draft');
        assert.equal(gmail.calls.createDraft, 1);
        gmail.behavior.getDraft = undefined;
        const entered = deferred();
        const gate = deferred();
        if (stage === 'read') {
          gmail.behavior.getDraft = async (id, fake) => {
            entered.resolve();
            await gate.promise;
            if (!valid) throw new Error('late read failure');
            return { id, message: { raw: fake.draftStore.get(id)!.raw } };
          };
        } else {
          gmail.matchesDraft = async () => {
            entered.resolve();
            await gate.promise;
            return valid;
          };
        }
        const sending = Promise.allSettled([outbox.send('chief', 'agent-chief', action.id)]);
        await entered.promise;
        await outbox.revoke('chief', action.id);
        gate.resolve();
        const [result] = await sending;
        if (result.status === 'fulfilled') assert.equal(result.value.status, 'revoked');
        else assert.ok(result.reason instanceof MailError && result.reason.code === 'not_approved');
        const [stored] = await outbox.list('chief');
        assert.equal(stored.status, 'revoked');
        assert.equal(stored.approvedAt, approved.approvedAt);
        assert.equal(stored.draftId, draft.draftId);
        assert.equal(gmail.calls.createDraft, 1, '已有草稿不重新创建');
        assert.equal(gmail.calls.sendDraft, 0, '撤销后的迟到核对不能准入发送');
        await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'not_approved');
      });
    }
  }

  it('成功草稿回执后的实际 Message-ID 先固定落盘，发送未知重启后只用该标识回查', async () => {
    const { outbox, gmail, mailFile, restart } = await setup();
    const providerMessageId = 'gmail-rewritten@mail.gmail.com';
    gmail.behavior.createDraft = async (raw, fake) => ({ id: fake.putDraft(fake.encode({ ...fake.decode(raw), messageId: providerMessageId })) });
    const action = await outbox.propose('chief', 'agent-chief', proposal('rewritten-id'));
    await outbox.approve('chief', action.id);
    gmail.behavior.sendDraft = async (draftId, fake) => {
      const document = JSON.parse(await readFile(mailFile, 'utf8'));
      assert.equal(document.actions[0].providerMessageId, providerMessageId, '副作用前必须持久绑定实际标识');
      assert.equal(document.actions[0].status, 'sending');
      assert.equal(document.actions[0].messageId, action.messageId, '保留原请求 Message-ID');
      assert.equal(document.actions[0].requestId, action.requestId);
      assert.equal(fake.decode(document.actions[0].raw).messageId, action.messageId, '保留原始 MIME');
      fake.markSent(fake.draftStore.get(draftId)!.raw);
      throw new Error('receipt lost');
    };
    const unknown = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(unknown.status, 'send_unknown');
    await expectMailError(() => restart().send('chief', 'agent-chief', action.id), 'in_flight');
    let lookupId: string | undefined;
    gmail.behavior.findSent = async (messageId, fake) => {
      lookupId = messageId;
      return (fake.sentStore.get(messageId) ?? []).map(id => ({ id, labelIds: ['SENT'] }));
    };
    const recovered = await restart().reconcile('chief', 'agent-chief', action.id);
    assert.equal(recovered.status, 'sent');
    assert.equal(lookupId, providerMessageId);
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 1);
  });

  it('已登记 draftId 的旧草稿可在完整核对后恢复发送，不重新创建草稿', async () => {
    const { outbox, gmail, restart } = await setup();
    const providerMessageId = 'existing-draft@mail.gmail.com';
    gmail.behavior.createDraft = async (raw, fake) => ({ id: fake.putDraft(fake.encode({ ...fake.decode(raw), messageId: providerMessageId })) });
    gmail.behavior.getDraft = async () => { throw new Error('temporary read failure'); };
    const action = await outbox.propose('chief', 'agent-chief', proposal('existing-draft'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft');
    assert.equal(gmail.calls.sendDraft, 0);
    gmail.behavior.getDraft = undefined;
    const sent = await restart().send('chief', 'agent-chief', action.id);
    assert.equal(sent.status, 'sent');
    assert.equal('providerMessageId' in sent && sent.providerMessageId, providerMessageId);
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 1);
  });

  it('实际 Message-ID 不能掩盖内容篡改，已固定后也不得随草稿刷新', async () => {
    const { outbox, gmail, mailFile, restart } = await setup();
    const providerMessageId = 'fixed@mail.gmail.com';
    gmail.behavior.createDraft = async (raw, fake) => ({ id: fake.putDraft(fake.encode({ ...fake.decode(raw), messageId: providerMessageId, text: '未经批准的正文' })) });
    const action = await outbox.propose('chief', 'agent-chief', proposal('tampered-provider-id'));
    await outbox.approve('chief', action.id);
    const rejected = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(rejected.status, 'draft');
    assert.equal('providerMessageId' in rejected, false, '内容不匹配时不能固定标识');
    assert.equal(gmail.calls.sendDraft, 0);
    const document = JSON.parse(await readFile(mailFile, 'utf8'));
    document.actions[0].providerMessageId = providerMessageId;
    await writeFile(mailFile, JSON.stringify(document), 'utf8');
    const changedId = 'changed-later@mail.gmail.com';
    gmail.draftStore.set(rejected.draftId!, { raw: gmail.encode({ ...gmail.decode(document.actions[0].raw), messageId: changedId }), messageId: changedId });
    const later = await restart().send('chief', 'agent-chief', action.id);
    assert.equal(later.status, 'draft');
    assert.equal('providerMessageId' in later && later.providerMessageId, providerMessageId, '固定值不得被后续草稿替换');
    assert.equal(gmail.calls.sendDraft, 0);
  });

  it('没有成功草稿 id 的未知创建不采用改写标识，也不重新创建', async () => {
    const { outbox, gmail, restart } = await setup();
    gmail.behavior.createDraft = async (raw, fake) => {
      fake.putDraft(fake.encode({ ...fake.decode(raw), messageId: 'unknown-draft@mail.gmail.com' }));
      throw new Error('create receipt lost');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('unknown-rewritten'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');
    let lookupId: string | undefined;
    gmail.behavior.findDrafts = async messageId => { lookupId = messageId; return []; };
    const unresolved = await restart().reconcile('chief', 'agent-chief', action.id);
    assert.equal(unresolved.status, 'draft_unknown');
    assert.equal(lookupId, action.messageId);
    assert.equal('providerMessageId' in unresolved, false);
    assert.equal(unresolved.draftId, undefined);
    await expectMailError(() => restart().send('chief', 'agent-chief', action.id), 'in_flight');
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0);
  });

  it('实际 Message-ID 无法与发送准入一同落盘时不调用发送', async () => {
    const { outbox, gmail, mailFile } = await setup();
    gmail.behavior.getDraft = async (id, fake) => {
      const raw = fake.encode({ ...fake.decode(fake.draftStore.get(id)!.raw), messageId: 'persist-first@mail.gmail.com' });
      await breakWrites(mailFile);
      return { id, message: { raw }, rfcMessageId: 'persist-first@mail.gmail.com' };
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('binding-write-fails'));
    await outbox.approve('chief', action.id);
    await assert.rejects(() => outbox.send('chief', 'agent-chief', action.id));
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0, '绑定及 sending 未持久化，禁止发送');
  });

  it('事项在草稿核对期间取消后不准入发送，仍可回查未知结果且不阻塞其他事项', async () => {
    const { dir, store, gmail } = await setup();
    const tasks = new TaskTracker({ baseDir: dir, store, cli: { command: '', cwd: '' }, getPaseo: () => ({ agents: { ref: () => ({ archive: async () => ({ archivedAt: 'now' }) }) } }) as unknown as PaseoApi });
    const outbox = new MailOutbox({ baseDir: dir, store, getClient: async () => gmail, requireActive: (bot, agent) => tasks.requireActive(bot, agent) });
    const action = await outbox.propose('chief', 'agent-chief', proposal('stopped-during-draft'));
    await outbox.approve('chief', action.id);
    gmail.behavior.getDraft = async (id, fake) => {
      await tasks.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
      return { id, message: { raw: fake.draftStore.get(id)!.raw } };
    };
    await assert.rejects(() => outbox.send('chief', 'agent-chief', action.id), /不再|active|推进|状态/);
    assert.equal(gmail.calls.sendDraft, 0);
    assert.equal((await outbox.list('chief'))[0].status, 'draft');
    await assert.rejects(() => outbox.propose('chief', 'agent-chief', proposal('after-stop')), /不再|active|推进|状态/);
    gmail.behavior.getDraft = undefined;
    gmail.behavior.sendDraft = async () => { throw new Error('response lost'); };
    const other = await outbox.propose('chief', 'agent-second', proposal('independent'));
    await outbox.approve('chief', other.id);
    assert.equal((await outbox.send('chief', 'agent-second', other.id)).status, 'send_unknown');
    await tasks.stop('chief', 'agent-second', { outcome: 'canceled', summary: '用户取消' });
    const calls = gmail.calls.sendDraft;
    assert.equal((await outbox.reconcile('chief', 'agent-second', other.id)).status, 'send_unknown');
    assert.equal(gmail.calls.sendDraft, calls, '停止后仍可只读回查，不能重发');
  });

  it('propose 只登记，不产生任何 Gmail 写调用；未批准时 send 拒绝', async () => {
    const { outbox, gmail } = await setup();

    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    assert.equal(action.status, 'pending_confirmation');
    assert.equal(action.account, 'owner@example.com');
    assert.equal(action.query, 'from:lark.example OR subject:跟进');
    assert.match(action.messageId, /@paseo-guys\.local$/);
    assert.equal(action.agentId, 'agent-chief');
    noSideEffects(gmail);
    assert.equal(gmail.calls.getMessage, 0, 'propose 不校验来源，留到发送前');

    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'not_approved');
    noSideEffects(gmail);
    const [still] = await outbox.list('chief');
    assert.equal(still?.status, 'pending_confirmation');

    const revoked = await outbox.revoke('chief', action.id);
    assert.equal(revoked.status, 'revoked');
    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'not_approved');
    noSideEffects(gmail);
  });

  it('跨 Bot、未关联 Agent 与错误 Agent 的发送都被拒绝', async () => {
    const { outbox, gmail } = await setup();
    await expectMailError(() => outbox.propose('missing', 'agent-chief', proposal('req-x')), 'bot_not_found');
    await expectMailError(() => outbox.propose('chief', 'agent-other', proposal('req-y')), 'agent_not_linked');

    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);
    await expectMailError(() => outbox.send('chief', 'agent-second', action.id), 'wrong_agent');
    await expectMailError(() => outbox.send('chief', 'agent-other', action.id), 'agent_not_linked');
    noSideEffects(gmail);
  });

  it('伪造来源在创建草稿前被拒，事项保持已批准', async () => {
    const { outbox, gmail } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1', { sourceIds: ['msg-forged'] }));
    await outbox.approve('chief', action.id);

    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'source_not_scoped');
    noSideEffects(gmail);
    assert.equal(gmail.calls.getMessage, 1);
    const [after] = await outbox.list('chief');
    assert.equal(after?.status, 'approved');

    gmail.scoped.add('msg-in-scope');
    const scoped = await outbox.propose('chief', 'agent-chief', proposal('req-2', { sourceIds: ['msg-in-scope'] }));
    await outbox.approve('chief', scoped.id);
    const sent = await outbox.send('chief', 'agent-chief', scoped.id);
    assert.equal(sent.status, 'sent');
  });

  it('createDraft 超时后保留 draft_unknown，下次不再创建草稿', async () => {
    const { outbox, gmail, restart } = await setup();
    gmail.behavior.createDraft = async () => {
      throw new Error('read ETIMEDOUT');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    const failed = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(failed.status, 'draft_unknown');
    assert.match(failed.detail ?? '', /reconcile/);
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0);

    await expectMailError(() => restart().send('chief', 'agent-chief', action.id), 'in_flight');
    assert.equal(gmail.calls.createDraft, 1, '未知状态绝不重写 create');

    const reconciled = await restart().reconcile('chief', 'agent-chief', action.id);
    assert.equal(reconciled.status, 'draft_unknown');
    assert.match(reconciled.detail ?? '', /未找到该 Message-ID 的草稿/);
    assert.equal(gmail.calls.createDraft, 1);
  });

  it('草稿回执落盘失败时按未知处理，磁盘停在 creating_draft 也只回查', async () => {
    const harness = await setup();
    const { outbox, gmail, mailFile } = harness;
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    let snapshot = '';
    gmail.behavior.createDraft = async (raw, fake) => {
      snapshot = await readFile(mailFile, 'utf8');
      const id = fake.putDraft(raw);
      await breakWrites(mailFile);
      return { id };
    };

    const result = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(result.status, 'draft_unknown');
    assert.match(result.detail ?? '', /落盘失败/);
    assert.equal(gmail.calls.createDraft, 1);

    await rm(mailFile, { recursive: true, force: true });
    await writeFile(mailFile, snapshot, 'utf8');
    assert.equal((await harness.restart().list('chief'))[0]?.status, 'creating_draft');

    await expectMailError(() => harness.restart().send('chief', 'agent-chief', action.id), 'in_flight');
    assert.equal(gmail.calls.createDraft, 1);

    const recovered = await harness.restart().reconcile('chief', 'agent-chief', action.id);
    assert.equal(recovered.status, 'draft');
    assert.ok(recovered.draftId);
    assert.equal(gmail.calls.sendDraft, 0, 'reconcile 只回查，不发送');
  });

  it('草稿被改动后拒绝发送，且草稿保持可见', async () => {
    const { outbox, gmail } = await setup();
    gmail.behavior.createDraft = async (raw, fake) => {
      const id = fake.putDraft(raw);
      const tampered = fake.decode(raw);
      fake.draftStore.set(id, { raw: fake.encode({ ...tampered, text: '被替换的正文' }), messageId: String(tampered.messageId) });
      return { id };
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    const result = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(result.status, 'draft');
    assert.match(result.detail ?? '', /不一致，已拒发/);
    assert.ok(result.draftId);
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0);
  });

  it('只有 SENT 回执与 findSent 正面证据才置为已发送', async () => {
    const { outbox, gmail } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);
    const sent = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(sent.status, 'sent');
    assert.ok(sent.sentId);
    assert.equal(gmail.calls.sendDraft, 1);
    assert.deepEqual(await outbox.reconcile('chief', 'agent-chief', action.id), sent);

    gmail.behavior.sendDraft = async (id, fake) => {
      const record = fake.draftStore.get(id)!;
      fake.markSent(record.raw);
      return { id: '', labelIds: ['DRAFT'] };
    };
    const second = await outbox.propose('chief', 'agent-chief', proposal('req-2'));
    await outbox.approve('chief', second.id);
    const unknown = await outbox.send('chief', 'agent-chief', second.id);
    assert.equal(unknown.status, 'send_unknown');
    assert.match(unknown.detail ?? '', /未证明 SENT/);

    const unresolved = await outbox.reconcile('chief', 'agent-chief', second.id);
    assert.equal(unresolved.status, 'sent');
    assert.ok(unresolved.sentId);
  });

  it('sendDraft 超时/回执丢失后不重发，reconcile 找到 SENT 才确认', async () => {
    const { outbox, gmail } = await setup();
    gmail.behavior.sendDraft = async () => {
      throw new Error('read ECONNRESET');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    const unknown = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(unknown.status, 'send_unknown');
    assert.equal(gmail.calls.sendDraft, 1);
    assert.equal(gmail.calls.createDraft, 1);

    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'in_flight');
    assert.equal(gmail.calls.sendDraft, 1, '未知状态绝不重发');

    const notEvidence = await outbox.reconcile('chief', 'agent-chief', action.id);
    assert.equal(notEvidence.status, 'send_unknown');
    assert.match(notEvidence.detail ?? '', /草稿存在也不等于已发送/);
    assert.equal(gmail.calls.sendDraft, 1);

    gmail.behavior.findSent = async () => [{ id: 'sent-evidence', labelIds: ['SENT'] }];
    const confirmed = await outbox.reconcile('chief', 'agent-chief', action.id);
    assert.equal(confirmed.status, 'sent');
    assert.equal(confirmed.sentId, 'sent-evidence');
  });

  it('未知事项不阻塞其他独立事项', async () => {
    const { outbox, gmail } = await setup();
    const gate = deferred();
    gmail.behavior.createDraft = async (raw, fake) => {
      await gate.promise;
      return { id: fake.putDraft(raw) };
    };
    const blocked = await outbox.propose('chief', 'agent-chief', proposal('req-blocked'));
    await outbox.approve('chief', blocked.id);
    const pendingSend = outbox.send('chief', 'agent-chief', blocked.id);
    await new Promise((done) => setTimeout(done, 20));

    gmail.behavior.createDraft = undefined;
    const independent = await outbox.propose('chief', 'agent-second', proposal('req-independent'));
    await outbox.approve('chief', independent.id);
    const sent = await outbox.send('chief', 'agent-second', independent.id);
    assert.equal(sent.status, 'sent');

    gate.resolve();
    const late = await pendingSend;
    assert.equal(late.status, 'sent');
    assert.notEqual(late.sentId, sent.sentId);
  });

  it('固定预授权只覆盖完全相同的内容，撤销后立即失效', async () => {
    const { outbox, gmail } = await setup();
    const first = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    const grant = await outbox.allowFixed('chief', first.id);
    assert.equal(grant.account, 'owner@example.com');
    assert.equal(grant.revokedAt, undefined);
    assert.equal((await outbox.list('chief'))[0]?.status, 'approved');
    assert.equal((await outbox.send('chief', 'agent-chief', first.id)).status, 'sent');

    const repeated = await outbox.propose('chief', 'agent-chief', proposal('req-2'));
    assert.notEqual(repeated.id, first.id, '已发送后同内容的新请求是独立事项');
    assert.equal(repeated.status, 'approved');
    assert.equal(repeated.grantId, grant.id);

    const widened = await outbox.propose(
      'chief',
      'agent-chief',
      proposal('req-3', { to: ['lin@example.com', 'cc@example.com'] }),
    );
    assert.equal(widened.status, 'pending_confirmation', '收件人变化不得被预授权泛化');

    const revoked = await outbox.revokeGrant('chief', grant.id);
    assert.ok(revoked.revokedAt);
    const actions = await outbox.list('chief');
    assert.equal(actions.find((item) => item.id === first.id)?.status, 'sent', '已发送不受撤销影响');
    assert.equal(actions.find((item) => item.id === repeated.id)?.status, 'revoked');
    assert.equal(actions.find((item) => item.id === widened.id)?.status, 'pending_confirmation');
    const before = gmail.calls.createDraft;
    await expectMailError(() => outbox.send('chief', 'agent-chief', repeated.id), 'not_approved');
    assert.equal(gmail.calls.createDraft, before);
  });

  it('单次撤销不隐式撤销固定预授权，UI 可分开处理', async () => {
    const { outbox } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    const grant = await outbox.allowFixed('chief', action.id);

    const revoked = await outbox.revoke('chief', action.id);
    assert.equal(revoked.status, 'revoked');
    assert.match(revoked.detail ?? '', /固定预授权仍然有效/);
    assert.equal((await outbox.listGrants('chief')).find((item) => item.id === grant.id)?.revokedAt, undefined);

    const repeated = await outbox.propose('chief', 'agent-chief', proposal('req-2'));
    assert.equal(repeated.status, 'approved');
    assert.equal(repeated.grantId, grant.id);
  });

  it('撤销结果未知的草稿时提示可能已创建', async () => {
    const { outbox, gmail } = await setup();
    gmail.behavior.createDraft = async () => {
      throw new Error('read ETIMEDOUT');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');

    const revoked = await outbox.revoke('chief', action.id);
    assert.equal(revoked.status, 'revoked');
    assert.match(revoked.detail ?? '', /草稿可能已创建，请先人工核对/);
    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'not_approved');
  });

  for (const lookup of ['none', 'multiple', 'tampered', 'unique'] as const) {
    it(`未知草稿创建撤销并重启后不重建；${lookup} 回查只在完整确认后允许重新批准`, async () => {
      const { outbox, gmail, restart } = await setup();
      gmail.behavior.createDraft = async (raw, fake) => {
        if (lookup !== 'none') {
          const id = fake.putDraft(raw);
          if (lookup === 'multiple') fake.putDraft(raw);
          if (lookup === 'tampered') fake.draftStore.set(id, { raw: fake.encode({ ...fake.decode(raw), text: '云端被改动的内容' }), messageId: String(fake.decode(raw).messageId) });
        }
        throw new Error('create receipt lost');
      };
      const action = await outbox.propose('chief', 'agent-chief', proposal(`unknown-revoked-${lookup}`));
      const grant = await outbox.allowFixed('chief', action.id);
      assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');
      await outbox.revoke('chief', action.id);
      const recoveredOutbox = restart();
      await expectMailError(() => recoveredOutbox.approve('chief', action.id), 'in_flight');
      await expectMailError(() => recoveredOutbox.allowFixed('chief', action.id), 'not_approvable');
      const repeated = await recoveredOutbox.propose('chief', 'agent-chief', proposal(`new-request-${lookup}`));
      assert.equal(repeated.id, action.id, '未知写入的同输入即使换 requestId 也不能新建提案');
      assert.equal(repeated.status, 'revoked');
      assert.equal((await recoveredOutbox.listGrants('chief')).find(item => item.id === grant.id)?.revokedAt, undefined);
      await expectMailError(() => recoveredOutbox.send('chief', 'agent-chief', action.id), 'not_approved');
      const reconciled = await recoveredOutbox.reconcile('chief', 'agent-chief', action.id);
      assert.equal(gmail.calls.findDrafts, 1, '已撤销的未知创建仍可只读回查');
      assert.equal(reconciled.status, 'revoked', '回查不能自动恢复批准');
      assert.equal(JSON.stringify(reconciled).includes('draftCreationUncertain'), false, '私有状态不进入对外视图');
      if (lookup === 'unique') {
        assert.ok(reconciled.draftId);
        assert.equal((await restart().approve('chief', action.id)).status, 'approved');
        gmail.behavior.createDraft = undefined;
        assert.equal((await restart().send('chief', 'agent-chief', action.id)).status, 'sent');
        assert.equal(gmail.calls.sendDraft, 1);
      } else {
        assert.equal(reconciled.draftId, undefined);
        await expectMailError(() => restart().approve('chief', action.id), 'in_flight');
        assert.equal(gmail.calls.sendDraft, 0);
      }
      assert.equal(gmail.calls.createDraft, 1);
    });
  }

  for (const knownReceipt of [true, false]) {
    it(`创建草稿在途撤销，迟到${knownReceipt ? '已知 id' : '未知结果'}不会自动重获批准`, { timeout: 5000 }, async () => {
      const { outbox, gmail, restart } = await setup();
      const entered = deferred();
      const gate = deferred();
      gmail.behavior.createDraft = async (raw, fake) => {
        const id = fake.putDraft(raw);
        entered.resolve();
        await gate.promise;
        if (!knownReceipt) throw new Error('create receipt lost');
        return { id };
      };
      const action = await outbox.propose('chief', 'agent-chief', proposal(`revoke-in-flight-${knownReceipt}`));
      await outbox.approve('chief', action.id);
      const sending = outbox.send('chief', 'agent-chief', action.id);
      await entered.promise;
      assert.equal((await outbox.list('chief'))[0].status, 'creating_draft');
      await outbox.revoke('chief', action.id);
      gate.resolve();
      assert.equal((await sending).status, 'revoked');
      assert.equal(gmail.calls.sendDraft, 0);
      if (!knownReceipt) {
        await expectMailError(() => restart().approve('chief', action.id), 'in_flight');
        const reconciled = await restart().reconcile('chief', 'agent-chief', action.id);
        assert.equal(reconciled.status, 'revoked');
        assert.ok(reconciled.draftId);
      }
      await restart().approve('chief', action.id);
      assert.equal((await restart().send('chief', 'agent-chief', action.id)).status, 'sent');
      assert.equal(gmail.calls.createDraft, 1);
      assert.equal(gmail.calls.sendDraft, 1);
    });
  }

  for (const grantOnly of [false, true]) {
    it(`没有未知写入的${grantOnly ? '固定预授权' : '单次批准'}撤销仍可由用户重新批准`, async () => {
      const { outbox, gmail, restart } = await setup();
      const action = await outbox.propose('chief', 'agent-chief', proposal(`ordinary-reapprove-${grantOnly}`));
      if (grantOnly) {
        const grant = await outbox.allowFixed('chief', action.id);
        await outbox.revokeGrant('chief', grant.id);
      } else {
        await outbox.approve('chief', action.id);
        await outbox.revoke('chief', action.id);
      }
      await restart().approve('chief', action.id);
      assert.equal((await restart().send('chief', 'agent-chief', action.id)).status, 'sent');
      assert.equal(gmail.calls.createDraft, 1);
      assert.equal(gmail.calls.sendDraft, 1);
    });
  }

  it('旧撤销存档缺少创建结论时保守回查，不改写原文件或重新创建', async () => {
    const { outbox, gmail, mailFile, restart } = await setup();
    gmail.behavior.createDraft = async () => { throw new Error('old create receipt lost'); };
    const action = await outbox.propose('chief', 'agent-chief', proposal('legacy-revoked-unknown'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');
    await outbox.revoke('chief', action.id);
    const old = JSON.parse(await readFile(mailFile, 'utf8'));
    delete old.actions[0].draftCreationUncertain;
    await writeFile(mailFile, JSON.stringify(old), 'utf8');
    const bytes = await readFile(mailFile, 'utf8');
    const restored = restart();
    const [visible] = await restored.list('chief');
    assert.equal(visible.status, 'revoked');
    await expectMailError(() => restored.approve('chief', action.id), 'in_flight');
    assert.match(visible.detail ?? '', /旧版|历史/);
    assert.equal(await readFile(mailFile, 'utf8'), bytes, '只读兼容不自动迁移存档');
    const repeated = await restored.propose('chief', 'agent-chief', proposal('legacy-new-request'));
    assert.equal(repeated.id, action.id);
    assert.equal((await restored.reconcile('chief', 'agent-chief', action.id)).status, 'revoked');
    assert.equal(gmail.calls.findDrafts, 1);
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0);
  });

  it('已撤销未知创建的回查结论无法落盘时，不恢复批准或重复副作用', async () => {
    const { outbox, gmail, mailFile, restart } = await setup();
    gmail.behavior.createDraft = async (raw, fake) => {
      fake.putDraft(raw);
      throw new Error('create receipt lost');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('revoked-recovery-write-failure'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');
    await outbox.revoke('chief', action.id);
    const snapshot = await readFile(mailFile, 'utf8');
    gmail.behavior.getDraft = async (id, fake) => {
      await breakWrites(mailFile);
      return { id, message: { raw: fake.draftStore.get(id)!.raw } };
    };
    const result = await outbox.reconcile('chief', 'agent-chief', action.id);
    assert.equal(result.status, 'revoked');
    assert.match(result.detail ?? '', /落盘失败/);
    await rm(mailFile, { recursive: true, force: true });
    await writeFile(mailFile, snapshot, 'utf8');
    await expectMailError(() => restart().approve('chief', action.id), 'in_flight');
    await expectMailError(() => restart().send('chief', 'agent-chief', action.id), 'not_approved');
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0);
  });

  it('发送准入前撤销预授权会拦下 sendDraft', async () => {
    const { outbox, gmail } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    const grant = await outbox.allowFixed('chief', action.id);

    gmail.behavior.getDraft = async (id, fake) => {
      await outbox.revokeGrant('chief', grant.id);
      const record = fake.draftStore.get(id)!;
      return { id, message: { id, raw: record.raw } };
    };

    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'not_approved');
    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 0, '准入前再查撤销状态');
    const [visible] = await outbox.list('chief');
    assert.equal(visible?.status, 'revoked');
    assert.match(visible?.detail ?? '', /预授权已撤销/);
  });

  it('重启后读回真实状态，在途状态标明可回查', async () => {
    const harness = await setup();
    const { outbox, gmail, mailFile } = harness;
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    let snapshot = '';
    gmail.behavior.createDraft = async (raw, fake) => {
      snapshot = await readFile(mailFile, 'utf8');
      const id = fake.putDraft(raw);
      await breakWrites(mailFile);
      return { id };
    };
    const stuck = await outbox.send('chief', 'agent-chief', action.id);
    assert.equal(stuck.status, 'draft_unknown');

    await rm(mailFile, { recursive: true, force: true });
    await writeFile(mailFile, snapshot, 'utf8');

    const restarted = harness.restart();
    const [listed] = await restarted.list('chief');
    assert.equal(listed?.status, 'creating_draft');
    assert.match(listed?.detail ?? '', /reconcile/);
    await expectMailError(() => restarted.send('chief', 'agent-chief', action.id), 'in_flight');
    assert.equal(gmail.calls.createDraft, 1);
  });

  it('发送成功后重启仍可读回已发送状态', async () => {
    const harness = await setup();
    const action = await harness.outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await harness.outbox.approve('chief', action.id);
    const sent = await harness.outbox.send('chief', 'agent-chief', action.id);

    const [listed] = await harness.restart().list('chief');
    assert.equal(listed?.status, 'sent');
    assert.equal(listed?.sentId, sent.sentId);
    assert.equal((await harness.restart().listGrants('chief')).length, 0);
  });

  it('同 requestId 幂等、异输入冲突、未决同输入复用、已发送后独立新增', async () => {
    const { outbox } = await setup();
    const first = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    assert.equal((await outbox.propose('chief', 'agent-chief', proposal('req-1'))).id, first.id);
    await expectMailError(
      () => outbox.propose('chief', 'agent-chief', proposal('req-1', { text: '换了一段正文' })),
      'request_conflict',
    );

    const reused = await outbox.propose('chief', 'agent-chief', proposal('req-other'));
    assert.equal(reused.id, first.id, '同输入未决复用同一条，不吞独立输入');

    await outbox.approve('chief', first.id);
    await outbox.send('chief', 'agent-chief', first.id);
    const independent = await outbox.propose('chief', 'agent-chief', proposal('req-3'));
    assert.notEqual(independent.id, first.id);
  });

  it('并发发送同一事项只发生一次 createDraft 与一次 sendDraft', async () => {
    const { outbox, gmail } = await setup();
    const gate = deferred();
    let entered!: () => void;
    const firstEntered = new Promise<void>((done) => {
      entered = done;
    });
    gmail.behavior.createDraft = async (raw, fake) => {
      entered();
      await gate.promise;
      return { id: fake.putDraft(raw) };
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    const first = outbox.send('chief', 'agent-chief', action.id);
    await firstEntered;
    const second = outbox.send('chief', 'agent-chief', action.id);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(gmail.calls.createDraft, 1);
    assert.equal(gmail.calls.sendDraft, 1);
    assert.equal(a.status, 'sent');
    assert.equal(b.status, 'sent');
    assert.equal(a.sentId, b.sentId);
  });

  it('账户或查询范围被换掉后 send 不产生任何副作用', async () => {
    const { outbox, gmail } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);

    gmail.config.account = 'someone-else@example.com';
    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'account_mismatch');
    noSideEffects(gmail);
    assert.equal(gmail.calls.getMessage, 0);
    assert.equal((await outbox.list('chief'))[0]?.status, 'approved');

    gmail.config.account = 'owner@example.com';
    gmail.config.query = 'subject:另一个范围';
    await expectMailError(() => outbox.send('chief', 'agent-chief', action.id), 'account_mismatch');
    noSideEffects(gmail);

    gmail.config.query = 'from:lark.example OR subject:跟进';
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'sent');
  });

  it('未知状态只在记录中的原账户/原范围回查', async () => {
    const { outbox, gmail } = await setup();
    gmail.behavior.createDraft = async () => {
      throw new Error('read ETIMEDOUT');
    };
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    await outbox.approve('chief', action.id);
    assert.equal((await outbox.send('chief', 'agent-chief', action.id)).status, 'draft_unknown');

    gmail.behavior.createDraft = undefined;
    gmail.config.account = 'someone-else@example.com';
    const before = gmail.calls.findDrafts;
    await expectMailError(() => outbox.reconcile('chief', 'agent-chief', action.id), 'account_mismatch');
    assert.equal(gmail.calls.findDrafts, before, '不在新账户上回查');

    gmail.config.account = 'owner@example.com';
    assert.equal((await outbox.reconcile('chief', 'agent-chief', action.id)).status, 'draft_unknown');
  });

  it('对外结构不返回 raw，raw 只留在存档内', async () => {
    const { outbox, mailFile } = await setup();
    const action = await outbox.propose('chief', 'agent-chief', proposal('req-1'));
    const [listed] = await outbox.list('chief');
    assert.ok(listed);
    assert.equal('raw' in listed, false);
    assert.equal(JSON.stringify(listed).includes(action.messageId), true, 'Message-ID 可见，便于人工回查');
    assert.equal(JSON.stringify(listed).includes('raw'), false);

    const stored = await readFile(mailFile, 'utf8');
    assert.match(stored, /"raw": "/);
  });
});
