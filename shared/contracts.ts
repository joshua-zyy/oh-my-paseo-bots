import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';
import { botDetailsSchema, botPatchSchema } from './bot.js';
import { mcpImportSchema } from './capabilities.js';
import { memoryChangeSchema, memoryEntrySchema } from './memory.js';

const id = z.string().min(1).max(64);
const botView = botDetailsSchema.extend({ id });
const savedBotView = botView.extend({ updatedAt: z.string(), archivedAt: z.string().optional() });
export const settings = defineSettings({
  id: 'bots', scope: 'host', version: 1,
  schema: z.object({
    cwd: z.string().min(1),
    provider: z.string().regex(/^[^/\s]+\/.+$/, '使用宿主已有的 provider/model 标识'),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    paseoCommand: z.string().min(1).optional(),
    paseoHome: z.string().min(1).optional(),
  }),
});

export const listBots = defineRpc({ name: 'bots.list', input: z.object({ includeArchived: z.boolean().optional() }), output: z.object({ bots: z.array(savedBotView), corrupt: z.array(z.string()) }) });
export const toolStatus = defineRpc({ name: 'bots.tools.status', input: z.object({}), output: z.object({ state: z.enum(['idle', 'ready', 'unavailable']), detail: z.string().optional() }) });
export const createBot = defineRpc({ name: 'bots.create', input: botDetailsSchema.extend({ id: id.optional() }), output: z.object({ id }) });
export const updateBot = defineRpc({ name: 'bots.update', input: z.object({ botId: id, patch: botPatchSchema, mcpImports: z.array(mcpImportSchema).optional() }), output: savedBotView });
export const archiveBot = defineRpc({ name: 'bots.archive', input: z.object({ botId: id }), output: savedBotView });
export const restoreBot = defineRpc({ name: 'bots.restore', input: z.object({ botId: id }), output: savedBotView });
export const startSession = defineRpc({ name: 'bots.start', input: z.object({ botId: id, requestId: z.string().uuid().optional(), title: z.string().min(1).max(200), prompt: z.string().min(1) }), output: z.object({ agentId: z.string(), requestId: z.string() }) });
export const openConversation = defineRpc({ name: 'bots.conversation.open', input: z.object({ botId: id }), output: z.object({ agentId: z.string() }) });
export const createConversation = defineRpc({ name: 'bots.conversation.create', input: z.object({ botId: id }), output: z.object({ agentId: z.string() }) });
export const stopReply = defineRpc({ name: 'bots.reply.stop', input: z.object({ botId: id, agentId: z.string().min(1) }), output: z.object({ agentId: z.string(), status: z.enum(['requested', 'idle']) }) });
export const acknowledgeCreation = defineRpc({ name: 'bots.creation.acknowledge', input: z.object({ botId: id, requestId: z.string() }), output: z.object({}) });
export const pendingCreations = defineRpc({ name: 'bots.creations.pending', input: z.object({ botId: id }), output: z.array(z.object({ requestId: z.string(), agentId: z.string(), status: z.enum(['pending', 'created']) })) });
export const inspectCreation = defineRpc({ name: 'bots.creation.inspect', input: z.object({ botId: id, requestId: z.string() }), output: z.object({ agentId: z.string(), status: z.enum(['created', 'unknown']), detail: z.string().optional() }) });
export const listSessions = defineRpc({ name: 'bots.sessions', input: z.object({ botId: id }), output: z.array(z.object({ sessionId: z.string(), title: z.string().nullable(), workspaceId: z.string().nullable() })) });
const memory = memoryEntrySchema.extend({ history: z.array(memoryChangeSchema) });
export const listMemories = defineRpc({ name: 'bots.memories', input: z.object({ botId: id, includeArchived: z.boolean().optional() }), output: z.array(memory) });
export const forgetMemory = defineRpc({ name: 'bots.memory.forget', input: z.object({ botId: id, memoryId: z.string() }), output: z.object({ removed: z.boolean() }) });
export const restoreMemory = defineRpc({ name: 'bots.memory.restore', input: z.object({ botId: id, memoryId: z.string() }), output: memory });
export const saveMemory = defineRpc({ name: 'bots.memory.save', input: z.object({ botId: id, kind: z.enum(['confirmed', 'candidate']), content: z.string().min(1).max(8000) }), output: memory });
export const correctMemory = defineRpc({ name: 'bots.memory.correct', input: z.object({ botId: id, memoryId: z.string(), content: z.string().min(1).max(8000), kind: z.enum(['confirmed', 'candidate']) }), output: memory });
export const readJournal = defineRpc({ name: 'bots.journal', input: z.object({ botId: id, limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }), output: z.object({ entries: z.array(z.object({ agentId: z.string(), turnId: z.string().nullable(), kind: z.enum(['turn_started', 'turn_ended']), outcome: z.enum(['completed', 'failed', 'canceled']).optional(), error: z.string().optional(), observedAt: z.string() })), total: z.number(), offset: z.number(), nextOffset: z.number().nullable(), corruptCount: z.number(), corruptLines: z.array(z.number()) }) });
