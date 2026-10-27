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
    assert.deepEqual(await journal.inspect('chief'), {
      entries: [],
      total: 0,
      corruptCount: 0,
      corruptLines: [],
      offset: 0,
      nextOffset: null,
    });
    await assert.rejects(
      () => journal.inspect('..'),
      (error: unknown) => {
        assertJournalError(error, 'invalid_input');
        return true;
      },
    );
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

  it('崩溃留下的半行保留原字节，后续追加先补分隔符，inspect 报告损坏而严格 read 仍报错', async () => {
    const { baseDir, journal } = await makeJournal();
    await journal.append('chief', { agentId: 'agent-1', turnId: 'turn-1', kind: 'turn_started' });
    const file = path.join(baseDir, 'chief.jsonl');
    const beforeCrash = await readFile(file, 'utf8');
    const partial = `${beforeCrash}{"agentId":"agent-2","turnId":"turn-2","kind":"turn_sta`;
    await writeFile(file, partial, 'utf8');

    const appended = await journal.append('chief', {
      agentId: 'agent-3',
      turnId: 'turn-3',
      kind: 'turn_ended',
      outcome: 'completed',
    });

    const raw = await readFile(file, 'utf8');
    assert.ok(raw.startsWith(`${partial}\n`), '应保留原有半行字节并补一个换行分隔符');
    assert.ok(raw.endsWith(`${JSON.stringify(appended)}\n`), '新记录应完整独立成行');

    const inspection = await journal.inspect('chief');
    assert.deepEqual(Object.keys(inspection).sort(), [
      'corruptCount',
      'corruptLines',
      'entries',
      'nextOffset',
      'offset',
      'total',
    ]);
    assert.equal(inspection.total, 2);
    assert.deepEqual(
      inspection.entries.map((entry) => [entry.agentId, entry.kind]),
      [
        ['agent-1', 'turn_started'],
        ['agent-3', 'turn_ended'],
      ],
    );
    assert.equal(inspection.corruptCount, 1);
    assert.deepEqual(inspection.corruptLines, [2]);

    // inspect 只读：不修改原文件，也不清空损坏字节
    assert.equal(await readFile(file, 'utf8'), raw);

    await assert.rejects(
      () => journal.read('chief'),
      (error: unknown) => {
        assertJournalError(error, 'corrupt_log');
        assert.match((error as Error).message, /line 2 is not valid JSON/);
        return true;
      },
    );
    assert.equal(await readFile(file, 'utf8'), raw);
  });

  it('inspect 默认 50 条、上限 200 条，total 统计全部有效记录', async () => {
    const { baseDir, journal } = await makeJournal();
    for (let index = 0; index < 205; index += 1) {
      await journal.append('chief', { agentId: `agent-${index}`, turnId: null, kind: 'turn_started' });
    }

    const defaulted = await journal.inspect('chief');
    assert.equal(defaulted.total, 205);
    assert.equal(defaulted.entries.length, 50);
    assert.equal(defaulted.entries[0]?.agentId, 'agent-155');
    assert.equal(defaulted.entries.at(-1)?.agentId, 'agent-204');

    const bounded = await journal.inspect('chief', { limit: 2 });
    assert.equal(bounded.total, 205);
    assert.deepEqual(
      bounded.entries.map((entry) => entry.agentId),
      ['agent-203', 'agent-204'],
    );

    const capped = await journal.inspect('chief', { limit: 200 });
    assert.equal(capped.total, 205);
    assert.equal(capped.entries.length, 200);

    for (const limit of [0, 201, 1.5, -1]) {
      await assert.rejects(
        () => journal.inspect('chief', { limit }),
        (error: unknown) => {
          assertJournalError(error, 'invalid_input');
          return true;
        },
        `limit ${String(limit)} 应被拒绝`,
      );
    }

    // 日志只含轮次观察字段，不含聊天历史
    const lines = (await readFile(path.join(baseDir, 'chief.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 205);
    assert.deepEqual(Object.keys(JSON.parse(lines[0] ?? '{}')).sort(), ['agentId', 'kind', 'observedAt', 'turnId']);
  });

  it('offset 按最新有效记录跳过，页内仍从旧到新，跨页不重叠且覆盖全量', async () => {
    const { journal } = await makeJournal();
    const total = 205;
    for (let index = 0; index < total; index += 1) {
      await journal.append('chief', { agentId: `agent-${index}`, turnId: null, kind: 'turn_started' });
    }

    const pageIds = async (limit: number, offset?: number): Promise<string[]> => {
      const inspection = await journal.inspect('chief', offset === undefined ? { limit } : { limit, offset });
      // 总数与损坏统计不随分页变化
      assert.equal(inspection.total, total);
      assert.equal(inspection.corruptCount, 0);
      return inspection.entries.map((entry) => entry.agentId);
    };
    const ids = (start: number, count: number): string[] =>
      Array.from({ length: count }, (_, index) => `agent-${start + index}`);

    // offset 0 与省略 offset 等价，首页是最近的 limit 条
    assert.deepEqual(await pageIds(50), ids(155, 50));
    assert.deepEqual(await pageIds(50, 0), ids(155, 50));

    // 页边界：offset 正好等于已读条数时接续，不重叠也不跳条
    assert.deepEqual(await pageIds(50, 50), ids(105, 50));
    assert.deepEqual(await pageIds(50, 100), ids(55, 50));
    assert.deepEqual(await pageIds(50, 150), ids(5, 50));

    // 末页不足 limit 条时照常返回剩下的最早记录
    assert.deepEqual(await pageIds(50, 200), ids(0, 5));
    assert.deepEqual(await pageIds(1, 1), ['agent-203']);
    assert.deepEqual(await pageIds(1, 204), ['agent-0']);

    // nextOffset 指向下一页的 offset，最后一页为 null
    const boundaries: Array<[number, number, number | null]> = [
      [50, 0, 50],
      [50, 50, 100],
      [50, 150, 200],
      [50, 200, null],
      [1, 204, null],
      [7, 0, 7],
    ];
    for (const [limit, offset, nextOffset] of boundaries) {
      const inspection = await journal.inspect('chief', { limit, offset });
      assert.deepEqual([inspection.offset, inspection.nextOffset], [offset, nextOffset], `limit ${limit} offset ${offset}`);
    }

    // 走完整条分页链：每页从旧到新，拼起来正好是全部记录（最新页在最前）
    const walked: string[][] = [];
    const nextOffsets: (number | null)[] = [];
    let offset = 0;
    let nextOffset: number | null = 0;
    while (nextOffset !== null) {
      const inspection = await journal.inspect('chief', { limit: 7, offset });
      walked.push(inspection.entries.map((entry) => entry.agentId));
      assert.equal(inspection.offset, offset);
      nextOffset = inspection.nextOffset;
      nextOffsets.push(nextOffset);
      if (nextOffset !== null) offset = nextOffset;
    }
    assert.equal(walked.length, Math.ceil(total / 7));
    assert.deepEqual(nextOffsets.at(-1), null);
    assert.deepEqual(
      walked
        .slice()
        .reverse()
        .flat(),
      Array.from({ length: total }, (_, index) => `agent-${index}`),
    );
    assert.equal(new Set(walked.flat()).size, total, '跨页不应重复或遗漏记录');
  });

  it('非法 offset 被拒绝，超过记录总数返回空页且 nextOffset 为 null', async () => {
    const { journal } = await makeJournal();
    for (let index = 0; index < 3; index += 1) {
      await journal.append('chief', { agentId: `agent-${index}`, turnId: null, kind: 'turn_started' });
    }

    const atEnd = await journal.inspect('chief', { limit: 2, offset: 3 });
    assert.deepEqual([atEnd.entries.length, atEnd.total, atEnd.offset, atEnd.nextOffset], [0, 3, 3, null]);

    const beyondEnd = await journal.inspect('chief', { limit: 2, offset: 1000 });
    assert.deepEqual([beyondEnd.entries.length, beyondEnd.total, beyondEnd.offset, beyondEnd.nextOffset], [0, 3, 1000, null]);

    for (const offset of [-1, 1.5, Number.NaN, -0.5, '2']) {
      await assert.rejects(
        () => journal.inspect('chief', { limit: 2, offset } as never),
        (error: unknown) => {
          assertJournalError(error, 'invalid_input');
          return true;
        },
        `offset ${String(offset)} 应被拒绝`,
      );
    }
  });

  it('offset 只跳过有效记录，损坏行仍全量计数', async () => {
    const { baseDir, journal } = await makeJournal();
    await journal.append('chief', { agentId: 'agent-1', turnId: null, kind: 'turn_started' });
    await journal.append('chief', { agentId: 'agent-2', turnId: null, kind: 'turn_started' });
    const file = path.join(baseDir, 'chief.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    await writeFile(file, `${lines[0]}\n{ broken\n${lines[1]}\n`, 'utf8');

    const newest = await journal.inspect('chief', { limit: 1 });
    assert.deepEqual(newest.entries.map((entry) => entry.agentId), ['agent-2']);
    assert.deepEqual([newest.total, newest.corruptCount, newest.corruptLines], [2, 1, [2]]);
    assert.deepEqual([newest.offset, newest.nextOffset], [0, 1]);

    const older = await journal.inspect('chief', { limit: 1, offset: 1 });
    assert.deepEqual(older.entries.map((entry) => entry.agentId), ['agent-1']);
    assert.deepEqual([older.total, older.corruptCount, older.corruptLines], [2, 1, [2]]);
    assert.deepEqual([older.offset, older.nextOffset], [1, null]);

    assert.equal(await readFile(file, 'utf8'), `${lines[0]}\n{ broken\n${lines[1]}\n`, 'inspect 不应修改坏字节');
  });

  it('损坏行号最多 20 条，corruptCount 仍是全量计数', async () => {
    const { baseDir, journal } = await makeJournal();
    await journal.append('chief', { agentId: 'agent-1', turnId: null, kind: 'turn_started' });
    const file = path.join(baseDir, 'chief.jsonl');
    const good = await readFile(file, 'utf8');
    const junk = Array.from({ length: 25 }, (_, index) => `{ broken ${index + 1}`).join('\n');
    await writeFile(file, `${good}${junk}\n`, 'utf8');

    const inspection = await journal.inspect('chief');
    assert.equal(inspection.total, 1);
    assert.equal(inspection.corruptCount, 25);
    assert.deepEqual(
      inspection.corruptLines,
      Array.from({ length: 20 }, (_, index) => index + 2),
    );

    await writeFile(path.join(baseDir, 'schema.jsonl'), '{"agentId":"agent-1"}\n', 'utf8');
    const schemaInspection = await journal.inspect('schema');
    assert.equal(schemaInspection.total, 0);
    assert.equal(schemaInspection.corruptCount, 1);
    assert.deepEqual(schemaInspection.corruptLines, [1]);
    await assert.rejects(() => journal.read('schema'), /line 1 does not match the journal schema/);
  });
});
