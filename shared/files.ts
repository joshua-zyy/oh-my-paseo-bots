import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { botSkillSchema } from './capabilities.js';

export const listDirectory = defineRpc({
  name: 'bots.directory.list',
  input: z.object({ path: z.string().trim().min(1).optional(), kind: z.enum(['directory', 'skill', 'mcp']).default('directory') }),
  output: z.object({ path: z.string(), parent: z.string().nullable(), home: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(['directory', 'file']) })) }),
});
export const inspectSkill = defineRpc({ name: 'bots.skill.inspect', input: z.object({ path: z.string().trim().min(1) }), output: botSkillSchema });
export const inspectMcp = defineRpc({ name: 'bots.mcp.inspect', input: z.object({ path: z.string().trim().min(1) }), output: z.object({ names: z.array(z.string()) }) });
export const configurationDefaults = defineRpc({ name: 'bots.configuration.defaults', input: z.object({}), output: z.object({ cwd: z.string() }) });
