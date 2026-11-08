import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { botSkillSchema } from './capabilities.js';

export const listDirectory = defineRpc({
  name: 'bots.directory.list',
  input: z.object({ path: z.string().trim().min(1).optional(), kind: z.enum(['directory', 'skill', 'mcp']).default('directory') }),
  output: z.object({ path: z.string(), parent: z.string().nullable(), home: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(['directory', 'file']) })) }),
});
export const listBuiltinSkills = defineRpc({ name: 'bots.skills.builtin', input: z.object({}), output: z.array(botSkillSchema) });
export const inspectSkill = defineRpc({ name: 'bots.skill.inspect', input: z.object({ path: z.string().trim().min(1) }), output: botSkillSchema });
export const inspectMcp = defineRpc({ name: 'bots.mcp.inspect', input: z.object({ path: z.string().trim().min(1) }), output: z.object({ names: z.array(z.string()) }) });
export const listMcpSources = defineRpc({
  name: 'bots.mcp.sources',
  input: z.object({ cwd: z.string().trim().min(1).optional() }),
  output: z.object({ sources: z.array(z.object({ label: z.string(), path: z.string(), names: z.array(z.string()), error: z.string().optional() })) }),
});
export const configurationDefaults = defineRpc({ name: 'bots.configuration.defaults', input: z.object({ botId: z.string().min(1).optional() }), output: z.object({ cwd: z.string() }) });
