import { randomUUID } from 'node:crypto';
import type { MemoryEntry, MemoryOrigin } from '../shared/memory.js';
import type { AddMemoryInput, UpdateMemoryInput } from './store.js';
import { StoreError } from './store-errors.js';

/** 共用既有记忆生命周期；容器负责作用域、边界校验和持久化。 */
export function addMemoryEntry(entries: MemoryEntry[], value: AddMemoryInput) {
  const existing = entries.find(entry => !entry.archivedAt && entry.kind === value.kind && entry.content === value.content);
  if (existing) return { entry: existing, changed: false };
  const now = new Date().toISOString();
  const entry: MemoryEntry = { id: `mem_${randomUUID()}`, kind: value.kind, content: value.content, source: value.source ?? (value.kind === 'confirmed' ? 'user' : 'inferred'), createdAt: now, updatedAt: now, confirmedAt: value.kind === 'confirmed' ? now : null, origin: value.origin, history: [] };
  entries.push(entry);
  return { entry, changed: true };
}
export function updateMemoryEntry(entries: MemoryEntry[], memoryId: string, value: UpdateMemoryInput, expectedContent?: string) {
  const entry = entries.find(entry => entry.id === memoryId && !entry.archivedAt);
  if (!entry) throw new StoreError('memory_not_found', `active memory ${memoryId} not found`);
  if (expectedContent !== undefined && entry.content !== expectedContent) throw new StoreError('memory_conflict', '记忆已改变，请重新读取后按当前内容操作');
  if ((value.content === undefined || value.content === entry.content) && (value.kind === undefined || value.kind === entry.kind)) return { entry, changed: false };
  const now = new Date().toISOString();
  const duplicate = entries.find(other => other.id !== memoryId && !other.archivedAt && other.content === (value.content ?? entry.content) && other.kind === (value.kind ?? entry.kind));
  if (duplicate) {
    entry.archivedAt = now; entry.updatedAt = now; entry.history.push({ at: now, action: 'merged', targetId: duplicate.id, origin: value.origin });
    return { entry: duplicate, changed: true };
  }
  entry.history.push({ at: now, action: 'updated', before: { content: entry.content, kind: entry.kind }, origin: value.origin });
  if (value.content !== undefined) entry.content = value.content;
  if (value.kind !== undefined && value.kind !== entry.kind) { entry.kind = value.kind; entry.confirmedAt = value.kind === 'confirmed' ? now : null; }
  entry.updatedAt = now;
  return { entry, changed: true };
}
export function archiveMemoryEntry(entries: MemoryEntry[], memoryId: string, expectedContent?: string, origin?: MemoryOrigin) {
  const entry = entries.find(entry => entry.id === memoryId);
  if (expectedContent !== undefined && entry?.content !== expectedContent) throw new StoreError('memory_conflict', '记忆已改变或移除，请重新读取后按当前内容操作');
  if (!entry || entry.archivedAt) return false;
  const now = new Date().toISOString(); entry.archivedAt = now; entry.updatedAt = now; entry.history.push({ at: now, action: 'archived', origin });
  return true;
}
export function restoreMemoryEntry(entries: MemoryEntry[], memoryId: string) {
  const entry = entries.find(entry => entry.id === memoryId);
  if (!entry) throw new StoreError('memory_not_found', `memory ${memoryId} not found`);
  if (!entry.archivedAt) return { entry, changed: false };
  if (entries.some(other => !other.archivedAt && other.kind === entry.kind && other.content === entry.content)) throw new StoreError('memory_conflict', '已存在相同的活跃记忆，无需重复恢复');
  const now = new Date().toISOString(); delete entry.archivedAt; entry.updatedAt = now; entry.history.push({ at: now, action: 'restored', origin: { type: 'manual' } });
  return { entry, changed: true };
}
