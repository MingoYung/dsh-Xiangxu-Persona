# 正式验收的会话范围计费监控

`scripts/dsh-formal-monitor.mjs` 仅用于受控验收窗口，不是人格运行所需的常驻组件。它在 provider 实际执行前调用同一 whole 预算的 reserve，并在结束后 settle。它不改变提示、工具、预设、模型参数或人格的回复、等待、记忆与成长选择。

## 范围配置

安装者必须先从真实通道登记核对本次私聊、群聊的原生 sessionId 及当前人格 memoryRoot，再显式配置：

```js
formalMonitorConfig({
  artifacts: acceptanceEvidenceDirectory,
  wholeStatePath: sharedWholeBudgetFile,
  scope: {
    mode: 'sessions',
    sessionIds: [verifiedPrivateSessionId, verifiedGroupSessionId],
    memoryRoot: verifiedPersonaMemoryRoot,
    includeDescendants: true,
  },
});
```

这些变量必须来自安装时的实际登记，不能照抄示例、按昵称或会话名猜测。配置缺少 scope 会拒绝安装；旧版只传 provider/model 的安装脚本不再适用。监控枚举宿主 `llm.listProviders()` 并按 adapter 对象去重，后续注册表变更也会补包，因此相关 worker 使用另一 provider 时仍共用同一个 whole 预算。

原生主回复、工具续轮、重试、压缩、标题请求使用宿主真实的 `options.sessionId`。子任务通过宿主 `session.header.parentSession` 追溯到选定会话；冷会话只读取 `sessionQuery.observeSession(..., { projectionMode: 'none' })` 的 header 并释放 lease，不复制会话正文。明确不属于选定会话及其后代的请求透传，不记入此次验收预算。

相续自身的 control、reply、consolidation、memory_assistant 请求由 `createDshModelPort` 产生 `xiangxuAccounting: { sessionId, memoryRoot, purpose }` 技术元数据。归属来自请求已有 context 和已解析 agent；memoryRoot 固定来自 coordinator，而非请求自报。该字段不进入提示内容，也不冒充原生 sessionId，避免辅助提示被主回复的人格投影检查误判。后台整理沿用其已持久化的 job context，不借用上次请求或异步 initiator 猜测。

## 不明确归属与费用未知

选定人格的辅助调用缺少 session、原生与辅助 session 冲突、祖先头缺失或身份不符、父级循环时，监控在 provider 执行前拒绝并记录范围错误。无法读取祖先的原生会话同样不能证明是无关流量，故会拒绝；安装前必须验证真实宿主 header 服务可用。没有任何 session 或相续归因标记的第三方 agentless 请求透传，不得把它宣称为已归属的人格辅助调用。

结束时缺少权威 usage 的尝试保留为未知。默认模式会在下一次 reserve 时要求核账。若测试预算只用于防止反复派发，可在核对空闲账本后显式启用 `enableWholeBudgetUsageGuard`。每次尝试占用的保护额度取实测 tokens 和所配最低额度的较大值。未知、在途和实际零用量按最低额度占位，真实用量和未知计数分别保留。锁内先检查剩余额度能否容纳下一次最低占位，额度不足即停止派发。单次实际消耗高于占位时，结算仍记录完整的实际用量，因此本地保护阈值无法保证平台账单的硬上限。

明确配置的次数、deadline 和损坏或丢失的预算文件仍在 reserve 处检查。明确无关的会话直接透传。宿主可能把普通 Error 的自定义 code 归一化，诊断应同时核对 `dispatch-budget.jsonl` 中的原始原因及 provider 调用计数。

默认仅保留范围、请求 ID、实际 usage、参数和序列化尺寸，不保存输入或输出正文；尺寸不是 tokenizer token 数。`logFullInputs: true` 是明确的额外选项，只记录已纳入范围的请求。dispose 只恢复自身仍占有的 wrapper，不覆盖其他插件后来安装的 wrapper。

## 验证与启用边界

`test/dsh-formal-monitor.test.js` 用固定 adapter、真实预算模块与真实 modelport 验证范围、辅助、跨 provider 子任务、并发、停止门、未知、日志及卸载。当前宿主服务的额外字段保留与消息投影须另用固定 provider 验证，不能把 mock 上下文测试写成真实模型实测。

安装前需通过代码、隔离服务、所选 session/header 登记和预算检查。用账本副本和固定 provider 验证放行，并保留已有请求与真实用量。
