import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaseoApi } from '@getpaseo/client';
import type { TaskCli, TaskExecute } from '../server/tasks.js';
import { BotStore } from '../server/store.js';

test('停止当前回复只调用原生 stop，不归档聊天、取消事项或停止同事', async () => {
  const { stopBotReply } = await import(new URL('../server/reply.js', import.meta.url).href);
  const directory = await mkdtemp(join(tmpdir(), 'paseo-bots-reply-'));
  try {
    const store = new BotStore({ baseDir: directory });
    await store.createBot({ id: 'chief', name: '主 Bot', role: '协调' });
    await store.createBot({ id: 'helper', name: '同事', role: '执行' });
    await store.linkSession('chief', { sessionId: 'chat-1' });
    await store.linkSession('helper', { sessionId: 'chat-other' });
    const calls: string[][] = [];
    let status = 'running';
    const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, status, archivedAt: null } }), archive: () => assert.fail('停止回复不归档') }) } } as unknown as PaseoApi;
    const cli: TaskCli = { command: 'paseo.cmd', cwd: directory, home: join(directory, 'daemon-home') };
    const execute: TaskExecute = async (command, args, options) => {
      assert.equal(command, cli.command);
      assert.equal(options.cwd, directory);
      assert.equal(options.env.PASEO_AGENT_ID, 'chat-1');
      assert.equal(options.env.PASEO_HOST, undefined);
      calls.push(args);
      status = 'idle';
      return { stdout: JSON.stringify({ stoppedCount: 1, agentIds: ['chat-1'] }), stderr: '' };
    };
    const options = { store, paseo, botId: 'chief', agentId: 'chat-1', cli: async () => cli, tasks: { list: async () => [{ specialists: ['expert-1'] }] } };
    assert.deepEqual(await stopBotReply(options, execute), { agentId: 'chat-1', status: 'requested' });
    assert.deepEqual(calls, [['agent', 'stop', 'chat-1', '--home', cli.home, '--json']]);
    assert.deepEqual(await stopBotReply(options, execute), { agentId: 'chat-1', status: 'idle' });
    assert.equal(calls.length, 1, '闲置回复不发起停止命令');
    await assert.rejects(() => stopBotReply({ ...options, agentId: 'chat-other' }, execute), /未关联/);
    assert.equal(calls.length, 1);
    status = 'running';
    await assert.rejects(() => stopBotReply(options, async () => ({ stdout: '{"stoppedCount":0,"agentIds":[]}', stderr: 'synthetic stop failed' })), /未确认停止/);
    await assert.rejects(() => stopBotReply(options, async () => ({ stdout: 'bad response', stderr: '' })), /停止回执/);
    assert.equal((await store.getBot('chief'))!.sessions.length, 1, '持续聊天关联保持');
    status = 'idle';
    assert.deepEqual(await stopBotReply({ ...options, agentId: 'expert-1' }, execute), { agentId: 'expert-1', status: 'idle' }, '已登记的原生专家可在执行详情停止回复');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
