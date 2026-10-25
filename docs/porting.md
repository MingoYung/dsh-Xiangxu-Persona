# 接入其他宿主

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
