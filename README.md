# paseo-guys

供维护 Agent 使用的工程上下文。实施规则和权限以本地 `AGENTS.md` 为准，本文不授予运行权限。

## 目标与概念

单用户本地／自托管的 Paseo 固定 Bot 团队插件。Bot 跨原生会话保留身份和明确记忆；主 Bot（Chief）负责澄清、分工、跟进、产物核对和最终交付。

Paseo 是唯一执行、模型配置、会话、权限、多 Agent 通信和调度底座。插件只补充 Bot 身份、记忆、事项关联和受控办公能力，不另建运行时或聊天工作台。

| 概念 | 含义 |
| --- | --- |
| Bot | 固定身份与职责，关联多个原生会话；不等于某一次 Agent 执行 |
| 原生 Agent | Paseo 管理的执行会话；创建、通信、历史与归档复用宿主 |
| 事项 | 插件关联的目标、状态、专家、跟进和交付证据；轮次结束不等于事项完成 |
| 记忆 | 明确记忆与推断候选分开保存，仅确认内容用于新会话 |
| 跟进 | 绑定事项 Agent 的原生 heartbeat；创建回执不证明已经执行 |
| 独立例程 | 固定 Bot 关联的原生 new-agent schedule；每次执行建立新的事项与产物关联 |

完整范围与 A01–A08 在本地 `docs/internal/PRODUCT.md`，不随 Git 分发；缺失时不能据本文推定或缩减验收范围。

## 代码导航

| 入口 | 职责 |
| --- | --- |
| [index.client.tsx](index.client.tsx)、[client/ui.tsx](client/ui.tsx) | 同事侧栏与窄屏选择器，工作／记忆／例程导航，主题控件 |
| [client/work.tsx](client/work.tsx)、[client/tasks.tsx](client/tasks.tsx)、[client/memories.tsx](client/memories.tsx) | 交办、未决创建回查、事项报告与逐条记忆编辑 |
| [client/bot-config.tsx](client/bot-config.tsx)、[client/host-settings.tsx](client/host-settings.tsx)、[client/office.tsx](client/office.tsx) | 按需打开同事与插件宿主配置、办公连接和受控外发 |
| [client/journal.tsx](client/journal.tsx)、[client/history.tsx](client/history.tsx)、[client/usage.tsx](client/usage.tsx) | 工作日志与原生历史分页、按需读取会话用量 |
| [index.server.ts](index.server.ts)、[shared/](shared/) | 插件初始化、RPC／生命周期接线、共享配置和输入输出契约 |
| [server/sessions.ts](server/sessions.ts)、[server/store.ts](server/store.ts) | 原生创建意图、幂等键、Bot 身份与会话关联持久化 |
| [server/prompt.ts](server/prompt.ts)、[server/memory.ts](server/memory.ts)、[server/history.ts](server/history.ts)、[server/journal.ts](server/journal.ts) | Bot 行为提示、记忆来源核对、原生历史分页与轮次观察日志 |
| [server/mcp.ts](server/mcp.ts) | 插件内回环 HTTP MCP、稳定端点、Bot／Agent 凭证绑定与工具挂载 |
| [server/tasks.ts](server/tasks.ts)、[server/task-tools.ts](server/task-tools.ts)、[server/colleague-tools.ts](server/colleague-tools.ts) | 事项状态、跨会话查询、原生跟进、固定同事配置与委派 |
| [server/routines.ts](server/routines.ts)、[shared/routines.ts](shared/routines.ts)、[client/routines.tsx](client/routines.tsx) | 独立例程创建意图、原生调度控制、运行关联与结果展示 |
| [server/office.ts](server/office.ts)、[server/office-tools.ts](server/office-tools.ts) | 按 Bot／事项绑定办公范围；Gmail、飞书及外发登记接入 |
| [server/mail.ts](server/mail.ts)、[server/gmail.ts](server/gmail.ts)、[server/feishu.ts](server/feishu.ts) | 邮件状态与批准／撤销、gws 适配、lark-mcp 只读适配 |
| [test/](test/)、[scripts/build.mjs](scripts/build.mjs) | 本地单元与离线契约测试、类型编译与双端 bundle 构建 |

## 主流程与关键约束

固定主入口标识为 `chief`，由共享常量 `CHIEF_BOT_ID` 确定，不靠显示名称判定。首次读取同事目录按需登记身份，不启动模型；既有 Chief 的名称、说明、配置和历史关联保持原样，损坏存档只报告、不覆盖重建。

1. **开始事项**：宿主 `bots` 配置提供默认工作目录和模型，Bot 的 `execution` 可覆盖；`startBotSession` 读取该 Bot 的身份、长期说明和确认记忆，先保存创建意图，再挂载 Bot MCP 并调用 Paseo 原生创建，最后关联会话。同请求重试保留原始键，未知结果先回查。
2. **固定同事委派**：`list_colleagues` 查询职责，`delegate_to_colleague` 复用同一创建流程，显式打开接收方目录的原生工作区，再带 `parent` 创建子 Agent。仅传 `cwd` 时宿主可能仍沿用父工作区，不能据创建参数推定目录已生效。接收方使用自己的配置、身份、确认记忆和工具绑定，不自动继承 Chief 的历史或无关记忆。0.14 SDK 的 `parent` 只建立归属，不注册原生 MCP 创建路径的完成回调；`complete_task` 保存报告后、归档前通过原生 `send` 回报仍进行中且已登记委派关系的父事项。例程父会话没有普通 Bot 标签时，交付与失败回报复用已持久化的例程归属查询。消息含子事项标识、摘要与证据，使用子 Agent 来源和稳定 messageId；接收方仍须核对实际产物，回报不自动完成父事项。交互事项仅剩等待交付时，结束当前轮次、保持事项 active，由原生交付消息唤醒，无须周期轮询；异常新证据或用户询问仍可按需查询。独立例程在同轮用原生 CLI 等待，不注入交互事项的结束轮次等待指引。
3. **跨会话查询**：`list_bot_tasks` 默认列本 Bot 的未结事项，`includeFinished` 可查终态，`read_bot_task` 按需取完整记录。`read_bot_history` 只读本 Bot 已关联会话／创建意图的原生 canonical 分页，返回两侧游标与边界；游标失效、缺口或 epoch 变化时拒绝本页，重新从 tail 查询。固定入口的“读取历史”复用同一读取函数，归档工作区也可查回；原生“打开会话”导航仍可能要求取消工作区归档。查询不重新派发工作、不恢复终态，也不新增权限；实际产物仍须核对。
4. **完成与停止**：显式完成须附摘要和交付证据；停止先持久化，再归档关联原生会话与专家、清理已知跟进。原生归档观察同步收尾，但不覆盖已有完成结论。Paseo 单轮停止不等于取消插件事项；自身归档可能中断收尾回复。
5. **办公写入**：邮件先登记完整内容，经单次确认或本事项完全一致的固定动作预授权后执行。创建草稿不等于发送；撤销不收回已准入或已发出的邮件。写后超时保留未知并回查，不换请求键重建或盲重发，不阻塞独立事项。

`remember_explicit` 由服务端回查原生用户消息依据；`correct_memory`／`forget_memory` 还要求引用当前完整用户消息，并在存储锁内比较条目旧内容，陈旧选取拒绝写入。纠正内容须逐字来自当前用户消息；自然语言意图仍由 Bot 判断，来源核对不构成语义隔离。推断只作候选，确认前不注入新会话；MCP 记忆写入要求事项 active。纠正／遗忘不擦除原生历史或备份。工作日志记录实际轮次观察，不自动判定事项完成。固定同事的原生轮次失败还会向有效父事项发送最少失败状态，由父 Bot 查询原生错误及产物后决定恢复或升级；不自动重派、归档或改变双方事项状态，单轮 completed/canceled 不当作事项失败。临时原生专家继续使用宿主原有通知路径。

`client/usage.tsx` 对已关联会话按需借用客户端 SDK 读取 `lastUsage`。仅展示原生最新上报值，缺失字段与真实零值分开；不把快照相加成 Bot 总量、不估算账单，也不查询 Provider 账户额度或新增资源停止规则。

`read_memories` 的可选 `query` 在本 Bot 确认记忆中按空白分隔的全部关键词匹配，忽略大小写，中文短语按原文匹配；先筛选再按最新记录分页，`total`／`nextOffset` 对应匹配结果。无匹配返回空，空查询沿用读取全部确认记忆；不新建主题存储或检索库。

独立例程复用 `schedule create/inspect/pause/resume/run-once`，不另建调度器。创建意图先落盘，未知回执只回查唯一原生名称；首轮与重启恢复按 `paseo.schedule-id/run` 权威标签关联 Bot 和本次事项，再由打开钩子注入本次 HTTP MCP 与 Bot 选择的 MCP。动态 `get_bot_context` 给出当前身份、确认记忆、技能索引、本次目标及 `nativeCli.command/home`，其结果不属于 system 层，也不构成宿主强制的开工屏障。

0.14 原生 schedule 只等待根 Agent 的轮次，不等待全部子事项；结束轮次即可能将本次 run 收尾为 succeeded，`archiveOnFinish=false` 也不延长 run。例程先委派并推进独立工作，再使用已配置 CLI 的 `agent wait <完整子AgentId> --timeout 45s --json` 在同轮等原生事件，显式传已配置 `--home` 并按 shell 引用路径。读取 JSON 状态，不能仅看退出码：timeout 仅结束本次等待，可继续等待未完成同事；idle 不等于实际交付，无报告时查询活动并决定恢复或升级，不能反复等待 idle；error／permission 结合已保存报告与实际产物处理。CLI 等待不新增权限、调度框架或产品停止条件。

例程模型、目录、模式与思考选项在创建时按共用 Bot 配置映射设置，后续由原生 schedule 决定；修改 Bot 执行设置后需新建例程并取消旧例程。身份、记忆、技能与 MCP 在每次打开时读取当前值。默认原生 local 工作区保留 Bot 目录中的产物，其他临时工作区的文件不能据路径直接认定为永久交付。启用上轮参考时只取同一目标、原生成功且已报告完成的有限摘要，仍需核对实际产物。

例程 `complete_task` 保存本次交付报告后正常回复，由原生调度收尾归档；自动归档但没有完成报告的运行记为 `awaiting_review`，不标成用户取消。暂停只停未来触发；取消还停止当前关联执行，即使完成报告已经保存也不漏停或擦除报告。取消后的原生历史可继续读取。手动运行先返回本地派发状态，原生回执与实际结果分开显示；重载中断回执时保留未知，不自动重新触发。

Gmail 创建草稿及发送均可能改写 Message-ID；成功草稿回执经完整内容核对后固定实际标识。发送回执丢失且标识再次变化时，自动回查可能无法定位，仍保留未知并升级人工核对。来源／草稿核对期间撤销不能被迟到结果覆盖，未知创建在撤销后仍不可重建。

## 配置与持久化

配置字段以 [shared/bot.ts](shared/bot.ts)、[shared/capabilities.ts](shared/capabilities.ts)、[shared/contracts.ts](shared/contracts.ts) 和 [shared/office.ts](shared/office.ts) 为准；路径、进程环境与外部连接器均属于 daemon 机器，不属于远程客户端。

| 配置面 | 关键字段与条件 |
| --- | --- |
| 宿主 `bots` | 默认 `cwd`／`provider`／模式与思考选项；跟进需 `paseoCommand` 和当前 daemon 的绝对 `paseoHome`（后者可由 `PASEO_HOME` 提供） |
| Bot 身份与执行 | `instructions` 为长期说明；`execution` 可覆盖 `provider`、绝对 `cwd`、`modeId`、`thinkingOptionId`。旧存档默认空说明与空覆盖；普通开始与固定同事委派使用同一映射 |
| Bot 既有能力 | `capabilities.skills` 为 `{name, description, path}` 的已有 SKILL.md 索引，`path` 使用宿主绝对路径；`capabilities.mcpServers` 沿用宿主 stdio/http/sse 配置，不接管连接器生命周期或原生工具审批 |
| Bot Gmail | `command`、现有登录目录 `configDir`、预期 `account`、固定允许 `query`；适配基线 `gws 0.22.5` |
| Bot 飞书 | `command`／`args`、`appId`、`secretEnv` 或 `secretFile`、`documentIds`／`wikiTokens`；适配基线 `lark-mcp 0.5.1` |
| 业务数据 | 默认 `~/.paseo-guys`，可由 `PASEO_GUYS_DATA_DIR` 指定；单 daemon、单插件实例写入，不复制原生聊天历史 |
| MCP 端点 | 数据目录下 `mcp/endpoint.json` 保存稳定端口与密钥；冲突／损坏先排查或从备份恢复，重建会使旧会话工具配置失效 |

`bots.update` 按字段修改身份和说明，提供 `execution` 时整体替换执行覆盖，空对象恢复宿主默认。修改只影响新会话，不重配已有原生执行；有效配置参与创建请求指纹。同一模型未指定的模式／思考选项继承宿主默认，改选不同模型时使用其原生默认；显式 `null` 清除对应宿主选项。

`capabilities` 独立于 `execution`，由用户配置，提供时整体替换；旧存档读取为空技能与空 MCP，不改写旧文件。技能只在提示中列索引，使用时由原生 Agent 读取原文件，不复制正文、安装技能或修改工作树。MCP 配置交给原生创建，`paseo`／`paseo-guys` 为保留名称，传输环境和认证头不放进技能提示；配置会保存在本地 Bot 数据中，不应写入无关凭据。绑定叠加于宿主能力，不移除全局技能或 MCP，不代表沙箱或新增账户授权。

`create_colleague` 仅服务端绑定的 Chief 可调用，登记固定身份但不自动开工；未指定执行字段沿用创建者配置，不复制记忆、历史或能力绑定。`update_colleague` 允许普通同事改自己、Chief 改团队；执行字段局部合并，而非 RPC 的整体替换。工具仅开放模型、目录与思考选项，不开放能力绑定、`modeId`、账户或工具授权；换模型保留已有显式执行模式，由宿主校验兼容性，仅清除未重选的思考选项。两类写工具都要求当前事项仍在进行。

连接器由外部安装与登录，插件不创建 OAuth 服务。飞书使用与既有只读登录一致的 `offline_access docx:document:readonly` scope 选择续期路径，不开放默认写工具；`secretFile` 为单行密钥文件绝对路径，每次现读，指定后失败不回退环境变量。平台 keyring 行为不保证一致。

Gmail MIME 使用 Nodemailer 生成、MailParser 核对，经 gws 媒体上传而非 SMTP。临时 `.eml` 在 gws 配置目录生成并尝试清理，进程强杀可能残留。配置保存不等于连接、OAuth 权限或续期验证成功。

## 开发与验证入口

使用 npm 与 [package-lock.json](package-lock.json)，脚本定义见 [package.json](package.json)。

~~~bash
npm ci
npm run typecheck
npm test
~~~

`npm run typecheck` 检查当前依赖契约；`npm run build` 清理 `dist/` 后运行 TypeScript 编译与双端 esbuild；`npm test` 先构建，再用 Node test runner 执行 `dist/test/*.test.js`。这些命令不安装插件、不调用真实模型或办公账户，`dist/` 不提交。

验证先选受影响的现有测试；共享契约变更和收尾再跑适用的完整层级。本地 bundle 构建不是 Paseo 宿主加载验收。真实验证按 `AGENTS.md` 已确认的权限和数据范围执行，不因有运行命令就自动扩大授权。

插件清单 [paseo-plugin.json](paseo-plugin.json) 声明 `>=0.14.0 <0.15.0`；开发依赖为正式发布的 0.14.0 SDK。该发布包仍使用 `server.before('agent.session_open', ...)`，打开请求提供只读 Agent 标签与可编辑 MCP 配置；不能照抄主线文档的 `addHook` 注册名称。修改接缝前核对目标 daemon、app 和发布 SDK，不把最新文档当作已安装版本事实。

宿主检查入口为 `paseo plugin ls`／`paseo plugin logs paseo-guys`；本地目录安装为 `paseo plugin install /absolute/path/to/paseo-guys`，源码更新使用 `paseo plugin reload paseo-guys`。先核目标 daemon 与全局插件开关，不为加载源码重启 daemon。公共契约参见 [Paseo 插件文档](https://paseo.sh/docs/plugins)。

## 证据边界与已知限制

既有运行证据包含：固定同事合成委派与产物核对、记忆纠正后新会话使用、指定 Gmail／飞书读取与续期、受控单次邮件发送、桌面在线的单页浏览器、heartbeat 触发与停止及同一 daemon 重启关联。历史验证不替代修改后的回归，也不证明所有任务均能自主正确完成；模型曾出现工具错误和人工纠正。

| 边界 | 不可推定的能力 |
| --- | --- |
| 后台跟进 | 需同一 daemon 与依赖在线；Windows 桌面默认退出可能停止托管 daemon；不保证重放被中断轮次或覆盖休眠、断电 |
| 原生浏览器 | 依赖连接中的桌面 app 和已启用工具；无桌面网页与任意网站未验证 |
| 办公范围 | wiki 读取有实现未实测；不覆盖完整 Google Workspace／飞书接口或全部平台 keyring 行为 |
| 故障与资源 | 写后超时、回执丢失由离线契约测试覆盖；未做真实账户故障注入或原生计费告警实测 |
| 安全隔离 | Paseo 插件可信且无沙箱；Bot 工具绑定、最少上下文、目录和工作树不等于强安全隔离 |

## 资料来源

`AGENTS.md` 保存本项目实施规则；`docs/internal/` 保存产品约定、迁移依据、运行证据与历史交接，均按现有规则本地忽略。README 只保留工程上下文，不记录临时任务进度、账户正文、凭据或逐次验收流水账。

[DS-Bot](https://github.com/Fei2411/DS-Bot)、[OpenMausBot](https://github.com/milind-soni/OpenMausBot) 提供产品设计与功能参考；[paseo-bots](https://github.com/oliexe/paseo-bots) 提供插件接入参考，不默认整仓继承。目前未复制这些项目的实现源码，后续复用保留适用版权与许可证告知；SDK 按其发布包许可证使用。
