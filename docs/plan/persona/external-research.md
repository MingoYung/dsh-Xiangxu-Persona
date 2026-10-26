# 长期 AI 人格插件 · 外部资料调研记录

当前0.9.0定点补充初始化与自然交流参考，读取层级和不采纳项见文末；研究依据不直接成为人格规则。

> 0.6.0历史布局与继续保留的能力（当前导航已在0.8.0重组）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生九页设置沿用DSH宿主样式，保留QQBot／微信iLink扫码、实际能力许可与形象创作，新增“任务与资料”。主人格通过persona_task自主派发，子任务显式使用xiangxu-task-worker独立工作预设，任务过程、原始资料与完整报告存独立档案，父会话按需读取并自主选择retain片段供原有记忆整理。主预设共八工具，保留继承工具mask；工作预设不自动挂共享人格写入工具，也不把AI委派指令当真人原话。是否委派、记什么及怎样成长仍由人格决定。其它预设不变，既有平台与真实供应商验证边界保留。当前接口和分级证据见[任务与资料](../../delegation-and-task-archives.md)、[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)。

> 证据层定位（2026-10-25 修订）：本文保留历史调研出处、原研究范围和实际阅读深度；本次未重新联网，未把摘要升级为正文。论文结果与旧草案不是当前产品规则。当前设计以 `../长期AI人格插件-实施计划.md` 为准，字段以 `persona-schema.md` 的 `persona-memory/3` 为唯一权威；下面的采纳建议已按人格自主判断的要求收窄。

- 调研时间：2026-10-24（本机系统时间）。工作区 `C:\Users\Administrator\DSH`。
- 读取状态口径：**读到正文** = 亲自读了页面/源码正文；**仅摘要** = 通过 `export.arxiv.org/api/query` 取得标题、作者、年份与摘要全文，未读论文正文；**仓库元数据** = 通过 `api.github.com/repos/*` 读到 license / stars / pushed_at / archived，未读源码（`retrieve.py`、`scratch.py` 除外）；**打不开** = 尝试失败，注明失败原因。
- 结论分栏：`[官方]` 表示历史调研记录的来源报告，不表示脱离原实验范围的普遍事实；`[推断]` 是项目判断；`[实践]` 是待验证的借鉴方向。带 ⚠ 的条目提示风险，不自动成为人格行为限制。
- 第一轮范围说明：当时任务书写“12个概念层”，直接用户消息实际列出11个名字（记忆索引、总体记忆、编码索引、记忆梳理、短期记忆、记忆时效、性格培养、行为习惯、潜意识、主动记忆、主动聊天）；第八节保留这11项的历史映射。当前主计划包含后续补出的现实时间、关系对象和描述式人格，共14项，不以本篇历史计数覆盖当前范围。

---

## 一、分层记忆与自主整理

**S01 · MemGPT: Towards LLMs as Operating Systems**
- https://arxiv.org/abs/2310.08560 ｜ 2023 ｜ 论文 ｜ 仅摘要
- 机制：提出 *virtual context management*，仿操作系统分层内存（快/慢），在 LLM 有限上下文内通过"在内存层级间搬数据"制造大内存假象；用 **interrupt** 管理模型与用户之间的控制流。
- 可借鉴：`[实践]` 主上下文只放指令+工作集，其余进可检索归档；"中断"这个原语正可表达"人格层主动要求换页/整理"。`[推断]` 与我们的短期记忆/总体记忆分层形态同源。

**S02 · Letta（MemGPT 官方实现仓库）** — 见第六节 R01。

**S03 · Generative Agents: Interactive Simulacra of Human Behavior**
- https://arxiv.org/abs/2304.03442 ｜ 2023 ｜ 论文 ｜ 仅摘要
- 机制：用自然语言存**完整经历记录**（memory stream），随时间把记忆**综合成更高层 reflection**，再**动态检索**用于规划。
- 可借鉴：`[实践]` "原始流 + 周期性反思摘要"双层，是我们「记忆梳理」最直接的模板。

**S04 · generative_agents 官方源码（检索打分实现）**
- https://github.com/joonspk-research/generative_agents ｜ 2024（末次提交）｜ 官方仓库源码 ｜ **读到正文**
- 机制（`reverie/backend_server/persona/cognitive_modules/retrieve.py`）：三路分量各自 min-max 归一化到 [0,1] 后加权：`master = recency_w*recency*gw[0] + relevance_w*relevance*gw[1] + importance_w*importance*gw[2]`，代码里 `gw = [0.5, 3, 2]`（注释说 `[1,1,1]` 也"还行"，权重主张未来用 RL 学）；`recency = recency_decay ** i`（按 last_accessed 排序的第 i 新），取 top `n_count=30`，命中后**回写 last_accessed**。超参在 `memory_structures/scratch.py`：`recency_decay = 0.99`、`recency_w = relevance_w = importance_w = 1`、`att_bandwidth = 3`、`retention = 5`。
- 可借鉴：`[官方]` 所查实现的有效权重是时效 0.5 / 相关 3 / 重要 2；`[实践]` 可作为本地候选排序的比较基线，命中时更新 last_accessed 是该项目的做法，不直接规定本人格如何珍视一段经历。

**S05 · A-MEM: Agentic Memory for LLM Agents**
- https://arxiv.org/abs/2502.12110 ｜ 2025（NeurIPS 2025）｜ 论文 ｜ 仅摘要
- 机制：按 **Zettelkasten** 原则建互联知识网；写入新记忆时生成压缩的结构化笔记（含关键词/标签/上下文/向量）并**动态建立链接**，允许后续新记忆反向触发旧记忆的结构更新，检索结构随任务演化。
- 可借鉴：`[实践]` A-MEM 提供写入即结构化与链接演化的先例；旧稿据此要求梳理必须在写入时完成、反对睡眠批处理，已撤回。当前默认由人格自主选择睡眠及对应增量整理，可以只休息或清醒时显式run；用户可选on_write，写后合并机会，由人格在正常轮选择run/defer；写入时的归属记录与后续人格判断分开。

**S06 · Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**
- https://arxiv.org/abs/2504.19413 ｜ 2025 ｜ 论文 ｜ 仅摘要
- 机制：从对话中**抽取 + 巩固**显著信息并检索；加图结构变体捕获关系。LOCOMO 上对比 6 类基线，LLM-as-Judge 相对 OpenAI 提升 26%，图记忆再高约 2%；相比 full-context p95 延迟降 91%、token 省 90%+。
- 可借鉴：`[官方]` 上述延迟与 token 改善来自该研究的 LOCOMO 比较，不能承诺本插件同样幅度；`[实践]` 有限工作集、按需检索与抽取/巩固分工值得测试。

**S07 · Zep: A Temporal Knowledge Graph Architecture for Agent Memory**
- https://arxiv.org/abs/2501.13956 ｜ 2025 ｜ 论文 ｜ 仅摘要
- 机制：核心组件 **Graphiti**，时序感知知识图谱引擎，动态综合非结构化对话与结构化业务数据并**保留历史关系**（事实带有效期）。DMR 基准 94.8% vs MemGPT 93.4%。
- 可借鉴：`[实践]` 「记忆时效」用"边的有效期/失效"表达比"分数衰减"更能回答"那时它是什么"；`[推断]` 人格演化史需要这种可回溯的时序边。

**S08 · Graphiti（Zep 官方引擎仓库）** — 见第六节 R03。

**S09 · MemoryBank: Enhancing Large Language Models with Long-Term Memory**
- https://arxiv.org/abs/2305.10250 ｜ 2023 ｜ 论文 ｜ 仅摘要
- 机制：受**艾宾浩斯遗忘曲线**启发的记忆更新：按**时间流逝**与**记忆相对重要度**决定遗忘与强化；同时从历史交互中综合**用户人格**。落地为 AI 陪伴 chatbot SiliconFriend。
- 可借鉴：`[实践]` 记忆强度=时间衰减×重要度，且"被回忆即强化"，可与 S04 的 last_accessed 刷新合并成一条规则。`[推断]` 具体衰减参数论文摘要未给，本项目若要复现需自行标定（未核）。

**S10 · memobase** — 见第六节 R06（用户画像型长期记忆，最接近"陪伴"形态）。

**S11 · cognee** — 见第六节 R05。

---

## 二、上下文预算与注入位置

**S12 · Lost in the Middle: How Language Models Use Long Contexts**
- https://arxiv.org/abs/2307.03172 ｜ 2023（TACL）｜ 论文 ｜ 仅摘要
- 机制：多文档 QA 与 key-value 检索两个任务上，**改变相关信息位置**就显著改变性能；信息在**开头或结尾**最好，**中间**明显变差，即使长上下文模型也如此。
- 可借鉴：`[实践]` 上下文首尾布局可作为候选策略；`[推断]` 本研究的 QA/KV 位置效应不直接决定本插件每段必须放在哪，需连同宿主实际提示结构验证。

**S13 · Anthropic: Effective context engineering for AI agents**
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents （实际落到 `/research/effective-context-engineering-for-ai-agents`）｜ 2025 ｜ 官方文档 ｜ **读到正文**
- 机制：把上下文当**有限注意力预算**，"找到能最大化目标概率的**最小高信号 token 集**"；系统提示要"高度恰当"（不要硬编码脆弱 if-else，也不要空泛）；工具集要精简、去歧义；长任务用 **compaction**（摘要后重开上下文窗口，Claude Code 保留最近 5 个访问文件）、**structured note-taking**（把笔记写到上下文外的文件，如 NOTES.md / memory tool）、**sub-agent** 架构（子代理回传 1–2k token 摘要）。同时给出 **just-in-time 检索**（只存文件路径/链接等轻量标识符，运行时按需加载）与 **progressive disclosure**。
- 可借鉴：`[官方]` 文档引用 context rot 并强调有限注意力预算；`[实践]` 路径/标识符导航与按需加载可降低无关上下文。不能由此断言任意模型、任意输入长度增加都必然掉精度。

**S14 · Chroma Technical Report: Context Rot**
- https://research.trychroma.com/context-rot ｜ 2025-07-14 ｜ 厂商报告 ｜ **读到正文**（末尾 Limitations 前后被截断，主体实验完整）
- 机制：18 个模型（含 GPT-4.1、Claude 4、Gemini 2.5、Qwen3），在保持任务复杂度不变、只加长输入的条件下：性能随输入长度**普遍下降**；**针-问相似度越低，下降越快**；**哪怕一个 distractor 也会掉分**，4 个叠加更差且各 distractor 影响不均；**结构连贯的 haystack 反而比打乱的更差**（反直觉）；LongMemEval 上"只给相关片段（~300 token）"显著优于"给全量 113k token"，差距在 Claude 家族最大（表现为弃答）；复述任务上位置准确率在**序列开头**最高。
- 可借鉴：`[官方]` 检索质量比窗口大小重要，"精确挑出相关片段"优于"多给"。`[实践]` 注入顺序上，把最该被复述/遵守的内容放**开头**；`[实践]` 别用"语义相近但不完全对"的记忆凑数——它们就是 distractor。

---

## 三、人格一致性与漂移

**S15 · PersonaLLM: Investigating the Ability of LLMs to Express Personality Traits**
- https://arxiv.org/abs/2305.02547 ｜ 2023（NAACL Findings 2024）｜ 论文 ｜ 仅摘要
- 机制：让 GPT-3.5/GPT-4 扮演 Big Five 五类人格，做 44 题 BFI 自评 + 故事写作，自动与人工双评。结果：自评分数与指定人格**一致且效应量大**；文本出现可辨识的语言模式；人类对部分特质的识别率**最高 80%**，但**告知作者是 AI 后准确率显著下降**。
- 可借鉴：`[官方]` 被测试的人格提示能产生可辨识语言模式；`[推断]` 自评与外部行为回答不同问题，可结合观察，不能把问卷得分单独当成长人格已稳定的证明，也不要求行为没有变异。

**S16 · LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals**
- https://arxiv.org/abs/2411.10109 ｜ 2024（v3 于 2026 更新，**标题已改**；原题 Generative Agent Simulations of 1,000 People）｜ 论文 ｜ 仅摘要
- 机制：1,052 名美国人的 2 小时半结构访谈 / 结构化问卷 / 两者合并，构造成 generative agents；在留出的 GSS 题上准确率达本人两周重测一致性的 **83% / 82% / 86%**（仅人口学基线 74%）。
- 可借鉴：`[官方]` 该人类个体模拟研究报告访谈/问卷输入及温和的合并增益；`[推断]` 这不证明本插件只能从深度自述培养性格，也未证明普通聊天不能影响人格。

**S17 · ContextEcho: A Benchmark for Persona Drift in Long Agentic-Coding Sessions** ⚠
- https://arxiv.org/abs/2605.24279 ｜ 2026 ｜ 论文 ｜ 仅摘要
- 机制：25 探针身份测试 + snapshot-then-probe 协议（分叉会话状态再探测，不扰动主会话），3 个真实 Claude Code 会话共 3,746–9,716 轮，跨 23 个前沿模型。结论：人格漂移**跨厂商普遍**；**会话内 compaction 不能可靠重置漂移**；**单次 anchor 注入能把训练语域恢复**；漂移在工具使用场景"有益"、在纯聊天场景破坏格式契约并拉长输出。
- 可借鉴：`[官方]` 摘要报告的是其 agentic-coding 测试中的单次 anchor 注入与语域恢复；`[实践]` 可测试锚定是否帮助本插件保持身份连续。周期频率、长期陪伴效果、锚是否永久不变都不是该结果已证实的结论；当前锚可在梳理中慢变并回退。

**S18 · Best Friends, Not Forever: Evaluating Long-Horizon Persona Collapse and Behavioral Drift in AI Companions** ⚠
- https://arxiv.org/abs/2607.28818 ｜ 2026 ｜ 论文 ｜ 仅摘要
- 机制：ANCHOR 审计，2,008 段对话 × 27 人格 × 9 种交互日程 × 3 种记忆设置 × 4 个模型；分离测"人格扮演"与"轨迹回忆"。结果：**没有任何模型/配置可靠保住任一维度**；轨迹准确率均值 **44.4%**，用户状态回忆**接近四选一随机**；**没有任何测试过的上下文条件或记忆能一致解决这些失败**；问卷保持率与逐轮行为判断**互相矛盾**。
- 可借鉴：`[官方]` 被测试配置未可靠解决该审计的长期一致性与回忆任务；`[实践]` 本插件应观察身份连续与事件回忆的实际效果。不能将有限配置失败写成所有记忆方案被普遍证伪，也不把正常性格变化当失败。

---

## 四、主动对话 / 主动性 agent

**S19 · Proactive Conversational Agents with Inner Thoughts**
- https://arxiv.org/abs/2501.00383 （CHI 2025, DOI 10.1145/3706598.3713760）｜ 2024-12 提交 / 2025 发表 ｜ 论文 ｜ 仅摘要（+ACM 页面标题核实）
- 机制：批评"从上下文预测下一个说话人"的做法；据 24 人形成性研究与语言学/认知心理学，提出 **Inner Thoughts** 框架：AI 在与外显交流并行的通道里维持**连续、隐蔽的思绪流**，对"想表达的内在动机"建模，并在**合适的时机**介入；已实例化为两个实时系统（多方可视化会话）。
- 可借鉴：`[官方]` 主动性 = 持续生成"想说的话" + 单独的**时机判断**，两者分离。`[实践]` 这正好把「潜意识」和「主动聊天」拆成两个可独立评测的模块。

**S20 · Proactive Agent: Shifting LLM Agents from Reactive Responses to Active Assistance**
- https://arxiv.org/abs/2410.12361 ｜ 2024 ｜ 论文 ｜ 仅摘要
- 机制：收集真实人类活动→生成主动任务预测→人工标注"接受/拒绝"→训 **reward model** 当自动评估器→造 ProactiveBench（6,790 事件）→微调。微调后主动提供帮助 F1 **66.47%**，超过全部开源/闭源基线。
- 可借鉴：`[官方]` 66.47% 是该 ProactiveBench 设置的 F1，既非准确率也非所有主动聊天的上限；`[实践]` 接纳/拒绝可作为观察材料，但不能直接套成本产品限频、少而准或用户回应率阈值。

**S21 · Inner Monologue: Embodied Reasoning through Planning with Language Models**
- https://arxiv.org/abs/2207.05608 ｜ 2022 ｜ 论文 ｜ 仅摘要
- 机制：用**环境反馈**（成功检测、场景描述、人类交互）形成语言"内心独白"闭环，显著提升三类机器人任务的指令完成度。**注意：领域是具身操作，不是闲聊主动性。**
- 可借鉴：`[实践]` 具身任务中的环境反馈可作为参考；`[推断]` 用户回应、沉默、拒绝等事实可以交给人格在梳理时理解，但本论文没有证明闲聊中无此反馈就必然退化为噪声。

**S22 · ChatGPT Pulse（OpenAI 官方产品页）**
- https://openai.com/index/introducing-chatgpt-pulse/ ｜ 2025-09 ｜ 官方产品页 ｜ **打不开**（HTTP 403；先试 `openai.com/index/...`，又试本地化路径 `openai.com/nb-NO/index/...` 均为 403；urllib 与 web_fetch 都 403）。仅从搜索结果标题得知其为"主动推送/每日简报"类功能，**具体机制未取得正文，不引用细节**。
- 可借鉴：`[推断]` 该产品页面未取得正文，不能从搜索标题确认固定节奏或实时插话机制；本产品不据此规定主动调度。

---

## 五、记忆的安全与风险

**S23 · Memory Injection Attacks on LLM Agents via Query-Only Interaction (MINJA)** ⚠
- https://arxiv.org/abs/2503.03704 ｜ 2025 ｜ 论文 ｜ 仅摘要
- 机制：**不假设能直接改记忆库**，攻击者只通过正常提问与观测输出就把恶意记录写进记忆：设计"桥接步骤"把受害者查询链到恶意推理步骤，配 indication prompt 引导 agent 自主生成桥接，再用渐进缩短策略撤掉提示，使恶意记录在后续查询中更易被检索。
- 可借鉴：`[官方]` 该攻击设置说明普通查询也可能影响持久记忆；`[实践]` 保留 user_statement / observed / interpretation 等来源说明，防止程序把模型解释改标成用户亲口说过。这里不设印象形成资格或固定证据条数。

**S24 · AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases** ⚠
- https://arxiv.org/abs/2407.12784 ｜ 2024 ｜ 论文 ｜ 仅摘要
- 机制：首个针对通用/RAG agent 的**后门**攻击；把触发器生成写成约束优化，使带触发器的输入映射到唯一嵌入空间，从而高概率检索到恶意示例。**无需训练/微调**，触发器可迁移、隐蔽。三类真实 agent 上平均 ASR **>80%**，良性性能影响 **<1%**，投毒率 **<0.1%**。
- 可借鉴：`[官方]` 上述攻击成功率属于该研究设置；`[实践]` 它提示来源记录与数据结构校验的价值，不自动要求给本人格增加语义审查、拒绝学习或额外行为闸门。

**S25 · Understanding and Mitigating Cross-Session Attacks via Persistent Artifacts in Agent Skill Composition**
- https://arxiv.org/abs/2610.13227 ｜ 2026-10 ｜ 论文 ｜ 仅摘要
- 机制：跨会话持久化的**产物**（文件、配置、缓存）构成新攻击面，归纳三种机制：Instruction Propagation、Data Boundary Violation、**Evidence Poisoning**；SkillRelayBench 270 例，7 个模型在 Codex CLI / Gemini CLI / Claude Code 上 ASR **46.7%–77.4%**，攻击链成功率 35.6%–61.1%；防御 SkillRelayGuard（恢复产物来源 + 执行前建议复核）把 ASR 从 69.5% 降到 **10.9%**，同时合法完成率 79.6%→87.5%。
- 可借鉴：`[官方]` "带来源信息 + 执行前复核"既降风险又提完成率，不是纯成本。`[实践]` 我们的「记忆梳理」产出应携带 provenance，梳理结果视为"带来源的产物"。

**S26 · Disclosure Begets Disclosure: A Self-Reinforcing Privacy Loop in LLM Agents with Persistent Memory** ⚠
- https://arxiv.org/abs/2610.28315 ｜ 2026-10 ｜ 论文 ｜ 仅摘要
- 机制：多会话模拟，用户 24 个个人属性；对比"查记忆/不查记忆"。查记忆**提升回复质量，也提升实际泄漏率**（能从累积记录正确推断出的属性比例），且**随会话数扩大**。成因是**非对抗的普通助手行为**形成的环：记忆条件化的回复以"预设"方式把早期值带进对话，用户默认或未纠正，于是暗示与 agent 自己的猜测**被记录成事实**。移除 agent 对某属性的提及，可使其后续被披露程度下降约两倍于单轮效果。
- 可借鉴：`[官方]` 研究中的非对抗循环提示记忆来源容易混淆；`[实践]` 记录用户陈述和模型解释的差别。主观印象允许形成和改变，主动发过的话仍是真实经历，不因来源而检索降权，不按沉默自动降重要度。

**S27 · Can Agents Keep Secrets They Were Never Told? Benchmarking Latent Privacy Risks Across Sessions with MemJoin**
- https://arxiv.org/abs/2610.24359 ｜ 2026-10 ｜ 论文 ｜ 仅摘要
- 机制：MemJoin 基准 288 例，完整历史**蕴含**某敏感关系而**单会话均不足**；6 个记忆系统 + 同一天然生成模型，含 full-history / no-history 对照；分别检查存储记录与检索上下文中是否出现目标属性值、最终回答是否陈述完整且指向具体人的关系。
- 可借鉴：`[官方]` 该基准关注跨会话关系拼接；`[推断]` 是否需要组合级隐私审计取决于产品的披露约定。它不证明本插件应禁止跨对象理解、反思或正确谈论第三人。

---

## 六、可直接借鉴的开源项目

元数据均在 2026-10-24 通过 `api.github.com` 读取（stars / pushed_at / license / archived）。

| # | 仓库 | 许可证 | stars | 末次 push | 活跃度判断 | 记忆架构（官方描述+代码侧） |
|---|---|---|---|---|---|---|
| R01 | [letta-ai/letta](https://github.com/letta-ai/letta) | Apache-2.0 | 25,242 | 2026-10-18 | **活跃**，未归档 | S01 的实现：有状态 agent 平台，core/external 分层内存 + 自我编辑内存块；官方定位"stateful agents: AI with advanced memory that can learn and self-improve" |
| R02 | [mem0ai/mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 67,729 | 2026-10-23 | **最活跃**（open issues 869，迭代快） | "The Memory Layer for AI Agents"：抽取-巩固-检索，含图记忆变体（S06） |
| R03 | [getzep/graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | 32,176 | 2026-10-24 | **活跃** | 时序知识图谱引擎（S07）：边带有效期、保留历史关系 |
| R04 | [WujiangXu/A-mem](https://github.com/WujiangXu/A-mem) | MIT | 1,002 | 2026-10-22 | 活跃但体量小（open issues 2） | S05 官方代码：Zettelkasten 式动态索引 + 链接演化 |
| R05 | [topoteretes/cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | 32,717 | 2026-10-23 | **活跃** | "open-source AI memory platform"，面向 agent 的持久长期记忆，强调用小模型降本 |
| R06 | [memodb-io/memobase](https://github.com/memodb-io/memobase) | Apache-2.0 | 2,939 | 2026-01-11 | 中等（9 个月未 push，未归档） | **用户画像型**长期记忆（User Profile-Based），最贴近"陪伴型"而非"任务型"记忆 |
| R07 | [joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents) | Apache-2.0 | 22,282 | 2024-08-05 | 研究代码，**已停更**（2 年未 push） | S04：memory stream + reflection + 三因子打分检索 |

`[推断]` 选型上：要"分层+自我编辑"看 R01；要"抽取巩固+图"看 R02/R03；要"写入即索引+链接演化"抄 R04 的思路（代码量小，MIT 最宽松）；要"用户画像"看 R06；R07 只当**算法参考**（停更，且是旧模型栈）。

---

## 七、三类结论分栏

**① 来源报告的结果（保留原任务、模型与阅读深度限制）**
1. 检索三因子加权里，相关性与重要度的有效权重（3、2）远高于新近度（0.5）；`recency_decay = 0.99`（S04，源码）。
2. 相关信息落在上下文**中间**时性能显著下降；开头/结尾最好（S12）。
3. 输入变长性能**普遍**下降，且"语义相近但不精确"的内容（distractor）会主动拉低准确率；只给 ~300 token 精确片段优于给 113k token 全量（S14）。
4. 记忆系统相对 full-context 可省 90%+ token、降 91% p95 延迟（S06）。
5. S17 的测试中会话内 compaction 未可靠重置漂移，单次 anchor 注入恢复语域；不能推成周期重注入频率或永久固定锚点（S17）。
6. S18 所测试的 2,008 段对话/27 人格/4 模型及其配置未可靠保住人格与轨迹回忆；轨迹准确率 44.4%，用户状态回忆接近随机，范围限于原审计（S18）。
7. 仅靠正常提问即可向 agent 记忆投毒（S23）；投毒率 <0.1% 时 ASR >80%（S24）。
8. 记忆系统**不需要攻击者**就会因"预设-默认-回写"循环扩大隐私泄漏，且随会话数加剧（S26）。
9. S20 被测微调模型在其主动帮助基准上报告 F1 66.47%；它不是本产品聊天判断的准确率或普遍天花板。
10. S19 提出内在思绪与时机判断分离的架构，是一项研究方案，不是自主性的唯一来源。

**② 项目推断（我的判断，非文献结论）**
1. 旧稿把 S05 的写入即结构化推成必须写入时梳理，已撤回；当前 sleep / on_write 两种增量整理模式由主计划定义，不由论文决定。
2. S19 的 inner thoughts 可作候选架构；是否需要独立判断调用、能否复用正常轮次，应测成本与效果，不能承诺每轮零额外调用。
3. 「记忆时效」用**时序边（有效期）**（R03）比用分数衰减更能支撑"人格演化史"的可回溯叙述。
4. 「主动记忆」（人格自发去回忆）在文献中没有直接对应物，需要自建定义与评测。
5. 人格自评与外显行为可分别观察；本插件还需要体现主观性、缺点与情境变异，不能只追求可预测或讨喜。

**③ 可借鉴实践**
1. 可测试人格锚的呈现与更新方式；S17 只给其单次注入结果，周期频率和本场景收益仍待验证。
2. 上下文布局：人格锚与最相关记忆放**首尾**，中段放低价值内容（S12+S14）。
3. 记忆命中即刷新 `last_accessed`，把"被想起"当强化信号（S04）。
4. compaction 的调参顺序：先拉满 recall，再削 precision（S13）。
5. 记忆条目带 provenance，梳理产物按"带来源的产物"对待（S25）。
6. 将用户接纳、拒绝、未回应分别作为事实保留，交给梳理自主理解；未回应不自动等于拒绝，也不直接变成频控规则。

---

## 八、映射表（来源机制 → 本设计概念层）

| 概念层 | 主要来源 | 映射强度 | 说明 |
|---|---|---|---|
| 记忆索引 | S04（三因子打分）、S05（动态索引）、S06（抽取） | 强 | 索引 = 可检索的多因子打分 + 写入时生成的结构化笔记 |
| 总体记忆 | S01（core memory / 内存块）、S03（reflection）、S13（structured note-taking） | 强 | 常驻、高阶、跨会话；由反思与笔记沉淀而来 |
| 编码索引 | S05（关键词/标签/上下文/向量四元组） | 强 | 有结构化编码与链接的先例；本插件的关系默契编码在自主梳理时生成 |
| 记忆梳理 | S03（reflection）、S05（链接演化）、S06（consolidation）、S13（compaction） | 最强 | 合并/改写/建链/摘要，四份文献都指向同一动作 |
| 短期记忆 | S01（main context）、S13（compaction + tool result clearing）、S14（focused input） | 强 | 有限工作集与精确片段可作参考；不是任何输入越小越好的普遍定律 |
| 记忆时效 | S09（遗忘曲线）、S04（recency 0.99 + 命中刷新）、S07/R03（时序边有效期） | 强 | 三条可选路线：衰减分、命中强化、有效期 |
| 性格培养 | S15（Big Five 可设定）、S16（自述来源与收益饱和）、S18（难保一致） | 中 | 人类模拟与提示角色是参考；自主性格成长仍需本场景测试 |
| 行为习惯 | S03（日程/反思形成稳定行为）、S20（接受/拒绝反馈） | 弱 | 文献多为任务型习惯，非人格化习惯；需自定义 |
| 潜意识 | S19（inner thoughts）、S21（inner monologue，含领域警告） | 中 | 有明确对应物（并行隐流），但不是"潜意识"的完整语义 |
| 主动记忆 | 无直接对应 | 无对应 | 最接近的是 S13 的 just-in-time 检索与 S09 的主动召回，但那是"系统取用"，不是"人格自发想起" |
| 主动聊天 | S19（时机建模）、S20（主动帮助基准）、S22（未取得正文） | 强 | 可借鉴时机/内容分工；不推出本产品限频、固定检查周期或准确率上限 |
| （第 12 层） | — | — | 任务书说 12 层但只列 11 个名字，未指名者不映射 |

---

## 九、研究限制与旧设计推断的纠偏

1. **长期一致性仍需本场景验证。** S18 的 2,008 段对话、27 人格、3 种记忆设置、4 个模型未可靠解决其任务，轨迹准确率均值 44.4%。这提示风险，不证明用户的整体人格路线不成立。
2. **压缩与锚定不能由单项结果定终局。** S17 报告其测试中的 compaction 与单次 anchor 效果；没有给出永久锚、周期频率或“唯一有效手段”的证据。当前身份基调可由梳理慢变。
3. **磁盘保留量与每次注入量分开。** S12/S14/S16 的结果支持谨慎选择工作集，不支持所有经历都必须简化，也不取代人格对重要性的判断。
4. **量表与行为并非同一种测量。** S15/S18 提示两者可能不一致；不能据此全面判人格标签或问卷无效。当前偏好自由描述是用户产品选择。
5. **攻击研究给出特定威胁证据。** S23/S24/S25 的来源和数字保留在条目中；本插件保留来源、校验数据结构，不由研究自动追加生成后审查或人格硬闸门。
6. **经历与事实陈述要保留出处。** S26/S27 提示推断传播风险；记录一段对话、形成主观印象、确认某个事实不是同一件事。跨对象经历可改变同一人格，也允许正确谈论第三人，不采纳多租户绝对隔离作为本产品规则。
7. **F1 不是准确率或普遍上限。** S20 的 66.47% 来自主动帮助任务；旧稿“主动准确率天花板低，所以少而准/限频”的结论撤回。是否说话、何时再判断由人格选择。
8. **反馈研究不等于自动奖惩规范。** S21 来自具身操作；回应、未回应、拒绝可以成为理解材料，不强制沉默退避、检索降权或支持度增减。

---

## 十、没查够的主题

1. **「主动记忆」**：没有找到把"人格自发回忆"与"系统检索"区分开的文献，第八节只能写"无对应"。若要立项，需自建定义与指标。
2. **「行为习惯」**：现有工作几乎都是任务型习惯（工具调用、日程规划），缺少"对话风格习惯化"的实证。
3. **AI 陪伴产品的主动性设计（产品实践侧）**：OpenAI ChatGPT Pulse 页面 403（试过原路径与本地化路径、urllib 与 web_fetch），未取得正文；也没有找到可访问的同类官方产品文档。该主题目前只有学术侧（S19/S20）支撑，**产品侧证据缺口**。
4. **MemGPT/Letta 官方文档**未单独取证（只有论文摘要 + 仓库 API 元数据），"memory blocks 的实际字段与检索策略"未核。
5. **MemoryBank 的遗忘曲线具体公式与参数**未核（论文摘要只给机制描述）；若要复现需读正文或代码。
6. 全篇论文均为**摘要级**阅读（除 S04/S13/S14 为正文）；涉及数字的结论均来自摘要原文，但**实验设置细节未复核**，引用时请注意这一点。


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

## 0.9.0 初始化、社交表达与用户引导的定点参考

以下资料于2026-10-26读取，作为实现取舍依据，不构成人格必须遵从的社交规则，也不证明相续的长期效果。字段统一见[第20节](persona-schema.md#20-自我档案初始化与交流定位090)，普通操作见[使用说明](../../user-guide.md)。

| 来源及读取层级 | 可借鉴事实 | 本项目适用边界 |
|---|---|---|
| [SillyTavern Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)，官方正文 | 区分常驻人物资料、首次消息和对话示例 | 借鉴短自我资料与开场参考；不照搬固定剧情、人格标签或永久注入全部示例 |
| [Letta Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)，官方V1旧版正文 | persona/human记忆块持续可见、有容量限制并可更新 | 借鉴身份连续供料及对象资料区分；无需迁移框架，不把示例身份当事实 |
| [AIRI默认提示源码](https://raw.githubusercontent.com/moeru-ai/airi/main/packages/i18n/src/locales/en/base.yaml)，当日main源码 | 角色提示给出名字、虚拟身份、背景与说话方式 | 只参考初始化有明确起点；不采用其固定年龄、背景或编造过去，不声称运行质量已测 |
| [Huang等2017](https://www.hbs.edu/ris/Publication%20Files/Huang%20et%20al%202017_6945bc5e-3b3e-4c0a-addd-254c9e603c60.pdf)，摘要与讨论 | 真人初识交流中追问与回应性感知、好感有关；过多提问与互惠不足是边界 | 支持承接具体内容的参考，不支持每轮提问、先查身份或长期AI亲密效果保证 |
| [Microsoft HAX简短介绍](https://www.microsoft.com/en-us/haxtoolkit/pattern/g1-a-introductory-blurb/)，官方正文 | 简短清楚、可关闭的介绍，重复及夸大能力会造成问题 | 用户说明由界面提供，不要求人格问候时朗读操作手册 |
| [PersonaChat](https://aclanthology.org/P18-1205/)，ACL2018摘要 | 以人物资料与对象信息为条件研究个性化聊天 | 参考身份一致性验收，不把数据中的虚构履历注入本人的记忆 |
| [EmpatheticDialogues](https://aclanthology.org/P19-1534/)，ACL2019摘要 | 情绪情境对话数据与特定模型的人工感知共情评估 | 可设计回应性样本，不规定必须赞同、安慰或越聊越亲密；中文迁移与本项目效果待测 |

最终采纳的是可选初始资料、当前自我描述、简短交流定位与有界供料。任何提示都会影响生成，不承诺初始化完全无影响；不用“你是现实真人”来替代连续性技术，也不依赖一条“不要像AI”保证自然。short_chat仅偏好，分次表达仍由既有自主再判断选择。

## 0.9.0 人格生命周期的权威入口

名称式新建、切换、归档保留、恢复与明确文本清除按[字段契约第21节](persona-schema.md#21-人格实例生命周期与文本清除090)和[执行链](architecture.md#090-人格生命周期执行链)实施；归档不是备份，清除只处理目标库受管文本，外部资料排除，旧会话归属哈希保留。此处不另定义状态、容量或人格规则。0.9.0的统一状态与最终证据见[管理说明](../../management-ui.md#090-final-acceptance)。
