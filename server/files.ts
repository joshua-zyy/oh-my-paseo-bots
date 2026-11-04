import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { z } from 'zod';
import type { RpcInput } from '@getpaseo/plugin';
import type { listDirectory } from '../shared/files.js';
import { botSkillSchema, mcpNameSchema, mcpServerSchema } from '../shared/capabilities.js';

export async function readDirectory(input: RpcInput<typeof listDirectory>) {
  const skills = join(homedir(), '.agents', 'skills');
  const path = input.path ?? (input.kind === 'skill' && existsSync(skills) ? skills : homedir());
  if (!isAbsolute(path)) throw new Error('请选择宿主绝对路径');
  const current = resolve(path);
  const entries = await Promise.all((await readdir(current, { withFileTypes: true })).map(async entry => {
    const path = join(current, entry.name);
    const directory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path)).isDirectory());
    if (directory) return { name: entry.name, path, kind: 'directory' as const };
    if ((input.kind === 'skill' && entry.name === 'SKILL.md') || (input.kind === 'mcp' && entry.name.endsWith('.json'))) return { name: entry.name, path, kind: 'file' as const };
    return null;
  }));
  return { path: current, parent: dirname(current) === current ? null : dirname(current), home: homedir(), entries: entries.filter(entry => entry !== null).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-CN')) };
}

export async function readSkill(path: string) {
  if (!isAbsolute(path) || basename(path) !== 'SKILL.md') throw new Error('请选择宿主绝对路径下的 SKILL.md');
  const text = await readFile(path, 'utf8');
  // Frontmatter selection adapted from oliexe/paseo-bots (MIT); see THIRD_PARTY_NOTICES.md.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]?.split(/\r?\n/) ?? [];
  const read = (key: string) => {
    const index = frontmatter.findIndex(line => line.startsWith(`${key}:`));
    if (index < 0) return '';
    const value = frontmatter[index].slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
    if (value !== '|' && value !== '>') return value;
    const lines: string[] = [];
    for (const line of frontmatter.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      lines.push(line.trim());
    }
    return lines.join(' ').trim();
  };
  return botSkillSchema.parse({ path, name: read('name') || basename(dirname(path)), description: read('description') });
}

const importedMcp = z.object({ mcpServers: z.record(mcpNameSchema, z.preprocess(value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && !('type' in value)) {
    return { ...value, type: 'command' in value ? 'stdio' : 'http' };
  }
  return value;
}, mcpServerSchema)) });

export async function readMcp(path: string) {
  if (!isAbsolute(path)) throw new Error('请选择 MCP 配置的宿主绝对路径');
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('MCP 文件不是有效 JSON'); }
  const parsed = importedMcp.safeParse(value);
  if (!parsed.success) throw new Error('MCP 文件格式无效，需包含 mcpServers，且不能覆盖 Paseo 与 Bot 工具');
  return parsed.data.mcpServers;
}

/** Source locations adapted from oliexe/paseo-bots (MIT); credentials stay on the host. */
export async function discoverMcpSources(options: { cwd?: string; home?: string; appData?: string; platform?: NodeJS.Platform } = {}) {
  const home = options.home ?? homedir();
  const os = options.platform ?? platform();
  const desktop = os === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : os === 'win32' ? join(options.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude') : join(home, '.config', 'Claude');
  if (options.cwd && !isAbsolute(options.cwd)) throw new Error('请选择项目的宿主绝对路径');
  const locations = [
    ...(options.cwd ? [{ label: '当前项目', path: join(options.cwd, '.mcp.json') }] : []),
    { label: 'Claude Code', path: join(home, '.claude.json') },
    { label: 'Claude Desktop', path: join(desktop, 'claude_desktop_config.json') },
    { label: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
  ];
  const sources: { label: string; path: string; names: string[]; error?: string }[] = [];
  for (const location of locations) {
    try {
      const names = Object.keys(await readMcp(location.path));
      if (names.length) sources.push({ ...location, names });
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') sources.push({ ...location, names: [], error: failure instanceof Error ? failure.message : '配置不可读取' });
    }
  }
  return { sources };
}
