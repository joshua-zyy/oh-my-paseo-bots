import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mailAction } from '../shared/office.js';
import type { BotOfficeAccess } from './office.js';

/** 账户、Bot、Agent 与数据范围均在服务端绑定；没有原始写工具或确认权限。 */
export function registerOfficeTools(server: McpServer, office: BotOfficeAccess, botId: string, agentId: string) {
  const result = async (run: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '办公操作未完成' }] }; }
  };
  server.registerTool('office_scope', {
    description: '查看用户给本 Bot 配置的办公账户、邮件查询和飞书文档范围。配置存在不等于连接或执行已经验证。',
    annotations: { readOnlyHint: true },
  }, () => result(() => office.scope(botId, agentId)));
  server.registerTool('read_feishu_document', {
    description: '通过现有飞书连接器读取用户指定文档或知识库节点；不提供写入工具。',
    inputSchema: { documentId: z.string().optional(), wikiToken: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, input => result(() => office.readDocument(botId, agentId, input)));
  server.registerTool('list_gmail_messages', {
    description: '仅列出用户批准查询范围内的邮件，不接受另一个账户或查询表达式。',
    inputSchema: { pageToken: z.string().optional() }, annotations: { readOnlyHint: true },
  }, ({ pageToken }) => result(() => office.listMessages(botId, agentId, pageToken)));
  server.registerTool('read_gmail_message', {
    description: '先核对邮件属于批准的查询范围，再读取正文。',
    inputSchema: { id: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, ({ id }) => result(() => office.readMessage(botId, agentId, id)));
  server.registerTool('propose_mail', {
    description: '登记待确认的邮件正文，不发送、不创建云端草稿。同一次操作必须复用 requestId；来源邮件须在批准范围内。',
    inputSchema: {
      requestId: z.string().min(1).max(200), to: z.array(z.email()).min(1),
      subject: z.string().min(1).max(300), text: z.string().min(1).max(20000),
      sourceIds: z.array(z.string()).default([]),
    },
  }, input => result(async () => mailAction.parse(await office.mail.propose(botId, agentId, input))));
  server.registerTool('list_mail_actions', {
    description: '查看当前事项的邮件登记，区分待确认、草稿、已发送和结果不确定；不含其他事项。',
    annotations: { readOnlyHint: true },
  }, () => result(async () => {
    await office.scope(botId, agentId);
    return (await office.mail.list(botId)).filter(action => action.agentId === agentId).map(action => mailAction.parse(action));
  }));
  server.registerTool('send_mail_action', {
    description: '只执行已由用户确认或仍有效的精确固定预授权邮件。工具参数不能批准动作；未知结果只回查，不能重发。',
    inputSchema: { actionId: z.string().min(1) },
  }, ({ actionId }) => result(async () => mailAction.parse(await office.mail.send(botId, agentId, actionId))));
  server.registerTool('reconcile_mail_action', {
    description: '回查该事项邮件的实际状态，不发起新的外发。草稿消失不表示邮件已发送。',
    inputSchema: { actionId: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, ({ actionId }) => result(async () => mailAction.parse(await office.mail.reconcile(botId, agentId, actionId))));
}
