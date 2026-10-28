import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { FeishuReader } from '../server/feishu.js';

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
