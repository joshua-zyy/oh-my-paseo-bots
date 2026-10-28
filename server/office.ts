import { isAbsolute } from 'node:path';
import type { BotOffice } from '../shared/office.js';
import { GmailClient, buildMail, matchesDraft } from './gmail.js';
import { FeishuReader } from './feishu.js';
import { MailOutbox } from './mail.js';
import type { BotStore } from './store.js';

/** 只把已配置的办公读取和邮件动作接到 Bot；账户登录与执行仍由成熟连接器负责。 */
export class BotOfficeAccess {
  readonly mail: MailOutbox;
  constructor(private readonly options: { baseDir: string; store: BotStore; readConfig: (botId: string) => Promise<BotOffice>; requireActive?: (botId: string, agentId: string) => Promise<unknown> }) {
    this.mail = new MailOutbox({ baseDir: options.baseDir, store: options.store, requireActive: options.requireActive, getClient: async botId => Object.assign(await this.gmail(botId), { buildMail, matchesDraft }) });
  }

  async scope(botId: string, agentId?: string) {
    await this.authorize(botId, agentId);
    const config = await this.options.readConfig(botId);
    return {
      gmail: config.gmail ? { configured: true, account: config.gmail.account, query: config.gmail.query } : { configured: false },
      feishu: { configured: Boolean(config.feishu), documentIds: config.feishu?.documentIds ?? [], wikiTokens: config.feishu?.wikiTokens ?? [] },
    };
  }

  async listMessages(botId: string, agentId: string, pageToken?: string) {
    await this.authorize(botId, agentId);
    await this.options.requireActive?.(botId, agentId);
    return (await this.gmail(botId)).listMessages(pageToken);
  }

  async readMessage(botId: string, agentId: string, id: string) {
    await this.authorize(botId, agentId);
    await this.options.requireActive?.(botId, agentId);
    return (await this.gmail(botId)).getMessage(id);
  }

  async readDocument(botId: string, agentId: string, input: { documentId?: string; wikiToken?: string }) {
    await this.authorize(botId, agentId);
    await this.options.requireActive?.(botId, agentId);
    const config = (await this.options.readConfig(botId)).feishu;
    if (!config) throw new Error('本 Bot 未配置飞书读取范围');
    return new FeishuReader(config).read(input);
  }

  private async gmail(botId: string) {
    const config = (await this.options.readConfig(botId)).gmail;
    if (!config) throw new Error('本 Bot 未配置 Gmail 账户和读取范围');
    if (!isAbsolute(config.configDir)) throw new Error('gws 登录配置目录必须为宿主绝对路径');
    return new GmailClient(config);
  }

  private async authorize(botId: string, agentId?: string) {
    const bot = await this.options.store.getBot(botId);
    if (!bot) throw new Error('Bot 不存在');
    if (agentId && !bot.sessions.some(item => item.sessionId === agentId) && !bot.creationIntents.some(item => item.agentId === agentId)) {
      throw new Error('该会话未关联此 Bot');
    }
  }
}
