import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { provisionOfficeSkills } from '../server/office-skills.js';
import { CapabilityGuidance } from '../server/capability-guidance.js';
import { BotStore } from '../server/store.js';
import { botSessionConfig } from '../server/sessions.js';

test('固定内置Excel能力按需发现/分配，不自动授给所有Bot或执行Office', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-office-skills-'));
  try {
    const home = join(dir, 'empty-home'); await mkdir(home);
    const store = new BotStore({ baseDir: dir }); await store.ensureChief(); await store.createBot({ id: 'helper', name: '表格同事', role: '核对数字' });
    const skills = await provisionOfficeSkills(dir);
    assert.equal(skills.length, 1); assert.equal(skills[0].name, 'paseo-office-xlsx');
    const folder = dirname(skills[0].path);
    const body = await readFile(skills[0].path, 'utf8');
    assert.match(body, /openpyxl|recalculate/);
    assert.match(body, /Paseo原生工作区终端/);
    assert.match(body, /原生审批仍有效；权限拒绝时暂停/);
    assert.match(body, /不为检查改写无关输入/);
    assert.match(await readFile(join(folder, 'scripts', 'recalculate.ps1'), 'utf8'), /CalculateFullRebuild/);
    assert.match(await readFile(join(folder, 'scripts', 'check_xlsx.py'), 'utf8'), /data_only=True/);
    const service = new CapabilityGuidance(store, { home, platform: 'win32' }, undefined, async () => skills);
    assert((await service.catalog('helper')).skills.some(skill => skill.path === skills[0].path));
    assert.deepEqual((await store.getBot('helper'))!.bot.capabilities.skills, []);
    const applied = await service.configure('helper', 'chief-synthetic', { requestId: 'xlsx', summary: '用户交办表格制作与核对', skills: [skills[0].path], mcpImports: [] });
    assert.equal(applied.state, 'applied');
    const config = await botSessionConfig(store, 'helper', { cwd: dir, config: { provider: 'synthetic/model' } });
    assert.match(config.systemPrompt, /paseo-office-xlsx/); assert(config.systemPrompt.includes(JSON.stringify(skills[0].path)));
    assert.doesNotMatch(config.systemPrompt, /CalculateFullRebuild|import openpyxl/, '仅索引进提示，正文/脚本仍按需读取');
    assert.deepEqual((await store.getBot('chief'))!.bot.capabilities.skills, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Excel检查器拒绝未缓存公式/错误单元格，不把普通输入表当未计算公式', async context => {
  if (spawnSync('python', ['-c', 'import openpyxl'], { encoding: 'utf8' }).status !== 0) { context.skip('需要已有Python/openpyxl；不会自动安装'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'paseo-office-check-'));
  try {
    const [skill] = await provisionOfficeSkills(dir);
    const script = join(dirname(skill.path), 'scripts', 'check_xlsx.py');
    const fixtures = spawnSync('python', ['-c', `from openpyxl import Workbook
from pathlib import Path
import sys
p=Path(sys.argv[1])
for name,value in [('input',42),('formula','=1+1'),('error','#DIV/0!')]:
 w=Workbook(); w.active['A1']=value; w.save(p/(name+'.xlsx')); w.close()`, dir], { encoding: 'utf8' });
    assert.equal(fixtures.status, 0, fixtures.stderr);
    for (const [name, status] of [['input', 0], ['formula', 1], ['error', 1]] as const) {
      const output = spawnSync('python', [script, join(dir, `${name}.xlsx`)], { encoding: 'utf8' });
      assert.equal(output.status, status, output.stderr);
      const report = JSON.parse(output.stdout);
      assert.equal(report.ok, status === 0);
      if (name === 'formula') assert.deepEqual(report.uncachedFormulas, [{ sheet: 'Sheet', cell: 'A1' }]);
      if (name === 'error') assert.deepEqual(report.errors, [{ sheet: 'Sheet', cell: 'A1', error: '#DIV/0!' }]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
