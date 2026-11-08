import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { CapabilityPlanInput, CapabilityRequest } from '../shared/capability-guidance.js';
import type { BotDetails } from '../shared/bot.js';
import type { BotStore } from './store.js';
import { discoverSkills, discoverMcpSources, readSkill, readMcp } from './files.js';

function requestView({ fingerprint: _fingerprint, ...view }: CapabilityRequest) { return view; }

/** Existing capability selection + explicit user decision; native execution remains Paseo's. */
export class CapabilityGuidance {
  constructor(private readonly store: BotStore, private readonly locations: NonNullable<Parameters<typeof discoverMcpSources>[0]> = {}, private readonly defaultCwd?: () => Promise<string | undefined>) {}

  async catalog(botId: string) {
    const bot = await this.store.getBot(botId);
    if (!bot || bot.bot.archivedAt) throw new Error('同事不存在或已归档');
    const cwd = bot.bot.execution.cwd ?? await this.defaultCwd?.() ?? this.locations.cwd;
    const discovered = await discoverSkills(this.locations.home ?? homedir(), cwd);
    const sources = await discoverMcpSources({ ...this.locations, cwd });
    return { skills: [...new Map([...bot.bot.capabilities.skills, ...discovered.skills].map(skill => [skill.path, skill])).values()], sources: sources.sources, errors: discovered.errors };
  }

  async inspect(botId: string) {
    const record = await this.store.getBot(botId);
    if (!record || record.bot.archivedAt) throw new Error('同事不存在或已归档');
    return { botId, skills: record.bot.capabilities.skills, mcpNames: Object.keys(record.bot.capabilities.mcpServers).filter(name => !record.bot.capabilities.disabledMcpServers?.includes(name)), ...(record.bot.capabilityRequest ? { request: requestView(record.bot.capabilityRequest) } : {}) };
  }

  async configure(botId: string, sourceAgentId: string, input: CapabilityPlanInput) {
    if (input.skills.length + input.mcpImports.length === 0) throw new Error('至少选择一项已有能力');
    const resolved = await this.resolve(input);
    const request: CapabilityRequest = {
      id: createHash('sha256').update(JSON.stringify([sourceAgentId, input.requestId])).digest('hex'),
      sourceAgentId, summary: input.summary, skills: resolved.additions.skills, mcp: resolved.mcp,
      fingerprint: resolved.fingerprint, state: 'pending', createdAt: new Date().toISOString(),
    };
    return requestView(await this.store.configureCapabilities(botId, request, resolved.additions));
  }

  async decide(botId: string, requestId: string, decision: 'apply' | 'reject') {
    const record = await this.store.getBot(botId);
    if (!record || record.bot.archivedAt) throw new Error('同事不存在或已归档');
    const request = record.bot.capabilityRequest;
    if (!request || request.id !== requestId) throw new Error('能力方案已经变化，请刷新后核对');
    if (request.state !== 'pending') return requestView(request);
    if (decision === 'reject') return requestView(await this.store.decideCapabilities(botId, requestId, decision));
    const resolved = await this.resolve({ skills: request.skills.map(skill => skill.path), mcpImports: request.mcp.map(item => ({ path: item.path, names: [item.name] })) });
    if (resolved.fingerprint !== request.fingerprint) throw new Error('能力来源配置已经变化，未应用；请Chief重新读取并提出方案');
    return requestView(await this.store.decideCapabilities(botId, requestId, decision, resolved.additions));
  }

  /** Fresh disk reads are a new boundary; never execute or return credentials to the model. */
  private async resolve(input: Pick<CapabilityPlanInput, 'skills' | 'mcpImports'>) {
    const skills = await Promise.all([...new Set(input.skills)].map(path => readSkill(path)));
    const sources = new Map<string, Awaited<ReturnType<typeof readMcp>>>();
    const selected = new Map<string, BotDetails['capabilities']['mcpServers'][string]>();
    const mcp: CapabilityRequest['mcp'] = [];
    for (const source of input.mcpImports) {
      let servers = sources.get(source.path);
      if (!servers) { servers = await readMcp(source.path); sources.set(source.path, servers); }
      for (const name of new Set(source.names)) {
        if (!Object.hasOwn(servers, name)) throw new Error(`来源未找到所选MCP：${name}`);
        if (mcp.some(item => item.name === name)) throw new Error(`MCP名称重复：${name}，请选择一个来源`);
        mcp.push({ path: source.path, name, type: servers[name].type });
        selected.set(name, servers[name]);
      }
    }
    const additions = { skills, mcpServers: Object.fromEntries(selected) };
    return { additions, mcp, fingerprint: createHash('sha256').update(JSON.stringify({ additions, sources: mcp.map(({ path, name }) => ({ path, name })) })).digest('hex') };
  }
}
