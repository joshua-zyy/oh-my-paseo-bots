import test from 'node:test';
import assert from 'node:assert/strict';
import { GmailClient, GmailError, type GmailConfig, type GmailExecute } from '../server/gmail.js';

const config: GmailConfig = { command: 'synthetic-gws', configDir: 'C:/synthetic/gmail', account: 'chief@example.test', query: 'label:synthetic from:allowed@example.test' };
const cursor = '900719925474099312345';
const profile = { emailAddress: 'Chief@Example.Test', historyId: cursor };
function fake(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const execute: GmailExecute = async (command, args, options) => {
    assert.equal(command, config.command);
    assert.equal(options.cwd, config.configDir);
    assert.equal(options.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, config.configDir);
    const at = args.indexOf('--params');
    const method = args.slice(0, at).join('.');
    const params = JSON.parse(args[at + 1]);
    assert.deepEqual(args.slice(-2), ['--format', 'json']);
    assert(!args.includes('--json'), '事件检查没有写入请求');
    calls.push({ method, params });
    assert(handlers[method], `未预期调用 ${method}`);
    return { stdout: JSON.stringify(await handlers[method](params)), stderr: '' };
  };
  return { client: new GmailClient(config, execute), calls };
}
const errorCode = (code: string) => (error: unknown) => error instanceof GmailError && error.code === code;

test('Gmail基线游标只读profile并保持大整数原串，账户变化不执行history', async () => {
  const instance = fake({ 'gmail.users.getProfile': () => profile });
  assert.equal(await instance.client.getHistoryCursor(), cursor);
  assert.deepEqual(instance.calls, [{ method: 'gmail.users.getProfile', params: { userId: 'me' } }]);
  for (const operation of [(client: GmailClient) => client.getHistoryCursor(), (client: GmailClient) => client.listAddedMessages(cursor)]) {
    const wrong = fake({ 'gmail.users.getProfile': () => ({ ...profile, emailAddress: 'other@example.test' }) });
    await assert.rejects(() => operation(wrong.client), errorCode('unknown'));
    assert.equal(wrong.calls.length, 1);
  }
  const missing = fake({ 'gmail.users.getProfile': () => ({ emailAddress: config.account }) });
  await assert.rejects(() => missing.client.getHistoryCursor(), errorCode('unknown'));
});

test('Gmail新增事件仅输出批准query的ID，去重且忽略其他变更与正文', async () => {
  const instance = fake({
    'gmail.users.getProfile': () => profile,
    'gmail.users.history.list': () => ({ historyId: '900719925474099399999', nextPageToken: 'history-next', history: [
      { id: '101', messages: [{ id: 'not-added' }], messagesDeleted: [{ message: { id: 'deleted' } }], messagesAdded: [
        { message: { id: 'allowed-a', threadId: 'thread-a', payload: { body: 'DO-NOT-RETURN' } } },
        { message: { id: 'private', threadId: 'private-thread' } },
      ] },
      { id: '103', messagesAdded: [{ message: { id: 'allowed-a' } }, { message: { id: 'allowed-b' } }] },
    ] }),
    'gmail.users.messages.list': params => { assert.equal(params.q, config.query); return params.pageToken ? { messages: [{ id: 'allowed-b' }] } : { messages: [{ id: 'unrelated' }, { id: 'allowed-a' }], nextPageToken: 'scope-next' }; },
  });
  assert.deepEqual(await instance.client.listAddedMessages(cursor, 'history-page'), { historyId: '900719925474099399999', nextPageToken: 'history-next', messages: [{ id: 'allowed-a', threadId: 'thread-a' }, { id: 'allowed-b' }] });
  assert.deepEqual(instance.calls[1], { method: 'gmail.users.history.list', params: { userId: 'me', startHistoryId: cursor, historyTypes: ['messageAdded'], pageToken: 'history-page' } });
  assert.equal(instance.calls.filter(call => call.method === 'gmail.users.messages.list').length, 2);
  assert(!instance.calls.some(call => call.method === 'gmail.users.messages.get'));
});

test('Gmail空增量无需扫描query，末页返回新游标但本适配器不自动保存', async () => {
  const instance = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => ({ historyId: '123' }) });
  assert.deepEqual(await instance.client.listAddedMessages(cursor), { historyId: '123', messages: [] });
  assert.equal(instance.calls.length, 2);
});

test('Gmail事件有候选但scope查询无匹配时返回空，不读取其他邮件', async () => {
  const instance = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => ({ historyId: '123', history: [{ messagesAdded: [{ message: { id: 'private' } }] }] }), 'gmail.users.messages.list': () => ({ messages: [] }) });
  assert.deepEqual(await instance.client.listAddedMessages(cursor), { historyId: '123', messages: [] });
  assert.equal(instance.calls.length, 3);
});

test('Gmail增量参数非法在执行前拒绝，不转换historyId为number', async () => {
  const instance = fake({});
  for (const invalid of ['', ' abc ', '1.5', '-1', 123, null] as unknown[]) {
    await assert.rejects(() => instance.client.listAddedMessages(invalid as string), errorCode('unknown'));
  }
  await assert.rejects(() => instance.client.listAddedMessages(cursor, ' '), errorCode('unknown'));
  assert.equal(instance.calls.length, 0);
});

test('Gmail增量响应异常不能被解释为空成功或更新游标', async context => {
  for (const payload of [null, [], {}, { historyId: 123 }, { historyId: 'invalid' }, { historyId: '123', nextPageToken: '' }, { historyId: '123', history: null }, { historyId: '123', history: {} }, { historyId: '123', history: [null] }, { historyId: '123', history: [{ messagesAdded: null }] }, { historyId: '123', history: [{ messagesAdded: {} }] }, { historyId: '123', history: [{ messagesAdded: [null] }] }, { historyId: '123', history: [{ messagesAdded: [{ message: { id: '' } }] }] }]) {
    await context.test(JSON.stringify(payload), async () => {
      const instance = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => payload });
      await assert.rejects(() => instance.client.listAddedMessages(cursor), errorCode('unknown'));
      assert.equal(instance.calls.length, 2);
    });
  }
});

test('Gmail失效history游标明确报告history_expired，不自动重置profile', async () => {
  const instance = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => ({ error: { code: 404, status: 'NOT_FOUND', message: 'SYNTHETIC-SECRET' } }) });
  await assert.rejects(() => instance.client.listAddedMessages(cursor), error => {
    assert(errorCode('history_expired')(error)); assert.doesNotMatch((error as Error).message, /SYNTHETIC-SECRET/); return true;
  });
  assert.equal(instance.calls.length, 2);
  const retryable = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => ({ error: { code: 503, status: 'UNAVAILABLE' } }) });
  await assert.rejects(() => retryable.client.listAddedMessages(cursor), errorCode('unknown'));
  assert.equal(retryable.calls.length, 2);
});

test('Gmail query分页循环或失败不能返回部分筛选事件', async () => {
  for (const reply of [{ messages: [], nextPageToken: 'same' }, { error: { code: 403, status: 'PERMISSION_DENIED' } }]) {
    const instance = fake({ 'gmail.users.getProfile': () => profile, 'gmail.users.history.list': () => ({ historyId: '123', history: [{ messagesAdded: [{ message: { id: 'a' } }] }] }), 'gmail.users.messages.list': () => reply });
    await assert.rejects(() => instance.client.listAddedMessages(cursor), errorCode('unknown'));
    assert.equal(instance.calls.filter(call => call.method === 'gmail.users.messages.list').length, 'messages' in reply ? 2 : 1);
  }
});
