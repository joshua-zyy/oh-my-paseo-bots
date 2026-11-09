import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../server/store.js';
import { CapabilityGuidance } from '../server/capability-guidance.js';
import type { CapabilityRequestView } from '../shared/capability-guidance.js';

type RecordStatus = (botId: string, request: CapabilityRequestView) => Promise<void>;
async function fixture(run: (f: { store: BotStore; mcp: string; service: (record: RecordStatus) => CapabilityGuidance }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-capability-records-'));
  try {
    const store = new BotStore({ baseDir: dir }); await store.ensureChief();
    await store.createBot({ id: 'helper', name: '合成同事', role: '验证' });
    const mcp = join(dir, 'synthetic-mcp.json');
    await writeFile(mcp, JSON.stringify({ mcpServers: { chosen: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'PRIVATE-SECRET' } } } }));
    await run({ store, mcp, service: record => new CapabilityGuidance(store, {}, undefined, undefined, record) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const input = (mcp: string, requestId = 'proposal') => ({ requestId, summary: '合成能力方案', skills: [], mcpImports: [{ path: mcp, names: ['chosen'] }] });

test('共同能力入口只在已提交状态变化后记录，形成与决定两端都有行，幂等回执不重复', async () => fixture(async f => {
  const records: [string, string, string][] = [];
  const service = f.service(async (botId, request) => {
    assert.equal((await f.store.getBot(botId))!.bot.capabilityRequest!.state, request.state, '记录发生在业务落盘之后');
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE-SECRET|Authorization|fingerprint/);
    records.push([botId, request.id, request.state]);
  });
  const request = await service.configure('helper', 'real-source', input(f.mcp));
  await service.configure('helper', 'real-source', input(f.mcp));
  const rejected = await service.decide('helper', request.id, 'reject');
  await service.decide('helper', request.id, 'reject');
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(records, [['helper', request.id, 'pending'], ['helper', request.id, 'rejected']]);
  const direct = await service.configure('helper', 'real-source', input(f.mcp, 'next'));
  assert.equal((await service.decide('helper', direct.id, 'apply')).state, 'applied');
  const authorized = await service.configure('helper', 'real-source', input(f.mcp, 'already-authorized'));
  assert.equal(authorized.state, 'applied');
  assert.equal(records.at(-1)![2], 'applied', '已有授权直接保存只记录真实applied，不制造pending');
}));

test('状态记录失败不改业务回执或重做配置，业务失败不发布行', async () => fixture(async f => {
  let records = 0;
  const service = f.service(async () => { records++; throw new Error('synthetic append acknowledgement lost'); });
  const proposed = await service.configure('helper', 'real-source', input(f.mcp));
  assert.equal(proposed.state, 'pending');
  assert.equal((await service.decide('helper', proposed.id, 'reject')).state, 'rejected');
  await service.decide('helper', proposed.id, 'apply');
  assert.deepEqual((await f.store.getBot('helper'))!.bot.capabilities, { skills: [], mcpServers: {} });
  await assert.rejects(service.configure('helper', 'real-source', { ...input(f.mcp), requestId: 'bad', skills: [join(f.mcp, 'missing')] }));
  assert.equal(records, 2, '失败不盲目补发；没有业务提交不发布');
  assert.match(service.recordIssues()[0].detail, /业务|已保存/);
  assert.equal(service.recordIssues()[0].source, 'capability_record');
}));

test('同一同事的能力提交与记录保序，迟到pending不能覆盖rejected，不阻塞其他同事', async () => fixture(async f => {
  const states: string[] = [];
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const service = f.service(async (botId, request) => {
    if (botId === 'helper' && request.state === 'pending') { enter(); await blocked; }
    states.push(`${botId}:${request.state}`);
  });
  const configured = service.configure('helper', 'real-source', input(f.mcp));
  await entered;
  const id = (await f.store.getBot('helper'))!.bot.capabilityRequest!.id;
  const rejected = service.decide('helper', id, 'reject');
  const chief = await service.configure('chief', 'chief-source', input(f.mcp));
  assert.equal(chief.state, 'pending');
  assert.equal((await f.store.getBot('helper'))!.bot.capabilityRequest!.state, 'pending');
  resume(); await configured; await rejected;
  assert.deepEqual(states, ['chief:pending', 'helper:pending', 'helper:rejected']);
}));
