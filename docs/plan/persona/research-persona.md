# "描述式人格"外部证据调研（特质 × 情境 × 印象 × 可落地 schema）

> 当前实现（0.6.0）：产品名`dsh-Xiangxu-Persona`，包名`dsh-xiangxu-persona`，预设展示名“相续人格”；内部presetId `persona-memory`与数据契约`persona-memory/3`保留兼容。原生九页设置沿用DSH宿主样式，保留QQBot／微信iLink扫码、实际能力许可与形象创作，新增“任务与资料”。主人格通过persona_task自主派发，子任务显式使用xiangxu-task-worker独立工作预设，任务过程、原始资料与完整报告存独立档案，父会话按需读取并自主选择retain片段供原有记忆整理。主预设共八工具，保留继承工具mask；工作预设不自动挂共享人格写入工具，也不把AI委派指令当真人原话。是否委派、记什么及怎样成长仍由人格决定。其它预设不变，既有平台与真实供应商验证边界保留。当前接口和分级证据见[任务与资料](../../delegation-and-task-archives.md)、[管理说明](../../management-ui.md)、[渠道接入](../../channel-integration.md)与[形象创作](../../media-and-identity.md)。

> 证据层定位（2026-10-25 修订）：本文保留历史调研出处、原研究范围和实际阅读深度；本次未重新联网，未把摘要升级为正文。论文结果与旧草案不是当前产品规则。当前设计以 `../长期AI人格插件-实施计划.md` 为准，字段以 `persona-schema.md` 的 `persona-memory/3` 为唯一权威；下面的采纳建议已按人格自主判断的要求收窄。

> 本报告讨论人格心理学中的特质与情境、对人的印象、LLM描述式人格及可借鉴的表示方向。旧稿曾另列JSON草案，本次已撤去过期字段定义；现行完整字段只见persona-schema.md，本文保留证据与设计适用边界。
> 记忆架构、上下文预算、人格漂移基准、主动性、记忆安全**不在本报告范围内**（见 `persona/external-research.md`，本报告只在需要时一句话引用其结论）。

## 0. 阅读说明

**来源总数：34 条**（心理学 18 条，LLM/角色扮演 16 条）。阅读深度分三级，正文中每条来源首次出现时都带标记：

| 深度 | 数量 | 含义 |
|---|---|---|
| 【正文】 | 2 | 逐节读过论文/页面正文（WTT 的 PMC 开放版开篇若干节、IPIP 官网 facet 页全文） |
| 【摘要】 | 29 | 只读到出版方/arXiv 摘要原文，未读正文 |
| 【元数据】 | 3 | 只取到标题、作者、年份、卷期页码、DOI；摘要被出版商屏蔽或无摘要（均 1946–1990 年经典） |

标记纪律：**凡标【摘要】的，其后所有细节只代表摘要里写了什么，不能当成论文已验证的细节**；标【元数据】的条目，其内容描述来自——明确写出的——二手转述或同类文献，不冒充原文。

取证渠道已验证可用（供后续复核）：Crossref REST（元数据最准）、OpenAlex（可重组 `abstract_inverted_index` 得摘要）、Europe PMC REST（PubMed 收录刊的摘要，比直接抓 PubMed 页面稳）、Semantic Scholar（能给出 `openAccessPdf`，据此定位真正的 PMCID）、arXiv export API（一次取多条摘要，最省）。**不要凭记忆猜 PMCID**——本次踩过，猜错后抓到的是完全无关的化学论文。

---

## 1. 人格心理学：特质与情境怎么拆开、又怎么合起来

### 1.1 CAPS：不是"人有多外向"，而是"什么条件下出现什么"

Mischel & Shoda 1995（*Psychological Review* 102(2):246–268）【摘要】把个体差异定位在两处：

1. **认知-情感中介单元的可及性**——encodings（对情境的编码）、expectancies and beliefs（预期与信念）、affects（情感）、goals（目标）；
2. **这些单元之间、以及它们与"情境的心理特征"之间的交互关系组织**。

它解释跨情境的变异模式与总体平均行为水平并存，摘要给出原型句式 "if A then she X, but if B then she Y"。这是理解 behavioral signature 的理论例子；旧稿据此要求每一条 JSON 签名必须含两个反向分支，超出了已读摘要的支持范围。当前自由描述可以记一种倾向，也可以保留矛盾和变异。

Shoda, Mischel & Wright 1994（*JPSP* 67(4):674）【摘要】是这套理论的 in vivo 证据（夏令营现场研究），给出两条可直接用于设计的结论：

- **nomothetic 层面**：跨情境一致性不是"有没有"，而是"**取决于情境心理特征的相似性**"——相似的处境下行为一致，不相似的处境下不一致；
- **idiographic 层面**：个体有稳定的 if…then situation-behavior 关系剖面；摘要举的例子是"被成人警告时表现出攻击，被同龄人威胁时表现出顺从"。

**对设计的参考**：区分环境名称与人在环境中感受到的心理线索，有助于避免机械套用同一表现。Shoda 的研究并未规定本插件禁用“深夜/工作/微信”等场景词；场景、关系和心理感受都可以成为人格理解的材料。

Mischel & Shoda 1998（Annual Review of Psychology 49:229）【摘要】将变异模式本身描述为一种人格稳定性，用以联系特质与社会认知取向。它可作为理解情境差异的参考，不给本插件 schema 的格式与禁词提供强制合法性。

### 1.2 Whole Trait Theory：描述侧是分布，解释侧是机制（两条腿）

Fleeson & Jayawickreme 2015（*Journal of Research in Personality* 56:82–92）【正文】的开篇给出五个论点，逐条抄下（这是本报告唯一读到正文的论文级来源，故保留原话结构）：

1. **描述侧**：traits 应被概念化为 **density distributions of states**（状态密度分布）；
2. 需要为 Big Five 提供**解释性**说明；
3. 加了说明之后，trait 就有两部分——**explanatory part** 与 **descriptive part**，两者应被当作可分离、再合成"whole trait"的实体；
4. 解释侧由**社会认知机制**构成；
5. 应识别出产生 Big-5 状态的这些社会认知机制。

正文里还引了两段关键史料（可核）：Allport 1968 年"向情境论者让步"（"our theory of traits cannot be so simpleminded as it once was… tendencies that constitute a person, however contradictory they may seem to be when activated differentially in various situations"），以及 Hartshorne & May 1928 的结论——"个体在不同情境下行为相似的程度，正比于这些情境的相似程度"。

**分布具体长什么样，有量化摘要可引**：Fleeson 2001（*JPSP* 80(6):1011）【摘要】用 2–3 周经验采样测 Big-Five 相关 states，四条结果：

- **individuals 内的变异很高**：典型个体在日常生活中"经常且例行地"表现出某特质**几乎所有水平**；
- 行为分布**中心倾向的个体差异几乎完全稳定**；
- **变异量本身（以及偏度、峰度）也是稳定的个体差异**；
- extraversion 的个体内变异量，反映的是**对 extraversion 相关情境线索的反应性**上的个体差异。

**对设计的参考**：只存一个分数可能丢失变异信息，但研究不要求任何 AI schema 都必须有 mean/sd/斜率，也不能把置信度等同情境反应性。若保留统计值，应有观测样本 n；sd 只表示真实样本标准差，数据不足可为 null。自由描述仍可表达尚未量化的性格。

### 1.3 facet 层：为什么"域"描述不了行为，"facet"可以

Big Five 的 domain 是 5 个；其下 facet 层在 IPIP-NEO 里是 **5 × 6 = 30 个**，每个 facet 10 题（5 正 keyed + 5 反 keyed）。这是**读到了正文**的部分（IPIP 官网 `https://ipip.ori.org/newNEOFacetsKey.htm`，Johnson 2014 的 IPIP-NEO-120 量表页【元数据】为对应论文）。结构照抄如下（α 为官网标注）：

| 域 | facet（α） |
|---|---|
| N 神经质 | N1 Anxiety .83 / N2 Anger .88 / N3 Depression .88 / N4 Self-Consciousness .80 / N5 Immoderation .77 / N6 Vulnerability .82 |
| E 外向 | E1 Friendliness .87 / E2 Gregariousness .79 / E3 Assertiveness .84 / E4 Activity Level .71 / E5 Excitement-Seeking .78 / E6 Cheerfulness .81 |
| O 开放 | O1 Imagination .83 / O2 Artistic Interests .84 / O3 Emotionality .81 / O4 Adventurousness .77 / O5 Intellect .86 / O6 Liberalism .86 |
| A 宜人 | A1 Trust .82 / A2 Morality .75 / A3 Altruism .77 / A4 Cooperation .73 / A5 Modesty .77 / A6 Sympathy .75 |
| C 尽责 | C1 Self-Efficacy .78 / C2 Orderliness .82 / C3 Dutifulness .71 / C4 Achievement-Striving .78 / C5 Self-Discipline .85 / C6 Cautiousness .76 |

**facet 层可提供哪些具体描述参考**：以下是所查量表形式与相关轨迹研究，不构成软件必须采用 facet 的证明：

- **题目本身就是"描述"而非"标签"**。官网正向题是行为陈述："Worry about things." "Take charge." "Try to lead others."；反向题如 "Am relaxed most of the time." "Have a sharp tongue." "Hold a grudge."。没有一道题是"你是外向的人吗"。这直接给了"如何写描述句"的范式：**第一人称、现在时、具体可观察反应**。
- **同域 facet 可以反向**：A4 Cooperation 的反向题是 "Have a sharp tongue."（说话刻薄），A6 Sympathy 的正向题是关心他人痛苦——同属宜人性，但一个说"会不会怼人"，一个说"会不会心疼人"。用 domain 说"A 高"会把这两件事糊在一起。
- **facet 层的纵向轨迹彼此不同**：Brandes, Kushner, Herzhoff & Tackett 2020（*JPSP*，DOI 10.1037/pspp0000367）【摘要】追踪 440 名儿童 4 个年度时点，15 个 facet 中 13 个有线性变化，但**域内异质**——Neuroticism 与 Openness 域内 facet 变化方向不一致，Extraversion 总体下降但**各 facet 的幅度与方向不同**，Conscientiousness 全部上升但**只在女孩中**。

**对设计的参考**：facet 级描述提供比粗标签更具体的表达例子；domain 或标签不因此被文献判为禁止。当前采用描述式人格是用户要求，具体层次由当前 schema 定义，不由儿童 facet 研究直接决定。

### 1.4 人际环形模型：两轴 + 八角，且"位置"比"类型"信息量大

结构参数（两条来源）：

- Wiggins 1979（*JPSP* 37(3):395–412）【元数据】：把特质词按**人际域**分类，给出两轴环状排布（dominance ↔ submission、love ↔ hate，即后称 agency/communion 的两轴）。本报告只取到书目元数据，两轴命名以 1990 年量表文献为准。
- Alden, Wiggins & Pincus 1990（*Journal of Personality Assessment*，DOI 10.1080/00223891.1990.9674088）【摘要】：用 IIP 全部 127 题、两个本科生样本（n=197、n=273）做主成分定位，**最终定为 8 个环形量表、每量表 8 题**（合并样本 n=470），在第三样本（n=974）交叉验证；并与独立编制的 IAS-R（Wiggins, Trapnell & Phillips 1988）**共享同一 circular space**。
- 两轴的上位表述可交叉引用社会认知侧：Locke 2019（*Frontiers in Psychology*，PMID 31118910）【摘要】把 IPC 概括为"由 **agency 与 communion** 两个因子定义的圆形模型"，并用 8 个各 8 题的 octant 量表在团队/组织层复现了环形性质。

**为什么"位置"比"类型"信息量大**：环形模型的价值不是把人分成 8 类，而是给一个**连续圆周坐标**——同一份人格在不同关系里可以沿圆周移动（对下属偏 agency 侧、对朋友偏 communion 侧），移动本身是可测量的。这与"同一个人本来就不只有一种性格"完全同构：**不是多贴几个类型标签，而是在同一坐标系里记多个位置**。

### 1.5 归因图式：为什么同一个行为在不同特质上"诊断力"不同

Reeder & Brewer 1979（*Psychological Review* 86(1):61）【摘要】提出三种"蕴含链接"图式：**partially restrictive / hierarchically restrictive / fully restrictive**，各自对应不同的归因推断规则——即从"观察到一次行为"推到"具备某特质"的强度，取决于该特质与行为的蕴含结构。摘要同时说明它解释了为何关于 consensus、situational context、past behavior 的信息会被区别使用。

**对设计的参考**：不同领域的行为可能有不同诊断性；这不要求本人格固定给某类道德事件更大权重，也不证明一次行为足以定性。主观印象如何改变由人格在梳理时理解，来源可回查。

---

## 2. "对某个人的印象"怎么建模

### 2.1 Asch 1946：中心特质 vs 边缘特质、首因效应——**深度不足，如实标注**

Asch, "Forming impressions of personality", *The Journal of Abnormal and Social Psychology* 41(3):258–290, 1946，DOI 10.1037/h0055756，PMID 20995551【元数据】。**该文无摘要、非开放获取**，本次只拿到书目元数据，**没有读到原文**，因此本报告不引用其具体条件数与百分比，也不把它当作已验证细节。若需引用"中心特质（warm-cold）/边缘特质（polite-blunt）/呈现顺序影响印象"这类结论，必须回溯原文或权威综述原文后再写。

**这对设计的影响是方法论的**：本 schema 的"印象更新"规则**不建立在 Asch 之上**，而建立在 2.2–2.4 三条有摘要可核的证据上。

### 2.2 双维刻板印象模型（SCM）：warmth × competence，2×4 格

Fiske, Cuddy, Glick & Xu 2002（*JPSP* 82(6):878）【摘要】，被引 7000+：

- 两个维度：**competence** 与 **warmth**；
- **混合刻板**：高 warmth 低 competence（paternalistic）、高 competence 低 warmth（envious）；四种组合对应四种情绪反应（pity、envy、admiration、contempt）；
- **结构预测**：对方的 **status** 预测我们对其 **competence** 的判断，**competition** 预测我们对 **warmth** 的判断；
- 证据面：9 个样本，覆盖性别、族裔、种族、社会经济阶层、年龄、残障。

Fiske, Cuddy & Glick 2007（*TiCS*，DOI 10.1016/j.tics.2006.11.005）【摘要】给出功能解释：社会知觉要立刻回答两个问题——"**对方意图是善是恶**"（warmth）、"**对方有没有能力执行该意图**"（competence）；两维都高 → 一致正向反应，都低 → 一致负向，**一高一低 → 可预测的矛盾反应**。

**对设计的参考**：warmth/competence 可以帮助描述矛盾印象，但不能据此禁止自由文本、要求每个人都被打两个坐标，或把群体刻板印象模型直接当具体人的事实判定。当前印象允许主观、有偏差与后续改变。

### 2.3 印象随新信息更新：不是"新近优先"，而是"低频优先"

Mende-Siedlecki, Baron & Todorov 2013（*Journal of Neuroscience*，DOI 10.1523/JNEUROSCI.2334-13.2013）【摘要】是本报告关于更新规则最硬的一条：

- **ability 域里，正面信息更具诊断性；morality 域里，负面信息更具诊断性**；
- 两者可用**同一原则**解释——**行为的主观频率**：越不常见的行为权重越大（高能力、低道德都属低频）；
- 人类被试在行为与神经两个层面都表现该不对称；右 vlPFC 在依据诊断性行为更新印象时优先激活，且激活随行为感知频率参数共变；左侧 vlPFC/IFG/STS 也呈现诊断性与敏感性模式，但主要响应**不道德行为**引发的更新。

Skowronski & Carlston 1989（*Psychological Bulletin* 105(1):131）【元数据，仅取到法文摘要】是这条线的早期综述（negativity/extremity bias in impression formation），本次**未读到正文**，只能作为"该方向早有系统综述"的注脚，不引用其数字。

**对设计的参考**：该实验中的更新不对称值得观察；旧稿将其写成按域强制 Δconf 的规则，已撤回。本产品不把 morality/ability 分类与固定奖惩当人格必须遵守的更新算法。

### 2.4 关系特定自我：把"对不同人有不同表现"写成理论

Andersen & Chen 2002（*Psychological Review* 109(4):619–645）【摘要】——这条是本次调研里**最直接命中用户原话**的理论：

- 提出 **relational self**：关于自我的知识**与关于重要他人的知识相连**，每个连接构成一种 self–other relationship；
- 重要他人的心理表征在人际相遇中被激活（transference），并**唤起相应的 relational self**；
- **可变性**来自人际情境线索，**稳定性**来自重要他人表征的 chronic accessibility；
- 原文明确写：relational selves **以 if-then 方式运作**（引 Mischel & Shoda 1995），**ifs 是触发 transference 的情境，thens 是 relational selves**；
- 个体的 relational selves 库，构成其人际模式的来源。

**这句"ifs 是触发情境、thens 是关系自我"就是 schema 第二层（对某人的印象）与第一层（情境签名）之间的接口**：情境签名的 `if` 里可以出现"对方的某个身份/关系标记"，`then` 是该关系下的行为倾向。它也解释了为什么"对不同的人不一样"不是虚伪，而是**稳定机制的稳定输出**。

### 2.5 谁的判断更准：熟人共识 > 自评

Kolar, Funder & Colvin 1996（*Journal of Personality*，DOI 10.1111/j.1467-6494.1996.tb00513.x）【摘要】：用自我评定与熟人评定去预测**录像行为**标准：

- 单个熟人的评定在预测效度上**略优于**自评；
- **两个熟人聚合后显著优于**自评；
- 结论：对"与公开行为模式相关"的人格判断，最有效的信息源可能**不是自评，而是同伴群体的共识**。

**对设计的参考**：人类熟人评定研究提示可以比较自述与观察，不能直接给 AI 自我描述设效度上限或规定外部观察永远更权威。当前保留来源说明，是否采纳反馈由人格梳理判断。

---

## 3. LLM / 角色扮演侧：有人做过"描述式人格"吗

### 3.1 CharacterGLM：把人格写成 attributes + behaviors，而不是形容词

CharacterGLM（Zhou Jinfeng 等，清华/智谱，2023-11-28，arXiv:2311.16832）【摘要】：

- 模型规模 **6B–66B**，基于 ChatGLM；
- 人格表示分两块：**attributes**（identities, interests, viewpoints, experiences, achievements, social relationships 等）与 **behaviors**（linguistic features, emotional expressions, interaction patterns 等）——即**自由文本的属性与行为配置**，而非"内向/外向"式形容词槽位；
- 人工评测在 consistency、human-likeness、engagement 三项上胜过多数主流闭源模型（含 GPT 系列）；
- 开源 6B 版本与部分训练数据。

EMNLP 2024 Industry Track 有正式版（题作 "CharacterGLM: Customizing Social Characters"，`https://aclanthology.org/2024.emnlp-industry.107.pdf`），**正文未读**。因此其 attributes/behaviors 的**具体字段模板、长度上限、是否分情境**都不清楚——见第 6 节。

### 3.2 量表式测量：能用，但只在特定 prompting 配置下有效

- Serapio-García, Safdari, Crepy, Sun, Fitz, Romero 等 2023（arXiv:2307.00184，v4 2025）【摘要】：对 18 个 LLM 施测并做心理测量学验证，三条结论——① 某些模型在**特定 prompting 配置**下输出的人格测量是 reliable & valid；② 越大、越经指令微调的模型，合成人格的信效度证据越强；③ 人格可沿目标维度被"塑形"以模仿指定人类剖面。
- Jiang, Xu, Zhu, Han, Zhang & Zhu 2022（arXiv:2206.07550）【摘要】：提出 **MPI**（Machine Personality Inventory，基于 Big Five 量表）与 **P² (Personality Prompting)**，证明可"可控地诱导特定人格"并产生多样且可验证的行为。
- Hilliard, Munoz, Wu & Koshiyama 2024（arXiv:2402.08341）【摘要】：用访谈式提示诱发 trait-activation，再用 myPersonality 数据训练的分类器从输出文本判人格；结论是**generally, all LLMs demonstrate high openness**——即多模型在开放维度上系统性饱和。
- Bhandari, Naseem, Datta, Fay & Nasim 2025（arXiv:2502.05248）【摘要】：用 BFI 等问卷测 LLM，处理训练数据污染问题后结论是——**同一模型家族内部也存在不同的主导特质与剖面**。

四条合起来说明：量表能给"可比数值"，但**数值的稳定性依赖 prompt 配置**，且**跨模型/跨家族不可直接比较**（饱和与家族内差异同时存在）。这直接限制了"用 Big Five 分数当人格本体"的做法。

### 3.3 稀疏属性 vs 稠密文本：两端都有坑（对 schema 最有价值的一条双边证据）

Tang, Wang, Fang, Zhao, Huang & He 2023（arXiv:2305.11482）【摘要】把三种 persona 来源的问题一句话说清：

- **sparse structured persona attributes 是 explicit but uninformative**（显式但信息量低）；
- **dense persona texts 是 rich but noisy**（丰富但噪声大）；
- 对话历史查询 **both noisy and uninformative**。

其做法是 CLV：把稠密描述聚成稀疏类别，再与历史查询结合。这是该任务中折中表示的一项先例，不证明纯文本或结构化标签在所有场景都被证伪，也不能推出本插件必须采用唯一混合结构。

PersonaPKT（Han, Guo, Jung, Yao, Zhang & Liu 2023，arXiv:2306.08126）【摘要】给出另一条路：**把 persona 表示为连续向量**（每个 persona 只增加 <0.1% 可训练参数），从少量同 persona 对话样本中隐式学习，从而**不需要显式人格描述**，并顺带缓解隐私问题。它是"向量表示"的实证，但代价是**不可读、不可编辑**——与"可被用户审视的描述"目标相反。

### 3.4 persona 向量：自然语言描述 → 激活空间方向（可当漂移探针）

Chen, Arditi, Sleight, Evans & Lindsey 2025（*Persona Vectors: Monitoring and Controlling Character Traits in Language Models*，arXiv:2507.21509，v3）【摘要】：

- 在模型激活空间中识别出若干特质方向——**persona vectors**（如 evil、sycophancy、propensity to hallucinate）；
- 这些向量可用于**部署时监测** Assistant 人格的波动；
- 可用于**预测与控制微调引起的人格变化**：有意的与无意的变化都与相关 persona vector 上的位移强相关；可事后干预，也可用其提出的预防性 steering 提前避免；
- 可用于**标记会导致不良人格变化的训练数据**（数据集级与单样本级）；
- 关键一句：抽取方法自动化，**只要给一个自然语言描述（natural-language description），就能对任意感兴趣的特质抽取向**。

**这一句把"描述"和"向量"接上了**：描述不是向量的替代品，而是向量的**生成器**。对设计的含义是——`desc` 句子既能进 prompt，也能（在开放权重场景）作为漂移探针的输入；闭源 API 下退化为 Nautilus Compass 那种纯文本层方案（Wang 2026，arXiv:2605.09863【摘要】：用 prompt 文本与 behavioral anchor texts 的余弦相似度做黑盒漂移检测，ROC AUC 0.83）。另有 Chen 等 2026 的预训练溯源工作（arXiv:2605.13329）【摘要，仅取到开头】。

### 3.5 角色一致性的测量方法（已有基准，不必自造）

- **CharacterEval**（Tu, Fan, Tian & Yan 2024，arXiv:2401.01275）【摘要】：中文 RPCA 基准；1,785 段多轮对话、23,020 个样本、77 个来自中文小说/剧本的角色；**13 个指标、4 个维度**；结论之一是中文 LLM 在中文角色扮演上优于 GPT-4。13 个指标的具体名字摘要未列。
- **PersonaGym**（Samuel, Zou, Zhou, Chaudhari, Kalyan, Rajpurohit 等 2024，arXiv:2407.18416）【摘要】：首个**动态** persona agent 评测框架 + **PersonaScore**（基于决策理论、与人类对齐的自动指标）；测了 10 个主流 LLM × 200 个 persona × 10,000 题；结论——**GPT-4.1 与 LLaMA-3-8b 的 PersonaScore 完全相同**，**模型规模与复杂度不必然提升 persona 保真度**。
- **PsyPlay**（Yang, Zhu, Quan, Liu & Wang 2025，arXiv:2502.03821）【摘要】：把人格特质注入角色扮演，多 agent 围绕主题讨论并持续展现指定特质；生成数据在 GPT-3.5 上达到 **80.31%** 的特质展现成功率；并观察到**与正向价值对齐的 LLM 更擅长扮演正向人格角色**。
- **Orca**（Huang 2024，arXiv:2411.10006）【摘要】：四阶段流水线——先从用户数据推断 Big Five 报告与分数，再模拟档案/背景故事/心理活动，然后做 personality-conditioned instruction prompting，最后做指令微调。

**对设计的参考**：这些基准可提供离线观察的候选方法，指标能否适用于自主成长的人格仍需验证；本插件不把预测一致、扮演固定角色或永远讨好用户当唯一目标。

### 3.6 “同一人在不同情境表现不同”的语音/行为测量参考

Zhang, Muralidhar, Gatica-Perez & Magimai-Doss（arXiv:2507.19137，v3 2026）【摘要】用双人角色扮演（中性面试 vs 有压力的客户互动）测**被感知的**人格，四条发现：

1. **被感知的人格在不同互动间显著不同**；
2. 响度、声级、频谱通量等特征在**中性互动**中指示 extraversion/agreeableness/conscientiousness/openness，而 **neuroticism 只在压力情境**下与这些特征相关；
3. 手工声学与非言语特征优于 speaker embeddings；
4. **压力情境对 neuroticism 更有预测力**。

这是语音/行为侧的观测，不是对本插件 LLM 的直接测量；它提示情境可能改变可观测信号，不能据此要求每条人格描述都按固定情境类别拆分。

### 3.7 规则/场景合约：一项 API 比赛任务中的提示比较

Ruangtanusak, Taveekitworachai & Pipatanakul 2025（*Talk Less, Call Right*，arXiv:2509.00482）【摘要】在 CPDC 2025 API 赛道比较四种提示法：基础角色提示、改进角色提示、**自动提示优化（APO）**、**规则式角色提示（RRP）**。结果：**RRP 最好**，总分 0.571 vs 零样本 0.519；其两个关键手法是 **character-card/scene-contract design** 与严格的工具调用约束。摘要还指出了两个典型失败模式：**over-speaking**（过度入戏、话太长）与 **under-acting**（该用工具时不用）。

**对设计的参考**：RRP 在该 API 比赛任务中优于所比较方法；不能将此推广成显式硬规则普遍优于自主人格。这里不采纳场景合约、工具约束作为控制日常发言和关系判断的额外闸门。

---

## 4. 设计借鉴范围：当前字段不在证据文档重复定义

旧稿在本节给出 persona-desc/1 示例、固定条目数、受控词表与自动更新阈值。这些都是调研者提出的工程草案，已由当前 `persona-schema.md` 的 `persona-memory/3` 取代，不再保留可直接照抄的旧字段表。

### 4.1 可以借鉴的方向及边界

| 研究方向 | 可借鉴之处 | 本产品不据此强制什么 |
|---|---|---|
| CAPS / Shoda | 用处境与反应的描述理解跨情境差异 | 不禁场景名，不强制两个反向分支，不以可确定预测作为人格成立条件 |
| Fleeson / WTT | 性格描述可以容纳中心倾向、变异和机制 | 不把一次命中比例叫 sd，不要求没有数据也填统计数，不将置信度当反应性 |
| IPIP facet / Brandes | 具体行为句与域内差异提供表达例子 | 不强制 IPIP 编码、禁词表或固定动词校验，不禁止内心/情绪材料 |
| 印象诊断性研究 | 可观察不同经历如何改变印象 | 不用固定 morality/ability Δconf、支持次数或置信度决定能否形成主观印象 |
| relational self | 同一人格在关系中呈现不同侧面 | 不把面对不同人变成复制不同人格，也不禁止跨人经历影响共同人格 |
| Kolar / LLM 量表研究 | 自述、外部反馈与观察可分别记录 | 不把来源分类变成事实认证或印象资格，允许自我理解不完美 |

### 4.2 数量、长度与合并阈值：没有论文推荐值

CAPS、Shoda 的夏令营研究与 WTT 没有给出“人格应有 N 条 if-then”的经验值。旧稿的 5 轴、12 facets、24 签名、48 字、特征重叠 ≥2、近 30 天 ≥2 次、连续 2 次失败、90 天归档、±0.15 位移、Δconf 0.15/0.25，均属工程推定，不能写成心理学定律。

不只是数字要降级：旧稿“场景名违反 Shoda”“5 个 domain 违反 facet 证据”“等权平均违反诊断性原则”的绝对断言也撤回。已读摘要不支持这些软件格式禁令。

当前数量配置只服务于资源容量和表达预算，不作为人格、印象或签名成立的硬资格；不要求 3 天长出 12–18 条，不设固定 3 条独立证据、5 次支持或 0.6 置信门槛。重复处理同一根事件不能机械重复计数，和人格通过多次回想自然巩固一段经历是不同问题。

### 4.3 当前表示与演化的分工

当前结构以 anchor / axes / facets / signatures / habits / retired 表达人格，由权威 schema 定义。if/then 以自由描述为主，本地线索只辅助检索；场景、关系、情绪和心理感受均可描述。锚保持身份基调，不随每轮机械漂移，可由梳理慢变并回退。

人格根据实际经历在梳理中理解和改变自己；不使用本报告旧稿的禁词检查、强制特征词表、自动增减 conf 或固定“预测失败即淘汰”规则替它判断。印象可主观、有偏差，也可以慢慢改。用户反馈是经历材料，不是外部优化器必须让它讨喜的目标。

### 4.4 观察效果不等于规定行为

可以离线比较仅锚与演化人格、回查描述和实际对话是否有关联；不能把自然变异、冲动、缺点或用户不喜欢某次发言一律当程序失败。统计项必须说明观测来源和样本量，sd 仅用于真实标准差，不能从“近 5 次成立比例”冒充得出。

上下文用多少、选哪些条目以及何时检索，参看当前主计划与 schema；本报告旧估算的 800 token 人格块和 8k token 存储量不覆盖现行总预算。

---

## 5. 证据能限制哪些结论，不能直接规定哪些行为

1. **长会话一致性有难点。** PersonaLLM、ANCHOR 的指标与条件不同；相关结果提示自评、行为、轨迹回忆要区分观察，不能断言用户的记忆人格整体路线已被证伪。
2. **单点分数可能漏掉变异。** Fleeson 的密度分布研究支持关注波动；不证明所有标量无用，也不要求本人格用固定统计值定义自己。
3. **量表受提示与模型配置影响。** Hilliard、Bhandari、Serapio-García 的结果不支持跨设置直接比较；也不能全面宣布 Big Five 或人格标签不可使用。
4. **稀疏与稠密表示各有取舍。** Tang 的任务结果支持测试折中方案，不证明所有纯标签或纯文本都失败，更不能强制唯一 schema。
5. **模型更大不保证该基准分数更高。** PersonaGym 的被测组合是反例，不能外推所有新模型都无改进。
6. **印象更新存在诊断性不对称。** Mende-Siedlecki 的实验结果可以借鉴，不要求软件固定道德负向权重，也不把人的主观判断当认证事实。
7. **自述可以与观察比较。** Kolar 是人类评定效度研究，不证明 AI 必须服从外部共识或达到固定证据条数才有性格。
8. **规则提示在特定 API 任务中有效。** Talk Less 的 0.571 vs 0.519 不构成日常人格必须接受场景合约、硬边界或工具性目标的依据。
9. **本轮缺少某字段的比较证据。** 没找到内心字段优于行为字段的研究，不等于内心/情绪没有价值或必须移出主干；用户要的自主判断不能被可观察性硬校验取代。

---

## 6. 未查够（查不到就说查不到）

1. **Asch 1946 原文完全没读到。** 无摘要、非 OA，只拿到 *J. Abnorm. Soc. Psychol.* 41(3):258–290 的书目元数据。因此"中心特质 vs 边缘特质""首因效应"的**具体条件、词表、效应量**均未经原文核实。若后续要把 Asch 写进设计依据，需补：原文或一篇逐条复述其实验条件的权威综述（并注明是综述转述）。
2. **Whole Trait Theory 只读到 PMC 版开篇若干节**（引言、"社会认知 vs 特质之争"开头）。**密度分布的具体统计参数化**（mean/sd/skew/kurtosis 如何映射到状态分布、如何从状态序列估计"whole trait"）**没读到**——那部分在正文更后面的方法章节，本次未展开。
3. **CharacterGLM 的字段模板没查清。** 只读到 arXiv 摘要（attributes/behaviors 的两大类），**具体怎么写、是否有情境维度、每条多长、总量上限**全部未知；EMNLP 2024 正式版 PDF 已定位但未读。这是"描述式人格"最接近的既有工业实现，值得优先补读。
4. **IPIP 30 facet 的"facet 比 domain 预测力更强"缺少元分析级证据。** 本次只有：官网 item 结构（正文）、Johnson 2014 量表论文（元数据）、Brandes 2020 的 facet 轨迹异质性（摘要）。**没有**找到系统比较 domain vs facet 对具体行为预测效度的元分析。
5. **Wiggins 1979 的八角（octant）名称没取到一手清单。** 只拿到：Wiggins 1979 元数据、Alden 1990 的"8 个 8 题环形量表"（摘要）、Locke 2019 的"agency × communion 两因子 + 8 octant"（摘要）。**八个 octant 的确切标签（如 assured-dominant / warm-agreeable 等）及其角度分配，本次未找到可引的一手来源**，故正文未列名称。
6. **CharacterEval 的 13 个指标没列出来。** 摘要只说"13 个指标、4 个维度"，具体指标名需读正文或仓库 README。
7. **“印象更新速度”缺时间尺度证据。** Mende-Siedlecki 2013 没给几次观察后应更新完成或何时衰减；旧草案连续 2 次失败/90 天归档等阈值已不作为当前人格的自动奖惩。

---

## 7. 来源清单（34 条，按深度分栏）

### 7.1 读到正文（2）

1. Fleeson, W., & Jayawickreme, E. (2015). *Whole Trait Theory*. Journal of Research in Personality, 56, 82–92. https://doi.org/10.1016/j.jrp.2014.10.009 ｜开放版正文：https://pmc.ncbi.nlm.nih.gov/articles/PMC4472377/ 【正文（开篇若干节）】
2. Johnson, J. A. (2014). *Measuring thirty facets of the Five Factor Model with a 120-item public domain inventory: Development of the IPIP-NEO-120*. Journal of Research in Personality. https://doi.org/10.1016/j.jrp.2014.05.003 ｜对应量表页（本次读的是这一页）：https://ipip.ori.org/newNEOFacetsKey.htm 【正文】

### 7.2 只读到摘要（28）

**人格心理学**

3. Mischel, W., & Shoda, Y. (1995). *A cognitive-affective system theory of personality: Reconceptualizing situations, dispositions, dynamics, and invariance in personality structure*. Psychological Review, 102(2), 246–268. https://doi.org/10.1037/0033-295X.102.2.246 【摘要】
4. Shoda, Y., Mischel, W., & Wright, J. C. (1994). *Intraindividual stability in the organization and patterning of behavior: Incorporating psychological situations into the idiographic analysis of personality*. JPSP, 67(4), 674. https://doi.org/10.1037/0022-3514.67.4.674 【摘要】
5. Mischel, W., & Shoda, Y. (1998). *Reconciling processing dynamics and personality dispositions*. Annual Review of Psychology, 49, 229. https://doi.org/10.1146/annurev.psych.49.1.229 【摘要】
6. Fleeson, W. (2001). *Toward a structure- and process-integrated view of personality: Traits as density distributions of states*. JPSP, 80(6), 1011. https://doi.org/10.1037/0022-3514.80.6.1011 【摘要】
7. Alden, L. E., Wiggins, J. S., & Pincus, A. L. (1990). *Construction of circumplex scales for the Inventory of Interpersonal Problems*. Journal of Personality Assessment. https://doi.org/10.1080/00223891.1990.9674088 【摘要】
8. Reeder, G. D., & Brewer, M. B. (1979). *A schematic model of dispositional attribution in interpersonal perception*. Psychological Review, 86(1), 61. https://doi.org/10.1037/0033-295X.86.1.61 【摘要】
9. Fiske, S. T., Cuddy, A. J. C., Glick, P., & Xu, J. (2002). *A model of (often mixed) stereotype content: Competence and warmth respectively follow from perceived status and competition*. JPSP, 82(6), 878. https://doi.org/10.1037/0022-3514.82.6.878 【摘要】
10. Fiske, S. T., Cuddy, A. J. C., & Glick, P. (2007). *Universal dimensions of social cognition: Warmth and competence*. Trends in Cognitive Sciences. https://doi.org/10.1016/j.tics.2006.11.005 【摘要】
11. Mende-Siedlecki, P., Baron, S. G., & Todorov, A. (2013). *Diagnostic value underlies asymmetric updating of impressions in the morality and ability domains*. Journal of Neuroscience. https://doi.org/10.1523/JNEUROSCI.2334-13.2013 【摘要】
12. Kolar, D. W., Funder, D. C., & Colvin, C. R. (1996). *Comparing the accuracy of personality judgments by the self and knowledgeable others*. Journal of Personality. https://doi.org/10.1111/j.1467-6494.1996.tb00513.x 【摘要】
13. Andersen, S. M., & Chen, S. (2002). *The relational self: An interpersonal social-cognitive theory*. Psychological Review, 109(4), 619–645. https://doi.org/10.1037/0033-295X.109.4.619 【摘要】
14. Brandes, C. M., Kushner, S. C., Herzhoff, K., & Tackett, J. L. (2020). *Facet-level personality development in the transition to adolescence*. JPSP. https://doi.org/10.1037/pspp0000367 【摘要】
15. Locke, K. D. (2019). *Development and validation of a circumplex measure of the interpersonal culture in work teams and organizations*. Frontiers in Psychology. https://pmc.ncbi.nlm.nih.gov/articles/PMC6504781/ 【摘要】

**LLM / 角色扮演**

16. Zhou, J., et al. (2023). *CharacterGLM: Customizing Chinese Conversational AI Characters with Large Language Models*. arXiv:2311.16832. https://arxiv.org/abs/2311.16832 【摘要】
17. Serapio-García, G., Safdari, M., Crepy, C., Sun, L., Fitz, S., Romero, P., et al. (2023). *Personality Traits in Large Language Models*. arXiv:2307.00184. https://arxiv.org/abs/2307.00184 【摘要】
18. Jiang, G., Xu, M., Zhu, S.-C., Han, W., Zhang, C., & Zhu, Y. (2022). *Evaluating and Inducing Personality in Pre-trained Language Models*. arXiv:2206.07550. https://arxiv.org/abs/2206.07550 【摘要】
19. Hilliard, A., Munoz, C., Wu, Z., & Koshiyama, A. (2024). *Eliciting Personality Traits in Large Language Models*. arXiv:2402.08341. https://arxiv.org/abs/2402.08341 【摘要】
20. Bhandari, P., Naseem, U., Datta, A., Fay, N., & Nasim, M. (2025). *Evaluating Personality Traits in Large Language Models: Insights from Psychological Questionnaires*. arXiv:2502.05248. https://arxiv.org/abs/2502.05248 【摘要】
21. Chen, R., Arditi, A., Sleight, H., Evans, O., & Lindsey, J. (2025). *Persona Vectors: Monitoring and Controlling Character Traits in Language Models*. arXiv:2507.21509. https://arxiv.org/abs/2507.21509 【摘要】
22. Wang, C. (2026). *Nautilus Compass: Black-box Persona Drift Detection for Production LLM Agents*. arXiv:2605.09863. https://arxiv.org/abs/2605.09863 【摘要】
23. Tu, Q., Fan, S., Tian, Z., & Yan, R. (2024). *CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agent Evaluation*. arXiv:2401.01275. https://arxiv.org/abs/2401.01275 【摘要】
24. Samuel, V., Zou, H. P., Zhou, Y., Chaudhari, S., Kalyan, A., Rajpurohit, T., et al. (2024). *PersonaGym: Evaluating Persona Agents and LLMs*. arXiv:2407.18416. https://arxiv.org/abs/2407.18416 【摘要】
25. Yang, T., Zhu, Y., Quan, X., Liu, C., & Wang, Q. (2025). *PsyPlay: Personality-Infused Role-Playing Conversational Agents*. arXiv:2502.03821. https://arxiv.org/abs/2502.03821 【摘要】
26. Huang, Y. (2024). *Orca: Enhancing Role-Playing Abilities of Large Language Models by Integrating Personality Traits*. arXiv:2411.10006. https://arxiv.org/abs/2411.10006 【摘要】
27. Tang, Y., Wang, B., Fang, M., Zhao, D., Huang, K., & He, R. (2023). *Enhancing Personalized Dialogue Generation with Contrastive Latent Variables: Combining Sparse and Dense Persona*. arXiv:2305.11482. https://arxiv.org/abs/2305.11482 【摘要】
28. Han, X., Guo, B., Jung, Y., Yao, B., Zhang, Y., & Liu, X. (2023). *PersonaPKT: Building Personalized Dialogue Agents via Parameter-efficient Knowledge Transfer*. arXiv:2306.08126. https://arxiv.org/abs/2306.08126 【摘要】
29. Zhang, A., Muralidhar, S., Gatica-Perez, D., & Magimai-Doss, M. (2025/2026). *Assessment of Personality Dimensions Across Situations in Dyadic Role-Play Scenarios*. arXiv:2507.19137. https://arxiv.org/abs/2507.19137 【摘要】
30. Ruangtanusak, S., Taveekitworachai, P., & Pipatanakul, K. (2025). *Talk Less, Call Right: Enhancing Role-Play LLM Agents with Automatic Prompt Optimization and Role Prompting*. arXiv:2509.00482. https://arxiv.org/abs/2509.00482 【摘要】

### 7.3 只拿到书目元数据（4 条；其中 3 条仅元数据，1 条仅摘要开头）

31. Asch, S. E. (1946). *Forming impressions of personality*. The Journal of Abnormal and Social Psychology, 41(3), 258–290. https://doi.org/10.1037/h0055756 ｜PMID 20995551 【元数据；无摘要、非 OA】
32. Wiggins, J. S. (1979). *A psychological taxonomy of trait-descriptive terms: The interpersonal domain*. JPSP, 37(3), 395–412. https://doi.org/10.1037/0022-3514.37.3.395 【元数据】
33. Skowronski, J. J., & Carlston, D. E. (1989). *Negativity and extremity biases in impression formation: A review of explanations*. Psychological Bulletin, 105(1), 131. https://doi.org/10.1037/0033-2909.105.1.131 【元数据；仅取到法文摘要】
34. Chen, R., et al. (2026). *Tracing Persona Vectors Through LLM Pretraining*. arXiv:2605.13329. https://arxiv.org/abs/2605.13329 【摘要，仅取到开头；因输出编码截断】

---

## 8. 一句话结论

这些来源为情境差异、关系特定自我与描述式表示提供参考，尤其与用户“同一人格面对不同人和境遇展现不同特质”的意图相容。但人类心理学、固定角色扮演与自主成长人格不是同一任务。当前由人格理解经历、形成主观印象并在梳理中演化；不从论文直接推出场景禁词、固定证据门槛、硬边界、永久锚或唯一数值更新法。具体字段和容量以主计划及 persona-schema.md 为准。


## 0.6.0 自主委派与任务资料隔离

主人格可自主选择经persona_task委派工程、研究或其它需要的任务，不设必须派发的题型、固定次数或记忆门槛。当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task；原始全局派发／Harness／编码工具仍不直接加入主预设，独立工作预设使用宿主已有工作能力和用户权限。

任务新建独立上下文并显式选择xiangxu-task-worker，可信宿主登记taskId、真实子会话、父会话和AI委派来源后才启动。宿主初始封套即使为source.kind:user，也不会作为真人C1或共享人格H1接收。主会话的任务工具调用及结果仅把安全导航元数据投影进H1；实时、回放和trace回读采用同一投影，不能把指针重新展开成工程原文。普通主人格回复、思考、其它工具和真实用户原话保留原意义。

完整委派prompt、宿主实际可取得的会话事件、工具结果与最终报告保存在独立.tasks档案；显式archive_file将所选工作区产物复制成带SHA的快照，不等于自动备份整个工程目录。默认总容量1GiB、单任务与单资料64MiB、任务收据4096条；owner可在“任务与资料”页高级设置调整资源上限。容量满保留旧资料／幂等凭据并明确报错，未归档尾部标capture.complete:false；删除／关闭任务不假称已经保存全部原件。

父会话通过status/read查询实际状态及按需读取；status默认只返回紧凑任务卡，显式documentOffset／documentLimit才附带资料目录页。retain选择真实资料的有界片段送入既有自主整理，不直接写人格、不要求任何模块变化。资料保留真实AI／工具／网页来源与原件定位，完整性、SHA与分页状态分别报告。明确遗忘通过源依赖撤销相关任务档案，旧原始宿主日志或外部副本不被冒称已删除；unknown任务不因重载自动重新执行。

完整动作、存储范围、权限与验收口径见[自主委派与任务档案](../../delegation-and-task-archives.md)。工作预设的能力限制继承DSH用户权限；full-access模式下没有额外OS沙箱。普通对话是否关注、回复、主动、睡眠以及是否整理的原有契约未变。

### 0.6.0 自动化验证与资源边界

本版最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](../../verification/0.6.0-tests.json)、[两阶段原生SDK](../../verification/0.6.0-sdk-fixture.json)及[静态自主性审查](../../verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](../../management-ui.md)单独维护。

status默认只返回紧凑任务卡和至多120字的导航摘要，不自动展开完整资料目录；明确传documentOffset／documentLimit可分页取目录，正文按documentId和Unicode offset／maxChars读取，返回nextOffset，下页传offset=nextOffset；通用工具cursor只续同一次有界响应，list.pageCursor只续任务列表。UI单次文件下载上限64MiB，不随档案扩容自动提高。archive_file虽按64KiB读取源文件，归档时仍组合受单资料容量限制的整份文件缓冲，内存随该文件大小增长；DSH冷查询也可能内部载入目标子会话日志，不能将逐页采集宣称为宿主恒定RAM。明确遗忘清理插件任务正文并保留永久撤销凭据，清理失败如实报告；它不会删除DSH原始会话历史或用户另存的工程副本。
