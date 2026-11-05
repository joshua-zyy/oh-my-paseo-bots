本项目的聊天订阅、历史合并、问题回复、技能 frontmatter 读取、MCP 配置来源发现和常见 Cron 描述适配自 [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots) 的 `client/useChat.ts`、`client/chat/stream/model.ts`、问题表单、`shared/skills.ts`、`server/mcp-sources.ts` 和 `shared/routines.ts`。修改包含 Paseo 0.14 的后台列表观察、订阅恢复、页面布局及原生权限接入。以下许可适用于这些复用部分。

## Paseo 原生控件适配

`client/ui.tsx` 的按钮和选择行，以及 `client/chat.tsx` 的输入框布局，按 [Paseo v0.14.0](https://github.com/getpaseo/paseo/tree/v0.14.0) 的 `components/ui/control-geometry.ts`、`composer/agent-controls/control.tsx` 和 `composer/input/input.tsx` 适配。修改使用插件公开的 React Native、主题颜色和图标接口，保留本项目会话逻辑；不包含宿主私有模块或完整 Composer。

这些上游适配部分遵循 Apache License 2.0，许可证原文见 [licenses/Paseo-Apache-2.0.txt](licenses/Paseo-Apache-2.0.txt)。其余项目原创部分的 MIT 许可不改变。

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
