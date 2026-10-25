# DSH 扩展点与 P0 接入验证

当前实现（0.4.1）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生设置保留七页功能并沿用DSH宿主颜色、字体和透明背景；主动联系开关附日常说明，休息时才显示“现在叫醒”。QQ/微信已有兼容桥的高级配置默认折叠，真实使用仍需用户已有桥和账号，尚未实现扫码或接管桌面登录；Windows本机声音入口保留。当前实现及证据见[管理界面与验收](../../management-ui.md)与[渠道接入](../../channel-integration.md)。研究和旧版本数字保留各自历史范围，不提升为本版验收。

修订日期：2026-10-26。插件格式统一为 `persona-memory/3`，正式业务字段见 [persona-schema.md](persona-schema.md)，执行顺序见 [architecture.md](architecture.md)。

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

exec 中能取得哪些 session/request/channel 信息要实测。当前插件注册五个工具：memory_search、memory_forget、persona_introspect、persona_decide、persona_voice，完整参数以 persona-schema 为准。缺省目标由真实宿主上下文补齐，显式目标可指已知他人；scope 是用途而非管理员 ACL。删除/更正需要目标可解析，歧义不能扩大为批量操作。

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

## 0.4.1 聊天渠道、外观与声音适配

DSH设置沿用宿主的颜色、字体和透明背景，使用可换行页签与设置分隔行，不另设主题选择器或品牌页眉；第七页“聊天渠道与语音”把已有兼容桥的参数折叠为高级配置，尚未实现扫码或接管桌面登录。该页适配用户已有QQ、微信软件的普通私聊/群聊。QQ适配OneBot11/NapCat，微信需要兼容OneBot12本地桥；微信官方接口当前不提供本方案所需普通群聊能力。默认没有listener，用户明确启用后仅在本机提供桥事件回调；个人网页和Telegram是预留接口，不挂载手机网页主入口。

平台、账号、房间、实际发言者、消息ID和平台发生时间作为真实环境事实保留；每发言者＋房间的原生通道仍共享同一个人格，外部ID和昵称不自动成为personId。接入范围是用户选择的连接边界，空范围未接入，显式*才开放相应全部对象/群；没有被@、主动次数、最短间隔或话题资格规则。原件经原生inbox持久，最终正文只有平台桥真实消息回执后才计实际说过，unknown不自动重放。

当前五工具追加persona_voice供人格按需查看真实音色目录和自主选择，用户指定模式优先。IM音频使用Windows System.Speech生成WAV，再取平台音频回执；rate近似SAPI音级、pitch:false，不克隆音色、不硬映射性格标签或强迫每轮选声。voice-only缺能力明确失败，both可保留真实文字交付并标语音不可用。技术字段和容量以persona-schema第14节为唯一权威；实际操作与验证见[聊天渠道接入](../../channel-integration.md)。
