import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

async function sourceFile(path: string) {
  const root = process.env.BOT_UI_SOURCE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  return ts.createSourceFile(path, await readFile(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

test('执行详情保留主聊天及草稿归属，只有打开同事聊天才切换固定身份', async () => {
  const source = await sourceFile('index.client.tsx');
  let callback = '';
  let detailCallback = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'openAgent') callback = `${node.getText(source)}\nreturn openAgent;`;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'openAgent' && node.initializer) callback = `return (${node.initializer.getText(source)});`;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Chat') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      if (attributes.find(attribute => attribute.name.getText(source) === 'botId')?.initializer?.getText(source) === '{detail.owner}') {
        const action = attributes.find(attribute => attribute.name.getText(source) === 'openAgent')?.initializer;
        if (action && ts.isJsxExpression(action) && action.expression) detailCallback = `return (${action.expression.getText(source)});`;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  let mainSession = 'chief-chat';
  let selected = 'chief';
  let conversations: Record<string, string> = { chief: mainSession };
  let detail: { agentId: string; owner: string; executor: string } | undefined;
  const api = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: {
    id, title: `执行 ${id}`, labels: id === 'expert' ? {} : { 'paseo-guys.bot': 'helper', ...(id === 'helper-chat' ? { 'paseo-guys.conversation': 'true' } : {}) },
  } }) }) } };
  const body = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const open = new Function('api', 'selected', 'current', 'bots', 'choose', 'setConversations', 'setDetail', 'setPanel', 'setError', 'setViewedSession', 'setTab', body)(
    api, selected, { name: '主 Bot' }, [{ id: 'helper', name: '核对同事' }],
    (id: string) => { selected = id; detail = undefined; },
    (update: (value: Record<string, string>) => Record<string, string>) => { conversations = update(conversations); },
    (value: typeof detail) => { detail = value; }, () => {}, (error: unknown) => assert.fail(String(error)),
    (id: string) => { mainSession = id; }, () => {},
  );
  open('worker');
  await new Promise<void>(done => setImmediate(done));
  assert.equal(mainSession, 'chief-chat');
  assert.equal(selected, 'chief');
  assert.deepEqual({ ...conversations }, { chief: 'chief-chat' });
  assert.equal(detail?.owner, 'helper');
  assert.equal(detail?.executor, '核对同事');
  assert.ok(detailCallback);
  const openFromDetail = new Function('openAgent', 'detail', ts.transpileModule(detailCallback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(open, detail);
  openFromDetail('expert');
  await new Promise<void>(done => setImmediate(done));
  assert.equal(detail?.owner, 'helper', '从受托同事详情打开原生专家时保留实际 Bot 归属，停止回复不误用 Chief');
  open('expert');
  await new Promise<void>(done => setImmediate(done));
  assert.equal(detail?.executor, '原生专家');
  assert.equal(selected, 'chief');
  open('helper-chat');
  await new Promise<void>(done => setImmediate(done));
  assert.equal(selected, 'helper');
  assert.equal(conversations.helper, 'helper-chat');
  assert.equal(detail, undefined);
});

interface Element { type: string; props: Record<string, any>; children: any[] }
test('聊天显示完整邮件后才提供确认，未知发送只提供回查并保留原动作标识', async () => {
  const source = await sourceFile('client/office.tsx');
  let row = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'row') row = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(row);
  const body = ts.transpileModule(`${row}\nreturn row;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText;
  const calls: { kind: string; input: unknown }[] = [];
  const action = { id: 'registered-mail', agentId: 'worker', account: 'sender@example.test', to: ['receiver@example.test'], subject: '完整草案', text: '完整正文\n第二行。', sourceIds: ['source-1'], query: 'label:synthetic', status: 'pending_confirmation' };
  let actions: typeof action[] = [action];
  let pending: Promise<unknown> = Promise.resolve();
  const render = new Function('h', 'Fragment', 'Disclosure', 'Copy', 'Actions', 'Button', 'labels', 'opened', 'inline', 'busy', 'setOpened', 'botId', 'run', 'send', 'reconcile', 'revoke', 'allow', 'setActions', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }), 'Fragment', 'Disclosure', 'Copy', 'Actions', 'Button', {}, undefined, true, false, () => {}, 'chief',
    (work: () => Promise<unknown>) => { pending = work(); return pending; },
    async (input: unknown) => { calls.push({ kind: 'send', input }); return { ...action, status: 'sent' }; },
    async (input: unknown) => { calls.push({ kind: 'reconcile', input }); return { ...action, status: 'send_unknown' }; },
    async () => {}, async () => {}, (update: (value: typeof actions) => typeof actions) => { actions = update(actions); },
  );
  const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flatMap(elements)] : [];
  const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'children' in node ? text(node.children) : typeof node === 'string' ? node : '';
  const draft = render(action) as Element;
  assert.equal(draft.props.open, true);
  assert.equal(draft.props.title, action.subject);
  for (const value of [action.account, action.to[0], action.text, action.query, action.sourceIds[0]]) assert.ok(text(draft).includes(value));
  const confirm = elements(draft).find(node => node.type === 'Button' && node.props.label === '确认并发送')!;
  assert.ok(confirm && !confirm.props.disabled);
  confirm.props.onPress(); await pending;
  assert.deepEqual(calls, [{ kind: 'send', input: { botId: 'chief', actionId: 'registered-mail' } }]);
  assert.equal(actions[0].status, 'sent');
  const unknown = render({ ...action, status: 'send_unknown' }) as Element;
  const controls = elements(unknown).filter(node => node.type === 'Button');
  assert.equal(controls.some(node => node.props.label === '确认并发送'), false);
  const reconcile = controls.find(node => node.props.label === '回查')!;
  assert.ok(reconcile && !reconcile.props.disabled);
  reconcile.props.onPress(); await pending;
  assert.deepEqual(calls[1], { kind: 'reconcile', input: { botId: 'chief', actionId: 'registered-mail' } });
});

test('例程按选择的频率和时间提交，保留高级 Cron 与指定时区', async () => {
  const source = await sourceFile('client/routines.tsx');
  let cadence = 'cron';
  let submit = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'cadence' && node.initializer) cadence = node.initializer.getText(source);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      if (attributes.find(attribute => attribute.name.getText(source) === 'label')?.initializer?.getText(source) === '"创建例程"') {
        const action = attributes.find(attribute => attribute.name.getText(source) === 'onPress')?.initializer;
        if (action && ts.isJsxExpression(action) && action.expression) submit = action.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(submit);
  const body = ts.transpileModule(`const cadence = ${cadence}; return (${submit});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createSubmit = new Function('frequency', 'hour', 'minute', 'weekday', 'cron', 'timezone', 'botId', 'name', 'prompt', 'continuity', 'run', 'create', 'setCreating', 'setName', 'setPrompt', 'setOpened', body);
  for (const [frequency, hour, minute, weekday, expected] of [
    ['daily', '17', '43', '1', '43 17 * * *'],
    ['weekdays', '09', '07', '1', '7 9 * * 1-5'],
    ['weekly', '00', '05', '0', '5 0 * * 0'],
    ['custom', '09', '00', '1', '*/10 * * * *'],
  ]) {
    let pending = Promise.resolve();
    const values: unknown[] = [];
    const callback = createSubmit(frequency, hour, minute, weekday, '*/10 * * * *', 'America/New_York', 'chief', '合成例程', '仅整理本地合成文件', false,
      (work: () => Promise<void>) => { pending = work(); return pending; },
      async (input: unknown) => { values.push(input); return { id: 'registered-routine' }; }, () => {}, () => {}, () => {}, () => {},
    );
    callback(); await pending;
    assert.deepEqual(values, [{ botId: 'chief', name: '合成例程', prompt: '仅整理本地合成文件', cron: expected, timezone: 'America/New_York', continuity: false }]);
  }
});

test('例程列表显示普通时间，其他 Cron 保留原文', async () => {
  const { describeRoutineCron } = await import(new URL('../client/routine-time.js', import.meta.url).href);
  for (const [expression, expected] of [
    ['43 17 * * *', '每天 17:43'], ['7 9 * * 1-5', '工作日 09:07'], ['5 0 * * 0', '每周日 00:05'],
    ['0 9 1 * *', '0 9 1 * *'], ['*/10 * * * *', '*/10 * * * *'],
  ]) assert.equal(describeRoutineCron(expression), expected);
});

test('旧 Bot 聊天发送携带当前确认记忆，原话与失败重试内容保持完整', async () => {
  const source = await sourceFile('client/chat.tsx');
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'send') callback = `${node.getText(source)}\nreturn send;`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const body = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createSend = new Function('agentId', 'sends', 'stops', 'draft', 'offline', 'chat', 'observer', 'setDrafts', 'api', 'opened', 'prepare', body);
  const text = '请记住：后续报告使用英文。\n本条原话不能附加或删改。';
  const attachment = { type: 'text', mimeType: 'text/plain', title: '最新确认记忆', text: '["使用英文"]' };
  let preparations = 0;
  const requests: { text: string; options: unknown }[] = [];
  let drafts: Record<string, any> = { 'helper-chat': { text, messageId: 'same-message' } };
  let sendFails = true;
  let contextFails = false;
  let conversation = true;
  const invoke = () => createSend('helper-chat', { current: new Set() }, { current: new Set() }, drafts['helper-chat'], false,
    { loading: false, agent: { archivedAt: null, labels: conversation ? { 'paseo-guys.conversation': 'true' } : {} } }, { current: { refresh() {} } },
    (update: (value: typeof drafts) => typeof drafts) => { drafts = update(drafts); },
    { agents: { ref: () => ({ send: async (text: string, options: unknown) => { requests.push({ text, options }); if (sendFails) throw new Error('回执丢失'); } }) } },
    { owner: 'helper' }, async (input: unknown) => { preparations++; assert.deepEqual(input, { botId: 'helper', agentId: 'helper-chat' }); if (contextFails) throw new Error('记忆读取失败'); return attachment; },
  )();
  await invoke();
  assert.equal(preparations, 1);
  assert.deepEqual(requests, [{ text, options: { messageId: 'same-message', activeTurnBehavior: 'steer', attachments: [attachment] } }]);
  assert.equal(drafts['helper-chat'].unknown, true);
  sendFails = false;
  await invoke();
  assert.equal(preparations, 1, '回执不确定时沿用原消息的上下文附件，不重新取内容或换消息标识');
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(drafts['helper-chat'].text, '');
  drafts['helper-chat'] = { text, messageId: 'not-dispatched' };
  contextFails = true;
  await invoke();
  assert.equal(requests.length, 2, '上下文读取失败不发送原生消息');
  assert.notEqual(drafts['helper-chat'].unknown, true, '尚未派发不能报告为发送回执不确定');
  assert.equal(drafts['helper-chat'].text, text);
  conversation = false;
  drafts['helper-chat'] = { text, messageId: 'expert-message' };
  await invoke();
  assert.equal(preparations, 2, '原生专家详情不自动取得固定 Bot 的全部记忆');
  assert.deepEqual(requests[2], { text, options: { messageId: 'expert-message', activeTurnBehavior: 'steer' } });
});
