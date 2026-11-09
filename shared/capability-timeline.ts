import { z } from 'zod';
import type { AgentTimelineItem, PluginTimelineItem } from '@getpaseo/protocol/agent-types';
import { capabilityRequestSchema, type CapabilityRequestView } from './capability-guidance.js';

export const CAPABILITY_TIMELINE = { pluginId: 'oh-my-paseo-bots', kind: 'capability-status', version: 1 } as const;
/** A readable decision record, not a revision signal or an approval endpoint. */
export const capabilityStatusSchema = z.strictObject({
  botId: z.string().min(1).max(64), botName: z.string().min(1).max(200),
  requestId: capabilityRequestSchema.shape.id,
  state: capabilityRequestSchema.shape.state,
  skillCount: z.number().int().min(0).max(50), mcpCount: z.number().int().min(0).max(30),
});
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
const rowId = (data: Pick<CapabilityStatus, 'botId' | 'requestId'>) => `capability:${data.botId}:${data.requestId}`;
export function capabilityStatusItem(botId: string, botName: string, request: CapabilityRequestView): Omit<PluginTimelineItem, 'pluginId'> {
  const data = capabilityStatusSchema.parse({ botId, botName, requestId: request.id, state: request.state, skillCount: request.skills.length, mcpCount: request.mcp.length });
  return { type: 'plugin', id: rowId(data), kind: CAPABILITY_TIMELINE.kind, version: CAPABILITY_TIMELINE.version, data };
}
export function readCapabilityStatus(item: AgentTimelineItem): CapabilityStatus | null {
  if (item.type !== 'plugin' || item.pluginId !== CAPABILITY_TIMELINE.pluginId || item.kind !== CAPABILITY_TIMELINE.kind || item.version !== CAPABILITY_TIMELINE.version) return null;
  const parsed = capabilityStatusSchema.safeParse(item.data);
  return parsed.success && item.id === rowId(parsed.data) ? parsed.data : null;
}
export function capabilityStatusText(data: CapabilityStatus) {
  return {
    title: `${data.botName} · ${data.state === 'pending' ? '能力方案待确认' : data.state === 'applied' ? '能力配置已保存' : '能力方案已拒绝'}`,
    detail: data.state === 'pending' ? `${data.skillCount}项技能、${data.mcpCount}项连接。请到原能力入口核对；查看不会批准。`
      : data.state === 'applied' ? '仅影响后续新会话或任务；已有运行不因此获得新增能力。' : '此方案未应用配置；不会替你停止其他工作。',
  };
}
