# oh-my-paseo-bots

基于 [Paseo](https://github.com/getpaseo/paseo) `0.16.2` 的轻量主总管工作台。侧栏「总管」直接进入唯一 Chief 持续聊天；耗时事项可交给原生临时专家或后台专长子 Bot 预设。

当前是瘦身后的最小骨架，不是完整多任务产品。Paseo 仍是模型、执行、原生历史、父子通信、后台工作区与权限的唯一底座。插件只保留身份／预设、JSON 记忆和必要的原生会话／事项关联，不提供自建调度器或审批流。

## 当前能力

- **单一主入口**：顶栏仅保留新对话、配置、记忆。专长预设不是可日常切换的独立私聊。
- **持续对话**：开新对话不关闭旧对话或重新派发旧事项。消息框沿用原生模型、工作目录与思考等级；配置切换保留历史关联及草稿。
- **原生协作**：保留已有专长预设创建／调整、子事项委派和摘要／证据回报；执行详情仍在工作台内查看。开始回执、轮次结束、实际交付是不同事实。
- **JSON 记忆**：明确记忆与候选分开，可查看来源、纠正、遗忘／拒绝及恢复。候选与归档内容不注入；主聊天发送前取得当前确认记忆，而非固化过期创建快照。
- **后台工作区**：插件创建的工作区与 Agent 使用 `background: true`；模型和权限仍由 Paseo／Provider 决定，不自动放行原生请求。

项目频道、共享记忆发布、办公连接与外发、插件内例程、能力审批及旧工作日志已移除。任务状态条、结构化交接中枢、任务定向改令、Markdown 记忆和旧数据导入工具尚未提供。Paseo 自身的原生工具不因此被禁用。

## 数据隔离

业务写入只使用 `<baseDir>/v2/`：

```text
v2/
  chief.json                 # schemaVersion: 2 的主总管
  specialists/<id>.json      # schemaVersion: 2 的专长预设
  mcp/endpoint.json          # 本机工具端点；含凭证，不入 Git
  tasks/<botId>.json         # 保留的原生事项关联索引，schemaVersion: 2
  workspace/<botId>/         # 默认工作目录；显式选择的项目目录仍可使用
```

`baseDir` 优先取 `OH_MY_PASEO_BOTS_DATA_DIR`，兼容 `PASEO_GUYS_DATA_DIR`；默认使用 `~/.oh-my-paseo-bots`。已有 `~/.paseo-guys` 时继续作为基目录，但仅使用其中的 `v2/`。

根层旧 JSON 和旧子目录保持原样，**不自动导入、迁移、删除或回写**。旧 Bot 标签不构成纳管证明；生命周期只使用有效 v2 登记及现有 v2 原生关联。相同参数重复关联会话不更新时间、不写盘。

不要把含端点密钥、原生凭据或办公原文的数据目录提交到仓库。插件本身是可信本机代码，后台目录和工具绑定不是安全沙箱。

## 安装与配置

需要 Paseo `0.16.2`、已有且可用的模型／Provider 配置，以及 Node.js 22 与 npm（本地构建）。插件不代登录、不新增账户权限或配置外部付费服务。

```bash
npm ci
npm run build
paseo plugin install /absolute/path/to/oh-my-paseo-bots
paseo plugin ls
```

源码更新后重载本插件，不必重启 daemon：

```bash
paseo plugin reload oh-my-paseo-bots
paseo plugin logs oh-my-paseo-bots
```

打开侧栏「总管」。未配置默认模型时先进入「配置 → 默认设置」；主总管身份与执行覆盖在「配置 → 主总管」中编辑。配置只影响新对话，不自动重载正在运行的会话。停止回复复用当前 daemon 的原生 CLI，需要可用的 CLI 命令与正确 home。

交办时说明目标、范围、交付物和完成条件。只有真实交付及可核查证据才代表事项完成；超时与未知回执不等于未执行，不能盲目重发。外发、破坏性操作、付款及新增权限仍需明确授权。

## 验证与开发

```bash
npm ci
npm run typecheck
npm run build
npm test
```

离线测试使用临时目录、合成数据和本机回环端口，不连接真实账户或调用模型；覆盖 v2 隔离、旧会话钩子、旧文件哈希保护及会话关联无写幂等。实机验证记录独立保存，不能由离线通过外推。手机端与复杂真实任务尚不作为本骨架的已验证承诺。

工程与阶段证据见维护者本地 `docs/internal/`，不随仓库分发。

## 许可与致谢

[MIT](LICENSE) 许可；复用部分的版权和许可告知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。设计参考 DS-Bot、OpenMausBot；插件接入与部分客户端能力参考 [paseo-bots](https://github.com/oliexe/paseo-bots)。
