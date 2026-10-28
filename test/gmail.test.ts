import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildMail, GmailClient, GmailError, matchesDraft } from '../server/gmail.js';
import type { ExpectedMail, GmailConfig, GmailExecute } from '../server/gmail.js';

const CONFIG: GmailConfig = {
  command: 'gws',
  configDir: 'C:/paseo-gws/account-a',
  account: 'ops@example.com',
  query: 'from:boss@example.com newer_than:30d',
};

const PROFILE = { emailAddress: 'Ops@Example.com', messagesTotal: 42, threadsTotal: 7, historyId: '99' };

interface RecordedCall {
  command: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; cwd: string; maxBuffer: number };
}

/** Stands in for a rejected published execCommand call: non-zero exit carries code/stdout/stderr. */
class CliFailure {
  constructor(readonly code: number | string, readonly stdout = '', readonly stderr = '') {}
}

function methodOf(args: string[]): string {
  const index = args.indexOf('--params');
  return args.slice(0, index === -1 ? args.length : index).join('.');
}

function paramOf(args: string[]): Record<string, unknown> {
  const index = args.indexOf('--params');
  assert.notEqual(index, -1, 'gws call must pass --params JSON');
  return JSON.parse(args[index + 1] ?? '') as Record<string, unknown>;
}

function bodyOf(args: string[]): Record<string, unknown> | undefined {
  const index = args.indexOf('--json');
  return index === -1 ? undefined : (JSON.parse(args[index + 1] ?? '') as Record<string, unknown>);
}

type Handler = (args: string[], callIndex: number) => unknown | Promise<unknown>;

function createFake(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const execute: GmailExecute = async (command, args, options) => {
    calls.push({ command, args, options });
    const method = methodOf(args);
    const handler = handlers[method];
    if (handler === undefined) throw new Error(`unexpected gws call ${method}`);
    const reply = await handler(args, calls.length - 1);
    if (reply instanceof CliFailure) {
      throw Object.assign(new Error('gws failed'), { code: reply.code, stdout: reply.stdout, stderr: reply.stderr });
    }
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply), stderr: '' };
  };
  return { calls, execute };
}

function isGmailError(code: 'not_found' | 'unknown') {
  return (error: unknown): boolean => error instanceof GmailError && error.code === code;
}

/** createDraft writes its upload file under configDir, so those tests need a real writable one. */
async function withConfigDir<T>(run: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), 'paseo-guys-gws-'));
  try {
    return await run(configDir);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

function uploadOf(args: string[]): { file: string; contentType: string } | undefined {
  const fileIndex = args.indexOf('--upload');
  if (fileIndex === -1) return undefined;
  const typeIndex = args.indexOf('--upload-content-type');
  return { file: args[fileIndex + 1] ?? '', contentType: typeIndex === -1 ? '' : (args[typeIndex + 1] ?? '') };
}

test('每项账户动作前用固定 env 与 configDir 核对 getProfile，argv 为数组', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 }),
  });
  const client = new GmailClient(CONFIG, fake.execute);
  const page = await client.listMessages();

  assert.deepEqual(page, { messages: [{ id: 'm1', threadId: 't1' }] });
  assert.deepEqual(fake.calls.map(call => methodOf(call.args)), ['gmail.users.getProfile', 'gmail.users.messages.list']);
  for (const call of fake.calls) {
    assert.equal(call.command, 'gws');
    assert.ok(call.args.every(arg => typeof arg === 'string'));
    assert.equal(call.options.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, CONFIG.configDir);
    assert.equal(call.options.cwd, CONFIG.configDir);
    assert.equal(call.options.maxBuffer, 32 * 1024 * 1024);
  }
  assert.deepEqual(paramOf(fake.calls[0]!.args), { userId: 'me' });
  const listArgs = fake.calls[1]!.args;
  assert.deepEqual(listArgs.slice(0, 4), ['gmail', 'users', 'messages', 'list']);
  assert.deepEqual(listArgs.slice(-2), ['--format', 'json']);
  assert.deepEqual(paramOf(listArgs), { userId: 'me', q: CONFIG.query, maxResults: 20 });
  assert.equal(bodyOf(listArgs), undefined);
});

test('清除非 configDir 的凭据覆盖变量，避免绕过固定账户', async () => {
  const overrides = {
    GOOGLE_WORKSPACE_CLI_TOKEN: 'host-token',
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: 'C:/creds/other-account.json',
    GOOGLE_WORKSPACE_CLI_CLIENT_ID: 'host-client',
    GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: 'host-secret',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:/adc.json',
  };
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  try {
    const fake = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.messages.list': () => ({ resultSizeEstimate: 0 }),
    });
    const client = new GmailClient(CONFIG, fake.execute);
    assert.deepEqual(await client.listMessages(), { messages: [] });
    for (const call of fake.calls) {
      for (const name of Object.keys(overrides)) {
        assert.equal(name in call.options.env, false, `${name} 必须从子进程环境移除`);
      }
      assert.equal(call.options.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, CONFIG.configDir);
    }
  } finally {
    for (const name of Object.keys(overrides)) delete process.env[name];
  }
});

test('实际账户与配置不一致或拿不到邮箱时拒绝动作', async () => {
  const mismatch = createFake({ 'gmail.users.getProfile': () => ({ emailAddress: 'someone-else@example.com' }) });
  const client = new GmailClient(CONFIG, mismatch.execute);
  await assert.rejects(
    () => client.listMessages(),
    (error: unknown) => {
      assert.ok(isGmailError('unknown')(error));
      assert.doesNotMatch((error as Error).message, /someone-else@example\.com/);
      return true;
    },
  );
  assert.equal(mismatch.calls.length, 1);

  const missing = createFake({ 'gmail.users.getProfile': () => ({ messagesTotal: 0 }) });
  await assert.rejects(() => new GmailClient(CONFIG, missing.execute).listMessages(), isGmailError('unknown'));
  assert.equal(missing.calls.length, 1);
});

test('listMessages 透传 pageToken 并校验响应结构', async () => {
  const pages: unknown[] = [
    { messages: [{ id: 'm1' }], nextPageToken: 'p2' },
    { messages: [] },
  ];
  let index = 0;
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => pages[index++],
  });
  const client = new GmailClient(CONFIG, fake.execute);

  assert.deepEqual(await client.listMessages(), { messages: [{ id: 'm1' }], nextPageToken: 'p2' });
  assert.deepEqual(await client.listMessages('p2'), { messages: [] });
  const listCalls = fake.calls.filter(call => methodOf(call.args) === 'gmail.users.messages.list');
  assert.equal(listCalls.length, 2);
  assert.equal(paramOf(listCalls[1]!.args).pageToken, 'p2');

  for (const [payload, pattern] of [
    [{ messages: 'm1' }, /messages 不是数组/],
    [{ messages: [{ threadId: 't1' }] }, /message id/],
    [{ nextPageToken: '' }, /nextPageToken/],
    ['not-json', /JSON 无法解析/],
    ['', /未返回内容/],
    [42, /返回结构不可识别/],
  ] as const) {
    const broken = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.messages.list': () => payload,
    });
    await assert.rejects(() => new GmailClient(CONFIG, broken.execute).listMessages(), (error: unknown) => {
      assert.ok(isGmailError('unknown')(error));
      assert.match((error as Error).message, pattern);
      return true;
    });
  }
});

test('getMessage 必须先在批准 query 中分页确认可见，再取完整内容', async () => {
  const listPages: unknown[] = [
    { messages: [{ id: 'other', threadId: 't0' }], nextPageToken: 'p2' },
    { messages: [{ id: 'm9', threadId: 't9' }] },
  ];
  let index = 0;
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => listPages[index++],
    'gmail.users.messages.get': () => ({ id: 'm9', threadId: 't9', labelIds: ['INBOX'], payload: { headers: [] } }),
  });
  const client = new GmailClient(CONFIG, fake.execute);
  const message = await client.getMessage('m9');

  assert.equal(message.id, 'm9');
  assert.deepEqual(message.payload, { headers: [] });
  const listCalls = fake.calls.filter(call => methodOf(call.args) === 'gmail.users.messages.list');
  assert.equal(listCalls.length, 2);
  assert.deepEqual(paramOf(listCalls[0]!.args), { userId: 'me', q: CONFIG.query, maxResults: 20 });
  assert.equal(paramOf(listCalls[1]!.args).pageToken, 'p2');
  const getCall = fake.calls.at(-1)!;
  assert.equal(methodOf(getCall.args), 'gmail.users.messages.get');
  assert.deepEqual(paramOf(getCall.args), { userId: 'me', id: 'm9', format: 'full' });
});

test('getMessage 对未出现在批准 query 的 id 返回 not_found 且不取内容', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ messages: [{ id: 'other' }] }),
  });
  const client = new GmailClient(CONFIG, fake.execute);
  await assert.rejects(() => client.getMessage('unapproved'), isGmailError('not_found'));
  assert.deepEqual(fake.calls.map(call => methodOf(call.args)), ['gmail.users.getProfile', 'gmail.users.messages.list']);
});

test('getMessage 遇到重复分页游标时拒绝而不是无限分页', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ messages: [], nextPageToken: 'same' }),
  });
  await assert.rejects(() => new GmailClient(CONFIG, fake.execute).getMessage('m1'), isGmailError('unknown'));
});

test('只把结构化 gws 404 识别为 not_found，其余失败不泄漏 stderr', async () => {
  const notFound = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () =>
      new CliFailure(1, JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }), ''),
  });
  await assert.rejects(() => new GmailClient(CONFIG, notFound.execute).listMessages(), (error: unknown) => {
    assert.ok(isGmailError('not_found')(error));
    assert.doesNotMatch((error as Error).message, /Requested entity/);
    return true;
  });

  const authFailure = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => new CliFailure(2, '', 'error: invalid_grant refresh-token-secret-123'),
  });
  await assert.rejects(() => new GmailClient(CONFIG, authFailure.execute).listMessages(), (error: unknown) => {
    assert.ok(isGmailError('unknown')(error));
    assert.match((error as Error).message, /退出码 2：认证错误/);
    assert.doesNotMatch((error as Error).message, /refresh-token-secret-123/);
    return true;
  });

  const spawnFailure = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => new CliFailure('ENOENT'),
  });
  await assert.rejects(() => new GmailClient(CONFIG, spawnFailure.execute).listMessages(), (error: unknown) => {
    assert.ok(isGmailError('unknown')(error));
    assert.match((error as Error).message, /ENOENT/);
    return true;
  });

  const structuredOnSuccess = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ error: { code: 403, message: 'Access not configured for caller' } }),
  });
  await assert.rejects(() => new GmailClient(CONFIG, structuredOnSuccess.execute).listMessages(), (error: unknown) => {
    assert.ok(isGmailError('unknown')(error));
    assert.match((error as Error).message, /Gmail 错误码 403/);
    assert.doesNotMatch((error as Error).message, /Access not configured/);
    return true;
  });
});

const EXPECTED: ExpectedMail = {
  from: 'ops@example.com',
  to: ['boss@example.com', 'assistant@example.com'],
  subject: '周报 2026-03',
  text: '第一行\n第二行',
  messageId: '<weekly-1@example.com>',
};

async function approvedRaw(): Promise<string> {
  return buildMail({ ...EXPECTED, date: '2026-03-02T01:00:00Z' });
}

test('createDraft 用 gws media upload 传 RFC 原文，getDraft/sendDraft 后清理临时文件', async () => {
  await withConfigDir(async configDir => {
    const raw = await approvedRaw();
    const encoded = Buffer.from(raw, 'utf8').toString('base64url');
    const uploads: { args: string[]; content: string; file: string }[] = [];
    const sentBodies: (Record<string, unknown> | undefined)[] = [];
    const fake = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.drafts.create': async args => {
        const upload = uploadOf(args);
        assert.ok(upload, 'drafts.create 必须通过 --upload 上传正文');
        uploads.push({ args, content: await readFile(upload.file, 'utf8'), file: upload.file });
        return { id: 'd1', message: { id: 'm1', threadId: 't1' } };
      },
      'gmail.users.drafts.get': () => ({ id: 'd1', message: { id: 'm1', raw: encoded } }),
      'gmail.users.drafts.send': args => {
        sentBodies.push(bodyOf(args));
        return { id: 'm2', labelIds: ['SENT'] };
      },
    });
    const client = new GmailClient({ ...CONFIG, configDir }, fake.execute);

    assert.deepEqual(await client.createDraft(raw), { id: 'd1' });
    assert.equal(uploads[0]!.content, raw);
    assert.match(uploads[0]!.content, /\r\nMessage-ID: <weekly-1@example\.com>\r\n/);
    assert.match(uploads[0]!.content, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
    const createArgs = uploads[0]!.args;
    assert.deepEqual(paramOf(createArgs), { userId: 'me' });
    assert.deepEqual(bodyOf(createArgs), { message: {} }, '新草稿必须保留 Draft.message 包装，正文只走上传');
    assert.equal(uploadOf(createArgs)!.contentType, 'message/rfc822');
    assert.ok(uploadOf(createArgs)!.file.startsWith(resolve(configDir)), '临时 .eml 必须在 gws cwd（configDir）之下');
    assert.deepEqual(createArgs, [
      'gmail', 'users', 'drafts', 'create',
      '--params', '{"userId":"me"}',
      '--json', '{"message":{}}',
      '--upload', uploadOf(createArgs)!.file,
      '--upload-content-type', 'message/rfc822',
      '--format', 'json',
    ]);
    await assert.rejects(() => readFile(uploads[0]!.file, 'utf8'), /ENOENT/);
    await assert.rejects(() => readdir(dirname(uploads[0]!.file)), /ENOENT/);

    const draft = await client.getDraft('d1');
    assert.deepEqual(draft, { id: 'd1', message: { id: 'm1', raw } });
    const getCall = fake.calls.find(call => methodOf(call.args) === 'gmail.users.drafts.get')!;
    assert.deepEqual(paramOf(getCall.args), { userId: 'me', id: 'd1', format: 'raw' });
    assert.equal(await matchesDraft(draft.message.raw, EXPECTED), true);

    assert.deepEqual(await client.sendDraft('d1'), { id: 'm2', labelIds: ['SENT'] });
    assert.deepEqual(sentBodies[0], { id: 'd1' });

    // 已编码的 base64url 也接受，写到 upload 文件的是解码后的 RFC 原文。
    assert.deepEqual(await client.createDraft(encoded), { id: 'd1' });
    assert.equal(uploads[1]!.content, raw);
    assert.equal(uploads[1]!.args.some(arg => arg.includes(encoded.slice(0, 64))), false);

    assert.equal(fake.calls.filter(call => methodOf(call.args) === 'gmail.users.getProfile').length, 4);
  });
});

test('长正文只进 upload 文件，不进 argv，不受 CreateProcess 参数长度限制', async () => {
  await withConfigDir(async configDir => {
    const text = '会议纪要：本周跟进事项与下周安排。'.repeat(800);
    const raw = await buildMail({ ...EXPECTED, text, date: '2026-03-02T01:00:00Z' });
    assert.ok(raw.length > 32768, '本用例需要超出 Windows CreateProcess 参数上限的正文');
    const uploads: { content: string; file: string }[] = [];
    const fake = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.drafts.create': async args => {
        const upload = uploadOf(args)!;
        uploads.push({ content: await readFile(upload.file, 'utf8'), file: upload.file });
        return { id: 'd1' };
      },
    });
    const client = new GmailClient({ ...CONFIG, configDir }, fake.execute);

    await client.createDraft(raw);
    const createArgs = fake.calls.at(-1)!.args;
    for (const arg of createArgs) {
      assert.ok(arg.length < 4096, '单个 argv 参数不得接近 CreateProcess 上限');
      assert.equal(arg.includes('会议纪要'), false, 'argv 不得包含正文原文');
      assert.equal(arg.includes(raw.slice(0, 64)), false, 'argv 不得包含正文片段');
    }
    assert.equal(uploads[0]!.content, raw);
    assert.match(uploads[0]!.content, /\r\nMessage-ID: <weekly-1@example\.com>\r\n/);
    assert.match(uploads[0]!.content, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
    await assert.rejects(() => readFile(uploads[0]!.file, 'utf8'), /ENOENT/);
  });
});

test('createDraft 失败也清理临时 .eml 与空目录，且不重试 mutation', async () => {
  await withConfigDir(async configDir => {
    const raw = await approvedRaw();
    let uploadFile = '';
    let createCalls = 0;
    const fake = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.drafts.create': args => {
        createCalls++;
        uploadFile = uploadOf(args)!.file;
        return new CliFailure(1, JSON.stringify({ error: { code: 503, message: 'Backend Error' } }), '');
      },
    });
    const client = new GmailClient({ ...CONFIG, configDir }, fake.execute);

    await assert.rejects(() => client.createDraft(raw), isGmailError('unknown'));
    assert.equal(createCalls, 1, 'mutation 不得自动重试');
    await assert.rejects(() => readFile(uploadFile, 'utf8'), /ENOENT/);
    await assert.rejects(() => readdir(dirname(uploadFile)), /ENOENT/);
  });
});

test('sendDraft 未返回 labelIds 时视为未知结果而不是成功', async () => {
  await withConfigDir(async configDir => {
    const raw = await approvedRaw();
    const fake = createFake({
      'gmail.users.getProfile': () => PROFILE,
      'gmail.users.drafts.create': () => ({ id: 'd1' }),
      'gmail.users.drafts.send': () => ({ id: 'm2' }),
    });
    const client = new GmailClient({ ...CONFIG, configDir }, fake.execute);
    await client.createDraft(raw);
    await assert.rejects(() => client.sendDraft('d1'), isGmailError('unknown'));
    assert.equal(fake.calls.filter(call => methodOf(call.args) === 'gmail.users.drafts.send').length, 1);
  });
});

test('findDrafts 跨页核对唯一性，不把首页唯一草稿误作全量唯一', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.drafts.list': args => paramOf(args).pageToken ? { drafts: [{ id: 'duplicate-later' }] } : { drafts: [{ id: 'first' }], nextPageToken: 'older-drafts' },
  });
  assert.deepEqual(await new GmailClient(CONFIG, fake.execute).findDrafts('fixed@example.com'), [{ id: 'first' }, { id: 'duplicate-later' }]);
});

test('findDrafts 只用固定 rfc822msgid 查询并交出可回查的草稿 id', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.drafts.list': () => ({
      drafts: [
        { id: 'd7', message: { id: 'm7', threadId: 't7' } },
        { id: 'd8' },
      ],
    }),
  });
  const client = new GmailClient(CONFIG, fake.execute);
  assert.deepEqual(await client.findDrafts('<weekly-1@example.com>'), [{ id: 'd7' }, { id: 'd8' }]);
  const listCall = fake.calls.at(-1)!;
  assert.equal(methodOf(listCall.args), 'gmail.users.drafts.list');
  assert.deepEqual(paramOf(listCall.args), { userId: 'me', q: 'rfc822msgid:weekly-1@example.com', maxResults: 20 });
  await assert.rejects(() => client.findDrafts('not a message id'), /Message-ID/);
});

test('findSent 只认 metadata 确证 SENT 且 Message-ID 匹配，草稿 404 不算已发送', async () => {
  const getCalls: Record<string, unknown>[] = [];
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'd9' }] }),
    'gmail.users.messages.get': args => {
      const params = paramOf(args);
      getCalls.push(params);
      if (params.id === 'm1') {
        return { id: 'm1', threadId: 't1', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: '<weekly-1@example.com>' }] } };
      }
      if (params.id === 'm2') {
        return { id: 'm2', threadId: 't2', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: '<other@example.com>' }] } };
      }
      return new CliFailure(1, JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' } }), '');
    },
  });
  const client = new GmailClient(CONFIG, fake.execute);
  const sent = await client.findSent('weekly-1@example.com');

  assert.deepEqual(sent, [{ id: 'm1', labelIds: ['SENT'] }]);
  const listCall = fake.calls.find(call => methodOf(call.args) === 'gmail.users.messages.list')!;
  assert.deepEqual(paramOf(listCall.args), { userId: 'me', q: 'in:sent rfc822msgid:weekly-1@example.com', maxResults: 20 });
  assert.equal(getCalls.length, 3);
  for (const params of getCalls) {
    assert.equal(params.userId, 'me');
    assert.equal(params.format, 'metadata');
    assert.deepEqual(params.metadataHeaders, ['Message-ID']);
  }
});

test('findSent 不把非 SENT 标签或无标签结果当作已发送', async () => {
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => ({ messages: [{ id: 'm1' }, { id: 'm2' }] }),
    'gmail.users.messages.get': args =>
      paramOf(args).id === 'm1'
        ? { id: 'm1', labelIds: ['DRAFT'], payload: { headers: [{ name: 'Message-ID', value: '<weekly-1@example.com>' }] } }
        : { id: 'm2', payload: { headers: [{ name: 'Message-ID', value: '<weekly-1@example.com>' }] } },
  });
  const sent = await new GmailClient(CONFIG, fake.execute).findSent('weekly-1@example.com');
  assert.deepEqual(sent, []);
});

test('findSent 跨页查找已发送证据，不只信任首页结果', async () => {
  const pages: unknown[] = [
    { messages: [{ id: 'm1' }], nextPageToken: 'p2' },
    { messages: [{ id: 'm2' }] },
  ];
  let index = 0;
  const fake = createFake({
    'gmail.users.getProfile': () => PROFILE,
    'gmail.users.messages.list': () => pages[index++],
    'gmail.users.messages.get': args =>
      paramOf(args).id === 'm2'
        ? { id: 'm2', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: '<weekly-1@example.com>' }] } }
        : { id: 'm1', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: '<other@example.com>' }] } },
  });
  assert.deepEqual(await new GmailClient(CONFIG, fake.execute).findSent('weekly-1@example.com'), [{ id: 'm2', labelIds: ['SENT'] }]);
  const listCalls = fake.calls.filter(call => methodOf(call.args) === 'gmail.users.messages.list');
  assert.equal(listCalls.length, 2);
  assert.equal(paramOf(listCalls[1]!.args).pageToken, 'p2');
});

test('buildMail 生成 CRLF 本地 MIME 并拒绝头注入', async () => {
  const raw = await approvedRaw();
  assert.ok(raw.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(raw), 'newline=windows 输出必须只有 CRLF');
  assert.match(raw, /^From: ops@example\.com\r\n/);
  assert.match(raw, /\r\nTo: boss@example\.com, assistant@example\.com\r\n/);
  assert.match(raw, /\r\nMessage-ID: <weekly-1@example\.com>\r\n/);
  assert.match(raw, /\r\nDate: Mon, 02 Mar 2026 01:00:00 \+0000\r\n/);
  assert.doesNotMatch(raw, /\r\n(Bcc|Cc|Reply-To):/i);
  assert.doesNotMatch(raw, /text\/html/i);

  const base = { from: 'ops@example.com', to: ['boss@example.com'], subject: 'hi', text: 'body', messageId: '<m@example.com>', date: '2026-03-02T01:00:00Z' };
  const rejected: [Partial<typeof base>, RegExp][] = [
    [{ subject: 'hi\r\nBcc: evil@example.com' }, /subject 不能包含换行/],
    [{ subject: 'hi\nBcc: evil@example.com' }, /subject 不能包含换行/],
    [{ from: 'Ops <ops@example.com>' }, /from 必须是单个纯邮箱地址/],
    [{ to: ['boss@example.com\r\nBcc: evil@example.com'] }, /to\[0\] 不能包含换行/],
    [{ to: ['boss@example.com', 'boss@example.com'] }, /不能包含重复收件人/],
    [{ to: [] }, /至少需要一个收件人/],
    [{ messageId: 'm@example.com\r\nX-Injected: 1' }, /Message-ID/],
    [{ messageId: 'not-a-message-id' }, /Message-ID/],
    [{ date: 'yesterday' }, /date 必须是合法日期字符串/],
    [{ text: 'body\u0000' }, /text 不能包含 NUL/],
  ];
  for (const [patch, pattern] of rejected) {
    await assert.rejects(() => buildMail({ ...base, ...patch }), pattern);
  }
});

function withHeader(raw: string, header: string): string {
  const split = raw.indexOf('\r\n\r\n');
  return `${raw.slice(0, split)}\r\n${header}${raw.slice(split)}`;
}

const HTML_RAW = [
  'From: ops@example.com',
  'To: boss@example.com, assistant@example.com',
  'Subject: 周报 2026-03',
  'Message-ID: <weekly-1@example.com>',
  'Date: Mon, 02 Mar 2026 01:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '第一行',
  '第二行',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>第一行<br>第二行</p>',
  '--b1--',
  '',
].join('\r\n');

const ATTACHMENT_RAW = [
  'From: ops@example.com',
  'To: boss@example.com, assistant@example.com',
  'Subject: 周报 2026-03',
  'Message-ID: <weekly-1@example.com>',
  'Date: Mon, 02 Mar 2026 01:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '第一行',
  '第二行',
  '--b1',
  'Content-Type: application/octet-stream; name="x.bin"',
  'Content-Disposition: attachment; filename="x.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  'AAECAwQ=',
  '--b1--',
  '',
].join('\r\n');

test('matchesDraft 用真实 MIME 比对批准内容，任何未批准改动都不通过', async () => {
  const raw = await approvedRaw();
  assert.equal(await matchesDraft(raw, EXPECTED), true);
  assert.equal(await matchesDraft(Buffer.from(raw, 'utf8').toString('base64url'), EXPECTED), true);
  assert.equal(await matchesDraft(raw, { ...EXPECTED, text: '第一行\n第二行\n' }), true, '尾部换行属于传输痕迹');

  const negatives: [string, string, Partial<ExpectedMail>][] = [
    ['subject 改动', raw, { subject: '周报 2026-04' }],
    ['正文改动', raw, { text: '第一行\n第三行' }],
    ['收件人改动', raw, { to: ['boss@example.com'] }],
    ['发件人改动', raw, { from: 'intern@example.com' }],
    ['Message-ID 改动', raw, { messageId: '<weekly-2@example.com>' }],
    ['cc 新增', withHeader(raw, 'Cc: cc@example.com'), {}],
    ['replyTo 新增', withHeader(raw, 'Reply-To: reply@example.com'), {}],
    ['html 新增', HTML_RAW, {}],
    ['附件新增', ATTACHMENT_RAW, {}],
  ];
  for (const [label, candidate, patch] of negatives) {
    assert.equal(await matchesDraft(candidate, { ...EXPECTED, ...patch }), false, label);
  }
  assert.equal(await matchesDraft('', EXPECTED), false);
  assert.equal(await matchesDraft('definitely not mail', EXPECTED), false);
});
