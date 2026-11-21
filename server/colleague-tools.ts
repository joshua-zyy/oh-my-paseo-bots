import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHIEF_BOT_ID, botDetailsSchema, botPatchSchema, botExecutionSchema, type BotDetails } from '../shared/bot.js';
import { botIdSchema, type BotStore } from './store.js';
import type { TaskTracker } from './tasks.js';

export interface ColleagueToolScope {
  store: BotStore;
  tasks: TaskTracker;
  botId: string;
  agentId: string;
  start: (input: { botId: string; parentAgentId: string; requestId: string; title: string; prompt: string }) => Promise<{ agentId: string; requestId: string }>;
}

const editableExecution = botExecutionSchema.omit({ modeId: true }).strict();
const editablePatch = z.strictObject({
  name: botPatchSchema.shape.name,
  role: botPatchSchema.shape.role,
  instructions: botPatchSchema.shape.instructions,
  execution: editableExecution.optional(),
});

/** 局部更新保留覆盖与显式执行模式；模型改变仅清除未重选的思考选项。 */
function mergeExecution(current: BotDetails['execution'], patch: z.output<typeof editableExecution>) {
  const next = { ...current, ...patch };
  if (patch.provider !== undefined && patch.provider !== current.provider) {
    if (patch.thinkingOptionId === undefined) delete next.thinkingOptionId;
  }
  return next;
}

/** 身份由服务端绑定；只适配业务元数据及原生创建，不复制同事历史。 */
export function registerColleagueTools(server: McpServer, scope: ColleagueToolScope): void {
  const run = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '同事委派未完成' }] }; }
  };
  const workInput = {
    requestId: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(20000),
  };
  async function startWork(botId: string, input: { requestId: string; title: string; prompt: string }, kind: 'task' | 'delegation') {
    await scope.tasks.requireActive(scope.botId, scope.agentId);
    const source = createHash('sha256').update(scope.agentId).digest('hex');
    const namespace = `${kind}:${source}:`;
    const result = await scope.start({ botId, parentAgentId: scope.agentId, requestId: `${namespace}${input.requestId}`, title: input.title, prompt: input.prompt });
    await scope.tasks.observeSpecialist(scope.botId, scope.agentId, result.agentId);
    return { agentId: result.agentId, requestId: result.requestId.slice(namespace.length) };
  }
  server.registerTool('start_task', {
    description: '为本 Bot 建立独立 Paseo 子事项，适合从持续聊天交办需要完成、取消或定时跟进的工作。传明确目标、交付物和必要上下文；不复制整段聊天、记忆或新增权限。保持原始 requestId 重试，启动回执不等于完成；结果经原生通信返回父聊天，由父 Bot 核对。普通问答直接回复，不建立事项。',
    inputSchema: workInput,
  }, input => run(() => startWork(scope.botId, input, 'task')));
  server.registerTool('create_colleague', {
    description: '仅 Chief 可登记一个确有长期职责且未重复的固定同事，不自动启动执行 Agent。id 是稳定小写标识，结果不确定时先查目录，不换标识重复创建。未指定执行配置沿用创建者；模型、思考和目录仅按用户要求或现有授权选择，不提供账户、工具权限或 modeId 授权。登记后用 delegate_to_colleague 交办实际工作。',
    inputSchema: {
      id: botIdSchema,
      name: botDetailsSchema.shape.name,
      role: botDetailsSchema.shape.role,
      instructions: botDetailsSchema.shape.instructions,
      execution: editableExecution.optional(),
    },
  }, input => run(async () => {
    if (scope.botId !== CHIEF_BOT_ID) throw new Error('只有 Chief 可创建固定同事，请将需要告知 Chief');
    await scope.tasks.requireActive(scope.botId, scope.agentId);
    const creator = (await scope.store.getBot(scope.botId))!;
    const record = await scope.store.createBot({ ...input, execution: mergeExecution(creator.bot.execution, input.execution ?? {}) });
    return { id: record.bot.id, name: record.bot.name, role: record.bot.role, started: false };
  }));
  server.registerTool('update_colleague', {
    description: '修改固定同事的名称、职责、长期说明及已有模型/目录/思考配置。普通同事只可修改自己，Chief 可修改团队同事；不接受 modeId、账户或权限字段。patch 只提交需要修改的字段，执行配置局部合并，模型改变仅清除未重选的思考选项；已有显式执行模式保留，若不兼容须由用户配置。仅影响之后的新会话，不重写已有执行会话。',
    inputSchema: { colleagueId: botIdSchema.optional(), patch: editablePatch },
  }, input => run(async () => {
    const botId = input.colleagueId ?? scope.botId;
    if (botId !== scope.botId && scope.botId !== CHIEF_BOT_ID) throw new Error('只有 Chief 可调整其他固定同事');
    await scope.tasks.requireActive(scope.botId, scope.agentId);
    const bot = await scope.store.updateBot(botId, current => input.patch.execution
      ? { ...input.patch, execution: mergeExecution(current.execution, input.patch.execution) }
      : input.patch);
    return { id: bot.id, name: bot.name, role: bot.role };
  }));
  server.registerTool('list_colleagues', {
    description: '查看其他已注册固定同事的标识、名称和职责；不读取其记忆、历史或账户配置。只按当前事项需要选择接收同事。',
    annotations: { readOnlyHint: true },
  }, () => run(async () => (await scope.store.listBots())
    .filter(bot => bot.id !== scope.botId && bot.id !== CHIEF_BOT_ID)
    .map(({ id, name, role }) => ({ id, name, role }))));
  server.registerTool('delegate_to_colleague', {
    description: '把当前事项中明确的一部分交给已注册的其他固定同事，通过 Paseo 原生父子会话运行。仅传任务必要上下文；不传全部记忆或历史，不扩大权限。requestId 为本次委派的稳定原始标识，重试用同一输入，不换标识规避未知结果。启动回执不等于完成；使用 Paseo 原生通知与通信取得实际结果并按交付条件核对。',
    inputSchema: {
      colleagueId: z.string().trim().min(1).max(64),
      ...workInput,
    },
  }, input => run(async () => {
    if (input.colleagueId === scope.botId) throw new Error('请委派给其他固定同事，不能委派给自己');
    const colleague = await scope.store.getBot(input.colleagueId);
    if (!colleague) throw new Error(`固定同事未注册：${input.colleagueId}`);
    if (colleague.bot.id === CHIEF_BOT_ID) throw new Error('Chief 不是专长子 Bot 预设');
    return startWork(input.colleagueId, input, 'delegation');
  }));
}
