import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { feishuConfig, type FeishuConfig } from '../shared/office.js';

/** 标准 SDK 连接官方 lark-mcp，只调用文档读取白名单，不向 Agent 透传原始工具。 */
export class FeishuReader {
  readonly config: FeishuConfig;
  constructor(config: FeishuConfig, private readonly transport?: () => Transport) {
    this.config = feishuConfig.parse(config);
  }

  async read(input: { documentId?: string; wikiToken?: string }): Promise<{ documentId: string; content: string }> {
    const { documentId, wikiToken } = input;
    if (Boolean(documentId) === Boolean(wikiToken)) throw new Error('请指定一个飞书文档标识或知识库节点');
    if (documentId && !this.config.documentIds.includes(documentId)) throw new Error('飞书文档不在用户指定范围内');
    if (wikiToken && !this.config.wikiTokens.includes(wikiToken)) throw new Error('飞书知识库节点不在用户指定范围内');
    const secret = await this.resolveSecret();
    if (!this.transport && !secret) throw new Error(`飞书缺少宿主环境变量 ${this.config.secretEnv}，请完成现有连接器配置`);
    const client = new Client({ name: 'oh-my-paseo-bots-feishu', version: '0.1.0' });
    const transport = this.transport?.() ?? new StdioClientTransport({
      command: this.config.command,
      // 与只读登录一致；lark-mcp 0.5.1 未指定 scope 时会选择旧 OIDC 续期端点。
      args: [...this.config.args, 'mcp', '--mode', 'stdio', '-c', 'snake', '--token-mode', 'user_access_token', '--scope', 'offline_access docx:document:readonly', '-t', 'docx.v1.document.rawContent,wiki.v2.space.getNode'],
      env: { APP_ID: this.config.appId, APP_SECRET: secret! },
      stderr: 'ignore',
    });
    try {
      await client.connect(transport);
      let id = documentId;
      if (wikiToken) {
        const node = z.object({ node: z.object({ obj_token: z.string(), obj_type: z.string() }) }).parse(
          await call(client, 'wiki_v2_space_getNode', { params: { token: wikiToken }, useUAT: true }),
        ).node;
        if (node.obj_type !== 'docx') throw new Error('该知识库节点不是已支持的 docx 文档');
        id = node.obj_token;
      }
      const result = z.object({ content: z.string() }).parse(await call(client, 'docx_v1_document_rawContent', { path: { document_id: id! }, useUAT: true }));
      return { documentId: id!, content: result.content };
    } finally { await client.close(); await transport.close(); }
  }

  /**
   * 每次读取都重新解析密钥。配置 secretFile 后只认该文件（宿主绝对路径、UTF-8 含 BOM、
   * 首尾空白 trim、单行），失败即报错且不回退环境变量；未配置时保持原来的 secretEnv 路径。
   * 错误里不含文件正文、密钥或底层异常文本。
   */
  private async resolveSecret(): Promise<string | undefined> {
    const secretFile = this.config.secretFile;
    if (!secretFile) return process.env[this.config.secretEnv];
    if (!nodePath.isAbsolute(secretFile)) {
      throw new Error(`飞书 secretFile 必须是宿主绝对路径：${secretFile}`);
    }
    let raw: string;
    try {
      raw = await readFile(secretFile, 'utf8');
    } catch {
      throw new Error(`无法读取飞书密钥文件 ${secretFile}，请检查路径与读取权限`);
    }
    const secret = raw.trim();
    if (secret === '') throw new Error(`飞书密钥文件 ${secretFile} 内容为空，请写入当前有效密钥`);
    if (/[\r\n]/.test(secret)) throw new Error(`飞书密钥文件 ${secretFile} 必须只包含单行密钥（检测到换行）`);
    return secret;
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error('飞书读取未完成，请检查现有连接器登录、权限和续期状态');
  const blocks = result.content;
  if (!Array.isArray(blocks)) throw new Error('飞书连接器返回格式不符');
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  try { return JSON.parse(text); }
  catch { throw new Error('飞书连接器返回格式不符'); }
}
