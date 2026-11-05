import { z } from 'zod';

export const memoryContentSchema = z.string().min(1).max(8000)
  .refine(value => value.trim().length > 0, 'must not be blank').transform(value => value.trim());
export const memoryKindSchema = z.enum(['confirmed', 'candidate']);
const timestamp = z.string().min(1).max(64);
const agentId = z.string().min(1).max(200);

/** Sources are assigned by the server, never accepted from an Agent's tool arguments. */
export const memoryOriginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('agent'), agentId }),
  z.object({ type: z.literal('message'), agentId, userQuote: z.string().min(1).max(8000) }),
]);

const change = { at: timestamp, origin: memoryOriginSchema.optional() };
export const memoryChangeSchema = z.discriminatedUnion('action', [
  z.object({ ...change, action: z.literal('updated'), before: z.object({ content: memoryContentSchema, kind: memoryKindSchema }) }),
  z.object({ ...change, action: z.enum(['archived', 'restored']) }),
  z.object({ ...change, action: z.literal('merged'), targetId: z.string().min(1).max(64) }),
]);

export const memoryEntrySchema = z.object({
  id: z.string().min(1).max(64),
  kind: memoryKindSchema,
  content: memoryContentSchema,
  source: z.enum(['user', 'inferred', 'agent']),
  createdAt: timestamp,
  updatedAt: timestamp,
  confirmedAt: timestamp.nullable(),
  origin: memoryOriginSchema.optional(),
  history: z.array(memoryChangeSchema).default([]),
  archivedAt: timestamp.optional(),
});

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemorySource = MemoryEntry['source'];
