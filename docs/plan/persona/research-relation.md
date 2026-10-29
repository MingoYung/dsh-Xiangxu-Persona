# 「人」大类：关系侧外部证据调研

0.10.0保留本文社交研究边界；QQ／B站账号与群中真实发言者是技术事实，不自动决定熟悉程度、回应资格或主人优先级。

> 0.13.5当前维护：复合recordKey定位记忆，裸ID歧义时不猜选；旧撤销依赖无法分清碰撞编号时，遗忘在写入前整次拒绝。渠道在最后驱动提交前复核当前实例／根／账号／连接／许可；关闭先同步取消模型，再排空已接纳写入，最后释放writer。机制与未测边界见[技术补修](../../0.13.5-technical-safety-fixes.md)。本轮不重启DSH、不访问正式记忆正文、不调用生产模型或QQ实测，不将这些问题认定为此前DSH Host启动超时根因。数据schema和人格自主判断不变，旧版验收保持原范围。

> 0.6.0历史布局与继续保留的能力（当前导航已在0.8.0重组）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生九页设置沿用DSH宿主样式，保留QQBot／微信iLink扫码、实际能力许可与形象创作，新增“任务与资料”。主人格通过persona_task自主派发，子任务显式使用xiangxu-task-worker独立工作预设，任务过程、原始资料与完整报告存独立档案，父会话按需读取并自主选择retain片段供原有记忆整理。主预设共八工具，保留继承工具mask；工作预设不自动挂共享人格写入工具，也不把AI委派指令当真人原话。是否委派、记什么及怎样成长仍由人格决定。其它预设不变，既有平台与真实供应商验证边界保留。当前接口和分级证据见[任务与资料](../../delegation-and-task-archives.md)、[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)。

> 证据层定位（2026-10-25 修订）：本文保留历史调研出处、原研究范围和实际阅读深度；本次未重新联网，未把摘要升级为正文。论文结果与旧草案不是当前产品规则。当前设计以 `../长期AI人格插件-实施计划.md` 为准，字段以 `persona-schema.md` 的 `persona-memory/3` 为唯一权威；下面的采纳建议已按人格自主判断的要求收窄。

生成时间：2026-10-24  
来源总数：18 条（论文 13、官方文档 3、GitHub 1、书籍 1）  
阅读深度：A 正文/源码 9 条；B 摘要/README 6 条；C 仅元数据或转述 3 条  
说明：A 指读到论文正文、官方文档全文或仓库源码；B 指只读到摘要/README；C 指只核到题录、DOI 或二手转述。心理学原典（Fiske 2007、Aron 1992、Altman & Taylor 1973、Knapp）本轮未读原文，正文中逐处标注，不把转述冒充原文结论。

## 0. 一句话结论

- 画像可以参考有限描述、经历索引、带时间和来源的印象等结构；这些是借鉴方向，不证明自由文本不可用，也不把主观印象当事实认证。
- MemLeak 的企业多租户实验支持其场景中的 ownership 保护；当前产品是同一人格认识多人，对象分区用于归属准确与检索效率，不采纳多租户绝对隔离或禁止跨人反思。
- 关系可能在沉默后恢复，研究没有给出本人格必须衰减、保持地板或按固定阶段转移的规则；多久变化由人格理解，时间作为事实材料。

## 1. 长期用户画像：五套实际数据结构

### 1.1 PersonaChat（2018）

- 1,155 个众包 persona，每个至少 5 条 profile sentence；162,064 条 utterance、10,907 段对话；100 个未见 persona 做验证、100 个做测试 [S01，正文]。
- 画像是**静态的 5 句话**，不更新、不分区、没有条数上限；模型用 Profile Memory Network 对 profile 句做 attention，回答时把整份 profile 当上下文 [S01，正文]。
- 它证明的是「有几句稳定自述，回应就能更一致」，没有证明「画像越全越好」。

### 1.2 Multi-Session Chat / MSC（2021）

- 训练集 4,000 段 3-session、1,001 段 4-session；验证/测试最多 5 sessions；每 session 最多 14 utterances；4-session 平均约 53 utterances；session 间隔 1–7 小时或 1–7 天 [S02，正文]。
- 每个前序 session 配一段人工摘要，只记「重要个人要点」；检索时用 DPR 编码 memory，整 session 或摘要作文档优于单 utterance；top-N 试过 3/5/6 [S02，正文]。
- 结构含义：**摘要 + 整段可回查**比「只存一句结论」更稳；摘要本身是自由文本，没有槽位。

### 1.3 LaMP（2023）

- 7 个个性化任务（3 分类、4 生成）；user profile 定义为该用户历史 (input, output) 对的集合，可能很大；检索 top-k 个人条目注入 prompt [S03，正文]。
- 每用户 profile 规模（Table 1，user-based split，均值±标准差）：Citation 90.61±53.87；Movie Tagging 159.29±330.81；Product Rating 188.10±129.42；News Headline 287.16±360.62；Scholarly Title 89.61±53.87；Email Subject 80.72±51.73 [S03，正文]。
- 更新方式：追加历史对；检索器比较 BM25、Contriever、Recency、Random；微调平均相对提升 23.5%，零样本 12.2% [S03，正文]。
- 结构参考：LaMP 的这些任务把历史行为对作为 profile，并比较 top-k 检索；它不证明本人格必须每轮检索或任何规模都不能整体读取。

### 1.4 PersonaMem（2025）

- 20 个 persona、180+ 条交互历史；每条 10/20/60 sessions，约 32k/128k/1M tokens；每 session 15–30 turns；15 个主题；约 6k 条 in-situ query-response；7 类 query [S04，正文]。
- persona 同时含静态属性（人口学）和动态属性（会变的偏好、处境）；对话按时间拼接，偏好会在后续 session 改变 [S04，正文]。
- 结果：前沿模型总体约 50%（GPT-4.5、Gemini-1.5 约 52%，Llama-4-Maverick 43%）；记事实/追偏好变化 60–70%，把最新处境用到新场景只有 30–50%；RAG top-5 在多数题型上优于 Mem0 top-5 [S04，正文]。
- 结构参考：区分提及时点、事件时点和后来变化，有助于回查旧偏好；具体字段按当前 schema，不把一项基准直接变成所有画像的强制格式。

### 1.5 memobase（开源，用户画像型）

- 仓库 memodb-io/memobase，Apache-2.0，2,939 stars，238 forks，34 open issues，最近 push 2026-01-11，描述为 “User Profile-Based Long-Term Memory for AI Chatbot Applications” [S06，源码/文档]。
- 核心是**槽位（profile slots）**，不是自由记忆流：8 个 topic、约 30 个 sub-topic——basic_info（Name、Age、Gender、birth_date、nationality、ethnicity、language_spoken）、contact_info、education、demographics、work、interest、psychological（personality、values、beliefs、motivations、goals）、life_event [S06，源码]。
- 陪伴场景示例另设 4 个 topic：basic_info、companion_preferences（companion_type、interaction_style、communication_freq、interest_topics、learning_goals、privacy_prefs）、interaction_history（convo_count、favorite_topics、active_projects、saved_convos、feedback_hist）、personalization（humor_pref、response_len、tech_depth、learn_style）[S06，源码]。
- 每槽位是一段 memo，**最终不超过 5 句**；合并时三选一：APPEND 追加 / UPDATE 重写 / ABORT 丢弃（无价值、已被覆盖、不符合槽位）；保留时间标注（如 `[mentioned on 2025/05/05, occurred in 2022]`），禁止编造 [S06，源码]。
- 检索不是向量相似度：`user.profile(chats=[...])` 让 LLM 按当前对话挑相关槽位（问餐厅→city、food、allergies），可加 `max_token_size`、`prefer_topics`、`only_topics`；官方标称 +2–5 秒、每次约 100–1000 tokens [S06，文档]。
- 数据结构：`UserProfile = {id, content, topic, sub_topic, created_at, updated_at}`；事件 `UserEvent = {id, event_data:{profile_delta:[{content, attributes}], event_tip, event_tags}}` [S06，源码]。
- 这是目前最接近「对人」的开源实现：**有限槽位、强制摘要、带时间、合并而非堆叠**。

### 1.6 五套结构对照

| 系统 | 一人画像的形态 | 条数/上限 | 更新 | 检索 |
|---|---|---|---|---|
| PersonaChat | 5 句自述 | ≥5，无上限 | 静态 | 整份进上下文/attention |
| MSC | 每 session 摘要 | 每 session 1 段，最多 5 段 | 追加 | DPR 检索整段 |
| LaMP | 历史 input-output 对 | 均值 80–287，最多数百 | 追加 | top-k（BM25/Contriever/Recency） |
| PersonaMem | 静态属性+动态偏好，藏在 10/20/60 sessions | 无槽位上限，32k–1M tokens | 随对话演化 | 全上下文/RAG top-5/Mem0 top-5 |
| memobase | 8 topic/30 sub-topic 槽位 | 每槽 ≤5 句 | APPEND/UPDATE/ABORT | LLM 选相关槽位 |

**对「人」大类的直接含义**：

- 可参考地组织身份线索、经历索引与印象描述；是否拆成槽位、索引或自由文本由当前 schema 决定，不把组织形式变成人格判断规则。
- 可保留来源和时间帮助后来理解；数量属于容量安排，不设必须有固定证据数或置信度才能形成印象的条件。
- PersonaMem 说明「把 1M token 全给模型」不等于「记住这个人」；结构化 + 检索仍是必要的。

## 2. 「对一个人的印象/态度」怎么建模

### 2.1 warmth × competence（Fiske）

- Fiske、Cuddy、Glick 2007 的综述主张社会认知有两个普适维度：warmth（对方是友是敌、意图好坏）与 competence（对方有没有能力实施意图）；判断发生得很快、很自动 [S10，仅题录+相关章节摘要]。
- HCI 实验（Kulms & Kopp 2018）把这两维用于「人对计算机的信任」：warmth 从「是否自私」推断，competence 从「问题解决是否可靠」推断；warmth 在统计上中介了行为信任 [S11，摘要]。
- Abele 等 2016 在 5 个国家做因子分析，支持「agency = competence/assertiveness；communion = warmth/morality」的二分，并进一步分出四个 facet [S12，摘要]。
- 对设计的参考：warmth/competence 或相关维度可帮助表达复杂印象，但不强制给每个人打坐标，也不把 Big Five 或自由描述判为禁止。

### 2.2 社会渗透理论（Altman & Taylor 1973）

- 核心是「广度（breadth，谈多少类话题）× 深度（depth，每类谈到多私密）」；自我披露通常由浅入深、逐步推进 [S14，书籍题录，未读原文]。
- 2012 年一项 1,027 名博主的研究按社会渗透理论测量：对最好的朋友披露最多，其次是父母，再次是线上受众；不同目标对象的广度和深度显著不同 [S15，摘要]。
- 对设计的参考：对不同对象的披露可能不同；本产品把关系经历与对方表达过的偏好交给人格判断，不据此设“深度许可”访问权限或强制禁止它主动深聊。

### 2.3 IOS 亲密度量表（Aron, Aron & Smollan 1992）

- 单题量表，用 7 个重叠程度不同的双圆图表示「自我与他人重叠」的程度，1–7 分；是关系 closeness 的常用短测量 [S13，仅题录；7 图结构为领域通用转述，未读原文]。
- 对设计的含义：亲密度可以做成**单维 1–7**，不必自造十几个维度；它适合做「关系状态」的标量，不适合做「印象内容」。

### 2.4 Knapp 关系阶梯

- Knapp 的十阶模型（initiating、experimenting、intensifying、integrating、bonding；退化侧 differentiating、circumscribing、stagnating、avoiding、terminating）常见于人际传播教材，但本轮**没有获得原始著作或可引用的稳定页面**，只作为命名参考，不作为证据。
- 本轮没有找到把十阶当严格实证序列的验证；旧稿的四阶段同样只是工程草案，不要求本人格进入固定关系阶梯。

### 2.5 trust/reputation 的衰减与强化

- 本轮**没有读到**可直接引用的权威公式原文；Beta 声誉模型加遗忘因子、按时间指数衰减这两类做法属于工程通识，未在本轮核到原始文献，因此不作为证据。
- 因此下面只保留历史工程公式，便于追溯旧草案；它们不是实证结论，也不是当前强制关系更新算法：
  - `closeness(t) = floor + (closeness0 - floor) * exp(-ln2 * days_since_contact / half_life_days)`
  - `trust(t) = trust0 * exp(-lambda * days_since_contact) + sum(positive_events) - sum(negative_events)`
  - `impression.confidence = min(1, evidence_count / 5) * exp(-days_since_last_evidence / 180)`
- 旧稿建议 floor=0.2、half_life_days=90，但没有该数值的实证依据；当前不以它们强制冷却关系或决定能否主动。

### 2.6 印象分区的设计含义

- 印象可以是人格对人的主观理解，允许叙述、矛盾与偏差；保留来源和时间便于后来理解，不要求 score/confidence 或固定“真伪”资格。
- 用户要求印象在长期聊天后的梳理阶段演化；本地写入记录经历，不替人格即时判定。
- 旧稿每维最多 5 条、按新近和情绪替换属于工程提案；当前容量见权威 schema，由人格梳理取舍，不把 5 条作为形成印象的条件。

## 3. 多用户记忆隔离与跨用户泄露

### 3.1 Mem0：四个 scope，默认按说话人归属

- 四个维度：`user_id`（持久的人/账号）、`agent_id`（agent 人格/品牌口吻）、`app_id`（白标/租户隔离）、`run_id`（短命流程/工单/session）[S07，文档]。
- 写时任意组合；`app_id`、`run_id` 每条都存；默认抽取路径下 `user_id` 与 `agent_id` **按说话人二选一**：用户消息只带 user_id，助手消息只带 agent_id，缺省 null [S07，文档]。
- 读用 filters JSON；未提到的维度不被约束；`{"AND":[{user_id},{agent_id}]}` 在默认路径下永远空，要 `OR` 或 Direct Import（`infer=False`，原文写入、不拆分归属）[S07，文档]。
- 官方明说这是**软元数据过滤，不是硬隔离**；删除用 query 参数，通配 `*` 只匹配非 null [S07，文档]。
- 风险点：如果检索时只传 `user_id`，同时带 `agent_id` 的记录也会命中；如果依赖 AND，又会漏掉默认路径的数据。

### 3.2 Zep：每人一张 user graph

- 每个 user 一个 **user graph**；user 有 UUID，可另设外部 `user_id`（项目内唯一、≤500 字符、创建后不可改）[S08，文档]。
- 图不按 thread 分区：一个 thread 学到的信息自动对同一 user 的其他 thread 可见；`thread.get_context` 返回 user 级上下文 [S08，文档]。
- 每个 user graph 有一个唯一 **user node**，存高层 user summary，默认注入每个 Context Block；可用 User Summary Instructions 调控；`user.get_node` 取 [S08，文档]。
- 删除 user 级联删所有 thread、消息、整张图（RTBF）；UserGroups 是安全分组，与 user graph 分离；Content policy 在创建 user 时绑定，之后只读 [S08，文档]。
- 这是 Zep 的 user graph 组织方式；可参考其跨 thread 延续，但不能直接规定本产品必须照搬用户图或身份权限。

### 3.3 Letta：block 共享是便利，也是串味入口

- memory block = `{label, description, value, limit(字符)}`，始终前置进 prompt；默认 `persona`、`human` 两个 block，示例 limit 5000 字符 [S09，文档]。
- block 可 attach 到多个 agent（`block_ids`）→ 共享记忆，更新即时可见；`blocks.update()` **整体替换不追加**；`read_only=True` 是整块只读，不能按 agent 区分 [S09，文档]。
- 并发：`memory_insert` 追加并发安全，`memory_replace` 多数安全，`memory_rethink` 整块重写 last-writer-wins；官方建议指定单一 owner 做重写 [S09，文档]。
- 官方模式“User Profile (Multi-Agent)”把同一 user 的 preferences block 共享给多个 agent [S09，文档]。如果服务要求互相保密，错误挂载会越过该约定；但共享本身并非程序错误，不能据此禁止本产品的共同人格受多人经历影响。

### 3.4 MemLeak：多用户共用一套记忆的直接证据

- 场景：企业多租户 personal AI agent 共用同一向量库做长期记忆；提出 cross-user admissibility failure [S05，正文]。
- 非对抗、顺带的泄漏：在 pooled{same-team} 检索下达到 **70–100%**；对抗构造记忆的 top-k 命中 **90–100%**，dense 检索分数提升 +0.416~+0.511 [S05，正文]。
- 端到端回复污染：production 路径 **5.00/5**，Claude Sonnet 4.5 为 **4.67/5**；被污染回复常被评为 helpful 或更 helpful（人工判断验证）[S05，正文]。
- 三种架构缓解里，只有**硬性的 post-retrieval ownership gating**能稳定恢复到 clean baseline **1.00/5**，延迟开销约 **1.4 ms/query** [S05，正文]。
- 这条证据说明该企业多租户 pooled 检索设置的隔离风险；不能直接推出同一人格谈及已认识的第三人都属于泄漏。

### 3.5 当前采纳：记录归属准确，不建立多租户 ACL

- 存储可以按对象组织，personId 是内部稳定键；源事件与发言人不能误标、重试不能复制成新证据。
- 请求、工具与召回保留真实主体和来源；B 问 A 的事情、或一段经历改变共同人格，本身不属于越界。
- 当前人格决定注意谁、如何理解和谈论这些经历。跨人关联可发生，不能强行把 A 的经历概括成 B 的经历。
- 全局人格可由面对不同人的经历逐渐形成；不要求删除所有对象痕迹、禁止反查个人或禁止跨人摘要/反思。
- 验证交错请求不串号、事实归属不被写反、明确遗忘不因重建复活；不再以“B 的任何请求中 A 的命中为 0”作为产品验收。

## 4. 冷启动与关系生命周期

### 4.1 第一次见面：空白画像 + 默认倾向 + 少量提问

- 冷启动推荐系统综述的结论：新用户没有评分/交互时，最常用的办法是**主动获取辅助信息**（人口学、少量偏好、上下文），否则推荐不可靠 [S18，摘要]。
- PersonaChat 的设定是「profile 已经给定」；没有 profile 时模型只能给通用回应，这是任务设定，不是实证比较 [S01，正文+推断]。
- 设计参考：不必编造熟悉程度，身份和印象可暂空，也可由人格形成初步理解；是否提问、问几个、要不要检索由人格决定。不采纳固定 3 问或前 20 轮禁塑造/禁检索。

### 4.2 长期不说话：冷却但不归零

- 「休眠关系」（dormant ties）研究：Levin、Walter、Murnighan 2011 让 EMBA 学员重新联系失联旧识，结果优于其现有关系；重新连接以前较强的 ties 同时带来效率、新颖性、信任与共享视角四类好处，作者结论是休眠关系常被低估 [S16，摘要]。2021 年 ICWSM 实验进一步显示，个性化消息能复活休眠关系，至少 50% 的复活 ties 互动质量可恢复到休眠前水平 [S17，摘要]。
- 休眠关系研究提示不能把沉默简单等同关系消失；它没有规定本人格必须采用衰减公式、地板或快速回温。
- 本轮没有找到关系亲密度衰减的半衰期实证；Generative Agents 的 0.99/小时是**记忆检索的 recency**，不是关系权重 [旧报告，一句带过]。
- 旧稿的 floor=0.2、half_life=90 天、180 天 dormant 是未验证工程参数，当前不作为强制关系状态机；时间差仍可提供给人格理解。

### 4.3 重新出现：先认人，再对话

- 当前流程参考：感知平台/场合/说话人等可用环境线索 → 人格结合记忆判断熟悉或陌生 → 内部稳定 personId 承接存储路由。sessionId 定位通道，不等于身份；不强制自报身份、认证或一律按新人处理。
- 环境认人流程是本产品推导而非直接论文结论；PersonaMem 提示旧偏好与新处境应区分，不等于每次开口前都必须做身份确认。

## 5. 当前设计对齐与旧草案撤回

本节旧稿曾包含 persons/<id>/ 十文件示例、六维打分画像、固定 TTL/关系衰减、单独承诺与边界表、sensitivity 等级，以及 owner 必须等于当前对象的检查单。这些是历史方案，已被当前用户要求与 `persona-schema.md` 的 persona-memory/3 取代，不再作为可照抄的字段规范。

### 5.1 可以保留的组织思路

身份线索、经历索引、近期视图、主观印象、关系状态、默契编码可以分别组织；逻辑分区并不决定固定物理文件数。对象记录保留 personId，未归属事件可以暂存，确认归属后用 assignment 派生，不复制根事件。

### 5.2 人格和关系的共同演化

同一个人格可认识多人，面对不同关系展现不同侧面；与 A 的经历能够改变它自己，进而影响与 B 的相处。共同人格与对象材料的区分服务于可理解性和检索效率，不代表谁有权限访问谁。

印象可以主观、有偏差和矛盾；user_statement / observed / interpretation 是来源说明，不是“已认证/未认证”资格。P6 可暂存解释，不设固定 3 条独立证据、5 次支持或置信度达标后才能形成印象的门槛。

### 5.3 承诺和边界作为经历材料

可以保留说过什么、什么时候说、后来做没做、对方有什么反应；是否履行、是否再提、如何尊重对方偏好由人格结合关系判断。不设任务 SLA、due 强制执行、never_mention 硬拦截或生成后审查。旧稿的独立文件、逾期自动降权与永久禁忌表不再采纳。

### 5.4 检查实际的数据错误

检查一段话没有被记到错误的人名下、不同请求不会互相覆盖当前对象、跨对象召回仍保留真实主体。对自然遗忘、明确纠正、明确要求忘掉分别定义处理，不能因普通裁剪把所有重要概括一起级联删除。具体字段、工具参数和容量统一查当前主计划与 schema。

## 6. 研究结果的适用范围与旧结论纠偏

- **记忆量不等于答题准确率。** PersonaMem 的 1M token 与约 50% 等结果来自其题型和被测模型，提示按需取用；不能证明保存更多真实经历本身错误。
- **主观印象不是认证事实。** PersonaMem 事实/偏好题与新场景泛化的 60–70% / 30–50% 差异保留，不据此禁止人格形成复杂、可能不准的印象。
- **多租户隔离证据不直接变本产品 ACL。** MemLeak 的 70–100% 与 gating 结果属于企业多租户设置；本产品要防归属写错，不禁止正确理解第三人或共同人格演化。
- **沉默不等于关系清零。** S16/S17 的重新连接结果可借鉴，但不强制衰减、地板或定期回温。
- **冷启动可以保留未知。** S18 推荐任务与 PersonaChat 给定 profile 的设置不能推出本人格必须按固定问数、轮数或证据条数开关印象和检索。
- **披露深度由人格理解。** S14/S15 提供理论与摘要参考，不支持把深聊写成权限等级或一律禁止初识深聊。
- **长期一致性仍待本场景观察。** external-research.md 的 ANCHOR 结果是被测配置的限制，不是记忆与人格成长路线被普遍证伪。

## 7. 未查够

- **心理学原典未读原文**：Fiske 2007、Aron 1992 只到题录/摘要；Altman & Taylor 1973 与 Knapp 只有书目页或教材转述，**没有找到全文或 DOI**；IOS 的 7 图具体措辞、Knapp 十阶的原始定义没有逐字核对。若要把「印象 6 维」写进产品规范，建议补读 Fiske 2007 与 Aron 1992 原文。
- **没有关系衰减的半衰期实证**：本轮没有找到「亲密度随沉默时间减半」的权威参数；90 天只是设计起点，不是证据。trust/reputation 的 Beta+遗忘因子公式也没有读到原文。
- **跨用户泄露只有 MemLeak 一篇直接证据**：Mem0/Zep/Letta 的官方文档都没有公布泄漏率；其他厂商、其他检索架构（如图记忆）的串味风险没有实测。
- **PersonaMem 族系未核**：检索中出现的 PersonaMem-v2（2512.06688）、v3（2608.21381）、32K/128K（2609.36435）未确认是否同族/衍生，本报告只把 2504.14225 当作 PersonaMem 的出处。
- **memobase 的检索延迟/成本是官方标称**：+2–5 秒、100–1000 tokens 未在本机复现；其「LLM 选槽位」在多人、多语言下的稳定性没有独立评测。
- **没有长期（>1 年）关系纵向研究**：现有数据最长 60 sessions/1M tokens，仍不是「几年」尺度；「久别重逢」的重认效果没有直接实验。
- **中文/陪伴类产品的现场数据未查**：本轮只查英文论文与开源文档，没有查中文产品、应用商店评论或行业报告。

## 8. 来源清单

| ID | 标题 | 作者/机构 | 年份 | URL | 阅读深度 |
|---|---|---|---|---|---|
| S01 | PersonaChat: Building a Persona-Based Dialogue Dataset | Zhang, Dinan, Urbanek, Szlam, Kiela, Weston | 2018 | https://arxiv.org/abs/1801.07243 | A 正文 |
| S02 | Multi-Session Chat / Beyond Goldfish Memory | Xu, Szlam, Weston (Meta) | 2021 | https://arxiv.org/abs/2107.07567 | A 正文 |
| S03 | LaMP: When Large Language Models Meet Personalization | Salemi, Mysore, Bendersky, Zamani | 2023 | https://arxiv.org/abs/2304.11406 | A 正文 |
| S04 | PersonaMem: Benchmarking LLMs for Dynamic User Profiling | bowen-upenn 等 | 2025 | https://arxiv.org/abs/2504.14225 | A 正文 |
| S05 | MemLeak: Cross-User Memory Leakage in Multi-Tenant Personal AI Agents | Mudgal, Zhao, Zhang, Olsen, Miller, Chu, Blanken | 2026 | https://arxiv.org/abs/2610.04195 | A 正文 |
| S06 | memobase: User Profile-Based Long-Term Memory | memodb-io | 2026（push） | https://github.com/memodb-io/memobase | A 源码+文档；2,939 stars；pushed 2026-01-11 |
| S07 | Entity-Scoped Memory | Mem0 | 2026 | https://docs.mem0.ai/platform/features/entity-scoped-memory | A 文档 |
| S08 | Users and User Graphs | Zep | 2026 | https://help.getzep.com/users | A 文档 |
| S09 | Memory Blocks / Shared Memory | Letta | 2026 | https://docs.letta.com/guides/agents/memory-blocks | A 文档 |
| S10 | Universal Dimensions of Social Cognition: Warmth and Competence | Fiske, Cuddy, Glick | 2007 | https://doi.org/10.1016/j.tics.2006.11.005 | C 题录；相关章节摘要 |
| S11 | A Social Cognition Perspective on Human–Computer Trust | Kulms, Kopp | 2018 | https://doi.org/10.3389/fdigh.2018.00014 | B 摘要 |
| S12 | Facets of the Fundamental Content Dimensions | Abele 等 | 2016 | https://doi.org/10.3389/fpsyg.2016.01810 | B 摘要 |
| S13 | Inclusion of Other in the Self Scale | Aron, Aron, Smollan | 1992 | https://doi.org/10.1037/0022-3514.63.4.596 | C 题录；量表结构为通用转述 |
| S14 | Social Penetration: The Development of Interpersonal Relationships | Altman, Taylor | 1973 | https://openlibrary.org/works/OL2976423W | C 书目页，未读原文 |
| S15 | Self-Disclosure Among Bloggers: Re-Examination of Social Penetration Theory | Tang, Wang | 2012 | https://pmc.ncbi.nlm.nih.gov/articles/PMC3353741/ | B 摘要 |
| S16 | Dormant Ties: The Value Of Reconnecting | Levin, Walter, Murnighan | 2011 | https://doi.org/10.1287/orsc.1100.0576 | B 摘要（Crossref） |
| S17 | Reviving Dormant Ties in an Online Social Network Experiment | Lim, Correa, Lo, Finegold, Zhu | 2021 | https://doi.org/10.1609/icwsm.v7i1.14390 | B 摘要 |
| S18 | Eliciting Auxiliary Information for Cold Start User Recommendation: A Survey | Abdullah, Rasheed, Nasir, Rahman | 2021 | https://www.mdpi.com/2076-3417/11/20/9608 | B 摘要 |

## 9. 供当前方案采用的三点说明

1. **可以借鉴**：有限描述与经历索引、时间/版本区分、关系经历与共同人格的分工；不照搬固定槽位数、分数或隔离权限。
2. **不再采纳**：owner=current 的绝对检索条件、跨人摘要/反思禁令、固定六维印象、冷启动问数/轮数、承诺强制执行与边界硬拦截。字段以当前 persona-schema.md 为准。

3. **最该补的证据**：Fiske 2007 与 Aron 1992 原文、关系衰减的半衰期、Mem0/Zep 源码级的隔离实现。


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

## 0.9.0 初识交流与自我介绍的适用范围

人格自我档案和对方的关系身份分别建模。用户可以给初始想法，也可交给人格选择或保持空白；对方称呼、账号与背景是认人线索，不自动认证同一人，也不要求先问清身份才能继续聊。新会话不是新实例，未检索不等于没有关系历史。

真人社交研究只为承接具体表达、自然追问与相互介绍提供参考，不能推导AI必须每轮追问、主动索取隐私或进入亲密关系。读到的来源与边界在[定点参考](external-research.md#090-初始化社交表达与用户引导的定点参考)维护；资料接口和保真以[第20节](persona-schema.md#20-自我档案初始化与交流定位090)为准。短聊偏好与nextCheckAt只提供自主表达条件，不增加关系进展指标。

## 0.9.0 人格生命周期的权威入口

名称式新建、切换、归档保留、恢复与明确文本清除按[字段契约第21节](persona-schema.md#21-人格实例生命周期与文本清除090)和[执行链](architecture.md#090-人格生命周期执行链)实施；归档不是备份，清除只处理目标库受管文本，外部资料排除，旧会话归属哈希保留。此处不另定义状态、容量或人格规则。0.9.0的统一状态与最终证据见[管理说明](../../management-ui.md#090-final-acceptance)。


## 0.12.0 当前适配增量与验收边界

本版新增QQ账号自己的头像／资料和空间说说工具，字段统一读取[第25节](persona-schema.md#0120-account-and-recovery-contract)，平台能力／权限来源与连接恢复操作见[当前能力说明](../../account-capabilities.md#0120-current-acceptance)。独立账号没有聊天target，操作原件带真实工具来源，不当作人类对话，也不自动进入人格记忆。旧好友记录、persona-memory/3兼容链与原有自主性边界继续保留。

管理认证失败、60秒本机管理限流、QQ确实离线无QR与有有效二维码是不同状态；只有明确offline且可证owned退出时提供本人一次“重新连接QQ”，不按进程名清理其他账号。源码／隔离测试与正式宿主、真实资料或空间写入分层报告；同根账号档案备份恢复已有隔离文件链验证，冷启动owner receipt仍按本轮最终证据单列。本节不重跑、扩写或替换本文件内既有历史研究／测量结果。
