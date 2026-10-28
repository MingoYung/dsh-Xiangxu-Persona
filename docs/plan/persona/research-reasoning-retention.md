# 长期记忆里要不要存 reasoning：文献与工程核查

0.10.0继续使用有界过程／任务原件与真实来源；向量缓存和参考诊断不是额外永久reasoning全文库，也不证明人格发生回忆。

> 0.13.0当前维护：统一短期／长期／归档时间线与必需人格上下文以[persona-schema第26节](persona-schema.md#0130-memory-timeline-contract)为字段权威，[使用与实现说明](../../memory-timeline-and-context.md)说明保存、转层、回查和加载故障。本轮不运行真实模型或社交平台验收；QQ按用户安排自行验证，其他社交平台显示未测试。0.12.0及更早验收保留历史范围，不推定本版或当前账号状态。

> 0.6.0历史布局与继续保留的能力（当前导航已在0.8.0重组）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生九页设置沿用DSH宿主样式，保留QQBot／微信iLink扫码、实际能力许可与形象创作，新增“任务与资料”。主人格通过persona_task自主派发，子任务显式使用xiangxu-task-worker独立工作预设，任务过程、原始资料与完整报告存独立档案，父会话按需读取并自主选择retain片段供原有记忆整理。主预设共八工具，保留继承工具mask；工作预设不自动挂共享人格写入工具，也不把AI委派指令当真人原话。是否委派、记什么及怎样成长仍由人格决定。其它预设不变，既有平台与真实供应商验证边界保留。当前接口和分级证据见[任务与资料](../../delegation-and-task-archives.md)、[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)。

> 证据层定位（2026-10-25 修订）：本文保留历史调研出处、原研究范围和实际阅读深度；本次未重新联网，未把摘要升级为正文。论文结果与旧草案不是当前产品规则。当前设计以 `../长期AI人格插件-实施计划.md` 为准，字段以 `persona-schema.md` 的 `persona-memory/3` 为唯一权威；下面的采纳建议已按人格自主判断的要求收窄。

**核查对象（历史定位）**：原 architecture.md 的 C1 只存聊天正文、reasoning 不进长期原文流的方案。原行号不再作为当前规范；当前另有 H1 临时过程区与按源指针读取的完整上下文。
**核查问题**：这个口径对不对？长期陪伴型 AI 的总体记忆，应当保存模型推理过程，还是只保存「用户说的话 + AI 最终说出口的话」？
**核查时间**：2026-10。**方法**：官方文档读正文；开源系统读源码；论文走 arXiv Atom API（含摘要全文），必要时读正文。
**与既有测量的接口**：measure-reasoning-volume.md 保留历史样本 604/604 assistant 消息含 reasoning、reasoning/text 块合计 5.0×、reasoning/AI 可见文本 42.8×。其中 user/message 含自动注入，不能视为纯人工对话或人数。体积测量不验证丢弃后质量，本篇也没有补出本产品的消融实测。

---

## 1 当前采用方式与证据边界

**长期原文流保留真实聊天正文，reasoning 原文不长期堆入；本次梳理的 H1 临时区保留宿主实际可用的完整过程，超缓存量以稳定源指针分页读取，梳理提交成功后只清已消费前缀。** 这是用户区分长期记忆与完整上下文后的产品选择，不是本篇证明“不存原文无损”。

人格可在梳理中把它认为重要的判断、假设或关系模式提炼成长期内容，保留 source 和 epistemic 说明。提炼成一句话、限 80 字或独立分池是旧工程候选，不作为必须遵守的形成资格；也不要求每轮额外生成一张判断卡。

源指针只承诺能回查当时宿主保留的材料；不可读、已裁剪、内部 reasoning 从未公开等情况要标明，不能拿一行摘要冒称完整过程。公开产品文档或某个源码路径未出现 reasoning 字段，不等于厂家内部完全不存，更不证明长期保留必然有害。

---

## 2 来源清单与方法

**总数 47 条**：商用产品 6（S01–S06）、平台 API 4（S07–S10）、开源系统 9（S11–S19）、学术 28（S20–S47）。

**阅读深度分布**：`正文` 19 条 ／ `摘要` 27 条 ／ `元数据` 1 条。
（正文 19 = S01–S05、S07–S19、S39；摘要 27 = S20–S38、S40–S47；元数据 1 = S06。Chroma 报告 S39 读的是网页全文，按 `正文` 计。）

三档定义（本篇自用，写进每条来源）：

- `正文`：完整读过正文/源码文件（官方文档整页、仓库源文件、arXiv 正文或 Chroma 报告全文）。
- `摘要`：只读到 arXiv Atom 返回的摘要全文（不是标题级）。每条数字均可在 `_research/persona_rr/arxiv_batch.txt` 用 grep 复核。
- `元数据`：只拿到 HTTP 状态/仓库元数据，正文取不到。

**检索式（arXiv API 原文，`export.arxiv.org/api/query`）**：

- `all:"conversation memory" AND all:summarization`（6 条）
- `all:"reasoning trace" AND all:memory`（6 条）
- `all:"chat history" AND all:"what to store"`（0 条命中）
- `abs:"assistant" AND abs:"utterance" AND abs:memory AND abs:compress`（1 条，主题不符）
- 另有按主题词逐条 `id_list` / `search_query` 定点取：scratchpad、ReAct、self-consistency、STaR、Quiet-STaR、Reflexion、ExpeL、AWM、Mem0、Lost in the Middle、Turpin、Lanham、To-CoT-or-not、self-correct、multi-turn lost、context length alone、LongMemEval、LoCoMo、CoT monitorability、RECOMP、LLMLingua、LongLLMLingua、Selective Context、MemoryBank、MemGPT、A-MEM、Generative Agents。

**打不开的条目（如实记录，未用记忆补写内容）**：

| 目标 | 结果 |
|---|---|
| `help.openai.com/en/articles/8590148-memory-faq` | HTTP 403 |
| `openai.com/index/memory-and-new-controls-for-chatgpt/` | HTTP 403 |
| `r.jina.ai/https://help.openai.com/...`（代理再试） | HTTP 403 |
| `help.replika.com/hc/en-us/articles/360047649471-Memory` | HTTP 403 |
| `pi.ai/` | HTTP 403 |
| `replika.com/blog`、`replika.com/blog/memory` | HTTP 404 |
| `docs.anthropic.com/.../memory` | 200 但正文为空壳（127 B） |
| `docs.anthropic.com/.../thinking-in-tool-and-multi-turn-workflows` | 200 但只取到壳（4 行有效文本） |

---

## 3 商用产品侧现状

在本次实际取得的消费者产品文档中，记忆单元主要描述为 topic、用户 pin 的原话或 facts，没有公开说明原始 reasoning 进入长期记忆。未提及不等于内部不存在，也不能证明“不存 reasoning 必然更好”。API 的不透明 reasoning item 与可见文本长期记忆属于不同层次。

| 产品 | 是否存 reasoning | 依据类型与出处 | 年份 |
|---|---|---|---|
| ChatGPT 消费者 memory | **未公布**（官方页全 403） | 元数据：`help.openai.com/...8590148`、`openai.com/index/memory-...`、代理镜像均 403（S06） | 2026 |
| OpenAI API（Responses） | **存，但只有不透明 item，且不返回推理文本** | 正文：`platform.openai.com/docs/guides/reasoning`（S10） | 2026 |
| Claude 消费者 memory | **未公布；记忆单元是 Topics，且明确「不是事后总结对话」** | 正文：`support.claude.com/en/articles/11817273`（S01） | 2026 |
| Claude API（extended thinking） | **按模型分档保留**：Opus 4.5 与 4.6 及以上保留前几轮 thinking 并计费；Sonnet 4.5（deprecated）、Haiku 4.5 及更早**剥离** | 正文：`docs.anthropic.com/.../extended-thinking`（S07） | 2026 |
| Claude API（context editing / compaction） | **可选择清除或保留 thinking**；`clear_thinking_20251015` 策略配 `keep={"type":"thinking_turns","value":N}` 或 `"all"`；默认档位随模型变化 | 正文：context-editing 页（S08）、compaction 页（S09） | 2026 |
| Gemini（Saved Info / Personal context） | **官方文档未提 reasoning** | 正文：`support.google.com/gemini/answer/16413516`（S02） | 2026 |
| Character.AI（Memory） | **所查公开记忆单元未描述 reasoning**；Story Memory 原话与 Facts 不足以证明内部完全不存 | 正文：blog.character.ai/memory/、helping-characters-remember-what-matters-most/（S03） | 2025–2026 |
| Replika | **未公布**（help 页 403；官网只有 "Memory" 导航项，无内容说明） | 正文：`replika.com/` 全文读过，零实质内容（S04） | 2026 |
| Pi（Inflection） | **未公布**（`pi.ai` 403；改抓 `inflection.ai/blog`，raw HTML 461,161 B、抽取正文 5,660 字符，`memor` 零命中——只能说明该页未提，不等于全文无此设计） | 正文：`inflection.ai/blog`（S05） | 2026 |

**可比较的三条公开产品做法（不自动成为本插件规则）**：

- Claude 的文档以 topic 描述记忆，并区别于对话结束后总结（S01）。这提供一种更新方式的先例，不证明 sleep 批处理不可行；当前 sleep / on_write 两种模式由用户选择。
- Character.AI 文档说明用户 pin 的 Story Memory 受到清理保护（S03）。这是该产品的做法，不推出本插件用户原话永久不淘汰；本插件的有限总量与自然遗忘由当前方案定义。
- Gemini 在回复底部标 `Your saved info` 作为来源标注，并承认 "may occasionally make mistakes and display this label incorrectly"（S02）——把「记忆被用了」做成可见事件，而不是隐式召回。

**历史 API 文档的两项状态与可见性记录（不代替实现期核实）**：

1. **历史查阅的 Anthropic 文档描述 summarized thinking**（S07），并区分 thinking 计费字段。插件能得到的 API 内容不一定是模型内部完整过程；H1 的“完整”只能指宿主实际提供的完整原件，不能承诺拿到未公开内部状态。
2. **OpenAI 的 reasoning item 是不透明的**（S10："The reasoning items remain opaque, and the API does not return their reasoning text"），`reasoning.context` 三档 `auto` / `current_turn` / `all_turns`，只有 `all_turns` 会把早期轮 reasoning 渲染进下一次采样（GPT-5.6 家族默认）。且 "**Persisted reasoning can be reused only within the same model family**"，换家族 API 直接丢弃不兼容 reasoning。

这些记录说明历史 API 的可见性、状态保留与跨家族复用有条件限制；不能把供应商内部状态机制推广成所有自然语言 reasoning 文本都不可迁移，也不证明厂商已判定其不值得作长期材料。具体版本能力仍需在实现时核实。

---

## 4 开源系统侧现状

在本次所查七个开源系统的路径/版本中，六个没有独立 reasoning 字段；Letta 对象层有 reasoning 类型，所查 summarizer 未读取独立 reasoning_content 键；Generative Agents 有 reflection thought。这不证明任意 content 字段从未容纳推理文本，也不证明所有版本的存储/摘要路径相同。

| 项目 | 存储单元与关键字段 | 有无 reasoning | 源码位置（阅读深度） |
|---|---|---|---|
| mem0 | `history(id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role)`；`messages(id, session_scope, role, content, name, created_at)` | **无此字段** | `mem0/memory/storage.py`（正文，S11） |
| Letta / MemGPT | ORM：`id, role("user/assistant/system/tool"), text, content(parts), model, name, tool_calls, tool_call_id, step_id, run_id, otid, tool_returns, group_id, sender_id, batch_item_id, conversation_id, is_err, approval_request_id, approve, denial_reason, approvals, sequence_id` | **ORM 无列；对象层有类型** | `letta/orm/message.py:44-90`（正文，S12） |
| Letta（对象层） | `MessageType` 枚举含 `reasoning_message`、`hidden_reasoning_message`；`ReasoningMessage{reasoning: str, signature: Optional[str], source: reasoner_model\|non_reasoner_model}`；`HiddenReasoningMessage{state: redacted\|omitted}` | **有**（但见下行：压缩时丢） | `letta/schemas/letta_message.py:58-63,160,182`（正文，S13） |
| Letta（压缩） | 所查 summarizer 读取 content 和 tool_calls，未读独立 reasoning_content 键 | **该路径未单独拼入该键；不据此推断全系统主动删除** | letta/services/summarizer/summarizer.py（正文，S14） |
| Zep / Graphiti | `EpisodicNode{source, source_description, content, valid_at, entity_edges, episode_metadata}`；`EntityNode{summary, attributes}`；`CommunityNode{summary}`；`SagaNode{summary, first/last_episode_uuid, last_summarized_at}` | **无此字段** | `graphiti_core/nodes.py:322,503,731,911`（正文，S15） |
| A-MEM | `Note{content, id, keywords, links, context, category, tags, timestamp, last_accessed, retrieval_count, evolution_history}` | **无此字段**（`evolution_history` 记的是记忆演化操作，不是任务推理） | `agentic_memory/memory_system.py:40`（正文，S16） |
| memobase | `OpenAICompatibleMessage{role: Literal["user","assistant"], content, alias, created_at}`；`Blob` 类型 chat/summary/doc/image/code/transcript | **无此字段** | `src/server/api/memobase_server/models/blob.py`（正文，S17） |
| memobase（摘要层） | `SUMMARY_PROMPT`="You are a expert of logging personal info, schedule, events from chats."；输入固定为 `[TIME] NAME: MESSAGE`，输出 `- ... // event` 或 `// info` | **摘要只保留用户侧事实/事件，assistant 过程不进** | `prompts/summary_entry_chats.py`（正文，S17） |
| Generative Agents | `ConceptNode{node_id, type("thought"/"event"/"chat"), depth, created, last_accessed, subject, predicate, object, description, poignancy, keywords, filling}`；分 `seq_event` / `seq_thought` / `seq_chat` | **有 `thought` 类型，但是 reflection 产出的一句话**，不是 CoT 原文 | `generative_agents/.../associative_memory.py:23,54`（正文，S18） |
| cognee | `DataPoint{id, created_at, ontology_uri, version, topological_rank, metadata, type, belongs_to_set, source_*, feedback_weight=0.5, importance_weight=0.5}` | **无此字段** | `cognee/infrastructure/engine/models/DataPoint.py:32`（正文，S19） |

**这一节最重要的三个事实**：

1. **所查 Letta 对象层有 reasoning 类型**，message.py:1497 含独立 reasoning_content 键，所查 summarizer 仅读取 content/tool_calls（S14）。这些是路径级观察，不能由此断定作者的主观取舍或全系统从不汇总 reasoning。
2. **memobase 的摘要 prompt 直接把输入格式钉成 `[TIME] NAME: MESSAGE`**（S17）——连「哪句话是模型想的」这个维度都没有，信息在进入摘要层之前就被结构性地排除了。
3. **Generative Agents 存 thought，但那是 reflection 的产物**（S18 摘要："store a complete record of the agent's experiences ... synthesize those memories over time into higher-level reflections"）。**「完整记录经验 + 合成反思」两层，原样保留的是 event/chat，进记忆库的是合成后的一句话**——这正是我们在 §7 要建议的形状。

---

## 5 学术证据

分两栏保留原机制与数字。任务内推理、训练、压缩、长期记忆和陪伴连续性不是同一问题；下面多数来源是相邻证据，不是“长期存/不存 reasoning”的直接对照。

### 5.1 留着有用（正面）

| 来源 | 机制 | 数字 |
|---|---|---|
| S20 `2112.00114` Scratchpads（2021） | 把中间计算写进 scratchpad，让模型「在纸上算」 | 多步计算 "dramatically improve"；长加法泛化到可执行任意程序 |
| S21 `2210.03629` ReAct（2022） | reasoning trace 与 action 交错，边想边查 | ALFWorld / WebShop 相对模仿学习与 RL 绝对成功率 **+34% / +10%**；HotpotQA/Fever 经 Wikipedia 交互缓解幻觉 |
| S22 `2203.11171` Self-Consistency（2022） | 采样多条推理路径再取最一致答案 | GSM8K **+17.9%**、SVAMP +11.0%、AQuA +12.2%、StrategyQA +6.4%、ARC-c +3.9% |
| S23 `2203.14465` STaR（2022） | 只对「最终答对」的 rationale 做微调 | CommonsenseQA 上相当于 **30×** 更大模型 |
| S24 `2403.09629` Quiet-STaR（2024） | 每 token 生成 rationale 的继续预训练 | GSM8K **5.9%→10.9%**；CommonsenseQA **36.3%→47.2%**（zero-shot） |
| S25 `2303.11366` Reflexion（2023） | 把「反思文本」存进 episodic buffer 供后续 trial 用 | HumanEval **91% pass@1**（对比 GPT-4 80%） |
| S26 `2308.10144` ExpeL（2023） | 不改权重，从轨迹里抽 insight 当经验 | 跨任务迁移增益（摘要未给单点数字，机制为「经验复用」） |
| S27 `2409.07429` Agent Workflow Memory（2024） | 从历史轨迹**归纳可复用 workflow**，再选择性注入 | Mind2Web / WebArena 相对成功率 **+24.6% / +51.1%**；分布差距变大时 **+8.9–14.0 绝对点** |
| S28 `2504.19413` Mem0（2025） | 结构化持久记忆替代全量 context（LOCOMO） | 相对 full-context：p95 延迟 **-91%**、token 成本 **-90%+** |
| S29 `2608.21265` Memory-Augmented Compression（2026） | 从**历史 trace 提炼「可复用推理模式/关键约束/关键操作」**，压缩时作为 prefill 脚手架 | 相对 Chain-of-Draft：GSM8K **+21.4**、MATH **+28.0**、BBH **+29.5**、MMLU-Sci **+6.61** 点；比标准 CoT 快 **1.14–1.49×** |
| S30 `2609.02702` Trace as State（2026） | 把 trace 当「任务状态的文本代理」，**放在长上下文之前**再重读 | 26/27 组合优于把 trace 放在后面；GraphWalks Parents EM：DeepSeek V4 Pro Preview **29.2%→81.8%**，GLM-5.2 **66.4%→100.0%** |
| S31 `2601.08079` MemoBrain（2026） | 对 reasoning 步骤建**依赖感知记忆**：剪掉无效步、折叠已完成的子轨迹、只留高显著度骨架 | GAIA / WebWalker / BrowseComp-Plus 上稳定优于强基线（摘要未给单点数字） |

**怎么读这一栏**：S20–S27 涵盖任务内、试验间经验或训练中的不同复用方式；S29/S30/S31 分别讨论提炼模式、trace 作为状态文本及依赖骨架。它们不能被合并为“原始 trace 没价值”的一致结论，特别是 S30 测的是 trace 的位置。是否在长期陪伴中临时保留、如何提炼仍需本场景验证。

### 5.2 相邻风险证据（不是长期保留的直接因果对照）

| 来源 | 机制 | 数字 |
|---|---|---|
| S32 `2307.03172` Lost in the Middle（2023） | 相关信息的位置决定能不能被用上：首尾好、中间差 | 多文档 QA 与 KV 检索上性能随位置显著变化（同长度下） |
| S39 Chroma《Context Rot》（2026，正文） | 输入变长本身让表现不稳，且**干扰项类型有差别** | 评测 **18 个 LLM**（GPT-4.1、Claude 4、Gemini 2.5、Qwen3 等）；"performance varies significantly as input length changes, even on simple tasks"；Latent List 里「相互抵消的列表操作」比 print 语句伤害更大 |
| S38 `2510.05381` Context Length Alone Hurts（2025） | **即使检索完美**，输入变长本身也掉性能 | 5 个开源/闭源模型 × 数学/QA/编码三类任务 |
| S33 `2305.04388` Turpin et al.（2023） | 加偏置特征后模型生成「合理化该答案」的 CoT，却不提偏置 | 准确率最多掉 **36%**（13 个 BIG-Bench Hard 任务，GPT-3.5） |
| S34 `2307.13702` Lanham et al.（2023） | 对 CoT 做加错/改写干预，测模型对 CoT 的依赖度 | 依赖度跨任务差异很大；"CoT's performance boost does not scale with" 依赖度 |
| S35 `2409.12183` To CoT or not to CoT（2024） | 100+ 篇元分析 + 20 数据集 × 14 模型 | CoT 主要惠及数学/逻辑；MMLU 上不加 CoT 准确率几乎相同（除非题面/回答含等号） |
| S36 `2310.01798` Self-Correct（2023） | 无外部反馈时难以自我纠错 | "at times their performance even degrades after self-correction" |
| S37 `2505.06120` Get Lost in Multi-Turn（2025） | 模型在**早期轮次做假设并过度依赖**，之后一路错下去 | 多轮比单轮平均掉 **39%**（六个生成任务，20 万+ 模拟对话）；"when LLMs take a wrong turn in a conversation, they get lost and do not recover" |
| S40 `2410.10813` LongMemEval（2024） | 长程记忆五能力（抽取/跨会话推理/时间/知识更新/弃答）测不出稳定 | 商用助手与长上下文 LLM **掉 30% 准确率**（500 题） |
| S41 `2402.17753` LoCoMo（2024） | 超长期对话的时序与因果理解 | 长上下文与 RAG 均 "substantially lag behind human performance" |
| S42 `2507.11473` CoT Monitorability（2025） | CoT 可被监控但有脆弱性 | "imperfect and allows some misbehavior to go unnoticed"；"may be fragile"，建议开发者考虑决策对 monitorability 的影响 |

**四类机制，对应四种风险**：

1. **上下文负担**：S32/S39/S38 测试位置、长度和干扰项；支持谨慎选择每次输入，不证明磁盘保存材料本身有害，也不说明临时梳理必须看不到原件。
2. **自述未必忠实**：S33/S34 说明被测 CoT 可能合理化偏置或与真实决策依赖不同；保留时应视作模型当时的表述，不能冒充完整心理因果或用户亲口确认。
3. **错误延续风险**：S37/S36 关注多轮假设和自我纠错，没有直接验证本插件长期保存 trace 的因果效果。普通记忆巩固、性格连续和记录自己说过的话不自动等于污染。
4. **适用范围**：S10 的跨家族限制针对供应商 reasoning item；S35 的结果来自其任务比较，不能推出自然语言提炼物在陪伴中必然无收益。

### 5.3 q4：「总结/压缩时该丢哪一部分」有没有人专门研究

**直接答案：本轮检索没有找到专门做“丢 reasoning、保 utterance”的消融实验。** 四组检索式的命中情况见 §2；这只说明本次检索未找到，不证明整个领域不存在，也未验证本产品丢弃后的质量。

能找到的相邻证据（都是「丢低信息内容」的泛化结论，不是「丢 reasoning」的专门结论）：

| 来源 | 丢什么 | 数字 |
|---|---|---|
| S43 `2310.04408` RECOMP（2023） | 抽取式+生成式压缩器压检索文档，可返回空串做 selective augmentation | 压缩率低至 **6%** 且性能损失极小；压缩器可跨 LM 迁移 |
| S44 `2310.06839` LongLLMLingua（2023） | 问题感知的 token 级压缩 | NaturalQuestions **+21.4%** 且 token 少 **约 4×**（GPT-3.5-Turbo）；LooGLE 成本 **-94.0%**；10k token 压 2×–6× 时延迟加速 **1.4×–2.6×** |
| S45 `2310.05736` LLMLingua（2023） | budget controller + token 级迭代压缩 | 高压缩率下保持任务性能（机制论文） |
| S46 `2310.06201` Selective Context（2023） | 按自信息剪除冗余内容 | 覆盖 arXiv 论文/新闻/长对话三类输入 |
| S47 `2604.11628` Back to Basics（2026） | 提出 **Dual-Level Redundancy**：会话间干扰 + 会话内「对话填充物」都是非信息内容，用 Query-Driven Pruning 删掉 | 在多个 benchmark 上 "consistently outperforming strong baselines"，token 与延迟更优 |

**这一小节的适用边界**：S47 讨论冗余，S43/S44 讨论其任务中的压缩收益。它们没有证明 reasoning 全属低信息类别，也没有证明“丢 reasoning 保发言”这一切分安全。measure-reasoning-volume.md 的“质量代价尚未验证”仍成立；当前分层取舍来自用户要求与资源预算。

---

## 6 对「只存对话不存推理」这条设计的具体影响

### 6.1 可能损失什么（工程推测，未做本产品消融）

| 损失 | 机制 | 严重度 |
|---|---|---|
| **决策依据**（“当时为何建议换工作”） | 正文可能未包含模型当时的全部自述；trace 也未必忠实 | 未测；H1 原件或源指针可帮助本次回看 |
| **失败教训的因果** | 只有「做错了」，没有「错在哪一步」 | 中高——S31 的 MemoBrain 正是为这个建「依赖感知记忆」 |
| **自我一致性校验** | 少了当时自述的假设或理由，可能更难解释后来变化；正文或可读源指针仍可能提供依据 | 未测；一句话是否够用也未测 |
| **可监控性** | S42 讨论 CoT 监测的价值和局限；不留副本是否降低本产品可诊断性，还取决于宿主可用原件 | 未测，不外推安全结论 |
| **调试与复盘** | 线上出问题无法回溯「模型当时看到了什么、怎么想的」 | 中——但 DSH 会话日志仍在，指针可解 |

### 6.2 可能降低哪些负担（风险提示，不能视为已测避免）

| 避免 | 机制 | 严重度 |
|---|---|---|
| **来源误读风险** | S33/S34 提示不能把模型自述当完整因果或用户确认；来源说明有助于回查 | 本产品实际影响未测 |
| **错误假设延续风险** | S37 来自其多轮任务；没有直接测本产品长期存储的效果 | 本产品实际影响未测 |
| **无关上下文负担** | S39/S38 提示每次输入的长度与干扰问题；不等于磁盘保存必然有害 | 本产品实际影响未测 |
| **跨家族状态兼容性** | S10 的限制适用于不透明 reasoning item，不能一概套给自然语言内容 | 取决于实际供应商与宿主 |
| **成本与体积** | 实测：reasoning 是纯对话的 **5.0×**、是 AI 发言的 **42.8×**（`measure-reasoning-volume.md` §2） | 高 |
| **额外敏感解释材料** | 临时过程可能包含模型对人的解释；S01 的消费者记忆约定是其产品做法 | 是否保留和如何提炼由当前方案与人格判断，不直接照搬厂商限制 |

**净判断仍是工程假设**：来源提示连续性、误解、上下文负担和体积之间存在取舍，但本篇没有证明一句话判断卡能无损补回连续性，也没有证明保存原始材料必然导致污染。当前采用“长期不背 reasoning 原文、临时整理保留可用完整过程”的双层方案，不能借论文排除人格自主选择提炼的内容。

---

## 7 对当前方案的有限建议

### 7.1 长期材料与本次整理材料分开

- C1 保留来源确认属于实际聊天的 user/assistant 正文；自动系统注入、技能卡与工具过程不能仅因落在 user/message 就当成人工说过的话。
- H1 为一次梳理提供宿主可得的完整对话、思考与工具原件。缓存文本与 host-trace 引用分清；摘要只作导航，不能冒称原文。临时容量和分页策略按主计划执行。
- 人格在梳理时决定保留哪些提炼物，kind 统一为 fact / preference / decision / pattern。epistemic 说明用户陈述、观察或解释；decision 不冒充用户亲口说过，但允许主观理解和后来改变。
- 本文不强制判断卡、80 字长度、每轮额外调用或永久分表/分池，具体索引与字段查 persona-schema.md。

### 7.2 回查与降级

引用使用权威 schema 的 srcRefs，承接 sourceSessionId/sourceEventId；可读性属于实际源状态，不因写了指针就保证永远可解。0.13.0的时间线转层保留同一原件与可用性，不能仅因转入归档标记available:false；明确纠正／遗忘和实际缺源另行表达，避免重建错误复活。

### 7.3 不能从本篇推出的规则

不把模型说过的话一律当污染、不按主动来源检索降权、不按沉默自动降重要度；关系反馈交给人格梳理理解。不因 reasoning 未必忠实就禁止它形成主观印象或用经历调整性格，也不以“主流系统这样做”为证明安全或唯一正确的依据。

---

## 8 没查够的

1. **ChatGPT / Replika / Pi 三家的官方记忆文档完全取不到**（403/404，代理也 403）。§3 里这三行只能写「未公布」，**不排除它们内部存了 reasoning**——只能说不公开。
2. **本次检索未找到直接“丢 reasoning 保 utterance”消融实验**（§5.3）；不将未命中写成整个领域已确证的空白。
3. **没有长期（月级）陪伴场景的对照实验**。现有证据最长的 LoCoMo/LongMemEval 也是「超长期对话」的评测集，不是「陪伴关系连续性」的纵向研究。
4. **Anthropic 两页打不开**（`memory`、`thinking-in-tool-and-multi-turn-workflows`），所以「multi-turn 里 thinking 具体怎么处理」只拿到 extended-thinking / context-editing / compaction 三页的侧面描述。
5. **Letta 只在 archive 分支读到 V1 实现**；main 分支已迁到 `letta-ai/letta-code`（TypeScript），新架构的存储 schema 未逐一核实，只有目录级证据。
6. **没有测「判断卡」本身的效果**：§7 的 B 档是设计建议，本文没有 A/B 数据支撑它「够用」。

---

## 9 与当前规范的接口

| 文档 | 本篇提供什么，不能覆盖什么 |
|---|---|
| measure-reasoning-volume.md | 历史体积数字可核对；没有补出“不存 reasoning 后质量无损”的结论 |
| architecture.md / 主计划 | 支持区分长期原文与临时过程的讨论；不规定 sleep/on_write 选择或必须写入时总结 |
| persona-schema.md | 当前 persona-memory/3 是唯一字段规范；本篇旧 decision_card 与 utterance 枚举不再采纳 |
| relation-model.md | 推断可作为带来源的主观印象材料，不自动认证为用户事实；不强制放进固定 assumed 字段才能存在 |

| gaps.md | 体积、来源可见性和直接消融缺失仍要分开记；未测质量不能写成已核安全 |


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

提交后保留的sourceDependencies采用sha256-identities/1来源／记录摘要收据，追踪实际读入材料而不另存原话。明确遗忘会清除受影响已提交journal的patch、助手报告与可回读诊断正文，保留提交标记、调用数等技术回执；旧档缺完整依赖时在撤销后保守去诊断正文，不删除无关人格记录。时间线转入长期或归档保留原件、人格解释和仍受容量约束的诊断；转层本身不撤销来源。人格所选retain片段本身也是来源；明确遗忘命中task-material时按真实任务会话、文档ID、SHA与Unicode范围撤销该任务资料，不能换页重新保留；时间线转层和无关新任务不受影响。

账号与社交身份复用当前QQ／微信连接，可登记其它平台并注入适配器；身份、在线核验、支持、授权和实际可用分别呈现。QQ官方主动推送取消是驱动执行事实，不改变人格主动联系的自主判断；OneBot桥按实际能力处理。同平台多个档案不等于多个并发连接。具体字段以[persona-schema第17至19节](persona-schema.md)为准，功能与资源见[新增说明](../../memory-reflection-and-social-identities.md)。

0.7.0[完整本地回归](../../verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](../../verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](../../verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](../../verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0的495/35及当时九页GUI、0.5.0和更早结果保留历史含义。0.7.0已修改核心，不能沿用0.6.0核心九文件未变的结论。


## 0.8.0 管理入口与任务式子页

顶层五个入口始终保留；打开任务式子页后，“返回”回到实际来处，当前主入口保持选中。相处提供日常状态、主动联系开关、了解人格和独立任务；记忆把可读原文、深刻经历、人物与成长记录分开；连接把QQ、微信、声音、社交身份分开，单平台再分扫码步骤、能力权限和兼容桥；创作分形象、图片服务、视频服务、生成与作品任务；设置再分实例列表、启动时加载、使用其他记忆库、交流时间、资料助手、分类容量和维护；同实例切换容量类别保留草稿，一次保存已改字段，不同实例草稿隔离。成长记录分整理进度／人格变化／手动操作，任务先显示摘要、技术元信息按需要打开。命名按钮替代原生details三角，不把所有表单同时摊开。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。该历史版本[完整本地回归](../../verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](../../verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](../../verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

## 0.9.0 自我资料、分次表达与过程保留

新增self/profile.json是有界身份资料，不是长期思考全文库。当前描述与用户想法分别供料，历史按需读取；局部selfProfileTokens默认350，仍包含在2970动态总预算内，输出、工具和宿主历史另按原口径核算。[第20节](persona-schema.md#20-自我档案初始化与交流定位090)统一定义格式与来源撤销。

分次表达复用原生模型每次实际输出及真实渠道回执，不从一份长答或reasoning中按标点切割生成伪assistant事件。每次续说可能增加模型调用和过程材料，原有临时工作区、归属、去重与容量继续适用；未交付、结果未知和计划台词不冒称已经说过。历史研究不证明这种节奏在真实长期陪伴中必然更好，本轮对照仍待执行。

## 0.9.0 人格生命周期的权威入口

名称式新建、切换、归档保留、恢复与明确文本清除按[字段契约第21节](persona-schema.md#21-人格实例生命周期与文本清除090)和[执行链](architecture.md#090-人格生命周期执行链)实施；归档不是备份，清除只处理目标库受管文本，外部资料排除，旧会话归属哈希保留。此处不另定义状态、容量或人格规则。0.9.0的统一状态与最终证据见[管理说明](../../management-ui.md#090-final-acceptance)。


## 0.12.0 当前适配增量与验收边界

本版新增QQ账号自己的头像／资料和空间说说工具，字段统一读取[第25节](persona-schema.md#0120-account-and-recovery-contract)，平台能力／权限来源与连接恢复操作见[当前能力说明](../../account-capabilities.md#0120-current-acceptance)。独立账号没有聊天target，操作原件带真实工具来源，不当作人类对话，也不自动进入人格记忆。旧好友记录、persona-memory/3兼容链与原有自主性边界继续保留。

管理认证失败、60秒本机管理限流、QQ确实离线无QR与有有效二维码是不同状态；只有明确offline且可证owned退出时提供本人一次“重新连接QQ”，不按进程名清理其他账号。源码／隔离测试与正式宿主、真实资料或空间写入分层报告；同根账号档案备份恢复已有隔离文件链验证，冷启动owner receipt仍按本轮最终证据单列。本节不重跑、扩写或替换本文件内既有历史研究／测量结果。
