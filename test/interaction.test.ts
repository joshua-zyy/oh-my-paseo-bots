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
  for (const path of ['client/chat.tsx', 'client/model-selector.tsx', 'client/ui.tsx', 'client/chat-permission.tsx']) {
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

test('执行详情不切换主总管，受托同事的原生专家沿用实际所有者', async () => {
  const source = await sourceFile('index.client.tsx');
  let callback = '';
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'openAgent') callback = node.getText(source); ts.forEachChild(node, visit); };
  visit(source); assert.ok(callback);
  let detail: { agentId: string; owner: string } | undefined;
  const api = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, title: id, labels: id === 'worker' || id === 'helper-chat' ? { 'paseo-guys.bot': 'helper' } : {} } }) }) } };
  const body = ts.transpileModule(callback + '\nreturn openAgent;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const open = new Function('api', 'CHIEF_BOT_ID', 'setDetail', 'setError', body)(api, 'chief', (value: typeof detail) => { detail = value; }, (error: unknown) => assert.fail(String(error)));
  open('worker'); await new Promise<void>(done => setImmediate(done)); assert.equal(detail?.owner, 'helper');
  open('expert', detail!.owner); await new Promise<void>(done => setImmediate(done)); assert.equal(detail?.owner, 'helper');
  open('expert'); await new Promise<void>(done => setImmediate(done)); assert.equal(detail?.owner, 'chief');
  open('helper-chat'); await new Promise<void>(done => setImmediate(done)); assert.equal(detail?.agentId, 'helper-chat');
  assert.doesNotMatch(callback, /choose\(|setConversation\(|setConversations\(/, '执行详情从不切换主入口');
});

interface Element { type: string; props: Record<string, any>; children: any[] }

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
  drafts.old = { text }; fail = true; wait = undefined;
  await invoke({ thinkingOptionId: 'high' });
  const high = requests.at(-1)!;
  await invoke({ thinkingOptionId: 'low' });
  const low = requests.at(-1)!;
  assert.notEqual(low.requestId, high.requestId, '改选思考等级不能重用上一等级的失败请求');
  assert.equal(low.execution.thinkingOptionId, 'low');
  fail = false;
  await invoke();
  assert.deepEqual(requests.at(-1), low, '重试当前等级仍沿原请求');
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
  let conversation = 'old';
  const remember = new Function('setConversation', ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)((update: (value: string) => string) => { conversation = update(conversation); });
  remember('chief', 'old', 'new'); assert.equal(conversation, 'new');
  remember('chief', 'old', 'late'); assert.equal(conversation, 'new', '迟到回执不覆盖已切换的主聊天');
  const settings = await sourceFile('client/chat-settings.tsx');
  const component = settings.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ConversationSettings')!;
  const body = ts.transpileModule(`${component.getText(settings)}\nreturn ConversationSettings;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const values: unknown[] = [];
  const levels = [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }];
  const catalog = { entries: [{ provider: 'pi', enabled: true, status: 'ready', models: [{ id: 'vendor/model', thinkingOptions: levels }] }], models: [], error: '', loading: false, reload() {} };
  const render = new Function('h', 'Fragment', 'View', 'PathPicker', 'ModelSelector', 'ThinkingSelector', 'useModelCatalog', body)(
    (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    'Fragment', 'View', 'PathPicker', 'ModelSelector', 'ThinkingSelector', () => catalog,
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
  const thinking = view().find(node => node.type === 'ThinkingSelector')!;
  assert.equal(thinking.props.options, levels, '只传当前Provider/model支持的等级');
  thinking.props.onSelect('high'); thinking.props.onSelect(null);
  assert.deepEqual(values.slice(2), [{ thinkingOptionId: 'high' }, { thinkingOptionId: null }]);
  assert.ok(!view().some(node => node.type === 'Modal'), '消息框不再自带简化居中模型列表');
  props.disabled = true;
  assert.ok(view().filter(node => ['ModelSelector', 'ThinkingSelector', 'PathPicker'].includes(node.type)).every(node => node.props.disabled));
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
