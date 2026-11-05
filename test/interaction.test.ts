import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { observeAgentChanges } from '../client/agent-changes.js';
import type { PaseoApi } from '@getpaseo/client';

async function sourceFile(path: string) {
  const root = process.env.BOT_UI_SOURCE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  return ts.createSourceFile(path, await readFile(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

test('裸输入沿用原生输入层，不显示浏览器绿色内层焦点框', async () => {
  for (const path of ['index.client.tsx', 'client/chat.tsx', 'client/model-selector.tsx', 'client/ui.tsx', 'client/chat-permission.tsx', 'client/connections.tsx']) {
    const source = await sourceFile(path);
    let checked = 0;
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'TextInput') {
        const style = node.attributes.properties.filter(ts.isJsxAttribute).find(attribute => attribute.name.getText(source) === 'style')?.initializer;
        assert.ok(style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression), path);
        const outline = style.expression.properties.filter(ts.isPropertyAssignment).find(property => property.name.getText(source) === 'outlineWidth');
        assert.equal(outline?.initializer.getText(source), '0', path);
        checked++;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(checked, path);
  }
});

test('表单复用原生设置组件，保留外部值同步、多行内容和长度限制', async () => {
  const source = await sourceFile('client/ui.tsx');
  const functions = source.statements.filter(ts.isFunctionDeclaration).filter(node => ['Field', 'Section'].includes(node.name?.text ?? '')).map(node => node.getText(source)).join('\n');
  const body = ts.transpileModule(`${functions}\nreturn { Field, Section };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText.replace(/export /g, '');
  const effects: (() => void)[] = [];
  const input = { current: null as null | { getText(): string; replaceText(value: string): void } };
  const render = new Function('h', 'useUi', 'useRef', 'useEffect', 'SettingsCard', 'SettingsInput', 'SettingsRow', 'SettingsSection', 'TextInput', 'View', 'Copy', 'Text', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    () => ({ colors: {}, compact: false }), () => input, (effect: () => void) => effects.push(effect),
    'SettingsCard', 'SettingsInput', 'SettingsRow', 'SettingsSection', 'TextInput', 'View', 'Copy', 'Text',
  );
  const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flatMap(elements)] : [];
  const changes: string[] = [];
  const props = { label: 'Paseo CLI', value: 'old', disabled: true, onChangeText: (value: string) => changes.push(value) };
  const single = elements(render.Field(props)).find(node => node.type === 'SettingsInput');
  assert.ok(single, '可复用的单行输入交给宿主渲染');
  assert.equal(single.props.label, props.label);
  assert.equal(single.props.initialValue, 'old');
  assert.equal(single.props.disabled, true);
  single.props.onChangeText('typed');
  assert.deepEqual(changes, ['typed']);
  let text = 'old';
  let replacements = 0;
  single.props.ref.current = { getText: () => text, replaceText: (value: string) => { text = value; replacements++; } };
  effects.splice(0).forEach(effect => effect());
  assert.equal(replacements, 0, '父组件回显不重设宿主输入光标');
  render.Field({ ...props, value: 'reset' });
  effects.splice(0).forEach(effect => effect());
  assert.equal(text, 'reset', '程序更新仍同步到原生非受控输入');
  const limited = elements(render.Field({ ...props, maxLength: 200 }));
  assert.ok(limited.some(node => node.type === 'SettingsRow' && node.props.label === props.label));
  assert.equal(limited.find(node => node.type === 'TextInput')?.props.maxLength, 200);
  const multiline = elements(render.Field({ ...props, value: '第一行\n第二行', multiline: true, maxLength: 8000 }));
  assert.ok(multiline.some(node => node.type === 'SettingsSection' && node.props.title === props.label));
  const editor = multiline.find(node => node.type === 'TextInput')!;
  assert.equal(editor.props.value, '第一行\n第二行');
  assert.equal(editor.props.multiline, true);
  assert.equal(editor.props.maxLength, 8000);
  assert.equal(editor.props.editable, false);
  const action = { type: 'action' };
  const section = render.Section({ title: '技能', action, children: 'content' });
  assert.equal(section.type, 'SettingsSection');
  assert.equal(section.props.trailing, action);
});

test('聊天控件沿用宿主尺寸与主题，选中态不冒充主要操作', async () => {
  const source = await sourceFile('client/ui.tsx');
  const functions = source.statements.filter(ts.isFunctionDeclaration).filter(node => ['Button', 'PickerRow'].includes(node.name?.text ?? '')).map(node => node.getText(source)).join('\n');
  const body = ts.transpileModule(`${functions}\nreturn { Button, PickerRow };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText.replace(/export /g, '');
  let compact = false;
  const colors = { accent: 'accent', accentForeground: 'accentForeground', surface2: 'surface2', foreground: 'foreground', foregroundMuted: 'foregroundMuted' };
  const render = new Function('h', 'useUi', 'Pressable', 'Text', 'View', 'Icon', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    () => ({ colors, compact }), 'Pressable', 'Text', 'View', 'Icon',
  );
  let pressed = 0;
  const action = render.Button({ label: '发送', primary: true, icon: 'ArrowUp', iconOnly: true, size: 'xs', disabled: true, onPress: () => pressed++ });
  assert.equal(action.props.disabled, true);
  assert.equal(action.props.accessibilityLabel, '发送');
  assert.equal(action.props.style({ pressed: false }).backgroundColor, colors.accent);
  assert.equal(action.props.style({ pressed: false }).minHeight, 28);
  assert.equal(action.props.style({ pressed: false }).width, 28);
  assert.equal(action.children[0].props.color, colors.accentForeground);
  const selected = render.Button({ label: '同事', selected: true, onPress: () => pressed++ });
  assert.equal(selected.props.accessibilityState.selected, true);
  assert.equal(selected.props.style({ pressed: false }).backgroundColor, colors.surface2);
  assert.equal(selected.props.style({ pressed: false }).minHeight, 32);
  assert.equal(selected.props.style({ pressed: false, hovered: true }).opacity, 1);
  compact = true;
  assert.equal(render.Button({ label: '发送', size: 'xs', onPress() {} }).props.style({ pressed: false }).minHeight, 44);
  const row = render.PickerRow({ label: '模型', selected: true, onPress: () => pressed++ });
  assert.equal(row.props.accessibilityState.selected, true);
  assert.equal(row.props.style({ pressed: false }).minHeight, 44);
  row.props.onPress();
  assert.equal(pressed, 1);
  assert.ok(row.children.some((child: any) => child?.type === 'Icon' && child.props.name === 'Check'));
});

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
test('聊天显示完整邮件并保存回执后通知同事，通知失败不重发，未知发送只回查', async () => {
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
  let error = '';
  let notificationFails = true;
  const notifiedStatuses: string[] = [];
  const render = new Function('h', 'Fragment', 'Disclosure', 'Copy', 'Actions', 'Button', 'labels', 'opened', 'inline', 'busy', 'setOpened', 'botId', 'run', 'send', 'reconcile', 'revoke', 'allow', 'setActions', 'notify', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }), 'Fragment', 'Disclosure', 'Copy', 'Actions', 'Button', {}, undefined, true, false, () => {}, 'chief',
    (work: () => Promise<unknown>) => { error = ''; pending = work().catch(failure => { error = String(failure); }); return pending; },
    async (input: unknown) => { calls.push({ kind: 'send', input }); return { ...action, status: 'sent' }; },
    async (input: unknown) => { calls.push({ kind: 'reconcile', input }); return { ...action, status: 'send_unknown' }; },
    async (input: unknown) => { calls.push({ kind: 'revoke', input }); return { ...action, status: 'revoked' }; }, async () => {},
    (update: (value: typeof actions) => typeof actions) => { actions = update(actions); },
    async (input: unknown) => {
      calls.push({ kind: 'notify', input }); notifiedStatuses.push(actions[0].status);
      if (notificationFails) throw new Error('原生通知回执丢失');
      return { agentId: action.agentId, status: 'notified' };
    },
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
  assert.deepEqual(calls, ['send', 'notify'].map(kind => ({ kind, input: { botId: 'chief', actionId: 'registered-mail' } })));
  assert.equal(actions[0].status, 'sent');
  assert.deepEqual(notifiedStatuses, ['sent'], '通知前已保存实际邮件回执');
  assert.match(error, /邮件状态已保存，同事通知未确认/);
  assert.equal(elements(render(actions[0])).some(node => node.props.label === '确认并发送'), false, '通知失败不重新开放已发送邮件的发送动作');
  notificationFails = false;
  const unknown = render({ ...action, status: 'send_unknown' }) as Element;
  const controls = elements(unknown).filter(node => node.type === 'Button');
  assert.equal(controls.some(node => node.props.label === '确认并发送'), false);
  const reconcile = controls.find(node => node.props.label === '回查')!;
  assert.ok(reconcile && !reconcile.props.disabled);
  reconcile.props.onPress(); await pending;
  assert.deepEqual(calls.slice(2), ['reconcile', 'notify'].map(kind => ({ kind, input: { botId: 'chief', actionId: 'registered-mail' } })));
  assert.equal(actions[0].status, 'send_unknown');
  const cancel = elements(render(action)).find(node => node.type === 'Button' && node.props.label === '撤销')!;
  cancel.props.onPress(); await pending;
  assert.deepEqual(calls.slice(4), ['revoke', 'notify'].map(kind => ({ kind, input: { botId: 'chief', actionId: 'registered-mail' } })));
  assert.deepEqual(notifiedStatuses, ['sent', 'send_unknown', 'revoked']);
  assert.equal(error, '');
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
  const createSend = new Function('agentId', 'sends', 'stops', 'changing', 'draft', 'offline', 'chat', 'observer', 'setDrafts', 'api', 'opened', 'prepare', body);
  const text = '请记住：后续报告使用英文。\n本条原话不能附加或删改。';
  const attachment = { type: 'text', mimeType: 'text/plain', title: '最新确认记忆', text: '["使用英文"]' };
  let preparations = 0;
  const requests: { text: string; options: unknown }[] = [];
  let drafts: Record<string, any> = { 'helper-chat': { text, messageId: 'same-message' } };
  let sendFails = true;
  let contextFails = false;
  let conversation = true;
  const changing = { current: new Set<string>() };
  const invoke = () => createSend('helper-chat', { current: new Set() }, { current: new Set() }, changing, drafts['helper-chat'], false,
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
  drafts['helper-chat'] = { text };
  changing.current.add('helper-chat');
  await invoke();
  assert.equal(requests.length, 3, '配置切换期间不把未发送消息发给旧会话');
});

test('消息框切换保留草稿并沿原请求重试，异步完成后仍只更新所属 Bot', async () => {
  const source = await sourceFile('client/chat.tsx');
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'changeSettings') callback = `${node.getText(source)}\nreturn changeSettings;`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const body = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createChange = new Function('agentId', 'changing', 'sends', 'stops', 'draft', 'offline', 'chat', 'running', 'opened', 'observer', 'settingsChanges', 'setSettingsChanges', 'setDrafts', 'switchConversation', 'onConversationChange', 'setOpened', 'key', body);
  const text = '继续完成原来的目标。\n这段草稿不能丢失。';
  let drafts: Record<string, any> = { old: { text, messageId: 'unsent-message', error: '尚未派发' }, helper: { text: '另一位同事的草稿' } };
  let changes: Record<string, any> = {};
  let opened = { key: 'chief:old', owner: 'chief', agentId: 'old', error: '' };
  const requests: Record<string, any>[] = [];
  const remembered: string[][] = [];
  const changing = { current: new Set<string>() };
  const sends = { current: new Set<string>() };
  let fail = true;
  let resolveSwitch: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  let nextId = 'new';
  const invoke = (execution?: Record<string, string>) => createChange('old', changing, sends, { current: new Set() }, drafts.old, false,
    { loading: false, agent: { archivedAt: null, pendingPermissions: [] } }, false, { owner: 'chief' }, { current: { refresh() {} } }, changes,
    (update: (value: typeof changes) => typeof changes) => { changes = update(changes); },
    (update: (value: typeof drafts) => typeof drafts) => { drafts = update(drafts); },
    async (input: Record<string, any>) => { requests.push(input); await wait; if (fail) throw new Error('创建回执丢失'); return { agentId: nextId }; },
    (...ids: string[]) => remembered.push(ids),
    (update: (value: typeof opened) => typeof opened) => { opened = update(opened); }, 'chief:old',
  )(execution);
  await invoke({ provider: 'pi/vendor/model' });
  assert.match(requests[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(drafts.old.text, text);
  assert.equal(remembered.length, 0);
  assert.equal(changes.old.pending, false);
  fail = false;
  await invoke();
  assert.deepEqual(requests[1], requests[0], '回执未确认时沿原请求及配置重试');
  assert.deepEqual(drafts.new, { text });
  assert.equal(drafts.old.text, '');
  assert.equal(drafts.helper.text, '另一位同事的草稿');
  assert.deepEqual(remembered, [['chief', 'old', 'new']]);
  assert.equal(opened.agentId, 'new');
  assert.equal(opened.key, 'chief:new');
  drafts.old = { text, unknown: true };
  await invoke({ cwd: 'D:/selected-project' });
  assert.equal(requests.length, 2, '发送回执未知时不能切换到其他原生会话');
  drafts.old = { text };
  sends.current.add('old');
  await invoke({ cwd: 'D:/selected-project' });
  assert.equal(requests.length, 2, '正在发送时不能切换');
  sends.current.clear();
  nextId = 'later';
  wait = new Promise<void>(resolve => { resolveSwitch = resolve; });
  const pending = invoke({ cwd: 'D:/selected-project' });
  assert.equal(changing.current.has('old'), true);
  opened = { key: 'helper:helper', owner: 'helper', agentId: 'helper', error: '' };
  resolveSwitch!();
  await pending;
  assert.equal(opened.agentId, 'helper', '切换 Bot 后不把异步创建结果打开到其他同事');
  assert.deepEqual(remembered.at(-1), ['chief', 'old', 'later']);
  assert.equal(drafts.later.text, text);
  assert.equal(drafts.helper.text, '另一位同事的草稿');
  assert.equal(changing.current.size, 0);
});

test('聊天入口按实际 Bot 保存切换结果，模型和工作区选项接入消息框切换', async () => {
  const source = await sourceFile('index.client.tsx');
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'rememberConversation' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  let conversations: Record<string, string> = { chief: 'old', helper: 'helper-chat' };
  const remember = new Function('setConversations', ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)((update: (value: typeof conversations) => typeof conversations) => { conversations = update(conversations); });
  remember('chief', 'old', 'new');
  assert.deepEqual(conversations, { chief: 'new', helper: 'helper-chat' });
  remember('chief', 'old', 'late');
  assert.equal(conversations.chief, 'new', '不覆盖用户已打开的其他对话');
  const settings = await sourceFile('client/chat-settings.tsx');
  const component = settings.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ConversationSettings')!;
  const body = ts.transpileModule(`${component.getText(settings)}\nreturn ConversationSettings;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const values: unknown[] = [];
  const catalog = { entries: [], models: [], error: '', loading: false, reload() {} };
  const render = new Function('h', 'Fragment', 'View', 'PathPicker', 'ModelSelector', 'useModelCatalog', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    'Fragment', 'View', 'PathPicker', 'ModelSelector', () => catalog,
  );
  const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flatMap(elements)] : [];
  const props = { execution: { provider: 'pi/vendor/model', cwd: 'D:/project' }, defaultCwd: 'D:/bot', disabled: false, onChange: (value: unknown) => values.push(value) };
  const view = () => elements(render(props));
  const selector = view().find(node => node.type === 'ModelSelector')!;
  assert.equal(selector.props.catalog, catalog);
  assert.equal(selector.props.value, 'pi/vendor/model');
  selector.props.onSelect('pi/vendor/model');
  const path = view().find(node => node.type === 'PathPicker')!;
  assert.equal(path.props.inline, true);
  assert.deepEqual(path.props.defaultLocation, { path: 'D:/bot', label: 'Bot 工作区' });
  path.props.onChange(undefined);
  path.props.onChange('D:/selected-project');
  assert.deepEqual(values, [{ provider: 'pi/vendor/model' }, { cwd: 'D:/selected-project' }]);
  assert.ok(!view().some(node => node.type === 'Modal'), '消息框不再自带简化居中模型列表');
  props.disabled = true;
  assert.ok(view().filter(node => ['ModelSelector', 'PathPicker'].includes(node.type)).every(node => node.props.disabled));
});

test('归档入口先确认，恢复与归档使用实际 Bot 标识且失败不切走同事', async () => {
  const source = await sourceFile('index.client.tsx');
  let action = '';
  const presses = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'changeArchive') action = node.getText(source);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Button') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const label = attributes.find(attribute => attribute.name.getText(source) === 'label')?.initializer;
      const press = attributes.find(attribute => attribute.name.getText(source) === 'onPress')?.initializer;
      if (label && ts.isStringLiteral(label) && press) presses.set(label.text, press.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(action);
  assert.equal(presses.get('归档同事'), "{() => setPanel('archive')}");
  assert.ok(presses.get('确认归档')?.includes('changeArchive(current.id, true)'));
  assert.ok(presses.get('已归档同事')?.includes("setPanel('archived')"));
  const calls: string[] = [];
  const guard = { current: false };
  let failure = false;
  const run = new Function('archive', 'restore', 'refresh', 'choose', 'CHIEF_BOT_ID', 'guard', 'setBusy', 'setError', ts.transpileModule(`${action}\nreturn changeArchive;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
    async ({ botId }: { botId: string }) => { calls.push(`archive:${botId}`); if (failure) throw new Error('未结束事项'); },
    async ({ botId }: { botId: string }) => { calls.push(`restore:${botId}`); },
    async () => calls.push('refresh'), (id: string) => calls.push(`choose:${id}`), 'chief', guard, () => {}, (error: string) => { if (error) calls.push(error); },
  );
  await run('helper', true);
  assert.deepEqual(calls.splice(0), ['archive:helper', 'refresh', 'choose:chief']);
  await run('other', false);
  assert.deepEqual(calls.splice(0), ['restore:other', 'refresh']);
  failure = true;
  await run('helper', true);
  assert.deepEqual(calls, ['archive:helper', 'Error: 未结束事项']);
  assert.equal(guard.current, false);
});

test('当前聊天订阅旧父会话的跨 Bot 子任务，旧任务报告变化仍触发工作刷新', async () => {
  const source = await sourceFile('client/chat-work.tsx');
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('observeAgentChanges')) callback = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  let revision = 0;
  let released = 0;
  const child = { id: 'old-helper-task', status: 'running', pendingPermissions: [], labels: { 'paseo-guys.bot': 'helper', 'paseo.parent-agent-id': 'old' }, updatedAt: 'one' };
  const observers: { matches: boolean; observer: any }[] = [];
  const api = { agents: { list: async (input: { filter: { labels: Record<string, string> } }) => {
    const matches = Object.entries(input.filter.labels).every(([key, value]) => child.labels[key as keyof typeof child.labels] === value);
    return { subscription: {
      subscribe: (observer: any) => { observers.push({ matches, observer }); observer.snapshot({ subscriptionId: `subscription:${observers.length}`, entries: matches ? [{ agent: child }] : [] }); return () => {}; },
      release: async () => { released++; },
    } };
  } } } as unknown as PaseoApi;
  const subscribe = new Function('api', 'botId', 'agentId', 'previousAgentIds', 'observeAgentChanges', 'setRevision', 'setError', ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(api, 'chief', 'new', ['old'], observeAgentChanges,
    (update: (value: number) => number) => { revision = update(revision); }, (error: unknown) => assert.fail(String(error)));
  const cleanup = subscribe();
  await new Promise<void>(done => setImmediate(done));
  const previous = revision;
  const matched = observers.filter(entry => entry.matches);
  assert.equal(matched.length, 1, '旧跨 Bot 子任务仍有其原父 ID 的订阅');
  matched[0].observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...child, status: 'closed', updatedAt: 'two' } } });
  assert.equal(revision, previous + 1);
  cleanup();
  await new Promise<void>(done => setImmediate(done));
  assert.equal(released, observers.length);
});
