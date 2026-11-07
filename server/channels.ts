import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { channelIdSchema, channelSchema, type Channel, type ChannelDetails, type ChannelId } from '../shared/channels.js';
import type { BotStore } from './store.js';
import { writeJsonFile } from './storage.js';

const diskSchema = channelSchema.safeExtend({ version: z.literal(1) }).refine(value => isAbsolute(value.cwd), '工作目录必须是绝对路径');

/** 仅保存场景配置和同事标识，不创建执行会话，不复制私聊或记忆。 */
export class ChannelStore {
  private readonly directory: string;
  private readonly bots: BotStore;
  constructor({ baseDir, bots }: { baseDir: string; bots: BotStore }) {
    this.directory = join(baseDir, 'channels');
    this.bots = bots;
  }

  async get(id: ChannelId): Promise<Channel | null> {
    const file = join(this.directory, `${id}.json`);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error(`频道存档损坏：${file}`, { cause: error });
      throw error;
    }
    const result = diskSchema.safeParse(value);
    if (!result.success || result.data.id !== id) throw new Error(`频道存档损坏：${file}`);
    const { version, ...channel } = result.data;
    return channel;
  }

  async list(includeArchived = false): Promise<Channel[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const channels: Channel[] = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const id = channelIdSchema.safeParse(name.slice(0, -5));
      if (!id.success) throw new Error(`频道存档损坏：${name}`);
      const channel = await this.get(id.data);
      if (channel && (includeArchived || !channel.archivedAt)) channels.push(channel);
    }
    return channels.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
  }

  private async checkMembers(details: ChannelDetails): Promise<void> {
    if (!isAbsolute(details.cwd)) throw new Error('频道工作目录必须是绝对路径');
    for (const id of details.memberIds) {
      if (!await this.bots.getBot(id)) throw new Error(`频道同事 ${id} 不存在`);
    }
  }

  async create(input: ChannelDetails & { id: ChannelId }): Promise<Channel> {
    const { id, ...details } = input;
    const current = await this.get(id);
    if (current) {
      const { id: savedId, createdAt, updatedAt, archivedAt, ...savedDetails } = current;
      if (JSON.stringify(savedDetails) === JSON.stringify(details)) return current;
      throw new Error('此频道标识已存在，请先读取原频道，不要用同一标识创建不同配置');
    }
    await this.checkMembers(details);
    const now = new Date().toISOString();
    const channel = { ...details, id, createdAt: now, updatedAt: now };
    await writeJsonFile(join(this.directory, `${id}.json`), { ...channel, version: 1 });
    return channel;
  }

  async update(id: ChannelId, details: ChannelDetails): Promise<Channel> {
    const current = await this.get(id);
    if (!current) throw new Error('未找到频道');
    if (current.archivedAt) throw new Error('频道已归档，请先恢复后再编辑');
    await this.checkMembers(details);
    const channel = { ...current, ...details, updatedAt: new Date().toISOString() };
    await writeJsonFile(join(this.directory, `${id}.json`), { ...channel, version: 1 });
    return channel;
  }

  async setArchived(id: ChannelId, archived: boolean): Promise<Channel> {
    const current = await this.get(id);
    if (!current) throw new Error('未找到频道');
    if (Boolean(current.archivedAt) === archived) return current;
    const { archivedAt, ...details } = current;
    const now = new Date().toISOString();
    const channel = { ...details, updatedAt: now, ...(archived ? { archivedAt: now } : {}) };
    await writeJsonFile(join(this.directory, `${id}.json`), { ...channel, version: 1 });
    return channel;
  }
}
