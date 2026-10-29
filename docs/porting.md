# 接入其他宿主

当前0.14.0增加只读[3D记忆关联图](memory-graph-3d.md)：展示有实际依据的记录、来源、人物和会话关系，后端有界读取，原文按需详情。图不调用模型、不触发回忆或人格更新；旧版QQ恢复与技术修复保留原范围，最终全量、实机与正式加载另验，不预填成功。

核心适用于 Node.js 22+，入口 `core/index.js`。它不负责取 API key、找应用安装路径、注册宿主工具或伪造发送成功。下面为集成骨架，模型和发送端口由目标宿主提供：

```js
import { MemoryRepository, PersonaRuntime } from './core/index.js';
const repository = new MemoryRepository({ root: absoluteDataDirectory, config });
const runtime = new PersonaRuntime({ repository, config, clock, model, host });
await runtime.open();
await runtime.accept(participantRecord, environment);
await runtime.handleSignal('new_message', { environment, personId: null });
// 关闭宿主时：
await runtime.close();
```

`model.complete` 接受 control/reply/consolidation 三类请求，返回决定、文本或 patch，并附可用 usage。`host.deliver` 需返回实际 submitted/delivered/unknown；`reconcileDelivery` 用稳定 deliveryId 查真实输出，未知结果不得盲重发。`readTrace` 使用 cursor/nextCursor 分页，缺源明确 unavailable。可选 countTokens 使用实际路由模型对应 tokenizer；缺失时默认估计有明确标签。

若目标宿主拥有原生 agent loop，可以像 DSH 一样提供 `host.requestDecision`，在原生轮次调用 `decide(input,{executeReply:false,controlId,operationId,...})`，避免核心和宿主同时生成两次回复。工具调用操作 ID 应稳定。队列通知应按 controlId/wakeId/deliveryId 去重；只在真实 admission 后确认读取，只对实际可见的完整来源清 pending，不能按整个 session 清空。

来源必须提供稳定 sourceSessionId/sourceEventId、sourceKind、参与者正文分类、角色和真实通道。若源会话 fork 复制祖先前缀，不把继承事件再当一段新经历。未知身份可暂存，再由人格用 identityPlan 选择新建或关联；一个 session 不是一个人。

宿主应传入真实可得的时间、IANA 时区、地点/工作区、头像或视觉可用性等环境信息。没有视觉时明确 unavailable。attention 是人格的选择，来源分类和可执行目标是适配层的技术责任。

运行状态和人格判断的完整契约见 runtime-api.md；记录与 patch 契约见 repository-api.md。采用其他存储时实现同等的单写者、事务恢复、源去重、撤销优先和容量语义。维护端口只支持当前数据版本，不进行猜测式旧格式转换。

## 0.1.1 接入注意

identityPlan.sourceRefs 选择待归属原件/来源会话，不是认人的证据门槛；认人结果和实际路由分别回执。跨目标回复提供 describeTarget，使用真实目标环境并按实际送达消息根投影。attention 只执行人格选择的输入范围，不能中止已接收轮次的自主回复。临时过程保存实际读取依赖，包含嵌套JSON工具结果；明确遗忘清理副本与未提交候选，不作关键词封禁。environment_change 应有真实事件生产者。整理失败保留候选、错误与usage，不静默重试付费。

DSH operator CLI 的 --wait-ms 为正整数，默认30000，可供慢整理增加等待；超时表示结果未知，先查询状态/回执，不盲目重发有副作用的请求。当前真实结果与限制见[复核记录](real-model-validation.md)。

## 0.2.0 自主整理与预算

实现consolidationPlan.run/defer及一次性作业回执；on_write提供合并机会，不在每写一条时擅自付费。所选job全部子run提交才触发对应整理完成唤醒。模型端口接收maxOutputTokens并实际传给供应商，输入与旧记忆上下文按预算/游标分页；paused保留未消费尾部，显式续执行，不自动重试付费。容量配置覆盖进化记录、文档和持久实例；拒绝时不静默截断。细节与验证见[当前报告](evolution-and-wake-validation.md)。

## Native DSH management (0.3.0)

The package is dsh-xiangxu-persona; its core export is dsh-xiangxu-persona/core. Existing persona-memory preset IDs and persona-memory/3 data remain compatible. UI-specific modules stay in adapters/dsh and ui; another host may reuse the core while implementing its own authenticated operator/lifecycle ports. Do not add a second live repository writer for browsing. Control and maintenance are explicit operations; importing/restoring data leaves the instance unloaded until selected again. See [management UI](management-ui.md) and the self-contained [schema](plan/persona/persona-schema.md).

## 0.10.0 可选语义端口与平台移植

普通文字和已存关联检索不要求外部服务。其它宿主可通过repository.setSemanticPort提供纯embed端口，显式调用prepareRetrievalIndex建立所选批次，再使用search；关闭或更换服务会清缓存，凭据、网络和用户启用界面由宿主负责。方法与真实向量要求见[Repository API](repository-api.md#0100-hybrid-candidate-retrieval-and-volatile-semantic-port)，数值以[retrieval-config.js](../core/retrieval-config.js)为准。

QQ、B站、宿主附件／语音识别与可选动态／翻唱都是DSH适配层，不是核心默认依赖。移植不能把附件已接收当作媒体理解、把状态submitted当作送达，或把参考曝光当作回忆。不得用旧DSH/模型证据替代新宿主验收，详见[0.10.0 接入与检索说明](integrations-and-retrieval.md)。

## 0.12.0 独立账号作用域与平台实际能力

当前DSH适配器的QQ头像profile.avatar、资料profile.update及QQ空间说说feed.publish可通过已核NapCat账号接口直连；它们是独立account作用域，不需要私聊binding或聊天target，不能伪造一条人类来信来获得执行路由。移植时分别实现当前人格／账号／生命周期核验、实际平台能力、用户技术许可、资产字节与SHA复核、持久准备与结果收据；未知或重启中的同一操作不盲重放。工具结果和账号资料作为独立原件保留，不自动写成人类对话或人格记忆。

资料更新必须取得明确result:0、QQ空间发布必须取得真实tid才能确认完成；普通OneBot名称、方法存在或submitted状态均不等于完整能力或成功。空间浏览／点赞／评论、翻唱及其它平台操作仍需对应真实驱动，不能从这三个接口推断已支持。参数、容量、支持来源和当前证据见[账号能力说明](account-capabilities.md)及[QQ账号操作](qq-account-operations.md)。0.10／0.11历史回执保留原宿主和版本边界，不能代替新移植或本版真实写入验收。
