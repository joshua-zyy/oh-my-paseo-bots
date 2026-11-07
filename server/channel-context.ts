import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PaseoApi } from '@getpaseo/client';
import { channelIdSchema, type ChannelId } from '../shared/channels.js';
import { memoryEntrySchema, type MemoryOrigin } from '../shared/memory.js';
import { BotStore, botIdSchema, addMemorySchema, updateMemorySchema, selectInjectableMemories, type AddMemoryInput, type UpdateMemoryInput } from './store.js';
import type { ChannelStore } from './channels.js';
import { addMemoryEntry, updateMemoryEntry, archiveMemoryEntry, restoreMemoryEntry } from './memory-entries.js';
import { writeJsonFile } from './storage.js';
import { ScopeAccessError } from './store-errors.js';

const stateSchema = z.strictObject({ version: z.literal(1), channelId: channelIdSchema, sessions: z.array(z.object({ botId: botIdSchema, agentId: z.string().min(1).max(200) })), memories: z.array(memoryEntrySchema) });
type State = z.output<typeof stateSchema>;

/** 仅持久化群内记忆和原生标识，不保存群聊正文。 */
export class ChannelContextStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string, private readonly bots: BotStore, private readonly channels: ChannelStore) {}

  async requireMember(id: ChannelId, botId: string) {
    const channel = await this.channels.get(id);
    if (!channel || channel.archivedAt) throw new ScopeAccessError('频道不存在或已归档');
    if (!channel.memberIds.includes(botId)) throw new ScopeAccessError('同事已不属于此频道');
    const bot = await this.bots.getBot(botId);
    if (!bot || bot.bot.archivedAt) throw new ScopeAccessError('频道同事不存在或已归档');
    return channel;
  }
  async authorize(id: ChannelId, botId: string, agentId: string, paseo: PaseoApi) {
    const channel = await this.requireMember(id, botId);
    const bot = (await this.bots.getBot(botId))!;
    const link = bot.sessions.find(link => link.sessionId === agentId) ?? bot.creationIntents.find(intent => intent.agentId === agentId);
    const native = await paseo.agents.ref(agentId).refresh();
    if (link?.channelId !== id || !native || native.agent.archivedAt || native.agent.labels['paseo-guys.channel'] !== id || native.agent.labels['paseo-guys.bot'] !== botId) throw new ScopeAccessError('原生会话不属于此频道场景');
    return channel;
  }
  private async read(id: ChannelId): Promise<State> {
    const file = join(this.directory, 'channel-contexts', `${id}.json`);
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, channelId: id, sessions: [], memories: [] }; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) { throw new Error(`频道上下文存档损坏：${id}`, { cause: error }); }
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success || parsed.data.channelId !== id) throw new Error(`频道上下文存档损坏：${id}`);
    return parsed.data;
  }
  private async change<T>(id: ChannelId, action: (state: State) => { value: T; changed: boolean }): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const pending = prior.then(async () => {
      const channel = await this.channels.get(id);
      if (!channel || channel.archivedAt) throw new ScopeAccessError('频道不存在或已归档');
      const state = await this.read(id); const result = action(state);
      if (result.changed) await writeJsonFile(join(this.directory, 'channel-contexts', `${id}.json`), state);
      return result.value;
    });
    const settled = pending.then(() => undefined, () => undefined); this.locks.set(id, settled);
    try { return await pending; } finally { if (this.locks.get(id) === settled) this.locks.delete(id); }
  }
  async sessions(id: ChannelId) { return (await this.read(id)).sessions; }
  async link(id: ChannelId, botId: string, agentId: string) {
    await this.requireMember(id, botId);
    return this.change(id, state => {
      if (state.sessions.some(session => session.agentId === agentId && session.botId === botId)) return { value: undefined, changed: false };
      state.sessions.push({ botId, agentId }); return { value: undefined, changed: true };
    });
  }
  async listMemories(id: ChannelId, includeArchived = false) {
    if (!await this.channels.get(id)) throw new Error('频道不存在');
    return (await this.read(id)).memories.filter(memory => includeArchived || !memory.archivedAt);
  }
  async confirmed(id: ChannelId) { return selectInjectableMemories(await this.listMemories(id)); }
  async addMemory(id: ChannelId, input: AddMemoryInput) {
    const value = addMemorySchema.parse(input);
    return this.change(id, state => { const result = addMemoryEntry(state.memories, value); return { value: result.entry, changed: result.changed }; });
  }
  async updateMemory(id: ChannelId, memoryId: string, input: UpdateMemoryInput, expectedContent?: string) {
    const value = updateMemorySchema.parse(input);
    return this.change(id, state => { const result = updateMemoryEntry(state.memories, memoryId, value, expectedContent); return { value: result.entry, changed: result.changed }; });
  }
  async removeMemory(id: ChannelId, memoryId: string, expectedContent?: string, origin?: MemoryOrigin) {
    return this.change(id, state => { const removed = archiveMemoryEntry(state.memories, memoryId, expectedContent, origin); return { value: removed, changed: removed }; });
  }
  async restoreMemory(id: ChannelId, memoryId: string) {
    return this.change(id, state => { const result = restoreMemoryEntry(state.memories, memoryId); return { value: result.entry, changed: result.changed }; });
  }
}
