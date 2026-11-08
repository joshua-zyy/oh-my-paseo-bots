import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSkill } from './files.js';

// Workflow guidance adapted from anthropics/skills xlsx at 2c5958ecac7cee2b583967a2c4981d0f4a75c579
// (Apache-2.0) and DS-Bot office-tools at 5c514ad. See THIRD_PARTY_NOTICES.md.
const xlsxSkill = `---
name: paseo-office-xlsx
description: 制作、读取、修改和检查原生可编辑Excel工作簿（.xlsx），包括明细、汇总公式、输入样式、冻结筛选和重算。用户要求表格文件或修改已有Excel时按需读取；不是截图、Markdown或PDF替代品。
---

# 可编辑 Excel 交付

这是插件随版本提供的固定能力，不是运行时自动学习的技能。先按用户要求核对输入、输出文件和数据范围，再使用Paseo/Provider原生文件与命令工具执行，原生审批仍有效。不自行安装全局软件、登录账户、联网取数或新增授权。当前用户要修改技能正文时另复制为自定义技能，不修改这些由插件维护的资源。

## 流程

1. 先确认当前原生环境的Python及openpyxl能导入。缺失时报告所需项目依赖，不假定已装，不擅自全局pip安装。原件保留，除非用户明确要求覆盖，否则先复制/读取后另存新的.xlsx。
2. 已有文件先读取工作表名、表头、输入单元格、公式、样式/合并/表格和图表；沿用既有约定，不重新设计。用openpyxl.load_workbook的普通模式编辑。data_only=True只用于回读缓存，绝不能拿它另存而抹掉公式。
3. 新文件使用真实单元格和Excel原生公式，不把计算结果硬编码代替公式。遵守精确表名/表头；输入与派生值区分，说明假设和来源，货币/比例写成正确数值并设置格式。统一字体、易读列宽、冻结表头、适当筛选；模板说明哪里可编辑。修改只触及用户要求区域并保留其他样式/公式。
4. 有公式必须调用真实表格引擎重算，openpyxl本身不计算。Windows且已有Microsoft Excel时可用本技能目录的scripts/recalculate.ps1：

    powershell -NoProfile -File <本技能目录>/scripts/recalculate.ps1 -Workbook <输出.xlsx绝对路径> -Pdf <可选检查.pdf绝对路径>

该脚本打开并写回传入的工作簿，只对已授权输出副本使用；禁用宏/事件和外部链接更新，不视为新增账户权限。宏、外部链接、受保护/加密文档不是本选定流程的覆盖保证。

Office重算优先使用已有授权的Paseo原生工作区终端，而不是假定Provider子进程具有桌面COM登录会话。可用时直接使用现有Paseo原生终端工具。使用CLI时先核对当前工作区，再用terminal create --workspace <工作区ID> --cwd <合成或输出目录> --json新建专用终端；terminal send-keys <终端ID> <完整重算命令> Enter发送命令，terminal capture <终端ID> --scrollback --json核对引擎输出和实际退出码。先核对终端实际shell（Windows可能是cmd而非PowerShell），按该shell引用路径；命令文本逐条发送，明确使用Enter，不把普通换行当Enter。cmd下需用powershell -NoProfile -File调用.ps1，且用双引号引用路径。发送回执不代表执行完成；最后只用terminal kill关闭本次自建终端，不影响用户已有终端。可先用terminal --help核对当前CLI，不写自建执行服务。也可使用同等的现有Paseo原生终端工具或SDK。只有命令和数据范围已经授权时才可使用，原生审批仍有效；权限拒绝时暂停，不改变Provider sandbox/工具权限/ExecutionPolicy，不新增MCP执行器来绕过。终端也不可用时如实报告“未重算”，不得把设置打开时重算当已验证，不自行安装Office/LibreOffice。
5. 用同目录scripts/check_xlsx.py对最终.xlsx做独立回读：

    python <本技能目录>/scripts/check_xlsx.py <输出.xlsx绝对路径>

返回JSON报告和退出码；错误单元格或没有可核实缓存的公式会失败。还须逐项核对用户要求及至少几个独立计算预期，不能用“无错误码”证明公式语义正确。按用户要求核对修改所影响的结果，不为检查改写无关输入。
6. 对布局/视觉任务或用户要求检查时，导出检查PDF并用可用PDF渲染器实际查看，不以生成PDF回执冒充已看过。缺少渲染条件如实说明；检查PDF/图片不是交付的工作簿。完成必须给出真实.xlsx路径、内容/结构/重算依据、已测/未测范围，不能只交脚本或聊天文本。

## 来源与适配

工作流参考并适配 anthropics/skills 的 xlsx（2c5958e，Apache-2.0）与 DS-Bot office-tools（5c514ad，Apache-2.0）。本版本改为中文、Paseo原生工具与审批、本机已有Excel重算，不假定依赖预装，不迁入其执行底座。适用许可与告知随插件提供于 THIRD_PARTY_NOTICES.md 及 licenses/；原始来源见 https://github.com/anthropics/skills 和 https://github.com/Fei2411/DS-Bot 。
`;

const recalculate = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Workbook,
  [string]$Pdf
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$path = (Resolve-Path -LiteralPath $Workbook).Path
if ([IO.Path]::GetExtension($path) -ne '.xlsx') { throw 'Only .xlsx output copies are supported' }
$excel = $null
$book = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false
  $excel.AskToUpdateLinks = $false
  $excel.AutomationSecurity = 3
  $book = $excel.Workbooks.Open($path, 0, $false)
  $excel.CalculateFullRebuild()
  $book.Save()
  if ($Pdf) { $book.ExportAsFixedFormat(0, [IO.Path]::GetFullPath($Pdf)) }
  [PSCustomObject]@{ workbook=$path; recalculated=$true; engine='Microsoft Excel'; pdf=$Pdf } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $book) { $book.Close($false); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book) }
  if ($null -ne $excel) { $excel.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) }
}
`;

const checkXlsx = String.raw`import json
import sys
import zipfile
from pathlib import Path
from openpyxl import load_workbook


def check_workbook(path):
    path = Path(path).resolve(strict=True)
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError('Invalid ZIP member: ' + bad)
    formulas = load_workbook(path, data_only=False)
    values = load_workbook(path, data_only=True)
    errors, uncached, sheets = [], [], []
    try:
        for sheet in formulas:
            count = 0
            for row in sheet:
                for cell in row:
                    cached = values[sheet.title][cell.coordinate]
                    if cached.data_type == 'e':
                        errors.append({'sheet': sheet.title, 'cell': cell.coordinate, 'error': cached.value})
                    if cell.data_type == 'f':
                        count += 1
                        if cached.value is None:
                            uncached.append({'sheet': sheet.title, 'cell': cell.coordinate})
            sheets.append({'name': sheet.title, 'rows': sheet.max_row, 'columns': sheet.max_column, 'formulas': count})
        return {'workbook': str(path), 'sheets': sheets, 'errors': errors, 'uncachedFormulas': uncached,
                'ok': not errors and not uncached}
    finally:
        formulas.close()
        values.close()


if __name__ == '__main__':
    report = check_workbook(sys.argv[1])
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(0 if report['ok'] else 1)
`;

/** Materialize fixed, plugin-owned resources; not model-authored or automatically assigned skills. */
export async function provisionOfficeSkills(baseDir: string) {
  const directory = join(baseDir, 'builtin-skills', 'paseo-office-xlsx');
  const scripts = join(directory, 'scripts');
  await mkdir(scripts, { recursive: true });
  const path = join(directory, 'SKILL.md');
  await Promise.all([
    writeFile(path, xlsxSkill, 'utf8'),
    writeFile(join(scripts, 'recalculate.ps1'), recalculate, 'utf8'),
    writeFile(join(scripts, 'check_xlsx.py'), checkXlsx, 'utf8'),
  ]);
  return [await readSkill(path)];
}
