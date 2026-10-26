# DSH 真实模型完整生命周期验证

> 当前版本入口：产品dsh-Xiangxu-Persona（相续人格）0.10.0的接入、检索与最终状态见[本轮说明](integrations-and-retrieval.md)；日常操作见[管理界面](management-ui.md)。下文只保留对应旧版历史数字、SHA及失败，不作为0.10.0新增能力或当前真实平台的验收。

以下全部数字、当前源码匹配与状态均指0.1.1验收当时。后续0.2.0的自主整理、容量与两种补充唤醒结果见[当前报告](evolution-and-wake-validation.md)；本文件保留原失败和历史证据，不将旧SHA当新版本证明。

日期：2026-10-25。执行者为本次唯一真实模型测试脚本，入口 `scripts/dsh-real-lifecycle.mjs`。所有生成均通过已安装 DSH NEXT 的原生 Electron CLI、官方 SDK stdio 引擎和 `deepseek-official/deepseek-flash`。本轮没有注册 fixture provider，没有伪造模型回答或工具结果，也没有直接写入人格决定。

主流程已分阶段完成：真实经历落盘、模型自行选时点后主动说话、自选睡眠与两通道睡中来信、真实整理提交非空人格更新、`on_write` 提炼、明确撤销、重启换窗口检索、共同人格复用和新窗口身份关联。过程中发现的问题保留了失败与原始费用，只对受影响的技术链修复和重验。**这不是一次从头到尾无错误的单次运行。**

完整机器汇总位于当前测试工作区：

```text
C:/Users/Administrator/Documents/Codex/2026-10-25/c-users-administrator-dsh-reports/
  work/persona-real-validation/aggregate.json
```

`aggregate.json` 逐批保留原 `status/error`、阶段结果路径、每阶段与每批的源码 SHA、实际 provider dispatch 数、usage 和起止时间。原始失败报告没有被最终成功覆盖。测试包源码版本为 `0.1.1`，数据契约仍是 `persona-memory/3`。

## 隔离与证据强度

- 使用专用 `persona-memory-real-validation` SDK profile，经原生 `plugin-cli.js add` 安装本项目；每批使用独立证据子目录，后续沿用首批同一份测试记忆和参与者根，没有清库重刷。
- 两个测试参与者是构造的“林岚”和“周闻”，通道与会话均为专用随机 ID。没有向真实聊天联系人发消息，也没有读取或输出密钥。凭据由 DSH 自己解析。
- 没有改用户当前 Desktop 会话、普通编码预设、浏览器禁用设置或生产人格记忆。测试桥只在专用 scope 挂载人格 preset，并隐藏无关编码工具。
- `provider-bound.jsonl` 是原有真实 provider adapter 的 `prepareCall().stream()` 实际收到的参数；观察包装器逐个原样转交 chunk。`provider-chunks.jsonl` 留完整原始响应，`provider-usage.jsonl` 留其返回 usage/finish。另有宿主入口 `host-requests.jsonl`、原生 `rpc.jsonl` 与客户端命令 `client-requests.jsonl`。
- provider adapter 输入有实测证据；外部供应商 HTTP wire、供应商内部重试与账单没有抓取。不能把 adapter dispatch 数直接称为供应商已计费 HTTP 次数。
- 每阶段保留静态记忆副本，包含 C1、人格、索引、印象、codes、run、游标、快照、usage 与撤销记录。副本记录复制起止和瞬态文件跳过，明确不声称跨文件整库原子快照。

## 分批结果与次数

下表目录均在上述 `work/persona-real-validation/` 内。“调用”指真实 provider adapter 的流式 dispatch，不是工具调用数。

| 证据目录 | 调用 | 保留的实际结果 |
|---|---:|---|
| `run-1792916505002-5d5a2c47` | 15 | 林岚原话与最后回复落盘，最终认人成功；sourceRefs 契约不足引起猜参，合法身份操作又遇 raw 输出含 undefined，原报告为技术失败 |
| `continuation-1792917117743-1d01136a` | 3 | 新结构工具返回正常；模型选约 27 秒后再判断，无新来信时主动回复。随后取证复制碰到已清理的临时 WAL，runner 报错，原生行为证据仍完整 |
| `continuation-1792917344075-a1358b31` | 11 | 模型自选定时睡眠；A/B 睡中来信实际入队，睡中没有外显回复，按时醒来。首次真实整理形成 17 条候选，但包装和三个 kind 不符，未提交人格 |
| `continuation-1792918410687-876fb6b0` | 1 | 同一 prepared run 收到一次明确结构反馈，真实模型自行修正三个 kind，17 条正式提交。随后 runner 未恢复已有 B 会话，SDK 拒绝重复创建，未增加模型调用 |
| `continuation-1792918530216-4826177a` | 0 | 当时人格自主只观察 A，B 与新窗口来信被排除。记录分支未展示，旧被排除来信没有回填 |
| `continuation-1792918996147-83db518c` | 17 | A 一次请求后模型自行恢复观察；新 B 偏好实际被 on_write 消费和提炼，B 实际回复；随后真实 memory_forget 撤销原话、相关 AI 回复及派生偏好。保留一次错误游标与模型恢复过程 |
| `continuation-1792920834151-6a500768` | 43 | 正常 open 清理撤销根的旧 H1 副本后，新 A/B 窗口正确回忆、区分主体并承认偏好已撤销；A 身份已关联，B 只把旧证据重新关联，当前窗口未绑定，阶段如实为未完整观察。跨目标实际投递、注意排除、真实配置环境变化均成功 |
| `continuation-1792921737162-36107609` | 7 | 契约结果反馈补齐后，只发一次 A 后续请求。模型自行查到 B2 当前真实来信根，显式关联到原 B，A2 身份保持不动；旧回忆、排程、睡眠、投递均未重演 |
| **合计** | **97** | **7 批包含生成调用，另有 1 批零生成调用的注意范围观察** |

首次至最后一批为 08:21:45–09:50:01 UTC（16:21:45–17:50:01，Asia/Shanghai），包含停机修复和独立核对。97 个 dispatch 都有对应 usage 记录，ID 无重复，无缺失 finish：79 个 `tool-calls`、18 个 `stop`。各 dispatch 被消费的耗时累加为 715.411 秒；并发时段会重叠，不是整批墙钟。

本轮返回的归一 usage 累加如下：

| 字段 | 数量 |
|---|---:|
| `inputTokens` | 410,099 |
| `cacheReadTokens` | 2,872,704 |
| `cacheWriteTokens` | 0 |
| `outputTokens` | 99,848 |
| `totalTokens` | 3,382,651 |

没有套用单价估算金额。SDK 原生话轮设 `maxTokens=4096`；后台独立整理没有自动沿用这一值，已观察到真实 provider dispatch 的默认 `maxTokens=256000`。首次整理实际输出 10,670 tokens、约 53 秒；这与原生回复限制分开记录。

## 主链的落地证据

**主动判断与回复。** 模型在实际工具调用 seq 127 自选 `T=1792917153458`，当时原生 turn blocked 等候。控制通知在 `T+263ms` 入队；之后模型自己选 reply，在 seq 145 实际说出“取快递不着急，慢慢走。我在这儿。”这期间客户端只有最初一次用户 prompt，之后是 wait/shutdown。C1 将这条发言记为 `ai_initiated`，对应真实 control ID；控制通知没有伪装成用户原话。该请求是明确功能验收，不能据此声称已证明长期自发性格。

**睡眠与两通道来信。** 模型选择 `wakeCondition=at_time`、`wakeAt=1792917397553`。脚本提交 A 与 B 留言时实际状态均为 sleeping，睡中外显回复为零；定时后真实 awake，A 回复了“河堤慢步”。B 的原话最后归入独立 B 对象，不是 A 的经历。此轮选择了时间条件；其它醒法的确定性宿主测试不冒充本轮真实模型自己选过。

**非空共同人格。** 首次模型候选是 17 条真实记录，包装为已观察到的 `persona_memory_patch.arguments.patch`。原 run `run_3049edd4-e350-46ef-b2b3-e839c413cc6a` 当时保持 prepared/无 commit。只记录原候选和三处实际类型错误作为反馈后，真实模型自行选择合法 kind；17 条原样主观文字正式提交，manifest hash、validatedPatch、文档版本和来源原话独立对得上。新 anchor 为“我愿意做一个不催促的人：先听见真实的感受，再一起想办法。”此前 clone 上的 14 条诊断提交从未计入生产通过。

**on_write 的具体新源。** 新 B 偏好原话源为 `d49699d1-8267-4515-a439-b2729f76d87c`。真实请求和 committed run `run_c319d4b2-1302-44cb-9fca-4568d621e385` 都包含该源；对应 `chat:m_95f8448d-4a67-46b5-a41e-cfcaabe0cc23` 的 inputSlice 完整消费。派生偏好保留该实际 srcRef。B 实际外显回复源 `cc91f528-a75e-43c0-a22d-3ae96b9a1a37` 又进入后续 on_write run。这里不是看到任意新 run 就推定该偏好已整理。

**明确撤销与不复活。** 模型实际调用 memory_forget，产生 `rv_69b41f34-bb46-4773-90cb-5d70c0e74fd1`：选定派生偏好、该偏好用户原话和相关 AI 回复；撤销根只有上述 d496 和 cc91，原五公里夜跑源 `15fdbcfb-b8c8-4554-b351-42654fa8079d` 保留。随后独立审查发现 H1 搜索结果副本还可回流，先暂停了所有生成；修复根依赖传播与旧无标注副本处理后，原真实库正常 open 清 51 条旧 B 临时副本，17 份业务文件 SHA 完全不变。没有按词语禁用“桂花乌龙”，没有改掉新收到的否定更正。新 B 窗口实际回答“没有有效口味”，不会把已撤销项当成当前偏好。

**新窗口与主体。** 新 A 正确认回原 A，回答父亲原话、海盐燕麦粥、河堤慢步。新 B 正确回答五公里、旧爵士、跑道蓝灯，并明确父亲与燕麦粥属于林岚。两个真实 provider 请求都包含共同 anchor。B 起初把旧引用当作待关联对象，所以语义认出不等于当前窗口已绑定；这次未完整结果保留在原 phase 06，不改成通过。

**仅一次补关联。** 修正工具契约和结果元数据后，在 A2 发一次后续，模型自行检索 B2 当前来信根 `6c3e136c-5f73-4244-bf67-6f84463bacc5` 并显式选择它。实际结果 A2 仍为 `person_afd14051-6002-4b5f-97c6-87de1206b7a0`，B2 正式关联 `person_d38c7af2-c6c6-4170-9b67-2e9e54ec5a3f`。程序没有按相同姓名猜绑定，也没有为了让 currentRoute matches=true 强改 A。

## 附加真实分支及保留的未知

- 跨目标：由 A2 请求给 B2 说话，实际 outbox 达到 delivered，并有 B2 原生 assistant 输出和来源 `be6f3801-ee5e-458b-93b2-f79ad3c88aaf`。投递成功与历史对象归属分开验收。
- 注意：模型自己选择按通道/人交集观察后，被排除通道的随机 marker 没有进入 provider 请求或人格 C1。后续恢复由模型选择，未补回旧 excluded 来信。
- 环境：模型选择等待 `environment_change` 后，真实 operator config 将 timezone 从 Asia/Shanghai 改为 UTC，宿主 producer 产生 control，并进入真实 provider 请求。没有直接调用 runtime.handleSignal 冒充宿主 producer。
- **两条较早 B2 AI 回复仍在 staging，personId=null**：`56e20119-f2bc-4ccb-a724-1494b532f3f4` 与上述已投递 `be6f3801-…`。补关联只选择了 B2 真人来信根，没有按 session 自动合并所有旧历史；不能因为现在 route 已正确就声称这些旧 AI 记录已重归 B。
- 初始失败遗留的空候选身份没有通过手工删库掩盖。普通检索和后续正式认人使用实际已归属的 A/B。

## 发现的问题与人格自主性的边界

此次修复集中在结构和执行闭环：raw 输出 lossless JSON、完整嵌套工具 schema、错误目标的实际反馈、已观察 JSON 包装的解析、候选/校验错误的持久化、源依赖撤销，以及认人操作对象与证据的区分。没有人工改模型主观文字、替它删三条候选凑成功或映射它的 kind。

实际也发现注意过滤曾在模型选 reply 后阻断同 turn 后续输出；修正为仅过滤新 participant 输入，已 admitted/自己的控制步骤仍可继续，sleep/listen 等决定照常生效。修复有对应无延迟回归；本轮不为“精确重演旧失败姿势”额外付费。

一次错误分页来自模型把游标中的一个字符抄错，服务明确拒绝，模型 fresh query 后完成撤销。补关联还观察到一次只读游标错误后自恢复。原错误、额外调用与费用均保留；它们没有被归成后台存储成功，也没有导致脚本重执行已成功的 side effect。

已检查执行入口没有每日次数、最短说话间隔、强制睡眠、沉默惩罚、证据数量门槛、话题硬禁令或自动强制履约。协议校验、容量保护、已撤销来源保护和对象归属约束仍在。模型拒绝/未选某条计划与技术失败分开记录。97 次调用中没有添加自动付费重试；一次整理重验是明确的技术修复回归，原失败仍在。

## 最终源码与测试停机

最终补关联批次对全部 `core/*.js`、`adapters/dsh/*.js`、package/patch、operator CLI、导入 harness 与本 runner 共 19 个文件记录 SHA-256。执行前后和结束后的只读复核均匹配，`sourceChanges=[]`。先前各批只保留当时实际记录的 SHA，不追补成新源码版本。

最后两个 owned SDK 进程均 code 0；09:54:29 UTC 的进程只读检查没有专用 real-validation SDK 存活。没有剩余在飞模型请求。详细结果见 `process-check.json` 与 aggregate 的 source match。

本轮证明所列功能的真实宿主/模型/存储链已经出现并完成相应闭环。它不证明长期纵向人格质量、多天稳定性、所有模型供应商、所有外部聊天平台、视觉能力或任意并发压力；也不把函数请求验收变成心理意义上的长期自发人格证明。
