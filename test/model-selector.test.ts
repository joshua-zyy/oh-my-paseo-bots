import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

interface Element { type: string; props: Record<string, any>; children: any[] }
const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flatMap(elements)] : [];
async function selector(compact = false) {
  const root = process.env.BOT_UI_SOURCE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  const source = ts.createSourceFile('selector.tsx', await readFile(resolve(root, 'client/model-selector.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = source.statements.filter(ts.isFunctionDeclaration).filter(node => ['ModelSelector', 'ThinkingSelector', 'modelPopoverFrame'].includes(node.name?.text ?? '')).map(node => node.getText(source)).join('\n');
  const body = ts.transpileModule(`${functions}\nreturn { ModelSelector, ThinkingSelector, modelPopoverFrame };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText.replace(/export /g, '');
  const state: any[] = [];
  let cursor = 0;
  const render = new Function('h', 'Fragment', 'View', 'Pressable', 'Text', 'Icon', 'ProviderGlyph', 'NativeModal', 'Modal', 'ScrollView', 'TextInput', 'Button', 'Copy', 'Notice', 'useUi', 'useState', 'useRef', 'useEffect', 'useWindowDimensions', 'Platform', 'PickerRow', body)(
    (type: string | object, props: unknown, ...children: unknown[]) => ({ type: typeof type === 'string' ? type : 'Modal', props: props ?? {}, children }),
    'Fragment', 'View', 'Pressable', 'Text', 'Icon', 'ProviderGlyph', 'NativeModal', Object.assign('Modal', { Content: 'Modal.Content' }), 'ScrollView', 'TextInput', 'Button', 'Copy', 'Notice',
    () => ({ compact, colors: { foreground: 'fg', foregroundMuted: 'muted', surface0: 's0', surface1: 's1', surface2: 's2', border: 'border' } }),
    (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (next: any) => { state[index] = next; }]; },
    () => ({ current: null }), () => {}, () => ({ width: 1000, height: 800 }), { OS: 'web' }, 'PickerRow',
  );
  const selected: string[] = [];
  const props = { value: 'pi/vendor/alpha', disabled: false, onSelect: (value: string) => selected.push(value), catalog: {
    entries: [{ provider: 'pi', label: 'Pi', enabled: true, status: 'ready', error: '' }, { provider: 'codex', label: 'Codex', enabled: true, status: 'ready', error: '' }],
    models: [{ value: 'pi/vendor/alpha', label: 'Alpha', providerLabel: 'Pi' }, { value: 'codex/beta', label: 'Beta', providerLabel: 'Codex' }], error: '', loading: false, reload() {},
  } };
  // Stub tree/callback tests only: this is not browser rendering or focus verification.
  return { props, selected, state, frame: render.modelPopoverFrame, view: () => { cursor = 0; return elements(render.ModelSelector(props)); }, thinking: (props: unknown) => { cursor = 0; return elements(render.ThinkingSelector(props)); } };
}

test('思考选择仅提供真实等级和模型默认，桌面锚定、窄屏宿主Modal，禁用时不派发', async () => {
  const f = await selector();
  const changes: (string | null)[] = [];
  const props = { options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], value: 'high', disabled: false, onSelect: (value: string | null) => changes.push(value) };
  const view = () => f.thinking(props);
  view().find(node => node.props.accessibilityLabel === '思考等级：High')!.props.onPress();
  f.state[0] = { x: 100, y: 600, width: 100, height: 28 };
  assert.ok(view().some(node => node.type === 'NativeModal' && node.props.visible));
  const rows = () => view().filter(node => node.type === 'PickerRow');
  assert.deepEqual(rows().map(row => row.props.label), ['模型默认', 'Low', 'High']);
  assert.equal(rows()[2].props.selected, true);
  rows()[1].props.onPress();
  assert.deepEqual(changes, ['low']);
  assert.equal(f.state[1], false);
  rows()[0].props.onPress();
  assert.deepEqual(changes, ['low', null]);
  props.disabled = true;
  rows()[2].props.onPress();
  assert.deepEqual(changes, ['low', null]);
  const compact = await selector(true);
  assert.ok(compact.thinking(props).some(node => node.type === 'Modal'));
  assert.equal(compact.thinking({ ...props, options: [] }).length, 0, '不为未支持思考的模型添加假控件');
});

test('模型弹层锚定输入触发器，受视口限制，优先向上展开', async () => {
  const { frame } = await selector();
  const above = frame({ x: 200, y: 650, width: 120, height: 28 }, { width: 1000, height: 800 }, 30);
  assert.equal(above.left, 200);
  assert.equal(above.top + above.height, 645);
  assert.equal(above.height, 400);
  const below = frame({ x: 950, y: 40, width: 30, height: 28 }, { width: 1000, height: 800 }, 2);
  assert.equal(below.top, 73);
  assert.equal(below.left + below.width, 992);
  const narrow = frame({ x: 50, y: 200, width: 120, height: 28 }, { width: 300, height: 400 }, 30);
  assert.equal(narrow.width, 284);
  assert.ok(narrow.top >= 8 && narrow.top + narrow.height <= 392);
});

test('模型浏览从当前 Provider 开始，支持返回、跨 Provider 搜索、键盘选择和关闭', async () => {
  const f = await selector();
  const trigger = () => f.view().find(node => node.props.accessibilityLabel === '模型：pi/vendor/alpha')!;
  trigger().props.onPress();
  assert.equal(f.state[1], true);
  assert.equal(f.state[2], 'pi');
  // A measured trigger is supplied by measureInWindow in the real component.
  f.state[0] = { x: 100, y: 650, width: 100, height: 28 };
  const rows = () => f.view().filter(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Alpha，'));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].props.accessibilityState.selected, true);
  assert.ok(JSON.stringify(f.view()).includes('vendor/alpha'), '保留模型 ID 中的斜线');
  assert.ok(f.view().some(node => node.type === 'NativeModal' && node.props.transparent));
  assert.ok(!f.view().some(node => node.type === 'Modal'));
  f.view().find(node => node.props.label === '全部 Provider')!.props.onPress();
  const provider = f.view().find(node => node.type === 'Pressable' && node.props.accessibilityLabel === 'Codex')!;
  provider.props.onPress();
  assert.equal(f.state[2], 'codex');
  f.view().find(node => node.props.label === '全部 Provider')!.props.onPress();
  f.view().find(node => node.type === 'TextInput')!.props.onChangeText('beta');
  let prevented = 0;
  const key = (value: string) => f.view().find(node => node.type === 'TextInput')!.props.onKeyPress({ nativeEvent: { key: value }, preventDefault: () => prevented++ });
  key('ArrowDown'); key('Enter');
  assert.deepEqual(f.selected, ['codex/beta']);
  assert.equal(f.state[1], false);
  assert.equal(prevented, 2);
  trigger().props.onPress();
  f.state[0] = { x: 100, y: 650, width: 100, height: 28 };
  key('Escape');
  assert.equal(f.state[1], false);
  trigger().props.onPress();
  f.view().find(node => node.type === 'NativeModal')!.props.onRequestClose();
  assert.equal(f.state[1], false);
});

test('窄屏使用宿主 Modal，搜索空态、Provider 错误及禁用选择保持可见', async () => {
  const f = await selector(true);
  f.view().find(node => node.props.accessibilityLabel === '模型：pi/vendor/alpha')!.props.onPress();
  assert.ok(f.view().some(node => node.type === 'Modal'));
  f.view().find(node => node.type === 'TextInput')!.props.onChangeText('not-found');
  assert.ok(JSON.stringify(f.view()).includes('没有匹配的模型'));
  f.props.catalog.entries[0].error = 'provider failed';
  assert.ok(f.view().some(node => node.type === 'Notice' && node.props.error === 'provider failed'));
  f.props.disabled = true;
  f.state[3] = '';
  f.view().find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Alpha，'))!.props.onPress();
  assert.deepEqual(f.selected, []);
});
