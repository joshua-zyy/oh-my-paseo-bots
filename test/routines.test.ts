import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { StoredSchedule } from '@getpaseo/protocol/schedule/types';
import { BotStore } from '../server/store.js';
import { TaskTracker, type TaskExecute } from '../server/tasks.js';
import { BotRoutines } from '../server/routines.js';

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.dir, { recursive: true, force: true }); }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-guys-routines-'));
  const store = new BotStore({ baseDir: dir });
  await store.createBot({ id: 'chief', name: '主 Bot', role: '核对', execution: { provider: 'pi/test', cwd: dir, modeId: 'configured-mode', thinkingOptionId: 'configured-thinking' } });
  await store.createBot({ id: 'other', name: '其他 Bot', role: '无关工作' });
  const archives: string[] = [];
  const native = new Map<string, StoredSchedule>();
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let failCreate = false;
  let failArchive = false;
  let afterCreate: (() => Promise<void>) | undefined;
  let manual: (() => Promise<void>) | undefined;
  const execute: TaskExecute = async (_command, args, options) => {
    calls.push({ args, env: options.env });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    let payload: unknown;
    if (args[1] === 'create') {
      const id = `native-${native.size + 1}`;
      const timestamp = new Date().toISOString();
      const record: StoredSchedule = { id, name: flag('--name'), prompt: args[2], status: 'active', cadence: { type: 'cron', expression: flag('--cron'), timezone: flag('--timezone') }, target: { type: 'new-agent', config: { provider: 'pi', model: 'test', cwd: flag('--cwd'), modeId: flag('--mode'), thinkingOptionId: flag('--thinking') } }, createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp, lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null, runs: [] };
      native.set(id, record);
      await afterCreate?.();
      if (failCreate) throw new Error('synthetic lost receipt');
      payload = { id, status: 'active' };
    } else if (args[1] === 'ls') payload = [...native.values()].map(item => ({ id: item.id, name: item.name }));
    else {
      const record = native.get(args[2]);
      if (!record) throw new Error('native not found');
      if (args[1] === 'pause') record.status = 'paused';
      if (args[1] === 'resume') record.status = 'active';
      if (args[1] === 'run-once') await manual?.();
      payload = args[1] === 'inspect' ? record : { id: record.id, status: record.status };
    }
    return { stdout: JSON.stringify(payload), stderr: '' };
  };
  const api = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, labels: {} } }), archive: async () => {
    if (failArchive) throw new Error('synthetic archive unavailable');
    archives.push(id); return { archivedAt: new Date().toISOString() };
  } }) } } as unknown as PaseoApi;
  const cli = { command: 'synthetic-cli-only', home: dir, cwd: dir };
  const tasks = new TaskTracker({ baseDir: dir, store, cli, getPaseo: () => api, execute });
  const reopen = () => new BotRoutines({ baseDir: dir, store, tasks, cli, execute, defaults: async () => ({ cwd: dir, config: { provider: 'host/default', modeId: 'host-mode' } }) });
  const routines = reopen();
  const input = { requestId: randomUUID(), name: '资料跟进', prompt: '核对本次合成资料，交付报告；无外发授权', cron: '0 9 * * *', timezone: 'Asia/Shanghai', continuity: true };
  const request = (nativeId: string, agentId = randomUUID(), runId = randomUUID()) => {
    const schedule = native.get(nativeId)!;
    schedule.runs.push({ id: runId, agentId, workspaceId: 'native-ws', status: 'running', scheduledFor: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null, output: null, error: null });
    return { agentId, workspaceId: 'native-ws', provider: 'pi', cwd: dir, title: '标题不决定 Bot', background: true, labels: { 'paseo.schedule-id': nativeId, 'paseo.schedule-run': runId }, metadata: {}, reason: 'create', purpose: 'interactive', tools: [], env: {}, mcpServers: {} } satisfies PluginSessionOpenRequest;
  };
  return { dir, store, tasks, routines, reopen, native, calls, archives, input, request, failCreate: () => { failCreate = true; }, failArchive: () => { failArchive = true; }, onCreate: (handler: () => Promise<void>) => { afterCreate = handler; }, onManual: (handler: () => Promise<void>) => { manual = handler; } };
}

test('独立例程沿同一 Bot 配置映射，不复制记忆/MCP秘密；重复创建、重启回查不重发', async () => fixture(async f => {
  await f.store.addMemory('chief', { content: '只在动态上下文出现的记忆', kind: 'confirmed' });
  const [created] = await Promise.all([f.routines.create('chief', f.input), f.routines.create('chief', f.input)]);
  assert.equal(created.state, 'ready');
  assert.equal(await f.routines.ownsSchedule(created.nativeId!), true, '本插件的原生例程可在工作区创建前识别');
  assert.equal(await f.routines.ownsSchedule('unrelated'), false, '不改变其他原生例程');
  const args = f.calls.find(call => call.args[1] === 'create')!.args;
  assert.ok(args.includes('pi/test')); assert.ok(args.includes(f.dir));
  assert.ok(args.includes('configured-mode')); assert.ok(args.includes('configured-thinking'));
  assert.ok(!args.includes('--run-now')); assert.ok(!args.includes('--max-runs'));
  assert.match(args[2], /get_bot_context/); assert.doesNotMatch(args[2], /只在动态上下文出现的记忆/);
  assert.equal(f.calls.filter(call => call.args[1] === 'create').length, 1);
  assert.equal(f.calls[0].env.PASEO_AGENT_ID, undefined);
  assert.ok(f.calls[0].args.includes('--home'));
  assert.equal((await f.reopen().create('chief', f.input)).id, created.id);
  await assert.rejects(f.routines.create('other', f.input), /冲突/);
  await assert.rejects(f.routines.create('chief', { ...f.input, prompt: '换目标' }), /冲突/);
  await f.store.updateBot('chief', { execution: { provider: 'pi/changed', cwd: f.dir } });
  assert.notEqual((await f.routines.create('chief', { ...f.input, requestId: undefined })).id, created.id, '新的执行设置能创建新例程');
}));

test('待办只读例程列举不回查未决创建、不补写关联，原入口仍可显式回查', async () => fixture(async f => {
  f.failCreate();
  const unknown = await f.routines.create('chief', f.input);
  assert.equal(unknown.state, 'unknown');
  const file = join(f.dir, 'routines', 'state.json');
  const before = await readFile(file, 'utf8'), calls = f.calls.length;
  const rows = await f.routines.list('chief', { reconcile: false });
  assert.equal(rows[0].routine.state, 'unknown'); assert.equal(rows[0].native, null);
  assert.equal(f.calls.length, calls); assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await f.routines.list('chief'))[0].routine.state, 'ready');
  assert.equal(f.calls.filter(call => call.args[1] === 'create').length, 1);
}));

test('创建回执丢失只回查权威 schedule 名称，取消后拒绝触发', async () => fixture(async f => {
  f.failCreate();
  const unknown = await f.routines.create('chief', f.input);
  assert.equal(unknown.state, 'unknown');
  const recovered = await f.reopen().create('chief', f.input);
  assert.equal(recovered.state, 'ready');
  assert.equal(f.calls.filter(call => call.args[1] === 'create').length, 1);
  const canceled = await f.routines.cancel('chief', recovered.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(f.native.get(recovered.nativeId!)!.status, 'paused');
  await assert.rejects(f.routines.action('chief', recovered.id, 'run-once'), /取消/);
}));

test('首轮在创建回执前按权威运行关联；正常收尾待核对，完成报告不提前归档', async () => fixture(async f => {
  let early: PluginSessionOpenRequest;
  f.onCreate(async () => { early = f.request('native-1'); await f.routines.bind(early); });
  const created = await f.routines.create('chief', f.input);
  const first = early!;
  assert.equal(await f.reopen().owner(first.agentId), 'chief');
  assert.equal((await f.store.listSessions('chief'))[0].sessionId, first.agentId);
  assert.equal((await f.store.listSessions('other')).length, 0);
  await f.tasks.observeArchived('chief', first.agentId);
  assert.equal((await f.tasks.get('chief', first.agentId))!.status, 'awaiting_review');
  await assert.rejects(f.tasks.requireActive('chief', first.agentId), /active|停止|推进/);
  const second = f.request(created.nativeId!);
  await f.reopen().bind(second);
  await f.tasks.stop('chief', second.agentId, { outcome: 'completed', summary: '已核对报告', evidence: ['report.md'] });
  assert.deepEqual(f.archives, [], '本次完成工具不抢先中断原生调度');
  await f.tasks.observeArchived('chief', second.agentId);
  assert.equal((await f.tasks.get('chief', second.agentId))!.status, 'completed');
  await assert.rejects(f.routines.bind({ ...second, agentId: randomUUID() }), /不符|其他/);
}));

test('动态上下文读取最新本 Bot 确认记忆，有限上轮参考排除失败、候选、他人及传输秘密', async () => fixture(async f => {
  const created = await f.routines.create('chief', f.input);
  const first = f.request(created.nativeId!); await f.routines.bind(first);
  await f.tasks.stop('chief', first.agentId, { outcome: 'completed', summary: '结果'.repeat(1500), evidence: ['preserved.md'] });
  const native = f.native.get(created.nativeId!)!;
  native.runs[0].status = 'succeeded';
  if (native.target.type !== 'new-agent') throw new Error('fixture target');
  native.target.config.mcpServers = { secret: { headers: { Authorization: 'NATIVE-TRANSPORT-SECRET' } } };
  await f.store.updateBot('chief', { instructions: '更新后的长期说明', capabilities: { skills: [], mcpServers: { helper: { type: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'BOT-TRANSPORT-SECRET' } } } } });
  await f.store.addMemory('chief', { content: '新确认偏好', kind: 'confirmed' });
  await f.store.addMemory('chief', { content: '未确认候选', kind: 'candidate' });
  await f.store.addMemory('other', { content: '他人记忆', kind: 'confirmed' });
  const next = f.request(created.nativeId!); await f.reopen().bind(next);
  const context = await f.routines.context('chief', next.agentId);
  assert.deepEqual(context.nativeCli, { command: 'synthetic-cli-only', home: f.dir }, '例程可用已配置的 CLI 在本轮等待同事，不自行选择另一个 daemon');
  assert.match(context.instructions, /更新后的长期说明/);
  assert.match(context.instructions, /新确认偏好/);
  assert.doesNotMatch(JSON.stringify(context), /未确认候选|他人记忆|TRANSPORT-SECRET/);
  assert.equal(context.previousResult?.summary.length, 2000);
  assert.deepEqual(context.previousResult?.evidence, ['preserved.md']);
  native.runs[0].status = 'failed';
  assert.equal((await f.routines.context('chief', next.agentId)).previousResult, undefined);
}));

test('持续聊天动态上下文保持聊天指引，独立事项保留原来的收尾指引', async () => fixture(async f => {
  await f.store.linkSession('chief', { sessionId: 'chat', title: '聊天' });
  await f.store.linkSession('chief', { sessionId: 'task', title: '独立事项' });
  await f.tasks.ensure('chief', 'chat', { title: '聊天', conversation: true });
  await f.tasks.ensure('chief', 'task', { title: '独立事项' });
  const chat = await f.routines.context('chief', 'chat');
  assert.equal(chat.task?.conversation, true);
  assert.match(chat.instructions, /当前是持续聊天，不能对自身调用 complete_task/);
  assert.doesNotMatch(chat.instructions, /停止跟进并归档本事项/);
  const task = await f.routines.context('chief', 'task');
  assert.match(task.instructions, /停止跟进并归档本事项/);
  assert.doesNotMatch(task.instructions, /当前是持续聊天/);
}));

test('暂停不停止当前工作；取消停止当前关联并拒绝未来执行，失败不假报完全停止', async () => fixture(async f => {
  const created = await f.routines.create('chief', f.input);
  const running = f.request(created.nativeId!); await f.routines.bind(running);
  await f.routines.action('chief', created.id, 'pause');
  assert.deepEqual(f.archives, []);
  assert.equal((await f.tasks.get('chief', running.agentId))!.status, 'active');
  await f.routines.action('chief', created.id, 'resume');
  const canceled = await f.routines.cancel('chief', created.id);
  assert.match(canceled.detail!, /已停止/);
  assert.deepEqual(f.archives, [running.agentId]);
  await assert.rejects(f.routines.bind(f.request(created.nativeId!)), /取消/);
  assert.equal(await f.routines.bind({ ...running, purpose: 'history' }), null, '取消仍可读取历史，不重新开工');
  assert.equal((await f.routines.list('other')).length, 0);
  await assert.rejects(f.routines.cancel('other', created.id), /本 Bot/);
  await f.routines.cancel('chief', created.id);
  assert.deepEqual(f.archives, [running.agentId]);
  const separate = await f.routines.create('chief', { ...f.input, requestId: randomUUID() });
  await f.routines.bind(f.request(separate.nativeId!)); f.failArchive();
  assert.match((await f.routines.cancel('chief', separate.id)).detail!, /尚未完全确认/);
}));

test('无关原生例程不额外回查，损坏存档不回空或覆盖', async () => fixture(async f => {
  assert.equal(await f.routines.bind({ labels: { 'paseo.schedule-id': 'unrelated', 'paseo.schedule-run': 'unrelated' } } as unknown as PluginSessionOpenRequest), null);
  assert.equal(f.calls.length, 0);
  await f.routines.create('chief', f.input);
  const file = join(f.dir, 'routines', 'state.json');
  await writeFile(file, '{broken');
  await assert.rejects(f.routines.list('chief'), /保留原文件/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
}));

test('报告已保存但原生仍运行时取消，停止执行且不丢完成报告', async () => fixture(async f => {
  const created = await f.routines.create('chief', f.input);
  const running = f.request(created.nativeId!); await f.routines.bind(running);
  await f.tasks.stop('chief', running.agentId, { outcome: 'completed', summary: '已核对交付', evidence: ['report.md'] });
  await f.routines.cancel('chief', created.id);
  assert.deepEqual(f.archives, [running.agentId]);
  const report = await f.tasks.get('chief', running.agentId);
  assert.equal(report!.status, 'completed');
  assert.deepEqual(report!.evidence, ['report.md']);
}));

test('在途创建被取消，迟到回执不复活例程', async () => fixture(async f => {
  f.onCreate(async () => { await f.routines.cancel('chief', f.input.requestId); });
  const created = await f.routines.create('chief', f.input);
  assert.equal(created.state, 'canceled');
  assert.equal(f.native.get(created.nativeId!)!.status, 'paused');
  await assert.rejects(f.routines.bind(f.request(created.nativeId!)), /取消/);
}));

test('手动触发先返回待派发状态，长执行与重载不导致自动重派', async () => fixture(async f => {
  const created = await f.routines.create('chief', f.input);
  let release!: () => void;
  f.onManual(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = await f.routines.action('chief', created.id, 'run-once');
  assert.equal(pending.runRequest?.state, 'pending');
  await assert.rejects(f.routines.action('chief', created.id, 'run-once'), /尚未结束/);
  const reloaded = await f.reopen().list('chief');
  assert.equal(reloaded[0].routine.runRequest?.state, 'unknown');
  assert.equal(f.calls.filter(call => call.args[1] === 'run-once').length, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
}));

test('Windows bundled CLI 使用可执行入口，保留多行原文及 shell 字符的 argv', { skip: process.platform !== 'win32' }, async () => fixture(async f => {
  const resources = join(f.dir, 'bundle with space', 'resources');
  const runnerDir = join(resources, 'app.asar.unpacked', 'dist', 'daemon');
  await mkdir(runnerDir, { recursive: true });
  await writeFile(join(resources, '..', 'Paseo.exe'), 'synthetic file, never executed');
  await writeFile(join(runnerDir, 'node-entrypoint-runner.js'), 'synthetic file, never executed');
  let captured: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const routines = new BotRoutines({ baseDir: f.dir, store: f.store, tasks: f.tasks, cli: { command: join(resources, 'bin', 'paseo.cmd'), home: f.dir, cwd: f.dir }, defaults: async () => ({ cwd: f.dir, config: { provider: 'pi/test' } }), execute: async (command, args, options) => {
    captured = { command, args, env: options.env };
    return { stdout: JSON.stringify({ id: 'literal-argv-native', status: 'active' }), stderr: '' };
  } });
  const prompt = '第一行\n第二行含 "引号" 与 %PATH% & | ! 原文';
  await routines.create('chief', { ...f.input, prompt });
  assert.equal(captured!.command, resolve(resources, '..', 'Paseo.exe'));
  assert.equal(captured!.env.ELECTRON_RUN_AS_NODE, '1');
  const start = captured!.args.indexOf('schedule');
  assert.equal(captured!.args[start + 1], 'create');
  assert.ok(captured!.args[start + 2].endsWith(prompt));
  assert.ok(captured!.args.includes('--cron'));
}));
