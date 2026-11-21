import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { attentionMutation } from '../client/attention-controller.js';

const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText.replace(/export default |export /g, '');
async function stateSource() { return ts.createSourceFile('attention-state.tsx', await readFile(new URL('../../client/attention-state.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }

test('本客户端RPC包装仅失效已知业务操作：读不刷新、失败不改错误或重派', async () => {
  const source = await stateSource();
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useBotRpc' || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'mutations'));
  const code = transpile(declarations.map(node => node.getText(source)).join('\n') + '\nreturn useBotRpc;');
  let refreshes = 0, attempts = 0, fail = false;
  const failure = new Error('receipt unknown'), calls: unknown[] = [];
  const hook = new Function('useNativeRpc', 'useContext', 'AttentionContext', 'useCallback', 'attentionMutation', code)((contract: any) => async (input: unknown) => { attempts++; calls.push([contract.name, input]); if (fail) throw failure; return 'saved'; }, () => ({ refresh: async () => { refreshes++; } }), {}, (fn: unknown) => fn, attentionMutation);
  await hook({ name: 'bots.sessions' })({ botId: 'chief' }); assert.equal(refreshes, 0);
  assert.equal(await hook({ name: 'bots.update' })({ botId: 'chief', patch: { name: 'new' } }), 'saved'); assert.equal(refreshes, 1);
  fail = true; await assert.rejects(hook({ name: 'bots.task.cancel' })({ botId: 'chief', agentId: 'original' }), e => e === failure); assert.equal(refreshes, 2); assert.equal(attempts, 3);
  assert.deepEqual(calls, [['bots.sessions', { botId: 'chief' }], ['bots.update', { botId: 'chief', patch: { name: 'new' } }], ['bots.task.cancel', { botId: 'chief', agentId: 'original' }]]);
});

test('Toast只在挂载期间接收派生提示，清理注销；消息不复制办公标题/正文', async () => {
  const source = await stateSource();
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['attentionMessage', 'AttentionToast'].includes(node.name?.text ?? '') || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'reasons'));
  const code = transpile(selected.map(node => node.getText(source)).join('\n') + '\nreturn AttentionToast;');
  let listener: ((entries: any[]) => void) | undefined, cleanup: (() => void) | undefined; const shown: unknown[] = [];
  const component = new Function('useAttentionController', 'useToast', 'useEffect', code)(() => ({ present: (next: (entries: any[]) => void) => { listener = next; return () => { listener = undefined; }; } }), () => ({ show: (...args: unknown[]) => shown.push(args) }), (work: () => () => void) => { cleanup = work(); });
  component(); listener!([{ botName: '同事', title: 'PRIVATE-SUBJECT', detail: 'PRIVATE-BODY', kind: 'failure', notice: { reason: 'native_error' } }]);
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE-SUBJECT|PRIVATE-BODY/); assert.match(JSON.stringify(shown), /提醒不等于批准或完成/); assert.equal((shown[0] as any)[1].variant, 'error');
  cleanup!(); assert.equal(listener, undefined); assert.equal(shown.length, 1);
});
