本项目的聊天订阅、历史合并、问题回复、技能 frontmatter 读取、MCP 配置来源发现和常见 Cron 描述适配自 [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots) 的 `client/useChat.ts`、`client/chat/stream/model.ts`、问题表单、`shared/skills.ts`、`server/mcp-sources.ts` 和 `shared/routines.ts`。修改包含 Paseo 0.14 的后台列表观察、订阅恢复、页面布局及原生权限接入。以下许可适用于这些复用部分。

## Paseo 原生控件适配

`client/ui.tsx` 的按钮和选择行，以及 `client/chat.tsx` 的输入框布局，按 [Paseo v0.14.0](https://github.com/getpaseo/paseo/tree/v0.14.0) 的 `components/ui/control-geometry.ts`、`composer/agent-controls/control.tsx` 和 `composer/input/input.tsx` 适配。修改使用插件公开的 React Native、主题颜色和图标接口，保留本项目会话逻辑；不包含宿主私有模块或完整 Composer。

`client/model-selector.tsx` 适配同版本的 `components/combined-model-selector.tsx`、`components/model-browser.tsx` 、`components/ui/combobox.tsx` 和 `composer/agent-controls/index.tsx`：保留 Provider 浏览、搜索、模型名与标识、思考等级选择、选中态和锚定桌面弹层；用公开 SDK 目录、图标和主题，以及 React Native Modal 测量定位替换宿主状态和 Portal，窄屏使用公开 Modal。不包含收藏、Profile 编辑或 Provider 设置入口。`client/provider-icons.ts` 将该版本 `components/icons/{pi,codex,claude}-icon.tsx` 的 SVG 路径转换为公开 Icon 可渲染的 SVG 字符串；其他 Provider 使用目录提供的 SVG，缺失时显示 Bot 图标。

这些上游适配部分遵循 Apache License 2.0，许可证原文见 [licenses/Paseo-Apache-2.0.txt](licenses/Paseo-Apache-2.0.txt)。其余项目原创部分的 MIT 许可不改变。

## t3code 上下文交接适配

`server/conversations.ts` 的有界完整消息选择改编自 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 提交 `337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17` 的 `packages/provider-core/src/server/handoffBudget.ts`。保留最近用户／助手和较早用户消息优先、完整原文、来源与遗漏标记；适配为 Paseo 原生历史读取及空分段的首轮附件，不引入 t3code 的编排层、会话库或 Provider 驱动。许可为 MIT，Copyright (c) 2026 T3 Tools Inc.，全文见 [licenses/t3code-MIT.txt](licenses/t3code-MIT.txt)。

## paseo-bots 许可原文

MIT License

Copyright (c) 2026 Ondrej Rehacek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
