import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PaseoApi, PaseoAgentSendOptions } from '@getpaseo/client';

import { BotStore } from '../server/store.js';
import { TaskError, TaskTracker, type TaskCli, type TaskErrorCode, type TaskExecute } from '../server/tasks.js';

/**
 * 离线测试：fake 原生 CLI + fake Paseo SDK，只用临时目录。
 * 不启动 daemon、不调用模型、不创建真实 heartbeat、不是宿主 E2E。
 */

const createdDirs: string[] = [];

after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CliCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

class FakeCli {
  readonly calls: CliCall[] = [];
  readonly createdNames: string[] = [];
  readonly deleted: string[] = [];
  behavior: {
    create?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
    delete?: (nativeId: string) => Promise<{ stdout: string; stderr: string }>;
  } = {};
  private seq = 0;

  readonly execute: TaskExecute = async (command, args, options) => {
    this.calls.push({ command, args: [...args], env: options.env, cwd: options.cwd });
    if (args[0] === 'heartbeat') {
      const name = args[args.indexOf('--name') + 1] ?? '';
      this.createdNames.push(name);
      if (this.behavior.create) return this.behavior.create(args, options.env);
      return { stdout: JSON.stringify({ id: `hb_${++this.seq}`, status: 'active' }), stderr: '' };
    }
    if (args[0] === 'schedule' && args[1] === 'delete') {
      const nativeId = args[2] ?? '';
      this.deleted.push(nativeId);
      if (this.behavior.delete) return this.behavior.delete(nativeId);
      return { stdout: JSON.stringify({ id: nativeId, status: 'deleted' }), stderr: '' };
    }
    throw new Error(`unexpected CLI args: ${args.join(' ')}`);
  };
}

class FakePaseo {
  readonly archived: string[] = [];
  readonly labels = new Map<string, Record<string, string>>();
  readonly sent: { agentId: string; text: string; options?: PaseoAgentSendOptions }[] = [];
  behavior: { archive?: (agentId: string) => Promise<{ archivedAt: string }> } = {};

  readonly api = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => ({ agent: { id: agentId, labels: this.labels.get(agentId) ?? {} } }),
        send: async (text: string, options?: PaseoAgentSendOptions) => { this.sent.push({ agentId, text, options }); },
        archive: async () => {
          this.archived.push(agentId);
          if (this.behavior.archive) return this.behavior.archive(agentId);
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
    // Offline native snapshots, delivery and archiving only.
  } as unknown as PaseoApi;
}

const CLI: TaskCli = { command: '/opt/paseo/bin/paseo', cwd: '/workspace/chief' };

interface Harness {
  dir: string;
  store: BotStore;
  cli: FakeCli;
  paseo: FakePaseo;
  tracker: TaskTracker;
  trackFile(botId?: string): string;
  restart(overrides?: { cli?: TaskCli | (() => Promise<TaskCli>); execute?: TaskExecute }): TaskTracker;
}

async function setup(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'paseo-guys-tasks-'));
  createdDirs.push(dir);
  const store = new BotStore({ baseDir: path.join(dir, 'store') });
  await store.createBot({ id: 'chief', name: '主 Bot', role: '跟进与核对' });
  await store.linkSession('chief', { sessionId: 'agent-chief' });
  await store.linkSession('chief', { sessionId: 'agent-legacy' });
  await store.createBot({ id: 'other', name: '另一个 Bot', role: '其他事项' });
  await store.linkSession('other', { sessionId: 'agent-other' });

  const cli = new FakeCli();
  const paseo = new FakePaseo();
  const build = (overrides?: { cli?: TaskCli | (() => Promise<TaskCli>); execute?: TaskExecute }) =>
    new TaskTracker({
      baseDir: dir,
      store,
      getPaseo: () => paseo.api,
      cli: overrides?.cli ?? CLI,
      execute: overrides?.execute ?? cli.execute,
    });

  return {
    dir,
    store,
    cli,
    paseo,
    tracker: build(),
    trackFile: (botId = 'chief') => path.join(dir, 'tasks', `${botId}.json`),
    restart: build,
  };
}

const followup = {
  name: '每日跟进',
  prompt: '检查指定邮件并汇总未解决事项',
  cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
};

async function expectTaskError(task: () => Promise<unknown>, code: TaskErrorCode): Promise<void> {
  await assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof TaskError, `期望 TaskError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('原生跟进关联', () => {
  it('保留原生长标题，重启后仍可读回', async () => {
    const { tracker, restart } = await setup();
    const title = '原生事项标题'.repeat(100);
    await tracker.ensure('chief', 'agent-chief', { title });
    assert.equal((await restart().get('chief', 'agent-chief'))?.title, title);
  });

  it('同 Bot 不同 Agent 的同名例程分别绑定各自 target', async () => {
    const { tracker, cli } = await setup();
    const first = await tracker.follow('chief', 'agent-chief', followup);
    const second = await tracker.follow('chief', 'agent-legacy', { ...followup, cron: '0 10 * * *' });
    assert.equal(first.followups[0].key, second.followups[0].key);
    assert.deepEqual(cli.calls.map(call => call.env.PASEO_AGENT_ID), ['agent-chief', 'agent-legacy']);
    assert.equal((await tracker.get('chief', 'agent-chief'))?.followups[0].cron, followup.cron);
  });

  it('并发 cancel/complete 只归档一次，先准入的终态与证据不被覆盖', async t => {
    const { tracker, paseo, store } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    const linked = await store.getBot('chief');
    t.mock.method(store, 'getBot', async () => linked);
    const entered = deferred();
    const gate = deferred();
    paseo.behavior.archive = async () => {
      entered.resolve();
      await gate.promise;
      return { archivedAt: new Date().toISOString() };
    };
    const first = tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    await entered.promise;
    const second = tracker.stop('chief', 'agent-chief', { outcome: 'completed', summary: '另一个完成', evidence: ['report.md'] });
    // 让绑定校验完成，再用同一文件队列的读取等待第二次 prepare（若存在）落盘。
    await Promise.resolve();
    await Promise.resolve();
    await tracker.get('chief', 'agent-chief');
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(paseo.archived.length, 1);
    assert.equal(a.status, b.status);
    assert.equal(b.status, 'canceled');
    assert.equal(b.summary, '用户取消');
    assert.equal(b.evidence, undefined);
  });

  it('ensure 幂等关联已存在会话，未关联 Agent 与未知 Bot 被拒绝', async () => {
    const { tracker, restart } = await setup();
    const first = await tracker.ensure('chief', 'agent-chief', { title: '跨应用跟进', goal: '汇总未解决事项' });
    assert.equal(first.status, 'active');
    assert.equal(first.title, '跨应用跟进');
    assert.equal(first.goal, '汇总未解决事项');
    assert.deepEqual(first.followups, []);

    const again = await tracker.ensure('chief', 'agent-chief', { title: '跨应用跟进' });
    assert.deepEqual(again, first, '已存在的关联不被改写');
    assert.deepEqual((await restart().get('chief', 'agent-chief'))?.title, '跨应用跟进');

    await expectTaskError(() => tracker.ensure('chief', 'agent-other', { title: 'x' }), 'agent_not_linked');
    await expectTaskError(() => tracker.ensure('missing', 'agent-chief', { title: 'x' }), 'bot_not_found');
  });

  it('requireActive 为升级前的会话惰性补登，停止后立即拒绝', async () => {
    const { tracker, restart, cli } = await setup();
    const adopted = await tracker.requireActive('chief', 'agent-legacy');
    assert.equal(adopted.status, 'active');
    assert.equal(adopted.agentId, 'agent-legacy');
    assert.equal((await restart().get('chief', 'agent-legacy'))?.status, 'active', '补登结果已落盘');

    await tracker.ensure('chief', 'agent-legacy', { title: '旧会话' });
    assert.equal((await restart().requireActive('chief', 'agent-legacy')).title, '会话 agent-legacy');

    await tracker.stop('chief', 'agent-legacy', { outcome: 'canceled', summary: '用户取消' });
    await expectTaskError(() => tracker.requireActive('chief', 'agent-legacy'), 'task_not_active');
    assert.equal(cli.calls.length, 0, '没有已知例程就不碰 CLI');
  });

  it('原生归档观察收尾未结事项和跟进，不重复归档或伪报删除', async () => {
    const { tracker, paseo, cli, restart } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '固定同事子任务' });
    await tracker.follow('chief', 'agent-chief', followup);
    const calls = cli.calls.length;
    const stopped = await tracker.observeArchived('chief', 'agent-chief');
    assert.equal(stopped?.status, 'canceled');
    assert.equal(stopped?.followups[0].status, 'inactive');
    assert.match(stopped?.followups[0].detail ?? '', /删除未确认/);
    assert.equal(cli.calls.length, calls);
    assert.deepEqual(paseo.archived, []);
    assert.deepEqual(await tracker.observeArchived('chief', 'agent-chief'), stopped);
    assert.equal((await restart().get('chief', 'agent-chief'))?.status, 'canceled');
    await expectTaskError(() => tracker.requireActive('chief', 'agent-chief'), 'task_not_active');
  });

  it('完成期间的原生归档观察不覆盖 stopping 或已完成的交付结论', async () => {
    const { tracker, paseo } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '核对后交付' });
    paseo.behavior.archive = async () => {
      assert.equal((await tracker.observeArchived('chief', 'agent-chief'))?.status, 'stopping');
      return { archivedAt: new Date().toISOString() };
    };
    const completed = await tracker.stop('chief', 'agent-chief', { outcome: 'completed', summary: '已核对报告', evidence: ['report.md'] });
    assert.equal(completed.status, 'completed');
    const observed = await tracker.observeArchived('chief', 'agent-chief');
    assert.equal(observed?.status, 'completed');
    assert.equal(observed?.summary, completed.summary);
    assert.deepEqual(observed?.evidence, completed.evidence);
    assert.deepEqual(completed.evidence, ['report.md']);
  });

  it('已停止的父事项不会被固定同事的完成回报重新唤醒', async () => {
    for (const outcome of ['canceled', 'completed'] as const) {
      const { tracker, paseo } = await setup();
      await tracker.ensure('chief', 'agent-chief', { title: '主事项' });
      await tracker.ensure('other', 'agent-other', { title: '子事项' });
      await tracker.observeSpecialist('chief', 'agent-chief', 'agent-other');
      paseo.labels.set('agent-other', { 'paseo.parent-agent-id': 'agent-chief' });
      paseo.labels.set('agent-chief', { 'paseo-guys.bot': 'chief' });
      await tracker.stop('chief', 'agent-chief', { outcome, summary: '主事项已停止', evidence: ['report.md'] });
      await tracker.stop('other', 'agent-other', { outcome: 'completed', summary: '子事项已交付', evidence: ['findings.md'] });
      assert.deepEqual(paseo.sent, []);
      assert.equal((await tracker.get('chief', 'agent-chief'))?.status, outcome);
    }
  });

  it('follow 先落盘意图再调用原生 CLI，回执后置 active', async () => {
    const { tracker, restart, cli, trackFile } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跨应用跟进' });
    const gate = deferred();
    const entered = deferred();
    let seen = '';
    cli.behavior.create = async () => {
      seen = await readFile(trackFile(), 'utf8');
      entered.resolve();
      await gate.promise;
      return { stdout: JSON.stringify({ id: 'hb-native-1', status: 'active' }), stderr: '' };
    };

    const pending = tracker.follow('chief', 'agent-chief', followup);
    await entered.promise;
    const intent = JSON.parse(seen) as { tasks: Array<{ followups: Array<{ status: string; key: string }> }> };
    assert.equal(intent.tasks[0]?.followups[0]?.status, 'pending');
    assert.match(intent.tasks[0]?.followups[0]?.key ?? '', /^paseo-guys-daily|^paseo-guys-/);

    gate.resolve();
    const done = await pending;
    assert.equal(done.followups[0]?.status, 'active');
    assert.equal(done.followups[0]?.nativeId, 'hb-native-1');
    assert.equal(cli.createdNames[0], done.followups[0]?.key);
    assert.equal((await restart().get('chief', 'agent-chief'))?.followups[0]?.nativeId, 'hb-native-1');
  });

  it('同参数幂等、不同参数同 key 冲突', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    const first = await tracker.follow('chief', 'agent-chief', followup);
    const second = await tracker.follow('chief', 'agent-chief', followup);
    assert.equal(cli.createdNames.length, 1, '同参数不重复创建');
    assert.deepEqual(second, first);

    await expectTaskError(() => tracker.follow('chief', 'agent-chief', { ...followup, cron: '0 10 * * *' }), 'follow_conflict');
    await expectTaskError(() => tracker.follow('chief', 'agent-chief', { ...followup, prompt: '换了内容' }), 'follow_conflict');
    assert.equal(cli.createdNames.length, 1);
    assert.equal((await tracker.get('chief', 'agent-chief'))?.followups.length, 1);
  });

  it('CLI 参数、Agent 绑定 env 与 --home 处理正确', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await tracker.follow('chief', 'agent-chief', followup);
    const call = cli.calls[0]!;
    assert.equal(call.command, CLI.command);
    assert.equal(call.cwd, CLI.cwd);
    assert.deepEqual(call.args.slice(0, 3), ['heartbeat', 'create', followup.prompt]);
    assert.deepEqual(call.args.slice(3), [
      '--cron',
      followup.cron,
      '--timezone',
      followup.timezone,
      '--name',
      cli.createdNames[0],
      '--json',
    ]);
    assert.equal(call.env.PASEO_AGENT_ID, 'agent-chief');
    assert.equal(call.env.PASEO_AGENT_CWD, CLI.cwd);
    assert.equal(call.args.includes('--home'), false);

    const previousHost = process.env.PASEO_HOST;
    process.env.PASEO_HOST = 'http://wrong-host';
    try {
      const homed = await setup();
      const homedTracker = homed.restart({ cli: { ...CLI, home: '/home/paseo/.paseo' } });
      await homedTracker.ensure('chief', 'agent-chief', { title: '跟进' });
      await homedTracker.follow('chief', 'agent-chief', followup);
      const homedCall = homed.cli.calls[0]!;
      const at = homedCall.args.indexOf('--home');
      assert.notEqual(at, -1);
      assert.equal(homedCall.args[at + 1], '/home/paseo/.paseo');
      assert.equal(homedCall.env.PASEO_HOST, undefined, '指定 home 后清掉 PASEO_HOST');
    } finally {
      if (previousHost === undefined) delete process.env.PASEO_HOST;
      else process.env.PASEO_HOST = previousHost;
    }
  });

  it('创建回执丢失或中断后保留未知，不重复调用会新建例程的 CLI', async () => {
    const { tracker, restart, cli, trackFile } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    cli.behavior.create = async () => {
      // 模拟服务端已创建，只丢失返回。CLI 每次 create 都会铸造不同 id。
      throw new Error('read ETIMEDOUT');
    };
    const lost = await tracker.follow('chief', 'agent-chief', followup);
    assert.equal(lost.followups[0]?.status, 'unknown');
    assert.equal(lost.followups[0]?.nativeId, undefined);

    cli.behavior.create = undefined;
    const retried = await restart().follow('chief', 'agent-chief', followup);
    assert.equal(retried.followups.length, 1);
    assert.equal(retried.followups[0]?.status, 'unknown');
    assert.equal(cli.createdNames.length, 1, '未知结果不再调用非幂等 create');
    assert.match(retried.followups[0]?.detail ?? '', /人工核对/);
    const disk = JSON.parse(await readFile(trackFile(), 'utf8'));
    disk.tasks[0].followups[0].status = 'pending';
    await writeFile(trackFile(), JSON.stringify(disk));
    const pending = await restart().follow('chief', 'agent-chief', followup);
    assert.equal(pending.followups[0].status, 'unknown');
    assert.equal(cli.createdNames.length, 1, '进程中断留下 pending 同样不能假设未创建');

  });

  it('未配置 CLI 时 follow 报未配置，其他能力不受影响', async () => {
    const { tracker, cli, restart } = await setup();
    const unconfigured = restart({ cli: async () => ({ command: '', cwd: '' }) });
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await expectTaskError(() => unconfigured.follow('chief', 'agent-chief', followup), 'not_configured');
    assert.equal(cli.calls.length, 0);
    assert.deepEqual((await unconfigured.get('chief', 'agent-chief'))?.followups, []);
    assert.equal((await unconfigured.requireActive('chief', 'agent-chief')).status, 'active');
  });

  it('stop 先持久 stopping 再 archive，期间拒绝新推进', async () => {
    const { tracker, restart, cli, paseo } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await tracker.follow('chief', 'agent-chief', followup);
    const gate = deferred();
    const entered = deferred();
    paseo.behavior.archive = async () => {
      entered.resolve();
      await gate.promise;
      return { archivedAt: new Date().toISOString() };
    };

    const stopping = tracker.stop('chief', 'agent-chief', {
      outcome: 'completed',
      summary: '已核对交付物',
      evidence: ['docs/report.md'],
    });
    await entered.promise;
    assert.equal((await restart().get('chief', 'agent-chief'))?.status, 'stopping');
    assert.equal((await restart().get('chief', 'agent-chief'))?.summary, '已核对交付物');
    await expectTaskError(() => restart().requireActive('chief', 'agent-chief'), 'task_not_active');
    await expectTaskError(() => restart().follow('chief', 'agent-chief', { ...followup, name: '新增例程' }), 'task_not_active');
    assert.equal(cli.createdNames.length, 1, 'stopping 期间不得新建例程');
    assert.deepEqual(paseo.archived, ['agent-chief'], 'archive 已发起');

    gate.resolve();
    const stopped = await stopping;
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.summary, '已核对交付物');
    assert.deepEqual(stopped.evidence, ['docs/report.md']);
    assert.equal(stopped.followups[0]?.status, 'deleted');
  });

  it('archive 失败保留 stopping 且可幂等重试', async () => {
    const { tracker, restart, paseo } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    paseo.behavior.archive = async () => {
      throw new Error('daemon connection lost');
    };
    await expectTaskError(
      () => tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' }),
      'archive_failed',
    );
    const stuck = await restart().get('chief', 'agent-chief');
    assert.equal(stuck?.status, 'stopping');
    assert.match(stuck?.detail ?? '', /可重试 stop/);
    await expectTaskError(() => restart().follow('chief', 'agent-chief', followup), 'task_not_active');

    paseo.behavior.archive = undefined;
    const stopped = await restart().stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    assert.equal(stopped.status, 'canceled');
    assert.deepEqual(paseo.archived, ['agent-chief', 'agent-chief']);
  });

  it('终态后不再创建例程，重复 stop 不重复 archive', async () => {
    const { tracker, cli, paseo } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await tracker.stop('chief', 'agent-chief', {
      outcome: 'completed',
      summary: '交付完成',
      evidence: ['docs/report.md'],
    });
    const calls = cli.calls.length;

    await expectTaskError(() => tracker.follow('chief', 'agent-chief', followup), 'task_not_active');
    const again = await tracker.stop('chief', 'agent-chief', {
      outcome: 'completed',
      summary: '另一个 summary',
      evidence: ['docs/other.md'],
    });
    assert.equal(again.status, 'completed');
    assert.equal(again.summary, '交付完成', '终态不被第二次 stop 改写');
    assert.equal(paseo.archived.length, 1);
    assert.equal(cli.calls.length, calls);
  });

  it('停止时在途的创建回执随后到达也不复活任务', async () => {
    const { tracker, restart, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    const gate = deferred();
    const entered = deferred();
    cli.behavior.create = async () => {
      entered.resolve();
      await gate.promise;
      return { stdout: JSON.stringify({ id: 'hb-late-1', status: 'active' }), stderr: '' };
    };

    const inFlight = tracker.follow('chief', 'agent-chief', followup);
    await entered.promise;
    const stopped = await tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    assert.equal(stopped.status, 'canceled');

    gate.resolve();
    const settled = await inFlight;
    assert.equal(settled.status, 'canceled', '任务不被迟到回执复活');
    const followupAfter = settled.followups[0]!;
    assert.equal(followupAfter.status, 'deleted');
    assert.equal(followupAfter.nativeId, 'hb-late-1', '迟到 id 被记录以便删除');
    assert.match(followupAfter.detail ?? '', /已确认删除/);
    assert.deepEqual(cli.deleted, ['hb-late-1'], '迟到 id 会尝试删除');
    assert.equal((await restart().get('chief', 'agent-chief'))?.status, 'canceled');
  });

  it('删除回执未确认 deleted 时不声称已删除', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await tracker.follow('chief', 'agent-chief', followup);
    cli.behavior.delete = async () => ({ stdout: '{}', stderr: '' });

    const stopped = await tracker.stop('chief', 'agent-chief', {
      outcome: 'completed',
      summary: '交付完成',
      evidence: ['docs/report.md'],
    });
    const record = stopped.followups[0]!;
    assert.equal(record.status, 'inactive', '退出码 0 不等于已删除');
    assert.match(record.detail ?? '', /删除未确认/);
    assert.match(stopped.detail ?? '', /删除未确认/);
  });

  it('停止时没有已确认原生 id 的例程标 inactive，不声称不存在', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    cli.behavior.create = async () => {
      throw new Error('read ETIMEDOUT');
    };
    await tracker.follow('chief', 'agent-chief', followup);

    const stopped = await tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    const record = stopped.followups[0]!;
    assert.equal(record.status, 'inactive');
    assert.equal(record.nativeId, undefined);
    assert.match(record.detail ?? '', /无已确认的原生 id，删除未确认/);
    assert.equal(cli.deleted.length, 0);
  });

  it('删除已知例程失败时不谎报完全停止', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    const active = await tracker.follow('chief', 'agent-chief', followup);
    assert.ok(active.followups[0]?.nativeId);
    cli.behavior.delete = async () => {
      throw new Error('permission denied');
    };

    const stopped = await tracker.stop('chief', 'agent-chief', {
      outcome: 'completed',
      summary: '交付完成',
      evidence: ['docs/report.md'],
    });
    assert.equal(stopped.status, 'completed');
    assert.match(stopped.detail ?? '', /原生例程删除未确认/);
    assert.match(stopped.detail ?? '', /archive 已使其不再执行/);
    assert.equal(stopped.followups[0]?.status, 'inactive');
    assert.match(stopped.followups[0]?.detail ?? '', /删除未确认/);
  });

  it('独立事项不被 unknown 例程卡死', async () => {
    const { tracker, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进 A' });
    await tracker.ensure('other', 'agent-other', { title: '跟进 B' });
    cli.behavior.create = async () => {
      throw new Error('read ETIMEDOUT');
    };
    const lost = await tracker.follow('chief', 'agent-chief', followup);
    assert.equal(lost.followups[0]?.status, 'unknown');

    cli.behavior.create = undefined;
    const second = await tracker.follow('chief', 'agent-chief', { ...followup, name: '另一条例程' });
    assert.equal(second.followups.length, 2);
    assert.equal(second.followups[1]?.status, 'active');

    const other = await tracker.follow('other', 'agent-other', followup);
    assert.equal(other.followups[0]?.status, 'active');
    assert.equal((await tracker.get('chief', 'agent-chief'))?.followups[0]?.status, 'unknown', '旧的未知保持可见');
  });

  it('全空白输入与空证据被拒绝，且不落盘', async () => {
    const { tracker, paseo } = await setup();
    await expectTaskError(() => tracker.ensure('chief', 'agent-chief', { title: '   ' }), 'invalid_input');
    assert.equal(await tracker.get('chief', 'agent-chief'), null, '非法输入不写存档');

    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await expectTaskError(() => tracker.follow('chief', 'agent-chief', { ...followup, name: '  ' }), 'invalid_input');
    await expectTaskError(() => tracker.follow('chief', 'agent-chief', { ...followup, prompt: '\n ' }), 'invalid_input');
    assert.deepEqual((await tracker.get('chief', 'agent-chief'))?.followups, [], '非法例程不落盘');

    await expectTaskError(
      () => tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '   ' }),
      'invalid_input',
    );
    assert.equal((await tracker.get('chief', 'agent-chief'))?.status, 'active', '非法停止不改变状态');
    assert.deepEqual(paseo.archived, []);
  });

  it('completed 必须附带交付证据，cancel 可以没有', async () => {
    const { tracker, paseo, cli } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await expectTaskError(
      () => tracker.stop('chief', 'agent-chief', { outcome: 'completed', summary: '这轮结束了' }),
      'invalid_input',
    );
    await expectTaskError(
      () => tracker.stop('chief', 'agent-chief', { outcome: 'completed', summary: '完成', evidence: ['   '] }),
      'invalid_input',
    );
    assert.equal((await tracker.get('chief', 'agent-chief'))?.status, 'active');
    assert.deepEqual(paseo.archived, [], '无证据不触发 archive');

    const canceled = await tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.evidence, undefined);
    assert.equal(cli.calls.length, 0);
  });

  it('专家只记录 id 关系，停止后不再接受', async () => {
    const { tracker, restart } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    const observed = await tracker.observeSpecialist('chief', 'agent-chief', 'child-1');
    assert.deepEqual(observed.specialists, ['child-1']);
    await tracker.observeSpecialist('chief', 'agent-chief', 'child-1');
    assert.deepEqual((await tracker.get('chief', 'agent-chief'))?.specialists, ['child-1'], '幂等去重');
    await tracker.observeSpecialist('chief', 'agent-chief', 'child-2');
    assert.deepEqual((await restart().get('chief', 'agent-chief'))?.specialists, ['child-1', 'child-2']);
    await expectTaskError(() => tracker.observeSpecialist('chief', 'agent-chief', 'agent-chief'), 'invalid_input');

    await tracker.stop('chief', 'agent-chief', { outcome: 'canceled', summary: '用户取消' });
    await expectTaskError(() => tracker.observeSpecialist('chief', 'agent-chief', 'child-3'), 'task_not_active');
  });

  it('存档损坏时报错，不回空、不自动修复', async () => {
    const { tracker, trackFile } = await setup();
    await tracker.ensure('chief', 'agent-chief', { title: '跟进' });
    await writeFile(trackFile(), '{"schemaVersion":1,"tasks":', 'utf8');
    await expectTaskError(() => tracker.get('chief', 'agent-chief'), 'corrupt_store');
    await mkdir(path.dirname(trackFile()), { recursive: true });
    await writeFile(trackFile(), '[]', 'utf8');
    await expectTaskError(() => tracker.list('chief'), 'corrupt_store');
  });
});
