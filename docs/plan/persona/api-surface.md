# DSH 扩展点与 P0 接入验证

当前0.10.0在既有八工具与owner桥补充检索、QQ丰富消息、B站及可选协议服务；当前字段以persona-schema第22节为准，平台支持／许可／送达分别报告。

0.6.0历史布局与继续保留的能力（当前导航已在0.8.0重组）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生九页设置沿用DSH宿主样式，保留QQBot／微信iLink扫码、实际能力许可与形象创作，新增“任务与资料”。主人格通过persona_task自主派发，子任务显式使用xiangxu-task-worker独立工作预设，任务过程、原始资料与完整报告存独立档案，父会话按需读取并自主选择retain片段供原有记忆整理。主预设共八工具，保留继承工具mask；工作预设不自动挂共享人格写入工具，也不把AI委派指令当真人原话。是否委派、记什么及怎样成长仍由人格决定。其它预设不变，既有平台与真实供应商验证边界保留。当前接口和分级证据见[任务与资料](../../delegation-and-task-archives.md)、[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)。

修订日期：2026-10-27。插件格式统一为 `persona-memory/3`，正式业务字段见 [persona-schema.md](persona-schema.md)，执行顺序见 [architecture.md](architecture.md)。

本文保留上一轮从本机安装包、官方 README 和既有插件读取的宿主出处，同时收回把“接口存在”直接写成“端到端行为成立”的结论。本次文档修订没有运行宿主探针，不能据此声称事件完整性、idle agent 自动启动、睡眠静默、请求作用域或最终送达已经实测。

## 1. 取证对象与证据边界

上一轮取证对象为 `@deepseek-ai/*` 0.2.1-rc.2，安装载体：

```text
C:\Users\Administrator\AppData\Local\Programs\DSH NEXT\resources\app.asar
```

对应公开项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。原取证方法为包内 README.zh.md、lib/*.js 与 `C:\Users\Administrator\DSH\_plugins\` 下已有插件调用点。以下“既有源码证据”指前轮已记录的静态内容，“既有插件用例”指前轮看过的具体用法，不代表本次在当前版本重新执行成功。

asar 字节偏移只定位该次安装包；宿主升级后应记录当前版本、包 SHA、成员路径/导出类型及实际探针结果，不能把旧偏移当稳定 API。P0 结果写进 self-check 的一次验证记录，不到每篇复制旧完成率和行数。

## 2. 能力矩阵：存在与可用分开

| 能力 | 既有证据 | 本方案仍需验证 |
|---|---|---|
| 系统提示 section | `ctx.systemPrompt.section`、section order、disposer 有文档与既有调用 | 动态内容能否限制到agent/session/request；最终messages/system prompt怎样观察，不能预设request/context含正文 |
| 会话事件 | `session/event(session,event)` 有包内源码 | 字段、源 ID、最终正文、重放/编辑/fork 语义、观察范围 |
| 结构型 Inbox | nextTurn/nextStep 与 append 等操作有文档和源码 | message 形状、领取时机、idle 启动、取消、目标路由、实际交付 |
| 工具注册 | dsh-tools 有 defineTool/register 示例 | 工具 exec 能否提供当前会话与请求，控制决定怎样接到真实 loop |
| 工具拦截 | guard/pre/post-execute 有说明与既有插件用例 | 本插件只使用必要数据校验/适配，不加人格行为裁判 |
| 生命周期与计时 | effect 清理及 setInterval 有既有插件用法 | 按人格时间与事件条件调度、恢复与取消 |
| 自有持久化 | `$DSH_HOME` 下 JSON/JSONL 是既有范式 | 单写者、幂等、跨文件提交、容量和崩溃恢复由本插件实现 |
| 历史投影与日志 | deriveMessages、sessions 服务有文档 | 稳定源事件和 host-trace 分页原件是否可读，缺源如何报告 |
| 自带 dsh-persona | 已见 prefix/suffix section 的小型实现 | 与共同 C3 anchor 如何合成，不能据此宣称具备演化和记忆 |

这些接口足以支持接入实验与主体实现方向；请求内注入、睡眠控制和主动交付能否满足产品行为，须通过第 5 节贯通探针后确定适配方式。

## 3. 逐项宿主出处

### A. 提示词 section 与请求上下文

既有接口记录：

```js
const dispose = ctx.systemPrompt.section({ name, order, text, complete? })
```

`getSectionOrder('DEPLOYMENT_PERSONA_PREFIX' | 'DEPLOYMENT_PERSONA_SUFFIX' | ...)` 用于取得宿主顺序基准；`suppressRuntimeContext()` 是宿主提供的运行态段控制。已有 `_plugins/dsh-local-stack-sentinel/index.js` 使用 section 与 disposer 添加/移除提示内容。

前轮记录 dsh-system-prompt 会注册全局 persona section，相同作用域同 order 可能冲突。插件需使用独立名称与实际可用 order。更关键的是：上述签名本身没有证明“会话 A 的动态记忆不会被会话 B 覆盖”。不能把一份插件级 lastText/disposer 当当前请求状态。

P0必须查实际作用域和请求组装入口，用交错并发核对最终messages/system prompt。先实测request/context的payload；历史测量中该事件未含完整messages，若当前也只有模型、窗口和更新策略等元数据，应改用宿主实际请求准备入口或受控调试观察最终内容，不能仅凭ID/版本匹配宣称内容正确。若section不能提供所需作用域，选择宿主真正支持的请求内上下文扩展。RequestSnapshot的requestId、sessionId、personId、版本及实际材料均应匹配最终请求；未能观察或证实的部分继续标待核。

前缀缓存也依路由模式而异。前轮读到 `systemPromptUpdate:in-history` 与 `toolUpdate:addition-only`：同一请求序列中提示词变化可追加在历史之后；未声明该模式时可能原位更新首系统节点。前轮模型目录中 deepseek-flash 声明 in-history，deepseek-v4-pro 未声明，当前目录需重新读取。不能把某个模型名永久等同某种缓存行为。工具定义变化同样需要按实际 schema 与缓存用量核算，工具集应稳定注册。

### B. 会话事件与稳定源

前轮宿主会话快照服务源码位置为 asar 字节偏移 7799525，记录到：

```js
ctx.on('session/created', (session) => { /* ... */ }, { global: true })
ctx.on('session/event', (session, event) => { /* ... */ }, { global: true })
ctx.on('session/disposed', (session) => { /* ... */ }, { global: true })
```

记录中的相关事件名包括 user/message、assistant/message、developer/message、system/message、turn/start、turn/end、step/start、step/end、tool/call、tool/result、compaction/*、goal/change、schedule/change、agent/inbox/spliced、request/header、request/context、model/selection。实际版本是否仍同名、字段在哪、时间与 ID 是否稳定，仍需探针确认，不能据名称就写死 text 字段。user/message 在历史测量中也含 runtime-context、agent-instructions、插件状态卡与 agent-message 等自动注入，不等于真人发言。C1 需结合实际 source.kind、来源与内容块，只投影参与者对话和 assistant 外显正文；工具、思考、运行态注入和代理通知可作诊断/临时过程，不算人物说过的话。

`{global:true}` 说明监听可能跨 agent 作用域；它不是“人格必须注意全部会话”的授权。适配层按人格已选择的观察范围与通道事实接收。收到事件不等于需要回答；在范围内已接收消息先持久记录，回复由人格决定。

宿主采用事件溯源与追加日志，是恢复的来源条件，并不自动保证本插件无漏帧。启动边界、订阅前历史、重放、fork、编辑、取消、流式最终事件与失败写入都可能影响投影。P0 需得到稳定 sourceSessionId/sourceEventId 及 lineage；每个根事件一次接收，缺源形成 memory_gap/回补游标。不能以插件自己递增的 m_0001 或 turn 数代替稳定源 ID。

### C. Inbox、loop 与交付

前轮 dsh-agent README 描述 `Agent.inbox` 为结构型 Inbox，含 nextTurn、nextStep，提供 append/prepend/replace/remove/clear/splice。变更提交 agent/inbox/spliced 持久事件，且有 inserted/claimed/discarded 实时通知。前轮见到：

```js
ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => { /* ... */ })
```

这证明存在排队和领取机制。它不证明 append 会主动启动一个 idle/disposed agent，不证明消息已经出现在用户可见 surface，也不证明用户已收到。消息是生成材料还是已生成正文、nextTurn/nextStep 的语义和参数形状，都必须按当前宿主实现验证。

P0 记录“提交→入队→领取→请求→assistant 源事件→通道回执”的对应关系，以稳定 deliveryId 对账。同一对象多个 session/channel 必须先解析目标。关闭会话、已销毁 agent、进程重启、请求中急停、领取后崩溃分别测试。只有 inbox 已接收时状态为 submitted；有实际交付确认才为 delivered；不明为 unknown，不盲目重发。

### D. 生成控制与睡眠

前轮列出的相关钩子有 agent/pre-step、agent/turn-stopping、agent/assistant-stream、agent/status、agent/created、agent/disposed。记录中的 agent/pre-step 可返回 `{kind:'reject'}` 或 `{kind:'enter',messages,startsRequestSeries?}`。这些是待复核的宿主形状；ArchivedSessionGate 的相似用法不足以证明“reject 等于睡觉时静默保留队列”。

必须实测 reject 是否显示错误、重试、消费 inbox 或已经开始一个 turn；enter 的 messages 是追加还是替换、何时持久化；取消生成是否仍产生部分 assistant 事件。根据实际结果实现睡中无输出、醒来一次接收汇总与用户停止主动。若此钩子不合适，用宿主实际提供的排队/暂停入口，不用未核返回值假装语义成立。

persona_decide 是插件计划新增的稳定工具，不是宿主已提供 API。它把人格决定持久化到 DecisionRecord，再由适配层执行 attention/replyPlan/sleepPlan/nextCheckAt/retrievePlan。决定字段见 persona-schema；宿主真实执行接口和返回状态在 P0 确认。人格可选择定时或事件型执行条件：ReplyPlan.recheckOn 支持 new_message/environment_change/explicit_wake；SleepPlan.wakeCondition 支持 at_time/consolidation_complete/explicit_wake。只有 at_time 需要 wakeAt；listen 可只等事件，无需墙钟。程序恢复对应监听，不填固定作息替代它。

### E. 工具注册与结果上下文

前轮 dsh-tools README:30/34/45/141 有 defineTool/register 示例，README:176 说明 schema 变化的缓存影响。原示例形状为：

```js
ctx.tools.register(defineTool({
  name, description, parameters, output,
  async execute(args, exec) { /* ... */ }
}))
```

exec 中能取得哪些 session/request/channel 信息要实测。当前插件注册八个工具：memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task，完整参数以 persona-schema 为准。缺省目标由真实宿主上下文补齐，显式目标可指已知他人；scope 是用途而非管理员 ACL。删除/更正需要目标可解析，歧义不能扩大为批量操作。

前轮 dsh-tools 记录到 guard、tools/pre-execute、tools/execute、tools/post-execute、tools/result；`_plugins/dsh-dispatch-concurrency-gate/index.js:178` 有 guard 用例。工具结果可附来源与可用性信息；这些宿主拦截能力不构成给人格加发送次数、印象门槛、承诺 SLA 或边界硬拦截的理由。

### F. 生命周期与调度

前轮 `_plugins/dsh-local-stack-sentinel/index.js:495` 记录了如下生命周期范式：

```js
ctx.effect(() => {
  const timer = setInterval(sync, intervalMs)
  return () => clearInterval(timer)
})
```

可复用的是“资源随插件释放清理”的范式，本方案不照搬固定轮询频率。调度器按人格已持久化的 nextCheckAt/wakeAt 安排定时任务，同时恢复 recheckOn 及 wakeCondition 的事件监听；整理完成唤醒需对应 run 已提交。热重载、进程重启、机器休眠后重新对账。人格选择定时复查时，时间经过就是到期执行条件，无新消息也不能跳过；选择仅等事件时忠实恢复监听。

已有 `@deepseek-ai/dsh-schedule` 包，前轮只确认 schedule/change、delivery-history 与 README 存在，未细读公开接口。本期可用 effect 管理一次性定时器，仍须验证调度恢复与目标 agent 唤起；如后续使用 schedule 包，先核具体语义，不能把它写成已完成依赖。

### G. 持久化、历史与完整临时过程

`$DSH_HOME`（`process.env.DSH_HOME || join(homedir(),'.dsh')`）下写自有 JSON/JSONL 是既有插件范式。宿主 dsh-session-persistence-jsonl 自己保存会话日志；本插件仍需有限的 C1 投影、人格判断、归属 assignment 和撤销账本，不能仅靠宿主日志恢复对象理解。

前轮记录 `session.deriveMessages()` 和 `ctx.sessions.get(id)/list()/fork()`。deriveMessages 是投影，不应自动等同原始完整过程、稳定源 ID 或原始 reasoning。完整临时上下文可以由实际缓存原件或 host-trace 引用按页取得，缺源/截断必须标清。原始聊天长期不留 reasoning 全文，不代表本轮梳理只能看一行摘要。

agent/assistant-stream 与 tool/result 是否暴露完整原件、不同供应商的 reasoning 字段是否可用、压缩日志如何按源 ID/offset 定位、源文件轮转后是否仍可读，都在 P0 验证。不得从“事件存在”推出“一定拿得到完整思考”，也不得凭摘要恢复不存在的内部过程。

前轮 SessionHeader 取证在 asar 偏移 17351398，字段为 `{version,id,createdAt,cwd,parentSession,isSeeded,origin,delegationDepth,agentPreset}`，没有 user/owner。环境、对象判断和路由需要插件自管；不能将 sessionId 当身份，也不能把头像相同当认证。

### H. 自带 dsh-persona 的职责

前轮看到 dsh-persona/lib/index.js 主要注册 PERSONA_PREFIX_SECTION、PERSONA_SUFFIX_SECTION，读取 config.prefix/config.suffix，并提供 suppressRuntimeContext；这不包含本方案的长期记忆、演化与主动交付。

新插件可以与它组合，但须明确部署底稿和 C3 anchor 的权威关系，避免两个身份基调各自漂移。section 名独立仅解决命名冲突，不解决共同人格的一致来源，也不解决每个请求的动态材料作用域。

## 4. 本插件必须自己补的能力

以下是插件设计任务，不能记作“宿主原生已经保证”：

- 环境线索到人格判断、未知 staging、assignment 更正和真实主体保留。personId表示关系归属与检索分区，role/sourceRole及speakerId表示实际发言来源；助手原件可由人格选择关联到关系，保留assistant角色、原speakerId、原话、时间与来源ID。
- 稳定源事件去重、已接收消息先记后回、有限缓存及 host-trace 回补。
- 请求冻结快照及跨会话动态注入适配。
- 人格控制决定、按其时间或 recheckOn/wakeCondition 事件条件调度、两种增量梳理模式。
- runId/高水位/输入版本/validated patch/提交标记、单写者与崩溃恢复。
- 有界 outbox、目标路由、停止未交付主动工作和交付对账。
- 自然淘汰与明确撤销区分，重建不复活已忘材料。
- 实例总容量、实际 bytes、缺口诊断、真实 token 与费用计量。

这些机制保护执行正确性，不能顺带加入替人格决定性格、亲疏、主动频率、边界理解或履约优先级的规则。

## 5. P0 贯通探针

先在可控的测试会话用明确样本做探针，再实现其余模块。记录宿主版本/包身份、具体入口、输入、实际事件、可见结果、未覆盖边界；不以打印构造器代替行为确认。

| 探针 | 操作与证据 | 通过条件或需要的适配结论 |
|---|---|---|
| P0-A 事件契约 | 发送短句、连发、不回复样本，并混入 runtime-context/agent-instructions/插件状态卡/agent-message；记录 source.kind、内容块、源 ID、时间与最终正文，随后重放/重启 | 参与者正文正确入 C1；自动注入不计人物发言；同根事件一次；不回复仍记录；缺口可定位 |
| P0-B 分支与编辑 | fork 后继续、编辑/撤回、取消流式输出 | 能辨别继承历史与新事件、最终正文与部分输出，不重复形成经历 |
| P0-C 请求作用域 | A/B交错更新人格与关系材料并发请求；先确认request/context字段，必要时经请求准备入口/受控调试取最终messages/system prompt | 每个请求的对象、版本和实际内容均与冻结快照一致；元数据匹配不替代正文验证，明确可用注入与观察入口 |
| P0-D Inbox 到输出 | idle agent、忙碌 agent、关闭会话、nextTurn/nextStep 分别提交测试材料 | 参数、领取、唤起、实际输出、可见通道均有对应关系；append 只算 submitted |
| P0-E 控制决定 | 调 persona_decide 分别 reply/wait/listen/search/sleep/wake，验证定时、仅等事件及整理提交后醒 | 人格选定时间或事件可执行；listen 无时点可合法观察；失败 run 不假唤醒；没有暗中固定时间规则 |
| P0-F 睡眠 | 睡中多个对象/通道来信，唤醒并重启 | 睡中无 assistant 输出；原件在；醒来一次接收按对象汇总；未送消息仍可对账 |
| P0-G 停止主动 | 入队前、入队后未领取、生成中、输出后分别执行用户停止 | 未交付工作取消；已交付如实标明；不等待下一次周期才检查 |
| P0-H 完整临时源 | 读取对话、可用 reasoning、工具原件，验证缓存与 host-trace 分页 | 原件/摘要/缺失分清；源 ID 可查；容量边界不一次全量喂入 |
| P0-I 提交与恢复 | 在接收、候选文件、commitMarker、游标、H1 清理各点中断 | 无重复根事件/半次提交；新到 H1 不误删；业务 sleep 与执行锁分离 |
| P0-J 交付对账 | append 后崩溃、输出后回执前崩溃、目标通道不可用 | 同 deliveryId 对账，不明为 unknown，不盲目重发或假报收到 |
| P0-K 容量与撤销 | 达目标量后自然淘汰，再明确遗忘并从宿主旧日志重建 | 重要概括可保留；撤销不复活；实际 bytes、缺口与回补路径可见 |
| P0-L 费用与缓存 | 统计判断/梳理/重试/生成的用量，覆盖实际路由更新模式 | 有真实调用、token、缓存与延迟数据，不用固定每日调用承诺代替 |

P0 完成并不意味着整个人格效果已验收，只意味着实现路径和失败边界有依据。后续阶段完成记忆、人格演化、两模式切换、主动与睡眠等全部功能；不能用接口探针通过替代长期行为观察，也不能用人格数量、准确印象或始终讨喜作为强制达标条件。

## 0.5.0 陪伴工具、扫码、权限与形象适配

> 本节保留0.5.0历史工具边界。当前八工具与自主派发按本文件0.6.0节执行；扫码、媒体与权限的未变契约仍适用。

DSH设置沿用宿主颜色、字体和透明背景；第七页“聊天渠道与语音”新增官方QQBot／微信iLink真实扫码，授权后按驱动实际支持的私群范围明确启用，高级OneBot保留。QQ连接Bot，不自动接管桌面个人QQ；微信官方只支持私聊，朋友圈和实时通话未实现。平台、账号、房间、真实发言者、原话和时间继续分别保存，外部ID不自动成为personId。能力表区分支持、用户许可、当前可用，未支持项目不能新授权。

陪伴预设在普通DSH／IM／主动／唤醒中清空继承工具范围，只提供memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform。不向人格暴露子agent派发、Harness、编码或文件工具；其它预设不变，内部接收与恢复通道仍可使用原生API。该工具边界不改认人、注意、回复、主动、睡眠和run／defer的自主机制。

第八页“形象与创作”提供形象描述、主参考版本与用户锁定，图片／视频分开配置且默认关闭。图片使用明确Images JSON／multipart或ComfyUI，视频需要实际工作流；生成／查询／平台发送分别记录真实状态，unknown不自动付费重放。作品字节与服务凭据在文本库之外，文本备份及元数据清单不等于完整作品备份。字段权威为persona-schema第14、15节；操作与当前证据见[渠道接入](../../channel-integration.md)、[形象创作](../../media-and-identity.md)及[管理说明](../../management-ui.md)。


## 0.6.0 自主委派与任务资料隔离

主人格可自主选择经persona_task委派工程、研究或其它需要的任务，不设必须派发的题型、固定次数或记忆门槛。当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task；原始全局派发／Harness／编码工具仍不直接加入主预设，独立工作预设使用宿主已有工作能力和用户权限。

任务新建独立上下文并显式选择xiangxu-task-worker，可信宿主登记taskId、真实子会话、父会话和AI委派来源后才启动。宿主初始封套即使为source.kind:user，也不会作为真人C1或共享人格H1接收。主会话的任务工具调用及结果仅把安全导航元数据投影进H1；实时、回放和trace回读采用同一投影，不能把指针重新展开成工程原文。普通主人格回复、思考、其它工具和真实用户原话保留原意义。

完整委派prompt、宿主实际可取得的会话事件、工具结果与最终报告保存在独立.tasks档案；显式archive_file将所选工作区产物复制成带SHA的快照，不等于自动备份整个工程目录。默认总容量1GiB、单任务与单资料64MiB、任务收据4096条；owner可在“任务与资料”页高级设置调整资源上限。容量满保留旧资料／幂等凭据并明确报错，未归档尾部标capture.complete:false；删除／关闭任务不假称已经保存全部原件。

父会话通过status/read查询实际状态及按需读取；status默认只返回紧凑任务卡，显式documentOffset／documentLimit才附带资料目录页。retain选择真实资料的有界片段送入既有自主整理，不直接写人格、不要求任何模块变化。资料保留真实AI／工具／网页来源与原件定位，完整性、SHA与分页状态分别报告。明确遗忘通过源依赖撤销相关任务档案，旧原始宿主日志或外部副本不被冒称已删除；unknown任务不因重载自动重新执行。

完整动作、存储范围、权限与验收口径见[自主委派与任务档案](../../delegation-and-task-archives.md)。工作预设的能力限制继承DSH用户权限；full-access模式下没有额外OS沙箱。普通对话是否关注、回复、主动、睡眠以及是否整理的原有契约未变。

### 0.6.0 自动化验证与资源边界

> 本节保留0.6.0当时源码的实测结果，不能当作0.7.0新核心已经重测。

0.6.0当时最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](../../verification/0.6.0-tests.json)、[两阶段原生SDK](../../verification/0.6.0-sdk-fixture.json)及[静态自主性审查](../../verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](../../management-ui.md)单独维护。

status默认只返回紧凑任务卡和至多120字的导航摘要，不自动展开完整资料目录；明确传documentOffset／documentLimit可分页取目录，正文按documentId和Unicode offset／maxChars读取，返回nextOffset，下页传offset=nextOffset；通用工具cursor只续同一次有界响应，list.pageCursor只续任务列表。UI单次文件下载上限64MiB，不随档案扩容自动提高。archive_file虽按64KiB读取源文件，归档时仍组合受单资料容量限制的整份文件缓冲，内存随该文件大小增长；DSH冷查询也可能内部载入目标子会话日志，不能将逐页采集宣称为宿主恒定RAM。明确遗忘清理插件任务正文并保留永久撤销凭据，清理失败如实报告；它不会删除DSH原始会话历史或用户另存的工程副本。


## 0.7.0 深刻参考、资料整理与社交身份

深刻记忆统一保存全部情绪经历，global:deep对应global/deep.json；title/reference、experience、feltThen和meaningNow分开表达参考、经历、当时感受与现在理解。参考卡不是已触发的回忆，cues不进行程序关键词匹配，何时联想、怎样反应及重释、淡化、合并、替换或修剪均由人格自主选择。容量上限同时保护条目、文档与实例，不因负面程度或时间经过自动删改。

整理冻结页增加memoryIndexes:{global,person}和deepMemories，保留实际版本、来源与未读位置。可选reviewAssistant默认关闭，只给本次有界材料的保真建议，使用当前DSH模型并共享原调用预算；它不写人格补丁、不决定记什么、不要求采纳，助手读取不计作人格已读。来源核对允许空引用的主观解释，不增加证据门槛。

提交后保留的sourceDependencies采用sha256-identities/1来源／记录摘要收据，追踪实际读入材料而不另存原话。明确遗忘会清除受影响已提交journal的patch、助手报告与可回读诊断正文，保留提交标记、调用数等技术回执；旧档缺完整依赖时在撤销后保守去诊断正文，不删除无关人格记录。自然原件淘汰保留人格解释和仍受容量约束的诊断。人格所选retain片段本身也是来源；明确遗忘命中task-material时按真实任务会话、文档ID、SHA与Unicode范围撤销该任务资料，不能换页重新保留；自然淘汰和无关新任务不受影响。

账号与社交身份复用当前QQ／微信连接，可登记其它平台并注入适配器；身份、在线核验、支持、授权和实际可用分别呈现。QQ官方主动推送取消是驱动执行事实，不改变人格主动联系的自主判断；OneBot桥按实际能力处理。同平台多个档案不等于多个并发连接。具体字段以[persona-schema第17至19节](persona-schema.md)为准，功能与资源见[新增说明](../../memory-reflection-and-social-identities.md)。

0.7.0[完整本地回归](../../verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](../../verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](../../verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](../../verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0的495/35及当时九页GUI、0.5.0和更早结果保留历史含义。0.7.0已修改核心，不能沿用0.6.0核心九文件未变的结论。


## 0.8.0 管理入口与任务式子页

顶层五个入口始终保留；打开任务式子页后，“返回”回到实际来处，当前主入口保持选中。相处提供日常状态、主动联系开关、了解人格和独立任务；记忆把可读原文、深刻经历、人物与成长记录分开；连接把QQ、微信、声音、社交身份分开，单平台再分扫码步骤、能力权限和兼容桥；创作分形象、图片服务、视频服务、生成与作品任务；设置再分实例列表、启动时加载、使用其他记忆库、交流时间、资料助手、分类容量和维护；同实例切换容量类别保留草稿，一次保存已改字段，不同实例草稿隔离。成长记录分整理进度／人格变化／手动操作，任务先显示摘要、技术元信息按需要打开。命名按钮替代原生details三角，不把所有表单同时摊开。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。该历史版本[完整本地回归](../../verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](../../verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](../../verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

## 0.9.0 自我档案接口与再判断

现有八工具保持不变。persona_introspect增加section:self的完整档案读取，以及action:update_self、selfPatch、expectedVersion的当前自我资料更新；主体、真实来源、版本、容量和错误按[唯一字段契约第20节](persona-schema.md#20-自我档案初始化与交流定位090)执行，不把owner初始化元数据写权限交给人格工具。

原生管理桥复用owner认证与64KiB请求/2MiB响应载体，增加self.get与self.update（顶层expectedVersion），status仅附mode/version/onboardingAcknowledged。config.update白名单包含conversationStyle三个枚举；无模型调用的保存与已有定时决定恢复分别看待。UI新增资料页、可跳过引导与[使用说明](../../user-guide.md)，不另开手机服务或平台权限。

多次表达继续使用persona_decide.nextCheckAt选时再判断，不额外注册“发一句空消息”或自行构造宿主assistant事件。原生assistant/message及平台每条回执仍是实际说过的证据；QQ官方主动限制不因短聊偏好放宽。0.9.0真实SDK、最终GUI和模型链结果统一见[当前验收状态](../../management-ui.md#090-final-acceptance)，不能把0.8.0继承后台不变的证据套到已修改的适配层。

定向续聊需一并保留当前replyPlan.target，单独设置时间不保证回到原会话。到期重新读取pending和当前上下文，不播放旧台词；生成开始后新来信可能下一原生轮次才处理，这不是实时打断机制。globalMuted与QQ官方等实际能力限制继续适用。

## 0.9.0 人格实例管理接口

这些动作复用已认证owner管理桥、既有请求/响应容量和单活动写者，不加入九个人格工具，也不交给模型一个任意目录删除工具。字段、清除范围、token与技术容量唯一权威为[第21节](persona-schema.md#21-人格实例生命周期与文本清除090)。

| owner动作 | 输入与真实结果 |
|---|---|
| instances.list | 无目标写入；返回items、activeInstanceId、selectedInstanceId、autoLoad、error、counts与clearedListComplete；item原始主键为instanceId |
| instances.create | {name,autoLoad?:boolean}；后台分配新UUID根，返回实际list形态；UI明确创建后可进入自我档案，不默认复制资料 |
| instances.load / select | {instanceId?,memoryRoot?,name?,autoLoad?}；显式加载/切换；返回实际list，归档及清除状态拒绝 |
| instances.unload | {instanceId}；停止当前目标、保留资料并返回list |
| instances.archive | {instanceId}；闲置核验、归属持久化、停用并归档，返回list；归档不是备份 |
| instances.restore | {instanceId,activate?:boolean}；只恢复已归档资料；activate:true明确恢复并加载，返回list |
| instances.clearPreview | {instanceId}；返回实际scope/excluded/files/bytes、requiresName、confirmationToken、64位hex版本和expiresAt；仅预览不删文件 |
| instances.clear | {instanceId,confirmationToken,typedName}；返回cleared或partial及实际已删/剩余量和错误，完成后UI重新读list |

clear不接收客户端自由路径或客户端自报文件列表，版本由token绑定而非另传expectedVersion。确认固定的是受管文本精确清单/内容、实例登记与目标状态；库外ownership只存会话哈希归属，capture在排他锁内重读合并最新记录，合法外部新增不使预览无意义失效，冲突或超限在删除前拒绝。token五分钟过期；预览后登记、实例状态或文件变化均要求重新预览。主动实例停止后若产生新收据，INSTANCE_CLEAR_STALE表示此轮零删除且保持停用；进入逐文件删除后的异常则可能为partial，必须按实际结果报告。忙碌、未知文件、链接、维护锁与容量失败不能被界面解释为已清空。

UI先显示真实范围，再要求精确名称确认；关闭/取消预览不写入，归档或切换不隐含清除。写RPC及其回执绑定原实例和页面代次，确认后再次核对，旧页控件不作用于后来选择。清除完成保留不可加载标记；“新建人格”仍需用户明确输入名称并提交，不自动创建或将旧会话带入新库。

最终owner桥、GUI与模型验收以[当前验收状态](../../management-ui.md#090-final-acceptance)为准，不从历史接口存在推定通过。

## 0.10.0 检索与可选平台接口

字段唯一见[persona-schema第22节](persona-schema.md#22-混合候选检索与可选平台扩展0100)。memory_search新增mode/timeMode/asOf/seedIds/associationDepth/diversity；persona_decide.retrievePlan同样可表达这些选择，不增加工具数或强制检索。tool结果仍按现有cursor分页，长解释可摘要为数量，不能为解释挤掉可继续读取的正文。

| owner动作 | 实际职责 |
| --- | --- |
| memory.search | 所选人物／全局范围、时间与模式的候选搜索，分页结果与当前覆盖分开 |
| retrieval.inspect/configure/prepare | 读取不回显密钥的服务状态；expectedVersion保存配置；仅明确prepare分页向量化 |
| retrieval.diagnostics/detail/clearDiagnostics | 有界摘要／完整分页／清除运行诊断，不删除记忆或改变重要度 |
| bilibili.inspect/configure/loginStart/loginPoll/loginCancel/disconnect | 实际公共网页扫码、账号就绪及启用；probe网络操作和纯能力快照分开 |
| bilibili.listReceipts/resolveReceipt | 真实收据分页与unknown核对；手填编号不能直接冒充送达 |
| socialProviders.inspect/configure/probe/execute/getJob/listJobs/cancel | 自备动态／翻唱服务配置、探测与同一真实作业查询 |
| socialProviders.uploadBegin/uploadChunk/uploadFinish/uploadCancel/readAssetChunk/listAssets/deleteAsset | 有界真实音频导入、SHA核对、产物下载与明确删除 |

persona_platform使用platform:bilibili的read/execute与operation，或QQ的feed.*／media.cover和job/cancel_job/assets；帐号权限由当前memoryRoot/平台/真实accountId核对，外发请求编号来自实际工具调用。QQ mention/message.read/forward读取沿真实binding与驱动支持执行，不开放泛化桌面控制。owner手动execute表示用户这次操作，不伪造人格自主选择；配置保存不启动生成。

原生媒体输入需要实际DSH attachments／视觉模型或speechToText端口，安全来源和识别覆盖分开标注。无端口、无服务、无许可和失败分别报告，不构造假向量、图片理解或平台回执。当前接入条件／隐私／容量／最终证据集中见[本轮说明](../../integrations-and-retrieval.md)。
