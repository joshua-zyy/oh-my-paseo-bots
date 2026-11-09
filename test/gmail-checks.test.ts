import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { BotStore } from '../server/store.js';
import { startBotSession } from '../server/sessions.js';
import { GmailChecks, type GmailCheckOptions } from '../server/gmail-checks.js';
import { GmailError, type GmailAddedMessagesPage, type GmailConfig } from '../server/gmail.js';

const botId = 'chief', agentId = 'native-run', prompt = '核对资料并生成本地摘要，不发送邮件';
async function fixture(run: (x: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const x = await setup(); try { await run(x); } finally { await rm(x.directory, { recursive: true, force: true }); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'paseo-gmail-checks-')), routineId = randomUUID();
  let config: GmailConfig = { command: 'synthetic', configDir: directory, account: 'chief@example.test', query: 'label:synthetic' };
  let currentRoutine: string | undefined = routineId;
  const known = new Map<string, string>(), dispatches: Parameters<GmailCheckOptions['dispatch']>[0][] = [], pages: { cursor: string; token?: string }[] = [];
  let profileCalls = 0;
  let readPage: (cursor: string, token?: string) => Promise<GmailAddedMessagesPage> = async () => ({ historyId: '200', messages: [{ id: 'a' }, { id: 'b' }] });
  let dispatch: GmailCheckOptions['dispatch'] = async input => { const id = `native-${known.size}`; known.set(input.requestId, id); return { agentId: id }; };
  const options: GmailCheckOptions = {
    baseDir: directory, getConfig: async owner => { assert.equal(owner, botId); return config; },
    client: scope => { assert.equal(scope, config); return { getHistoryCursor: async () => { profileCalls++; return '100'; }, listAddedMessages: async (cursor, token) => { pages.push({ cursor, token }); return readPage(cursor, token); } }; },
    validateRoutine: async (owner, id) => { assert.equal(owner, botId); if (id !== routineId) throw Error('wrong routine'); },
    activeRoutine: async (owner, id) => owner === botId && id === agentId ? currentRoutine : undefined,
    lookup: async (owner, key) => { assert.equal(owner, botId); return known.get(key); },
    dispatch: async input => { dispatches.push(input); return dispatch(input); },
  };
  const service = new GmailChecks(options), state = async () => JSON.parse(await readFile(join(directory, 'gmail-checks.json'), 'utf8')).checks[0];
  return { directory, routineId, service, options, known, dispatches, pages, state, profileCalls: () => profileCalls, changeScope: () => { config = { ...config, query: 'label:other' }; }, changeRoutine: (id?: string) => { currentRoutine = id; }, readPages: (fn: typeof readPage) => { readPage = fn; }, dispatchWith: (fn: typeof dispatch) => { dispatch = fn; } };
}

test('用户启用才读基线；相同启用幂等，不隐式读邮件或启用其他例程', () => fixture(async x => {
  assert.equal(await x.service.inspect(botId, x.routineId), null);
  assert.equal(await x.service.context(botId, agentId), undefined);
  await assert.rejects(() => x.service.check(botId, agentId), /未启用/);
  const view = await x.service.enable(botId, x.routineId, prompt);
  assert(view.enabled); assert.equal(x.profileCalls(), 1); assert.equal(x.pages.length, 0); assert.equal(x.dispatches.length, 0);
  assert(!JSON.stringify(view).includes('fingerprint')); assert(!JSON.stringify(view).includes('cursor'));
  await x.service.enable(botId, x.routineId, prompt); assert.equal(x.profileCalls(), 1);
  assert((await x.service.context(botId, agentId))?.note.includes('check_gmail_events'));
  await assert.rejects(() => x.service.enable(botId, x.routineId, 'changed'), /变化/);
  await assert.rejects(() => x.service.check(botId, 'other-agent'), /当前活跃/);
}));

test('提醒轮次只从实际游标/批次请求派生：同批次稳定，不存新字段或暴露ID，下一批次不同', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.dispatchWith(async () => { throw Error('lost receipt'); });
  await assert.rejects(() => x.service.check(botId, agentId), /lost receipt/);
  const first = await x.service.inspect(botId, x.routineId); assert.match(first!.noticeEpisode!, /^[a-f0-9]{64}$/);
  const file = join(x.directory, 'gmail-checks.json'), before = await readFile(file, 'utf8'), calls = x.pages.length;
  assert.equal((await x.service.inspect(botId, x.routineId))!.noticeEpisode, first!.noticeEpisode);
  assert.equal(await readFile(file, 'utf8'), before); assert.equal(x.pages.length, calls); assert(!('noticeEpisode' in await x.state()));
  const pending = await x.state(); x.known.set(pending.batch.events[0].requestId, 'recovered');
  x.dispatchWith(async input => { x.known.set(input.requestId, 'second'); return { agentId: 'second' }; });
  await x.service.check(botId, agentId);
  x.readPages(async () => ({ historyId: '300', messages: [{ id: 'new-mail' }] }));
  x.dispatchWith(async () => { throw Error('new lost receipt'); });
  await assert.rejects(() => x.service.check(botId, agentId), /new lost receipt/);
  const next = await x.service.inspect(botId, x.routineId); assert.notEqual(next!.noticeEpisode, first!.noticeEpisode);
  assert(!JSON.stringify(next).includes('new-mail')); assert.equal((await x.state()).cursor, '200');
}));

test('完整分页去重、稳定请求键派发后推进末页游标，跨周期重复ID复用已知事项', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.readPages(async (_cursor, token) => token ? { historyId: '900719925474099312345', messages: [{ id: 'a' }, { id: 'b' }] } : { historyId: '150', nextPageToken: 'second', messages: [{ id: 'a' }] });
  const result = await x.service.check(botId, agentId);
  assert.equal(result.dispatched.length, 2); assert.equal(x.dispatches.length, 2);
  assert.deepEqual(x.pages, [{ cursor: '100', token: undefined }, { cursor: '100', token: 'second' }]);
  assert.equal((await x.state()).cursor, '900719925474099312345'); assert.equal((await x.state()).batch, undefined);
  assert(x.dispatches.every(d => d.botId === botId && d.prompt.includes(prompt) && d.prompt.includes('read_gmail_message')));
  assert.notEqual(x.dispatches[0].requestId, x.dispatches[1].requestId);
  x.readPages(async () => ({ historyId: '900719925474099399999', messages: [{ id: 'a' }] }));
  const duplicate = await new GmailChecks(x.options).check(botId, agentId);
  assert.deepEqual(duplicate.dispatched, [result.dispatched[0]]); assert.equal(x.dispatches.length, 2);
}));

test('回执丢失保留原批次/旧游标，重启只回查原请求，不重新创建', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.dispatchWith(async () => { throw Error('synthetic lost receipt'); });
  await assert.rejects(() => x.service.check(botId, agentId), /lost receipt/);
  const state = await x.state(); assert.equal(state.cursor, '100'); assert.equal(state.state, 'dispatch_unknown');
  assert.equal(state.batch.events[0].state, 'pending'); assert.equal(state.batch.events[1].state, 'prepared');
  const reopened = new GmailChecks(x.options);
  await assert.rejects(() => reopened.check(botId, agentId), /尚未确认/); assert.equal(x.dispatches.length, 1);
  x.known.set(state.batch.events[0].requestId, 'recovered-native');
  x.dispatchWith(async input => { x.known.set(input.requestId, 'second-native'); return { agentId: 'second-native' }; });
  const result = await reopened.check(botId, agentId);
  assert.deepEqual(result.dispatched.map(item => item.agentId), ['recovered-native', 'second-native']);
  assert.equal(x.dispatches.length, 2); assert.equal(x.pages.length, 1); assert.equal((await x.state()).cursor, '200');
}));

test('scope变更与停用阻止继续；已派发不撤销、原批次不重置', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.dispatchWith(async input => { x.known.set(input.requestId, 'first'); await x.service.disable(botId, x.routineId); return { agentId: 'first' }; });
  await assert.rejects(() => x.service.check(botId, agentId), /停用/);
  assert.equal(x.dispatches.length, 1); assert.equal((await x.state()).cursor, '100');
  await x.service.enable(botId, x.routineId, prompt); assert.equal(x.profileCalls(), 1);
  x.changeScope();
  await assert.rejects(() => x.service.check(botId, agentId), /已改变/);
  await assert.rejects(() => x.service.enable(botId, x.routineId, prompt), /已变化/);
  assert.equal(x.dispatches.length, 1);
}));

test('history分页重复/失败不登记部分事件或推进游标，空检查正常推进', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.readPages(async () => ({ historyId: '200', nextPageToken: 'repeat', messages: [{ id: 'a' }] }));
  await assert.rejects(() => x.service.check(botId, agentId), /分页游标重复/);
  assert.equal(x.dispatches.length, 0); assert.equal((await x.state()).batch, undefined); assert.equal((await x.state()).cursor, '100');
  x.readPages(async () => { throw new GmailError('unknown', 'synthetic connection failed'); });
  await assert.rejects(() => x.service.check(botId, agentId), /connection failed/); assert.equal((await x.state()).cursor, '100');
  x.readPages(async () => ({ historyId: '300', messages: [] }));
  assert.deepEqual((await x.service.check(botId, agentId)).dispatched, []); assert.equal((await x.state()).cursor, '300');
}));

test('失效游标保持needs_sync，模型调用或重新启用不能跳过旧历史', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  x.readPages(async () => { throw new GmailError('history_expired', '需要重新同步'); });
  await assert.rejects(() => x.service.check(botId, agentId), /重新同步/);
  assert.equal((await x.state()).state, 'needs_sync'); assert.equal((await x.state()).cursor, '100');
  await assert.rejects(() => x.service.check(botId, agentId), /游标失效/);
  await assert.rejects(() => x.service.enable(botId, x.routineId, prompt), /需用户核对/);
  assert.equal(x.profileCalls(), 1); assert.equal(x.dispatches.length, 0);
}));

test('同例程并发检查拒绝重复执行，存档损坏不覆盖', () => fixture(async x => {
  await x.service.enable(botId, x.routineId, prompt);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  x.readPages(async () => { started(); await waiting; return { historyId: '200', messages: [] }; });
  const first = x.service.check(botId, agentId); await entered;
  await assert.rejects(() => x.service.check(botId, agentId), /检查在途/); release(); await first;
  const path = join(x.directory, 'gmail-checks.json'); await writeFile(path, '{broken');
  await assert.rejects(() => x.service.disable(botId, x.routineId), /存档损坏/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
}));

test('Gmail事件接缝实际复用startBotSession及原生创建意图，重读事件不克隆执行', () => fixture(async x => {
  const store = new BotStore({ baseDir: x.directory }); await store.ensureChief();
  const created: PaseoAgentCreateOptions[] = [];
  const native = { workspaces: { create: async () => ({ agents: { create: async (input: PaseoAgentCreateOptions) => { created.push(input); return { id: input.agentId, workspaceId: 'synthetic-background' }; } } }) } } as unknown as PaseoApi;
  const service = new GmailChecks({ ...x.options,
    lookup: async (owner, key) => { const intent = (await store.getBot(owner))?.creationIntents.find(item => item.requestId === key); return intent?.status === 'created' ? intent.agentId : undefined; },
    dispatch: input => startBotSession(store, native, input, { cwd: x.directory, config: { provider: 'synthetic/model' } }, { mount: async () => ({ type: 'http', url: 'http://127.0.0.1:1/synthetic' }) }),
  });
  await service.enable(botId, x.routineId, prompt);
  const first = await service.check(botId, agentId);
  assert.equal(created.length, 2); assert.equal(first.dispatched.length, 2);
  for (const input of created) { assert.equal(input.labels?.['paseo-guys.bot'], botId); assert(input.idempotencyKey?.startsWith('paseo-guys:chief:')); assert(input.prompt?.includes('read_gmail_message')); assert.equal(input.parent, undefined, '邮件事项不挂到马上结束的检查例程父会话'); }
  assert.equal((await store.getBot(botId))!.creationIntents.length, 2);
  assert.deepEqual((await service.check(botId, agentId)).dispatched, first.dispatched); assert.equal(created.length, 2);
}));
