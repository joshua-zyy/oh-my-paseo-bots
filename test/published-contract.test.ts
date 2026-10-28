import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRpc } from '@getpaseo/plugin';
import type { PluginServerContext, PluginLifecycleEvents } from '@getpaseo/plugin/server';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { assertPluginCompatibility } from '@getpaseo/protocol/plugin-requirements';

test('manifest 接受已核对契约的 0.12.0 和 0.13.2 宿主，拒绝未支持的主线', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../paseo-plugin.json', import.meta.url), 'utf8'));
  for (const version of ['0.12.0', '0.13.2']) {
    assert.doesNotThrow(() => assertPluginCompatibility({ ...manifest, version, runtime: 'daemon' }));
  }
  for (const version of ['0.11.9', '0.14.0']) {
    assert.throws(() => assertPluginCompatibility({ ...manifest, version, runtime: 'daemon' }));
  }
});

test('发布包可定义并验证 RPC 输入输出', () => {
  const rpc = defineRpc({ name: 'bots.inspect', input: z.object({ botId: z.string().min(1) }), output: z.object({ agentIds: z.array(z.string()) }) });
  assert.equal(rpc.input.safeParse({ botId: '' }).success, false);
  assert.deepEqual(rpc.output.parse({ agentIds: ['native-agent'] }), { agentIds: ['native-agent'] });
});

// Compile against the published declarations; this does not invoke a daemon.
export function publishedApiContract(server: PluginServerContext, paseo: PaseoApi, config: PaseoAgentCreateOptions) {
  server.on('agent.turn_ended', (event: PluginLifecycleEvents['agent.turn_ended'], context) => {
    // The inline timeline is deprecated and always empty in this version.
    return context.paseo.agents.ref(event.agent.id).timeline.refetch({ direction: 'tail', limit: 20 }).then(() => {});
  });
  return paseo.agents.create(config);
}
