import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { memoryEntrySchema, type MemoryEntry } from '../shared/memory.js';
import { selectInjectableMemories } from './store.js';
import { addMemoryEntry, updateMemoryEntry, archiveMemoryEntry, restoreMemoryEntry } from './memory-entries.js';
import { writeJsonFile } from './storage.js';

const document = z.strictObject({ version: z.literal(1), memories: z.array(memoryEntrySchema) });
type Input = Pick<MemoryEntry, 'content' | 'kind'>;

/** User-published team facts; model-facing memory tools are read-only. */
export class TeamMemoryStore {
  private readonly file: string;
  private serial = Promise.resolve();
  constructor(directory: string) { this.file = join(directory, 'team-memories.json'); }

  private async read() {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1 as const, memories: [] as MemoryEntry[] }; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) { throw new Error('团队记忆存档损坏，原文件未改写', { cause: error }); }
    const parsed = document.safeParse(value);
    if (!parsed.success) throw new Error('团队记忆存档损坏，原文件未改写');
    return parsed.data;
  }
  private async change<T>(action: (entries: MemoryEntry[]) => { value: T; changed: boolean }): Promise<T> {
    const pending = this.serial.then(async () => {
      const state = await this.read(); const result = action(state.memories);
      if (result.changed) await writeJsonFile(this.file, state);
      return result.value;
    });
    this.serial = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async listMemories(includeArchived = false) { return (await this.read()).memories.filter(entry => includeArchived || !entry.archivedAt); }
  async confirmed() { return selectInjectableMemories(await this.listMemories()); }
  async addMemory(input: Input) {
    return this.change(entries => { const result = addMemoryEntry(entries, { ...input, origin: { type: 'manual' } }); return { value: result.entry, changed: result.changed }; });
  }
  async updateMemory(memoryId: string, input: Input) {
    return this.change(entries => { const result = updateMemoryEntry(entries, memoryId, { ...input, origin: { type: 'manual' } }); return { value: result.entry, changed: result.changed }; });
  }
  async removeMemory(memoryId: string) {
    return this.change(entries => { const removed = archiveMemoryEntry(entries, memoryId, undefined, { type: 'manual' }); return { value: removed, changed: removed }; });
  }
  async restoreMemory(memoryId: string) {
    return this.change(entries => { const result = restoreMemoryEntry(entries, memoryId); return { value: result.entry, changed: result.changed }; });
  }
}
