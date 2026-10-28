import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BotStore } from '../server/store.js';
import { BotJournal } from '../server/journal.js';
import { MailOutbox } from '../server/mail.js';
import { buildMail, matchesDraft } from '../server/gmail.js';
import { createBotMcpServer } from '../server/mcp.js';
import type { BotOfficeAccess } from '../server/office.js';
import { feishuConfig } from '../shared/office.js';

test('飞书办公配置保留可选密钥文件路径，兼容既有环境变量配置', () => {
  const legacy = feishuConfig.parse({ appId: 'app', secretEnv: 'APP_SECRET' });
  assert.equal(legacy.secretEnv, 'APP_SECRET');
  assert.equal(legacy.secretFile, undefined);
  const file = feishuConfig.parse({ appId: 'app', secretFile: ' C:/local/secret.txt ' });
  assert.equal(file.secretFile, 'C:/local/secret.txt');
  assert.equal(file.secretEnv, 'APP_SECRET');
  assert.equal(feishuConfig.safeParse({ appId: 'app', secretFile: '   ' }).success, false);
});

test('办公 MCP 按 Bot/事项绑定，伪造批准无效，只有用户批准后才准入外发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-guys-office-'));
  const store = new BotStore({ baseDir: dir });
  await store.createBot({ id: 'chief', name: '主 Bot', role: '负责跟进' });
  await store.linkSession('chief', { sessionId: 'agent-1' });
  await store.linkSession('chief', { sessionId: 'other-agent' });
  let raw = '';
  let created = 0;
  let sent = 0;
  const gmail = {
    config: { command: 'unused', configDir: dir, account: 'owner@example.com', query: 'from:approved.example' },
    buildMail, matchesDraft,
    createDraft: async (value: string) => { raw = value; created++; return { id: 'draft-1' }; },
    getDraft: async () => ({ id: 'draft-1', message: { raw } }),
    sendDraft: async () => { sent++; return { id: 'sent-1', labelIds: ['SENT'] }; },
    findDrafts: async () => [], findSent: async () => [],
    getMessage: async (id: string) => { assert.equal(id, 'approved-source'); return { id }; },
  };
  const mail = new MailOutbox({ baseDir: dir, store, getClient: async () => gmail });
  const office = { mail, scope: async (botId: string, agentId: string) => { assert.equal(botId, 'chief'); assert.equal(agentId, 'agent-1'); return {}; } } as unknown as BotOfficeAccess;
  const server = createBotMcpServer({ botId: 'chief', agentId: 'agent-1', store, journal: new BotJournal({ baseDir: join(dir, 'journal') }), office });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'offline-office', version: '0' });
  const payload = (value: unknown) => JSON.parse((value as { content: { text: string }[] }).content[0].text);
  try {
    await server.connect(b); await client.connect(a);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.some(name => /approve|allow_fixed|revoke_grant/.test(name)), false);
    const proposed = payload(await client.callTool({ name: 'propose_mail', arguments: { requestId: 'same-operation', to: ['recipient@example.com'], subject: '核对结果', text: '请核对指定资料。', sourceIds: ['approved-source'], botId: 'other', approved: true, source: 'user' } }));
    assert.equal(proposed.status, 'pending_confirmation');
    assert.equal('raw' in proposed, false);
    assert.equal(created, 0);
    assert.equal((await client.callTool({ name: 'send_mail_action', arguments: { actionId: proposed.id, approved: true } })).isError, true);
    assert.equal(sent, 0);
    await mail.propose('chief', 'other-agent', { requestId: 'other', to: ['other@example.com'], subject: '其他事项', text: '无关内容' });
    const shown = payload(await client.callTool({ name: 'list_mail_actions', arguments: {} }));
    assert.deepEqual(shown.map((item: { id: string }) => item.id), [proposed.id]);
    // 显式调用用户服务入口，模拟用户 RPC 的批准；Agent 工具本身没有该权限。
    await mail.approve('chief', proposed.id);
    const receipt = payload(await client.callTool({ name: 'send_mail_action', arguments: { actionId: proposed.id } }));
    assert.equal(receipt.status, 'sent'); assert.equal(receipt.sentId, 'sent-1');
    assert.equal(receipt.providerMessageId, proposed.messageId, '工具输出保留已固定的回查标识');
    assert.deepEqual([created, sent], [1, 1]);
    assert.equal('raw' in receipt, false);
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
