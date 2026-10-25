# DSH 原生接入测试记录

> 当前版本入口：产品现名dsh-Xiangxu-Persona（相续人格），0.3.0图形设置、实例与管理说明见[管理界面](management-ui.md)。下文保留对应旧版历史数字、SHA及失败，不作为本版浏览器验收。

## 0.2.0历史结果入口

当前结果见[自主整理、容量与补充唤醒验证](evolution-and-wake-validation.md)。本文件下文保留 **0.1.0 首次交付历史**，通过数及 fixture 范围不覆盖新结果。0.1.1 的真实全流程、97次 provider 派发、最终155/155本地回归、实际修复及未覆盖项统一见[真实模型复核](real-model-validation.md)与[宿主证据](real-model-host-evidence.md)。

## 首次交付记录

日期：2026-10-25。执行入口为 `scripts/dsh-integration.mjs`。测试使用已安装的 DSH NEXT Electron CLI 和官方 SDK stdio 引擎，不把 core mock 或自写宿主当作 DSH。

## 测试范围与隔离

- 原生执行路径：`DSH NEXT.exe` + `resources/app.asar/lib/desktop-cli.js`，子进程采用 `ELECTRON_RUN_AS_NODE=1`、Windows 隐藏窗口。
- 仅创建/使用专门的 `persona-memory-validation` SDK profile，经已安装的 `lib/plugin-cli.js` 执行原生 `add` 安装本项目。没有手改 profile package/patch，没有改用户 Desktop profile、现有默认 preset 或浏览器禁用设置。
- 所有测试会话使用 `persona_validation_*` 随机 ID。记忆根目录位于当前聊天的 work 证据目录，每次调用有独立 run 子目录；不清空既有人格记忆。
- 专用测试桥在 SDK agent 创建后显式选择 `persona-memory` preset；SDK 本身不自动把 registry.default 应用到新 agent。测试内隐藏无关全局 coding 工具，保留 scope-local 人格工具，避免测试模型在工具缺失时另用 shell 寻找。此限制仅在测试插件内，生产 preset 不加这项限制。
- 模型路由从宿主 `agentDefaultModel.currentSelection()` 取得非敏感字段，可用 `DSH_TEST_PROVIDER` 与 `DSH_TEST_MODEL` 成对覆盖。凭据由 DSH 内部解析，脚本不读取或输出密钥。
- `rpc.jsonl` 记录真实 SDK 事件；`requests.jsonl` 记录 host llm/stream 输入及 fixture-provider 实际收到的 messages。后者是实际宿主到测试 provider 的绑定请求，不是外部供应商 HTTP wire。

## 已完成：真实模型调用

证据：

`C:/Users/Administrator/Documents/Codex/2026-10-25/c-users-administrator-dsh-reports/work/persona-build/integration-v4/`

该目录下本次 run 的 `real-model/result.json`、`rpc.jsonl` 和 `requests.jsonl` 为逐项记录。实际路由为 `deepseek-official/deepseek-flash`，来自宿主当前默认选择。

六项全部通过：原生 SDK initialize；模型实际调用 `persona_decide`；随后调用 `memory_search`；产生包含测试标记的外显最终回复；实际请求包含四个人格工具；实际请求的系统内容包含本插件环境与关系材料。`session/prompt` 的入队回执与后续 assistant/message 分开观察，没有把 append/messageId 当最终回答。

这证明当时版本的真实模型普通话轮与工具接入。随后对 checkpoint/backfill、故障容错等作了适配器修订；最终版本用下面的原生引擎 fixture 回归，未为这些局部修改重复付费请求真实模型。它也不证明长期人格质量或外部 HTTP 请求已抓包。

## 已完成：原生引擎确定性 fixture（v5 基线）

证据：

`C:/Users/Administrator/Documents/Codex/2026-10-25/c-users-administrator-dsh-reports/work/persona-build/integration-v5/run-1792901797272-3070fc6a/deterministic-host-fixture/result.json`

21 项全部通过。provider 是测试 overlay 注册的 `persona-fixture-validation/fixture-v1`；模型输出由测试脚本确定，DSH 的真实 scope、prompt 组装、inbox、loop、工具执行、会话日志、持久化与恢复未被替换。

| 验证面 | 实际结果 |
|---|---|
| 普通话轮 | 人格决定工具、记忆检索工具、外显最终回复均出现 |
| 请求组装 | 测试 provider 实际收到人格文本及工具 schema |
| 自主睡眠执行 | fixture 模型选择五秒定时睡眠，睡中无外显 assistant 文本 |
| 睡中来信 | 两条测试消息持久记录，醒来只产生一次汇总回复 |
| 非空梳理 | 返回并提交 anchor upsert，persona.version 实际增长到 3，非仅空 patch |
| 等待与再判断 | fixture 选择 listen + 自己的 nextCheckAt；后续输入先被 reject；到时重新进入模型 |
| 原文可见性 | 那条被 reject 的原始测试文本实际存在于之后 provider 收到的 messages，不仅有测试标记回复 |
| 操作者入口 | 通过实际 `persona-cli.mjs` 执行 status/mute/resume；运行态变化与回执一致 |
| 进程恢复 | shutdown 后重新启动 SDK，resume 同一会话，C1 未重复增加；恢复后仍能调用人格工具并回复 |

v5 的仅热区后续批次覆盖了 fixture anchor 的来源列表；这不影响“非空 patch 已提交”的观察，但测试脚本随后改为保留既有 srcRefs。不是给生产人格增加证据数量门槛。

## 最终版本回归

最终原生 fixture **26/26 全部通过**，三个由测试脚本创建的 SDK 进程均正常退出（code 0）。时间为 2026-10-25 12:41:09–12:41:49（Asia/Shanghai），本轮约 39.5 秒。最终证据：

`C:/Users/Administrator/Documents/Codex/2026-10-25/c-users-administrator-dsh-reports/work/persona-build/integration-final-4/run-1792903269941-fce9d054/deterministic-host-fixture/result.json`

该目录还包含 `rpc.jsonl`、`requests.jsonl`、`operator.jsonl`、`adapter-state.jsonl`，及 `restart/`、`inactive-resume/` 下对应的事件、请求与客户端命令。`adapter-state.jsonl` 只记录 turn、源事件 ID 和运行态映射，不含模型密钥。最终 26 项包含 v5 的 21 项，以及以下五项：

| 新增检查 | 最终实际结果 |
|---|---|
| 事件条件睡眠 | fixture 人格选择 `wakeCondition=explicit_wake`、`wakeAt=null`，无需墙钟时点即可执行 |
| 显式唤醒 | 实际 operator CLI `wake` 成功，原生会话产生醒来回复，sleep 变为 awake |
| 冷目标定时恢复 | 人格自行安排六秒后复查；关闭进程，重新启动第三个 SDK，插件定时器自动恢复原会话并产生 `PM_INACTIVE_RESUME` |
| 冷恢复请求接入 | 第三个进程的实际 fixture provider 请求包含人格工具与关系材料；`request/header` 保留原 `persona-fixture-validation/fixture-v1` 路由 |
| 已回复输入的消费 | 快速开始下一话轮后，先前已完成回复的原始消息不再次出现在冷恢复控制通知的 pending 源列表 |

第三进程的 `client-requests.jsonl` **只有 `initialize` 与最终 `shutdown`**。没有外部 `session/resume` 或 `session/prompt` 替插件唤起会话；原生事件中先出现控制通知，继而 turn 10 的外显回复（seq 150）。这证明本轮冷恢复由持久调度和插件宿主端口驱动。测试所选五秒睡眠、两秒/六秒复查只是确定性测试模型的选择，没有写入生产人格规则。

进程恢复前后 C1 均为 11 条，源键差集为空，无重复来源；读取基线放在 shutdown 完成之后，以免把宿主 loop idle 与插件异步接收队列的不同栅栏混为一谈。本轮非空梳理实际提交 anchor 更新，观察时 `persona.version=2`，保留一条来源引用；不要求生产人格满足任何来源数量门槛。

`result.json.sourceDigests` 保存本轮启动时 13 个核心/适配器/配置/测试入口文件的 SHA-256。关键实现版本如下，完整列表以 JSON 为准：

| 文件 | SHA-256 |
|---|---|
| `adapters/dsh/index.js` | `b442b2882948de17a0d1414a72700e20411b32bed01190a04ef86701b9b4cc2e` |
| `core/runtime.js` | `5ab0e0ed5371f68ad7ce990e12e7f7bed5b9af133ee60c9a5675f6fa917c7ead` |
| `core/repository.js` | `8f56280faa7171fbc3daec3c16dc96000795cfcc11e5d4c74ed8d1ca2b90573f` |
| `scripts/dsh-integration.mjs` | `4e2d7efc72a8259f32afbe576127141ec60981bcbdc0027bc93e044d39f01841` |

## 测试发现并推动修正的问题

1. SDK default preset 声明不会自动绑定 SDK agent。第一次试跑没有人格工具，已中止并保留 interrupted-run 记录；后续测试在 SDK 创建公告内用公开 preset API 绑定，并明确区分测试桥与生产入口。
2. pre-step reject 前 inbox 已经 claim。若睡中原始 next-turn 条目仍排队，再追加醒来汇总，会依次回复原条目和汇总。原生 trace 曾观察到三次，修正停放已持久接收的原始输入后，v5 只出现一次。
3. 定时复查的控制通知排在被 listen 拒绝的原始 next-turn 后，会再次 blocked 并把通知留住。复查前停放已持久输入、通知带有界原文后，原始文本实际进入后续 provider 请求。
4. Windows 读句柄可令原子 rename 瞬时 EPERM。保留目标文件的有界重试已在 storage 测试覆盖；后续原生回归未再因同类异常失败。不以删除旧目标文件规避它。
5. 冷恢复用 `presets.select` 会被真实宿主以 `agent-preset/locked` 拒绝；已有话轮应使用 `mount(scope,id)`。恢复时还必须传保存的模型路由，空 AgentOptions 会令 `{{model}}` 模板变量缺失。最终回归已实际通过两处修正。
6. 原生 explicit_wake 曾与接收/整理写入竞态，CLI 返回 `VERSION_CONFLICT`。修正为仓库同一队列内按实际改动字段执行原子 patch，保留并发更新的游标/缺口，同字段仍检查冲突；最终脚本没有用重试或延迟掩盖这次失败。
7. 下一话轮的同步 inbox claim 曾过早清理上一话轮的 admitted 映射，令异步 final 处理后仍留下已回复 pending。改为按对应 final/turn-end 的 FIFO 观察清理，并由最终 `completedReplyIsNotPendingAgain` 检查覆盖。

这些是测试过程记录，旧失败没有混入最终通过数量。不同原生 run 的 JSON、SDK 事件和请求证据保持分开。

## 重跑命令

```powershell
node scripts/dsh-integration.mjs --artifacts 'C:\absolute\work\persona-build\integration'
node scripts/dsh-integration.mjs --fixture-only --artifacts 'C:\absolute\work\persona-build\fixture'
```

普通 `node --test` 不会自动启动外部模型或修改测试 profile。SDK 基础握手可用 `--base-only`，它不会把仅初始化成功写成真实模型生成通过。只跑付费模型链路可用 `--real-only`。脚本对已有同名 validation profile 先检查 SDK bundle 与依赖，不替换意外的其他 profile；不要把生产 profile 名替进这个脚本。

## 不能从本测试推出的结论

- fixture 不证明真实模型会长期形成期望的性格，非空 anchor 更新也不是心理学效果验证。
- 真实模型普通话轮通过不等于所有供应商、所有会话通道或视觉适配已通过。
- 没有捕获外部供应商 HTTP wire；provider-bound messages 与宿主组装快照的证据级别已分开。
- 最终 fixture 使用一个专用 session 跨三个真实进程；多会话交错、取消/中断和各外部聊天平台仍需各自的原生压力/接入验证。
- 长期纵向质量、整请求精确 tokenizer/窗口分配和平台特有 UI 展示，需要各自的实际验证。当前测试不得把它们默认为已完成。
