import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { StoredScheduleSchema } from '@getpaseo/protocol/schedule/types';

export const routineInput = z.object({
  requestId: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(1500),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  continuity: z.boolean().default(false),
});
export const routineRecord = routineInput.omit({ requestId: true }).extend({
  id: z.uuid(), botId: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  state: z.enum(['pending', 'ready', 'unknown', 'canceled']),
  execution: z.object({ provider: z.string(), cwd: z.string(), modeId: z.string().optional(), thinkingOptionId: z.string().optional() }),
  runRequest: z.object({ id: z.uuid(), state: z.enum(['pending', 'acknowledged', 'unknown']) }).optional(),
  nativeId: z.string().min(1).optional(), detail: z.string().optional(),
});
export type RoutineRecord = z.infer<typeof routineRecord>;
export type RoutineInput = z.input<typeof routineInput>;
const view = z.object({ routine: routineRecord, native: StoredScheduleSchema.nullable(), error: z.string().optional() });
const owner = z.object({ botId: z.string(), routineId: z.uuid() });
export const listRoutines = defineRpc({ name: 'bots.routines', input: z.object({ botId: z.string() }), output: z.array(view) });
export const createRoutine = defineRpc({ name: 'bots.routine.create', input: routineInput.extend({ botId: z.string() }), output: routineRecord });
export const pauseRoutine = defineRpc({ name: 'bots.routine.pause', input: owner, output: routineRecord });
export const resumeRoutine = defineRpc({ name: 'bots.routine.resume', input: owner, output: routineRecord });
export const runRoutine = defineRpc({ name: 'bots.routine.run', input: owner, output: routineRecord });
export const cancelRoutine = defineRpc({ name: 'bots.routine.cancel', input: owner, output: routineRecord });
