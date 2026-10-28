import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { FeishuConfig } from '../shared/office.js';
import { FeishuReader } from '../server/feishu.js';

/**
 * 离线测试：本地 stdio 假 lark 服务 + 临时密钥文件。
 * 不联网、不使用真实飞书凭据；所有密钥都是测试里生成的合成值。
 */

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tempDirs: string[] = [];
const ENV_NAME = 'PASEO_TEST_FEISHU_SECRET';

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 极小标准 SDK stdio 服务：把收到的 APP_SECRET 落盘，并应答两个读取工具。 */
const FAKE_LARK = `
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dump = process.argv[3];
appendFileSync(dump, JSON.stringify({ secret: process.env.APP_SECRET ?? null, appId: process.env.APP_ID ?? null }) + '\\n');
const server = new McpServer({ name: 'offline-lark-stdio', version: '0' });
server.registerTool('docx_v1_document_rawContent', { inputSchema: { path: z.object({ document_id: z.string() }), useUAT: z.boolean() } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ content: 'synthetic 正文' }) }],
}));
server.registerTool('wiki_v2_space_getNode', { inputSchema: { params: z.object({ token: z.string() }), useUAT: z.boolean() } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ node: { obj_token: 'resolved-doc', obj_type: 'docx' } }) }],
}));
await server.connect(new StdioServerTransport());
`;

interface Runner {
  dir: string;
  script: string;
  dump: string;
}

async function makeRunner(): Promise<Runner> {
  const dir = await mkdtemp(path.join(projectRoot, '.tmp-feishu-'));
  tempDirs.push(dir);
  const script = path.join(dir, 'fake-lark.mjs');
  const dump = path.join(dir, 'secrets.jsonl');
  await writeFile(script, FAKE_LARK, 'utf8');
  return { dir, script, dump };
}

function spawnConfig(runner: Runner): FeishuConfig {
  return {
    command: process.execPath,
    args: [runner.script, '--dump', runner.dump],
    appId: 'cli_test_app',
    secretEnv: ENV_NAME,
    documentIds: ['allowed-doc'],
    wikiTokens: ['wiki-allowed'],
  };
}

async function dumpLines(dump: string): Promise<Array<{ secret: string | null; appId: string | null }>> {
  const text = await readFile(dump, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { secret: string | null; appId: string | null });
}

async function withEnv(value: string | undefined, task: () => Promise<void>): Promise<void> {
  const previous = process.env[ENV_NAME];
  if (value === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = value;
  try {
    await task();
  } finally {
    if (previous === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = previous;
  }
}

/** 断言密钥问题在创建 transport 之前就报错，且错误里没有密钥/原异常文本。 */
async function expectSecretFailure(
  config: FeishuConfig,
  pattern: RegExp,
  forbidden: string[],
): Promise<void> {
  let transportBuilt = false;
  const reader = new FeishuReader(config, () => {
    transportBuilt = true;
    throw new Error('transport 不应在密钥校验前创建');
  });
  await assert.rejects(
    () => reader.read({ documentId: 'allowed-doc' }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, pattern);
      for (const value of forbidden) assert.equal(message.includes(value), false, `错误不得包含 ${value}`);
      return true;
    },
  );
  assert.equal(transportBuilt, false, '密钥校验必须发生在启动子进程之前');
}

test('飞书只读接入使用真实工具名、用户身份与指定文档范围', async () => {
  const server = new McpServer({ name: 'offline-lark', version: '0' });
  const calls: unknown[] = [];
  server.registerTool('wiki_v2_space_getNode', { inputSchema: { params: z.object({ token: z.string() }), useUAT: z.boolean() } }, async input => {
    calls.push(input);
    return { content: [{ type: 'text', text: JSON.stringify({ node: { obj_token: 'resolved-doc', obj_type: 'docx' } }) }] };
  });
  server.registerTool('docx_v1_document_rawContent', { inputSchema: { path: z.object({ document_id: z.string() }), useUAT: z.boolean() } }, async input => {
    calls.push(input);
    return { content: [{ type: 'text', text: JSON.stringify({ content: '指定资料正文' }) }] };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const reader = new FeishuReader({ command: 'unused', args: [], appId: 'app', secretEnv: 'APP_SECRET', documentIds: ['allowed'], wikiTokens: ['wiki-allowed'] }, () => clientSide);
  try {
    await assert.rejects(() => reader.read({ documentId: 'other' }), /不在用户指定范围/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await reader.read({ wikiToken: 'wiki-allowed' }), { documentId: 'resolved-doc', content: '指定资料正文' });
    assert.deepEqual(calls, [{ params: { token: 'wiki-allowed' }, useUAT: true }, { path: { document_id: 'resolved-doc' }, useUAT: true }]);
  } finally { await server.close(); }
});

test('secretFile 优先于环境变量，并把文件里的合成密钥传给子进程', { timeout: 60_000 }, async () => {
  const runner = await makeRunner();
  const secretFile = path.join(runner.dir, 'feishu-secret');
  await writeFile(secretFile, '\uFEFF  file-secret-value  \n', 'utf8');

  await withEnv('env-secret-value', async () => {
    const reader = new FeishuReader({ ...spawnConfig(runner), secretFile });
    assert.deepEqual(await reader.read({ documentId: 'allowed-doc' }), {
      documentId: 'allowed-doc',
      content: 'synthetic 正文',
    });
    const [received] = await dumpLines(runner.dump);
    assert.equal(received?.secret, 'file-secret-value', '子进程只拿到文件里的密钥（含 BOM/空白处理）');
    assert.equal(received?.appId, 'cli_test_app');
  });
});

test('同一个 reader 每次读取都现读密钥文件，支持轮换', { timeout: 60_000 }, async () => {
  const runner = await makeRunner();
  const secretFile = path.join(runner.dir, 'feishu-secret');
  await writeFile(secretFile, 'first-synthetic-key', 'utf8');

  await withEnv('env-secret-value', async () => {
    const reader = new FeishuReader({ ...spawnConfig(runner), secretFile });
    await reader.read({ documentId: 'allowed-doc' });
    await writeFile(secretFile, 'second-synthetic-key', 'utf8');
    await reader.read({ documentId: 'allowed-doc' });
    const received = await dumpLines(runner.dump);
    assert.deepEqual(received.map((line) => line.secret), ['first-synthetic-key', 'second-synthetic-key']);
  });
});

test('未配置 secretFile 时仍走原来的 secretEnv 路径', { timeout: 60_000 }, async () => {
  const runner = await makeRunner();
  await withEnv('env-secret-value', async () => {
    const reader = new FeishuReader(spawnConfig(runner));
    await reader.read({ documentId: 'allowed-doc' });
    const [received] = await dumpLines(runner.dump);
    assert.equal(received?.secret, 'env-secret-value');
  });
});

test('secretFile 读取失败时不回退环境变量，也不泄露路径内容之外的细节', async () => {
  const runner = await makeRunner();
  await withEnv('env-secret-value', async () => {
    await expectSecretFailure(
      { ...spawnConfig(runner), secretFile: path.join(runner.dir, 'missing-secret') },
      /无法读取飞书密钥文件/,
      ['env-secret-value', 'ENOENT'],
    );
  });
  assert.deepEqual(await dumpLines(runner.dump), [], '没有启动子进程');
});

test('空白或多行密钥被拒绝且错误不回显密钥内容', async () => {
  const runner = await makeRunner();
  const blank = path.join(runner.dir, 'blank-secret');
  await writeFile(blank, '  \r\n\t\n', 'utf8');
  await expectSecretFailure({ ...spawnConfig(runner), secretFile: blank }, /内容为空/, []);

  const multiline = path.join(runner.dir, 'multiline-secret');
  await writeFile(multiline, 'SECRET-ONE\nSECRET-TWO', 'utf8');
  await expectSecretFailure({ ...spawnConfig(runner), secretFile: multiline }, /只包含单行密钥/, ['SECRET-ONE', 'SECRET-TWO']);
  assert.deepEqual(await dumpLines(runner.dump), []);
});

test('secretFile 必须是宿主绝对路径', async () => {
  const runner = await makeRunner();
  await writeFile(path.join(runner.dir, 'relative-secret'), 'relative-key', 'utf8');
  await expectSecretFailure({ ...spawnConfig(runner), secretFile: 'relative-secret' }, /绝对路径/, ['relative-key']);
  assert.deepEqual(await dumpLines(runner.dump), []);
});

test('文档白名单在读取密钥之前生效', async () => {
  const runner = await makeRunner();
  // 文件根本不存在：如果先读密钥就会报“无法读取”，白名单必须先拒绝。
  const reader = new FeishuReader({ ...spawnConfig(runner), secretFile: path.join(runner.dir, 'missing-secret') }, () => {
    throw new Error('transport 不应创建');
  });
  await assert.rejects(() => reader.read({ documentId: 'other-doc' }), /不在用户指定范围/);
  await assert.rejects(() => reader.read({ wikiToken: 'wiki-other' }), /不在用户指定范围/);
  assert.deepEqual(await dumpLines(runner.dump), []);
});
