import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRpc } from '@getpaseo/plugin';
import type { PluginServerContext, PluginLifecycleEvents } from '@getpaseo/plugin/server';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { assertPluginCompatibility } from '@getpaseo/protocol/plugin-requirements';

test('manifest 接受 0.14/0.15 宿主和客户端，拒绝缺少例程接入字段的旧版及未核对的下一主线', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../paseo-plugin.json', import.meta.url), 'utf8'));
  for (const runtime of ['daemon', 'app'] as const) {
    for (const version of ['0.14.0', '0.15.0', '0.15.2']) {
      assert.doesNotThrow(() => assertPluginCompatibility({ ...manifest, version, runtime }));
    }
    for (const version of ['0.12.0', '0.13.2', '0.16.0']) {
      assert.throws(() => assertPluginCompatibility({ ...manifest, version, runtime }));
    }
  }
});

test('发布包可定义并验证 RPC 输入输出', () => {
  const rpc = defineRpc({ name: 'bots.inspect', input: z.object({ botId: z.string().min(1) }), output: z.object({ agentIds: z.array(z.string()) }) });
  assert.equal(rpc.input.safeParse({ botId: '' }).success, false);
  assert.deepEqual(rpc.output.parse({ agentIds: ['native-agent'] }), { agentIds: ['native-agent'] });
});

// Compile against the published declarations; this does not invoke a daemon.
export function publishedApiContract(server: PluginServerContext, paseo: PaseoApi, config: PaseoAgentCreateOptions) {
  server.before('agent.session_open', async ({ request }) => {
    const botId: string | undefined = request.labels['paseo-guys.bot'];
    return {
      ...request,
      mcpServers: {
        ...request.mcpServers,
        ...(botId ? { 'contract-check': { type: 'http' as const, url: `http://127.0.0.1:1/${request.agentId}` } } : {}),
      },
    };
  });
  server.on('agent.turn_ended', (event: PluginLifecycleEvents['agent.turn_ended'], context) => {
    // The inline timeline is deprecated and always empty in this version.
    return context.paseo.agents.ref(event.agent.id).timeline.refetch({ direction: 'tail', limit: 20 }).then(() => {});
  });
  return paseo.agents.create(config);
}
