# 实测：DSH 会话日志里「思考过程」占多大

> 当前产品入口（0.5.0）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生八页设置沿用DSH宿主样式，保留主动联系／现在叫醒的日常说明，新增官方QQBot／微信iLink扫码、实际能力许可、形象档案与可选图片／视频接口；高级OneBot保留。陪伴预设在普通DSH／IM／主动／唤醒中仅提供七个人格工具，不继承子agent派发；其它预设与内部原生接收通道不变。平台未实现的动态、通话或群能力不冒称可用，服务默认关闭、本人扫码和真实供应商输出仍需实际环境验证。当前入口与证据见[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)；研究和旧版本结果保留历史含义。

> 证据层定位（2026-10-25 修订）：本文保留历史调研出处、原研究范围和实际阅读深度；本次未重新联网，未把摘要升级为正文。论文结果与旧草案不是当前产品规则。当前设计以 `../长期AI人格插件-实施计划.md` 为准，字段以 `persona-schema.md` 的 `persona-memory/3` 为唯一权威；下面的采纳建议已按人格自主判断的要求收窄。

**测量对象**：本工作区当前会话的持久日志
`C:\Users\Administrator\.dsh\sessions\--C-Users-Administrator-DSH--\session-e3af40ea-fd05-4be3-9dad-296739c2393b\session.v4.jsonl.zstd`
（DSH Desktop，profile=desktop；日志为多帧 zstd，实测 2,698 帧，解压后 14,725,391 字节 / 4,346 条事件）

**测量时间（历史快照）**：原会话内，脚本 _tmp/unzstd2.cjs、_tmp/probe-events.cjs、_tmp/probe3.cjs。本次修订未重新运行原测量脚本，原始计数原样保留。
**口径**：统计事件载荷 text.length，不解析语义，同一 block 只计一次。user/message 可能包含自动注入的上下文、系统提醒或技能内容；81 条不是 81 次真实人工发言，也不是 81 个用户。历史“纯对话”在本文只表示 user/assistant text 块合计，未经来源过滤。

---

## 1. DSH 到底有没有把「思考过程」写进日志

**这个历史样本有，且被计到的 604 条 assistant/message 都含 reasoning 块。** 这不能外推所有 DSH 模型、会话或供应商都公开完整内部推理。

源码证据（`app.asar` 内 `@deepseek-ai` 类型声明）：

```
export interface ContentBlockMap {
    text: TextBlock;
    reasoning: ReasoningBlock;     // <-- 思考过程是一种 ContentBlock
    image: ImageBlock;
    file: FileBlock;
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
}
```

`assistant/message` 事件的载荷形状是 `{ turn, step, message: { role, content, source, id }, usage, stream }`，`message.content` 就是 `ContentBlock[]`。

**实测分布（本会话 604 条 `assistant/message`）**：

| block 类型 | 条数 | 说明 |
|---|---|---|
| `reasoning` | **604** | 100% 的 assistant 消息都带推理块 |
| `text` | 8 | 大多数步骤是纯工具调用，没有可见文本 |
| `tool-call` | 637 | |

样本结论：被计入的 604 条 assistant 消息均带 reasoning，hasSig=false 表示该样本未见 signature 字段；不能据此断言其他模型或所有协议都没有签名或都提供同样完整的过程。

---

## 2. 体量对比（本会话实测）

| 项目 | 字符数 | 占纯对话量的倍数 |
|---|---|---|
| user/message 的 text 块（81 条，含自动注入可能） | 48,178 | — |
| AI 说出口的话（`assistant/message` 的 text 块，8 块） | 6,373 | — |
| **text 块合计（历史“纯对话”口径）** | **54,551** | **1.0×** |
| AI 的思考过程（`assistant/message` 的 reasoning 块，604 块） | **272,639** | **5.0×**（对纯对话）／**42.8×**（只对 AI 说出口的话） |
| 工具结果（`tool/result` 事件 JSON） | 1,703,110 | 31.2× |

**读法**：
- 历史稿用约 197.5 万总量估计为约 83% 工具、14% reasoning、2.8%“两人说过的话”；这和上表总和未完全对齐。按表内三组互斥数字求和为 2,030,300 字符，比例约 83.9% / 13.4% / 2.7%。但工具项统计 JSON、text 项含自动注入，不能把它当真实双人聊天的语义比例。
- 若只计算 user/assistant text 块，本样本为 54,551 字符；100 万字符约容纳 18 个同体量样本。此为静态容量换算，不表示完整插件可永久保存 18 场对话，实际还含人格、索引、概括和其他字节开销。

⚠️ 口径提醒：本样本是重工具会话（637 次调用）；5.0×、42.8× 与工具 31.2× 只描述该快照，不预测陪伴场景会更高或更低。历史 text.length 严格计量 JavaScript UTF-16 code units，不是 token 或磁盘 bytes；它与新 schema 的 Unicode code point 字符计数不同。原数原样保留，不回算替换历史数据。

---

## 3. 对「只保留聊天过程，不保留思考过程」这条设计的直接含义

1. **可以量化体积取舍**：原始过程与工具 JSON 在此样本占较大体量，但本测量没有证明不存它们必然提升质量。
2. **原文来源需到 block 和事件来源两层**：text / reasoning 的技术分类不等于人工 / 自动注入的语义归属。C1 只收实际聊天；本次梳理所需完整上下文由 H1 缓存或源指针承接。
3. **工具结果在此样本最大**：1,703,110 字符、约为 text 块合计 31.2×。有些工具材料对本次梳理可能重要，不能从体积直接判“对人格连续性几乎无用”；临时保留与长期提炼分开。
4. **质量代价仍未验证**：request/context 样本未带完整 messages，所以本测量未直接判断历史 reasoning 如何回传；也未做丢弃后的 A/B。后续研究记录提供相邻风险与收益，不替代本产品实测。

---

## 4. 当前分层口径（字段以 persona-schema.md 为准）

| 材料 | 长期原文流 C1 | 本次梳理 H1 / host-trace |
|---|---|---|
| 来源确认为实际人工的 user text | 在有限总量内保留聊天原文 | 梳理可读原件 |
| assistant 说出口的 text | 在有限总量内保留，包括主动发言 | 梳理可读原件 |
| 自动注入的 system/skill/runtime 文本 | 不冒充人工说过的话 | 若与本次判断有关，作为来源明确的过程上下文 |
| 可得 reasoning | 不长期堆入原文流；人格可提炼重要理解并说明来源 | 保留宿主实际可得原件，超缓存以指针分页，不用一句摘要冒称完整 |
| tool-call / tool-result | 不照单长期复制；人格在梳理时选择重要提炼物 | 原件或可回查指针，记录缺源降级 |
| compaction/summary | 不进 C1 原始聊天流；可另存为 C2 来源明确的提炼物，不能冒充原始聊天 | 可作导航，原件可得时仍能回查 |

人格自行决定重要性与整理时机；成功提交后只清已消费热区，不能清掉整理期间新到达的材料。容量、自然淘汰与明确遗忘按当前方案分别处理。

---

## 5. 这份测量不能证明的事

- 不能证明"丢弃 reasoning 不损失能力"——没有做 A/B。
- 不能证明陪伴场景的体积比——样本只有一个重工具会话。
- 不能外推到别的 harness：ChatGPT / Claude 的日志格式不同，本报告只适用于 DSH。
