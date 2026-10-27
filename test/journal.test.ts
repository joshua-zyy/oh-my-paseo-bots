import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BotJournal, JournalError } from '../server/journal.js';

const createdDirs: string[] = [];

async function makeJournal(): Promise<{ baseDir: string; journal: BotJournal }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'paseo-guys-journal-'));
  createdDirs.push(baseDir);
  return { baseDir, journal: new BotJournal({ baseDir }) };
}

function assertJournalError(error: unknown, code: string): void {
  assert.ok(error instanceof JournalError, `期望 JournalError，实际为 ${String(error)}`);
  assert.equal((error as JournalError).code, code);
}

after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Bot 工作日志', () => {
  it('按发生顺序追加，只记录轮次事件而不是任务完成', async () => {
    const { journal } = await makeJournal();

    const started = await journal.append('chief', { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started' });
    const ended = await journal.append('chief', {
      agentId: 'agent-1',
      turnId: 'turn-1',
      kind: 'turn_ended',
      outcome: 'completed',
    });

    assert.match(started.observedAt, /^\d{4}-\d{2}-\d{2}T/);
    const entries = await journal.read('chief');
    assert.deepEqual(entries, [
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started', observedAt: started.observedAt },
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_ended', outcome: 'completed', observedAt: ended.observedAt },
    ]);
  });

  it('并发追加与读取串行，新实例可读回同一日志', async () => {
    const { baseDir, journal } = await makeJournal();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        journal.append('chief', { agentId: `agent-${index}`, turnId: `turn-${index}`, kind: 'turn_started' }),
      ),
    );
    await journal.append('chief', {
      agentId: 'agent-0',
      turnId: 'turn-0',
      kind: 'turn_ended',
      outcome: 'failed',
      error: 'provider 超时',
    });

    const entries = await new BotJournal({ baseDir }).read('chief');
    assert.equal(entries.length, 11);
    assert.equal(new Set(entries.slice(0, 10).map((entry) => entry.agentId)).size, 10);
    const last = entries[10];
    assert.deepEqual([last?.kind, last?.outcome, last?.error], ['turn_ended', 'failed', 'provider 超时']);

    const lines = (await readFile(path.join(baseDir, 'chief.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 11);
  });

  it('缺失日志返回空数组', async () => {
    const { journal } = await makeJournal();
    assert.deepEqual(await journal.read('chief'), []);
  });

  it('非法标识与非法事件被拒绝且不落盘', async () => {
    const { baseDir, journal } = await makeJournal();
    for (const botId of ['', '..', '../escape', 'a/b', 'CON', 'Chief']) {
      await assert.rejects(
        () => journal.append(botId, { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started' }),
        (error: unknown) => {
          assertJournalError(error, 'invalid_input');
          return true;
        },
        `botId ${JSON.stringify(botId)} 应被拒绝`,
      );
    }
    const invalid: unknown[] = [
      { agentId: '', turnId: 'turn-1', kind: 'turn_started' },
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_completed' },
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started', outcome: 'completed' },
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_ended', outcome: 'done' },
      { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_ended', error: '   ' },
    ];
    for (const observation of invalid) {
      await assert.rejects(
        () => journal.append('chief', observation as never),
        (error: unknown) => {
          assertJournalError(error, 'invalid_input');
          return true;
        },
        `事件 ${JSON.stringify(observation)} 应被拒绝`,
      );
    }
    assert.deepEqual(await readdir(baseDir), []);
  });

  it('损坏日志报错且不被清空', async () => {
    const { baseDir, journal } = await makeJournal();
    await journal.append('chief', { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started' });
    const file = path.join(baseDir, 'chief.jsonl');
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}{ broken\n`, 'utf8');

    await assert.rejects(
      () => journal.read('chief'),
      (error: unknown) => {
        assertJournalError(error, 'corrupt_log');
        return true;
      },
    );
    assert.equal(await readFile(file, 'utf8'), `${original}{ broken\n`);
  });
});
