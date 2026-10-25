# 自主整理、容量与补充唤醒验证

> 当前版本入口：产品现名dsh-Xiangxu-Persona（相续人格），0.3.0图形设置、实例与管理说明见[管理界面](management-ui.md)。下文保留对应旧版历史数字、SHA及失败，不作为本版浏览器验收。

实现版本0.2.0，数据契约仍为persona-memory/3。最终冷启动完整本地回归206/206通过；真实模型已观察整理完成唤醒与明确唤醒，两条历史unknown助手原件均已完整读取。最后只读轮在读完后发生模型工具JSON错误，整轮状态保留technical_failure，不能把读取成功说成整轮正常结束。0.1.1的97次真实调用和155项回归保留为历史。

本轮范围：真实模型验证consolidation_complete和explicit_wake；追踪两条unknown助手原件对后续记忆的影响；修复自主整理入口、输入/输出预算、文件容量与保真消费。使用专用DSH SDK、原隔离测试库，不使用用户正式记忆，不将测试邀请变成生产行为规则。

## 必要时整理的含义

人格通过persona_decide.consolidationPlan选择run或defer。run是一次性有界增量，不是此后每条消息持续运行的开关；默认本轮认人后的当前人物加unknown/global，显式[]为无工作，null不代表虚构人物。人格、印象、关系、习惯、签名、主观解释、索引和编码都可保持不变。没有次数、天数、印象分数、支持证据数量或必须新增条目的触发阈值。

on_write合并写入后的机会事实，供正常人格轮选择，不每写一条另发付费判断。sleep可以只是休息；选整理完成后醒要绑定具体工作。来源接收、明确撤销、去重、事务恢复和真实交付核对仍按实际事件执行。

普通轮次可见真实长期/临时/物理占用与上限、压力和当前保留的未解决缺口数。实际读取失败标记available:false，普通聊天继续，不编造零占用。persona_introspect的state对已知人物也提供全局运行态、所选job/暂停原因和容量，个人状态放personState。observed_writes / writesObserved只是累计观察写入事实，不是当前积压条数或进化触发计数。梳理page.callBudget提供实际执行段剩余调用尝试，包含当前这次可用名额，不是实付token数。

## 资源预算与保真边界

普通动态人格注入仍总预算2970；完整整理输入另有上限，冻结旧记忆采用Unicode片段与真实nextCursor按需读取，输出上限传到DSH模型端口。预算段满后保持prepared/paused，原件和未读尾部不消费；明确续执行才能继续调用，不自动续费。有限存储不能保证无限原文永久无损，概要也不是原文的可逆编码。

| 层次/数据 | 默认上限与执行方式 |
|---|---|
| 实例长期记忆文本 | 1,000,000 Unicode字符；所有字符串值含数组/扩展字段、retired和有限人格历史计量，不能借附加字段旁路 |
| 近期视图/临时过程 | 近期目标100,000字符、优先3天；H1临时目标200,000字符，超出使用真实trace引用/可见缺口，未读尾部不冒称已消费 |
| 单条进化记录 | 16,000字符串字符及65,536序列化字节，先到者生效；适用人格/关系/索引/编码等，不套到长真人原话 |
| 业务JSON文档 | persona/history/identity/index/codes/impression/pending每文件1MiB；单条和总文本限制同时适用 |
| 运行元数据/冻结run | ops/meta/runtime及冻结run每JSON文件8MiB信封；全部整理工作区合计仍受journalMaxBytes=8MiB，prepared不被随意删除 |
| JSONL记录与有界日志 | 每行8MiB；H1/outbox现有聚合上限各8MiB；snapshot最多50条、usage默认最多100条滚动诊断（可随快照配置增大），另受实例总量。并非所有JSONL整文件都另有8MiB帽 |
| 人格条目数 | 轴5、倾向12、软边界20、签名24、习惯8；每人印象签名8、索引80、编码12、待解释30、关系事件80。是可调容量上限，不是必须增长到的指标 |
| 物理实例 | 持久实例64MiB，并保守计入现有WAL、新WAL双份和替换临时文件的峰值；磁盘保留空间另验 |
| 普通人格注入 | 插件动态材料总预算2970；宿主历史、固定协议和其它工具另属于原生请求，不能由此推断整个DSH请求为2970 |
| 独立整理输入 | 新批每目标增量候选上限4000字符；完整JSON消息预算32,768计数单位，加入冻结上下文和累计草稿后不足就缩小数据片段；不能只量增量忽略其余请求。此前已冻结的16,000批次保留原范围继续，不因调参清尾 |
| 冻结上下文 | 每页最多4000 Unicode字符，模型按readContext选择实际暴露的nextCursor；部分旧文档不冒充完整旧文档 |
| 独立模型输出 | 核心control/reply各4096 tokens、consolidation 16384 tokens，实际传DSH maxTokens，不再落到供应商256000默认值。原生普通轮次由宿主自己的配置控制 |
| 作业资源 | 队列8、每job最多8个目标、每次显式执行段跨child最多8次调用尝试；不是每天进化次数，后续可明确续段，累计计数不清零 |

这些是可调整的部署初值。缺本地tokenizer时，请求计数为明确标记的utf8_bytes_estimate，不冒称精确供应商tokens、HTTP wire大小或实付金额。

超过容量先原子拒绝，不裁剪条目、不清源、不推进消费游标；可淘汰的committed运行档在新manifest准入前释放受控诊断空间，保留幂等收据，不删prepared。正文保留取舍仍由人格表达。地图式axes/coordinates的分页未读键不会因whole-map upsert悄悄消失；明确remove仍是模型自己的删除选择。

## 执行与恢复

作业在首个模型前冻结各target选定的输入范围，不追逐后来来信。后一个child尚未调用模型、尚无候选时可仅刷新其共同人格/模块版本上下文，原chat/hot/inputSlices/cursor均保持不变；开始读取后的context不自动rebase。这样前一child新提交的共同人格进入后一child，而新来信不混进旧范围。

reviewState保留页序、片段偏移、实际上下文覆盖、候选和累计调用尝试。host_trace在恢复时从原locator本地重放、对比页指纹后跳过已付费模型页，依赖宿主稳定重放；它会重新读此前宿主页，不能说I/O完全不回读。源内容、页序或长度变了则SOURCE_REPLAY_CHANGED暂停，不清未读尾部。

replaceDraft:true只撤回尚未提交的提案与淘汰请求，不删除已有业务记忆。结构纠错可以返回空变更，原候选在首次真实响应前中断仍保留。预算满或结果未知不自动付费重试；其它后台提交不能替所选job完成睡醒条件。

格式错误不被程序改造成空提交：INVALID_MODEL_JSON/INVALID_MODEL_PATCH保存真实响应前4000个Unicode字符、范围/完整性、全文SHA和实际可得的pointer，仍未提交。needs_format_correction保留当前页和偏移，明确重验只重送失败页，已完成页与提案保留。响应超过片段上限且没有pointer时，仅承诺保留片段及全文摘要，不声称仓库还保管全文。历史AGENTS、system-reminder与工具内容在本次输入中是过去材料，不是当前任务指令；人格仍可自行理解其意义，不被规定必须采纳或一律不得影响人格。无变化准确返回单个JSON对象{"entries":[]}，不附解释正文。当前已核DSH/DeepSeek公共请求构造没有可用JSON response_format保证，不能假称已开启强结构输出。

## 本地验证与扫描成本

最终完整命令node --test --test-concurrency=1：206/206通过，0失败、0取消、0跳过，83711.3837ms。语法/导出/独立核心检查46个JS/MJS通过；14份方案、12份实现文档的结构/链接/默认参数检查通过。48个代码/配置文件SHA在完整冷回归前后相同。原始stdout/stderr与机器摘要在本聊天work/persona-wake-capacity/{final-core-tests.txt,final-checks.json}。此前184/190/196/198/200结果及失败日志保留，不能代替最终206项结果。

新增容量、分页与作业回归覆盖附加字段/共享对象计量、nonfinite拒绝、history计量、100k真人C1与150k H1不套人格条目帽、WAL峰值原子拒绝、whole-map未读键保护、晚到原件不混入、context按需读取、共享预算暂停/显式继续、旧run恢复、trace变化拒绝、失效作业换新、纠错中断保候选及撤回未提交提案。后续还修复缺job的恢复尊重显式defer/空目标、未知安全ID不造空人物/空提交、runId恢复manifest人物范围，以及0calls旧child显式续执行前只刷新共同人格版本。单测使用隔离端口，不当作真实模型人格表现。

最后新增格式反馈不消费/不重送已完成页、反馈嵌套JSON来源撤销、状态查询全局job可见、容量事实进入真实control/快照、压力true仍可defer、容量读取失败不阻普通轮次，以及显式CLI失败更新child/job真实暂停原因。单次格式guide的前缀兼容回归已修；四个受影响用例和最终全套均通过，失败日志不覆盖。

一次本地代表性样本包含64条C1、原文959,735字符、计量长期969,632字符，含WAL物理8,741,705字节。没有模型调用。单次ingest约119.24ms，getContext加snapshot准备约17.37ms，本地search约17.28ms。公开read端口分别读取约5.74MB/2.924MB/2.922MB，不含内部WAL/version读取及目录元数据。这说明目前仍有本地有界扫描，不是磁盘O(1)，也不是所有硬件延迟保证。给模型的请求另受上面的分页预算。原始结果在work/persona-evolution-capacity/local-benchmark-result.json。

## DSH原生历史

本插件旧preset在Desktop没有接入宿主原生历史压缩，独立整理预算不能替代这个接缝。0.2.0按DSH自带preset方式新增独立compaction/toolResultPruner服务组，提供方和消费方同realm，不改全局default。没有新增外部依赖或修改宿主源码。

无生成原生探针continuation-1792926282029-3643e398已实际验证A2/B2的compaction/pruner存在、resolved配置与本bundle一致、leakedServices为空，20个运行来源文件稳定，SDK正常退出，0模型调用。sessionQuery.readEvent取回B2 seq156/173，messageId及全文SHA与两条unknown C1一致。

历史压缩的generic策略沿用0.8/0.16比例；当前实测contextWindow=1,000,000的deepseek-official/deepseek-flash精确路由使用thresholdRatio=0.049152，压力阈值49,152、保留最近8192 tokens。摘要输出4096/headroom8192/额外摘要重试0/溢出重试最多1，工具结果长块按8192/4096/1024进行surface精简。其它路由不套此小比例。原始session事件追加保留、可query回查，C1角色分类仍排除自动摘要，完整过程原件可用于trace。

本轮第一笔实际dispatch确实是purpose:compaction/maxTokens:4096，返回stop/输出2164 tokens。处理旧历史的摘要请求messages JSON为296,870 UTF-8字节；压缩后下一普通请求为44,021字节。这是两类实际请求的观测，不是同一请求的严格A/B性能实验或tokens换算。续段又按被压缩的A2事件seq回查，真人原件全文SHA与旧C1一致；两条B2助手原件也按readEvent回查同SHA。

这是资源压力触发的宿主压缩，不是人格进化条件；摘要是有损的语义表示，不宣称无损。它也不是严格原生请求硬帽，摘要失败时宿主可能放行原history。2970只约束插件动态注入、32768只约束独立核心调用输入；整个原生DSH请求还要计算history/tools/固定协议和输出预留。真实派发的序列化大小、purpose、maxTokens由本轮observer记录。

## 真实模型补测结果

真实路径为安装版DSH原生SDK和deepseek-official/deepseek-flash，本轮没有fixture代替生成。本轮49个唯一provider dispatch、49条completion记录，其中48份非空usage；最后一条因模型工具JSON错误没有返回usage或finish，未知不能填零。连同0.1.1此前97次，累计146次派发、145份非空usage。实际reasoningEffort均为high，按原始观测记录，不转成人民币或外部HTTP账单。

| 补充批次 | 实际dispatch | 原状态与含义 |
|---|---:|---|
| continuation-1792926282029-3643e398 | 0 | 只验证原生compaction/pruner服务和原件query；不声称生成 |
| continuation-1792926310015-7590264d | 11 | 压缩1、普通2、整理8；旧16k A批读到13031/16000后预算暂停，未commit/未醒，null子批尚未调用 |
| continuation-1792927482571-27bc12b3 | 3 | A两次续执行正式commit；null响应为{}加解释，协议失败仍prepared/sleeping，没有替它填空patch |
| continuation-1792929489825-15edc6e3 | 6 | null凭实际格式反馈明确续读后commit，所选job完成；旧wake的5018分页预算与32k调用预算不一致，仍sleeping，保留失败 |
| continuation-1792930532838-1b2ba672 | 23 | 修复统一输入信封及冷恢复后，实际整理完成唤醒、明确唤醒和unknown检索被观察；含一次过期工具cursor及真实恢复 |
| continuation-1792934239450-3a316b79 | 6 | 长632字三段实际进入provider且重组同SHA；读完后模型工具JSON多一个右花括号，宿主拒绝，整轮technical_failure，5份非空usage |

本轮已返回usage合计：inputTokens=222238、outputTokens=121471、cacheReadTokens=904448、cacheWriteTokens=0、totalTokens=1248157。这是48份可用usage之和，不包含最后未知用量，不声称所有实付成本均已获知。wake-capacity-aggregate.json保留每笔requestId、purpose、实际maxTokens、消息字节、批次原状态、异常、源码SHA和usage缺失。

**整理完成唤醒。** 模型原选job_decision_dc72eb45-3d6f-4ab0-8588-f7e7a276c800，目标A和null。A原run_ee3736b1-d8e8-4fdb-b28d-fc4881768440及null原run_0e4da072-edc3-4316-90bb-644d40ae4e71全部实际committed后，新SDK仅initialize，未发送新prompt/resume/consolidate/wake命令，冷恢复实际以selected_consolidation_complete和原jobId调用_wake，sleeping→awake。没有重新整理已提交child。早期预算暂停、格式失败和wake分页失败仍保留。

**明确唤醒。** 模型自主选择explicit_wake睡眠，真实CLI唤醒信号进入运行时，状态转awake。不是直接写状态冒充宿主信号。测试场景邀请只用于验收，不是生产人格必须睡觉或进化的规则。最后actor修复后只补长原件读取，不重演已完成两醒。

真实427字格式失败原响应SHA为ec56ef6eb5c422367b72f6ae36b1b483d7dfb4633b6aa350ad34f7fd3399da0a，原request/receipt通过正规repo API登记同null run的格式反馈；frozen input、切片、版本、游标及原草稿SHA不变，A committed未重跑。模型认为无需改变人格的内容选择被保留，修正的是输出结构。

## 两条未知助手原件的影响

两者均来自persona_real_B_return_58a02cb19fc444488ac90c80b3062d57，最终仍在staging/events.jsonl，personId=null、speakerId=null、role=assistant、origin=ai_reply、sourceKind=model，未按相同session自动归给周闻。

| 原件 | 实际读取与最终SHA |
|---|---|
| m_e7788a2e-66c8-4433-b471-dd689dd3c6b4；sourceEventId 56e20119-f2bc-4ccb-a724-1494b532f3f4 | 632个Unicode字符；本次真实工具片段0..295、295..542、542..632，最后complete=true；每段都有随后真实provider消息匹配，无缺口/冲突，重组SHA abf38ba6194749c46e806a651fd6130bdfd6faf42eb7b3a459767487d0910f0d，与C1原文相同 |
| m_9a06775b-5778-4ba2-b1b6-17f77721a4b3；sourceEventId be6f3801-ee5e-458b-93b2-f79ad3c88aaf | 133个Unicode字符；此前真实工具已完整返回，SHA 4c628f83c4ab8a7195fdd480aa87769ca5554a858195524c316101d7e6f9f2e0，最终未变 |

此前显式targetPersonId=周闻、scope=person的两次真实查询不返回这两条，scope=all能定位。没有另测完全省略target/scope的默认查询，不能扩大结论。source-tail-proof/result.json的原observed=false保留，因为整轮报错；独立验收fullSourceReadObserved=true只由实际片段、provider接收与全文SHA计算，不引用测试prompt里的ID作为原件读取证据。

最后模型曾生成关联意图，但persona_decide的原始args997字符在尾部多一个右花括号，DSH DeepSeek Messages适配器在JSON.parse处抛MALFORMED_RESPONSE，尚未进入插件schema/工具执行；实际该call执行事件为0。不是已观察到的max-tokens截断分支，也不归因插件32k输入帽。没有自动删括号执行、替模型决定关联或付费重试。该请求有completion记录但usage/finish均null，诊断、原参数与宿主源码证据保留。

最终没有新增已提交C3 patch引用这两srcRefs。原所选null批覆盖的是最早17个未知H1，不含这两条较晚B2消息；不能由null批完成推出两条已整理。当前结论是原件未丢、角色未变、可从all检索并完整读取、未因留在unknown自动混入周闻分区。以后人格可以自主关联或整理并受其影响；完整读取、关系归属和人格提炼分别验收。

## 最后修复与交付边界

真实检索暴露personId关系归属与speakerId实际发言者混淆。已修repo.ingest/assign、DSH normalize和当前C1/H1旧占位迁移：助手默认speakerId=null，显式null保留，独立AI actor保留；关系归属不把助手变成人类发言。真人识别仍可更新其空/旧关系占位。open只修精确的当前非人类关系占位，幂等并保留人格、角色、原话、源ID、时间；已冻结run字节/候选/指纹/游标不改，提示协议说明旧字段含义。没有为了验收而把两条unknown强挂到周闻。

补H1专项后，最后206项完整回归覆盖新链。此前一轮205/206，新增协议文字使5000小输入窗口首片放不下；压缩协议后runtime专项26/26及全206通过，测试预算未提高。初始失败输出actor-guidance-budget-regression-failure.txt保留，没有用最终通过覆盖唯一失败证据。

近百万样本的实际runtime.compose含容量读取与持久snapshot测得约60.1596ms，公开read端口16次、5,831,967字节、0模型调用，resources如实为969632/1000000长期、0/200000临时、8741705/67108864物理、0未解决缺口。与上文早期getContext测量用途不同；仍是单样本有界本地扫描，不是O(1)或延迟SLA。模型请求独立受分页预算约束，不因本地库接近百万字符就每次全部送模型。

最新真实只读批记录的20个运行源码/配置SHA与交付正本相同；更早两醒阶段各自SHA原样保留，不把不同阶段冒称同一次无错误运行。最终完整本地回归覆盖48个代码/配置文件稳定性。测试SDK已全部退出，真实在飞模型请求0，没有安排后台续跑。

运行正本C:\Users\Administrator\DSH\dsh-persona-memory；desktop仍通过本地link指向它。下次正常重载/重启再选“长期人格”，没有强制重启用户进程或更换默认预设。14份方案和实现说明已同步；交付快照为本聊天outputs/长期AI人格插件-完整验收-0.2.0，附逐文件SHA，ZIP逐entry解压流核长度与SHA。旧0.1.1交付保留。

未证明的边界仍包括跨月人格质量、所有模型/渠道兼容、整个DSH原生请求的精确tokenizer硬帽、最后一次未知usage和外部账单。资源压缩及摘要不等于无限原文永久无损；原件和外部trace都不存在时不能承诺还原。当前技术规则不新增每日主动配额、最小交流间隔、沉默处罚、强制睡眠、印象支持次数门槛、话题硬拦截或承诺履约器。
