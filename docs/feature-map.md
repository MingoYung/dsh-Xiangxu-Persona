# 十四模块实现映射

本表说明代码落点；当前0.12.0的QQ账号操作与真实支持边界见[账号能力与验收](account-capabilities.md)，个人QQ受管向导见[操作说明](qq-one-click-setup.md)。下文0.10.0检索／平台、0.10.1界面／上下文与0.11.0个人QQ验收保留各自历史范围。人格表达的正确性、讨喜程度或持续性不能仅由结构测试断言。

| 模块 | 实现与消费点 | 验证种类 |
|---|---|---|
| 记忆索引 | repository.search，四类MemoryItem、来源/人物/全局查询 | 中文/短语、跨对象主体、原始对话与提炼物 |
| 总体记忆 | stream/index/global/persona与实例容量，evictSources | 自然淘汰保留概括、明确forget防复活、容量缺口 |
| 编码索引 | codes.json，label/meaning/cues/expandIds | 人物默契不冒充另一人共同经历，共同编码可见 |
| 记忆梳理 | prepareConsolidation→分页模型patch→applyConsolidation | 非空patch、空patch、乐观版本冲突、热区/迟到输入 |
| 短期记忆 | getContext.recent及pending页面，按近期偏好有界读取 | 窗口/容量、请求快照、长输入fragment不误确认 |
| 记忆时效 | sourceAt/observedAt、recentPreferredDays | 迟到时间不漏处理，源游标不依赖旧时间戳 |
| 性格培养 | 共同anchor/axes/facets/signatures及有限历史 | 一次经历可主观形成、不强迫新增、回滚不复活撤销 |
| 行为习惯 | persona.habits及本轮注入 | 结构/容量与共同/人物范围，无固定话术执行器 |
| 潜意识 | buildSnapshot有界材料、深刻参考及完整路由/时间 | 分段/总预算、独立冻结、无全局lastText串对象 |
| 主动记忆 | memory_search/retrievePlan | 模型选择检索，跨对象明确查询与真实主体 |
| 主动聊天 | 持久selected schedule→native followup→真实assistant | 定时复查、可见回复、outbox、急停、未知交付对账 |
| 现实时间 | epoch ms/IANA、clock端口、恢复计时 | 离线到期、原生定时器范围、事件型等待无强制闹钟 |
| 关系对象 | identity/assignment/person partitions/route绑定 | 自主认人、未知暂存、重新归属、共同人格跨关系 |
| 描述式人格 | schema结构、模型整理指南与本轮选择性材料 | 非空全字段patch、主观印象/边界/承诺均无硬干预 |

原文/思考/工具临时内容采用 cached 或可定位 host_trace；分页完整读完且提交后才消费。未暴露的内部思考不编造。DSH 自动注入不进入真人 C1，tool/result 和 reasoning 只作为独立过程材料。

维护与执行配套：单写者锁、WAL、多文件恢复、Windows rename 短占用有限重试、有界快照/历史/journal、备份hash校验与恢复journal、未知schema保护、用户显式wake/mute/resume/config入口。均不增加人格行为资格或频控。

## 0.1.1 真实模型复核

本轮实际贯通记忆、成长、主动、睡眠唤醒和两种整理模式，并修复跨目标/身份范围、注意下的轮次继续、实际环境事件以及H1遗忘依赖。对应代码落点为 core/{runtime,repository,source-dependencies}.js 与 adapters/dsh/{index,tool-schema,tool-output}.js 等；详细逐项证据、初始失败、155项最终回归及限制见[真实模型复核](real-model-validation.md)。

## 0.2.0 自主整理与容量

人格通过persona_decide.consolidationPlan选择run/defer；runtime持久作业、子run及实际读取进度，repository/store执行容量和原子拒绝，prompts/DSH模型端口执行有界context与实际输出预算。unknown/global有明确整理范围，保留原角色和未知主体。当前结果统一见[补充验证记录](evolution-and-wake-validation.md)。

## 0.3.0 原生图形管理与实例

六页界面位于DSH设置“相续人格”，由宿主现有设置slot、Connection认证载体与本地sandbox页面组成。management.js提供有界读取和明确操作；instances.js维护单活动实例、已保存配置、停用/切换与备份恢复；management operation收据持久化，冷恢复未知不重放。人格浏览、记忆/关系与来源、进化patch/有限版本差异、技术设置与维护均有页面入口。当前验收与边界见[管理说明](management-ui.md)。

## 0.4.0 聊天渠道、声音与主题

0.4.0引入第七页“聊天渠道与语音”；0.4.1保留七页功能并改为沿用DSH宿主颜色、字体和透明背景，以可换行页签、设置分隔行与自适应内容高度呈现。总览以日常说明解释主动联系开关，休息时才显示“现在叫醒”；已有OneBot桥的参数默认折叠为高级配置。channels/service.js维护本机桥回调、范围、真实actor/房间路由、有限回执及恢复代次；channels/native.js把来信接入原生inbox，并使不同发言者/房间通道共用同一个人格；channels/onebot.js执行QQ OneBot11与微信OneBot12数据规范化和实际HTTP动作。外发只有平台桥明确消息回执才投影为实际assistant对话，unknown不假清用户pending、不自动重放。

voice.js保存有界技术偏好，persona_voice由人格按需选择实际音色；channels/windows-speech.js/.ps1把已安装Windows声音生成实际WAV，渠道音频另取平台ack。语速是近似SAPI音级，pitch:false；voice-only缺能力明确失败，both可保留真实文字ack并标语音不可用。没有性格标签硬映射、每轮选声或新的成长阈值。

0.4.0当时为五工具，接入需要用户已有兼容桥；该节记录历史实现。0.5.0当时的工具、扫码与授权见下节，0.6.0当前委派见最后一节；微信官方普通群聊能力仍未实现。接口、容量及已验证边界见[聊天渠道接入](channel-integration.md)与[管理说明](management-ui.md)。个人网页与Telegram仅预留，实验mobile源码不挂载、不进入发布主入口。

## 0.5.0 陪伴范围、官方连接、权限与形象创作

> 本节是0.5.0历史实现，当时七工具并禁止人格派发；0.8.0时继续使用八工具与独立任务预设。

| 扩展 | 实现与消费点 | 验证含义 |
|---|---|---|
| 陪伴工具范围 | companion-scope.js与index.js：相续人格preset在普通DSH／IM／主动／唤醒中清空继承allow，再注册七个工具 | 不向人格提供子agent派发；其它预设不变，内部原生通道API保留 |
| 官方扫码 | connections/service.js、qq.js、wechat.js、login-qr.js；surfaces.js将真实绑定内容转二维码 | 本人手机确认后仍需选范围并启用；模拟流程不代表真实账号已登录 |
| 实际能力与许可 | channels.capabilities／execute、permissions.js、persona_platform | supported、allowed、available分开；未实现动态／RTC禁用，不凭目录伪造支持 |
| 形象档案与生成 | media/service.js、providers.js、io.js，persona_media；形象页与owner-actions | 描述／主参考／版本／锁定，图片和视频分开开关，真实任务与结果资产 |
| 有界外部资产 | owner-assets.js与父桥分块上传／下载、媒体manifest、永久撤销同步 | 不把二进制塞进每轮上下文；完整SHA，文本备份／元数据清单不冒充作品字节备份 |

0.5.0当时七工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform。新增工具不要求人格一定使用能力或固定频率更新形象，不改认人、注意、主动、睡眠与整理必要性的判断。平台媒体发送与生成分别取得回执。完整操作、容量和当前／历史证据见[渠道接入](channel-integration.md)、[形象与创作](media-and-identity.md)及[管理说明](management-ui.md#050-实现与验证范围)。


## 0.6.0 自主委派、独立工作预设与任务资料

> 以下实现继续保留，统计与源码指纹属于0.6.0历史验收；当前新增项见0.7.0节。

| 模块 | 实现与消费点 | 验证含义 |
|---|---|---|
| 受控自主派发 | index.js／tool-schema.js的persona_task；delegation/native.js显式原生spawn/caller与xiangxu-task-worker | 新上下文、真实父子归属、实际任务身份，是否派发由人格选择 |
| 工作能力范围 | delegation/worker.js与cordis.patch.yml | worker不挂共享人格工具、不直接向父发送整段过程；DSH已有权限继续适用，不冒称额外OS沙箱 |
| 完整独立资料 | delegation/archive.js／service.js | prompt、实际session events、报告、明确文件快照，分块SHA／Unicode分页／完整性与有界容量 |
| 人格记忆隔离 | delegation/isolation.js、normalize.js与index.js实时／回放／readTrace | kind:user委派不进入人类C1，parent任务控制仅导航metadata，retained实际片段可供原有自主整理 |
| 生命周期与界面 | “任务与资料”页、surfaces tasks.*、instance单写者与forget hooks | 不因只读浏览启动模型，prepared／unknown不自动重派，取消与来源撤销按实际回执报告 |

当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task。任务是否值得记、对人格和关系有何影响由人格自主理解；分流只保证实际来源、归档、权限和处理预算。当前证据与操作见[自主委派与任务档案](delegation-and-task-archives.md)和[管理说明](management-ui.md)。0.5.0的422／85＋22及更早结果保留各自范围，不充当0.6.0新源实测。

本版最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](verification/0.6.0-tests.json)、[两阶段原生SDK](verification/0.6.0-sdk-fixture.json)及[静态自主性审查](verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](management-ui.md)单独维护。

status默认只返回紧凑任务卡和至多120字的导航摘要，不自动展开完整资料目录；明确传documentOffset／documentLimit可分页取目录，正文按documentId和Unicode offset／maxChars读取，返回nextOffset，下页传offset=nextOffset；通用工具cursor只续同一次有界响应，list.pageCursor只续任务列表。UI单次文件下载上限64MiB，不随档案扩容自动提高。archive_file虽按64KiB读取源文件，归档时仍组合受单资料容量限制的整份文件缓冲，内存随该文件大小增长；DSH冷查询也可能内部载入目标子会话日志，不能将逐页采集宣称为宿主恒定RAM。明确遗忘清理插件任务正文并保留永久撤销凭据，清理失败如实报告；它不会删除DSH原始会话历史或用户另存的工程副本。


## 0.8.0 管理流程编排

| 用户任务 | 界面落点 | 保留边界 |
|---|---|---|
| 找到下一步 | 五个主入口、目的列表、子页返回、父入口选中 | 原有九类逻辑路由可达，不增工具或平台能力 |
| 阅读记忆 | 正文／经历／感受／当前理解在前，来源与JSON由命名按钮打开 | 不触发人格回忆，不修改原件与归属 |
| 调整配置 | 实例／启动加载／其他记忆库分开，按容量类别编辑并保留隔离草稿；助手与社交资料一次保存 | 付费／扩大权限／遗忘恢复等仍确认 |
| 接入聊天 | 单平台扫码步骤、能力权限、兼容桥分别呈现 | 账号资质、支持／许可／可用仍分别核对 |
| 管理形象与作品 | 形象、图片服务、视频服务、生成、作品任务分开 | 不因保存或浏览自动生成，未知任务不自动重付费 |

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。该历史版本[完整本地回归](verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

## 0.7.0 历史功能：深刻参考、整理供料与社交身份

原十四个维度继续保留，新增功能是其横向扩展，不以模块数量代表完成率。

| 扩展 | 实现与直接消费者 | 边界 |
|---|---|---|
| 深刻记忆参考 | global/deep.json、schema/repository/deep-memory/prompts；introspect deep与管理记忆页 | cues不匹配触发；回忆、反应与演化修剪由人格决定，空模块与空patch有效 |
| 整理供料 | prepare/refreshConsolidationContext→memoryIndexes与deepMemories→冻结页 | 相关旧索引可读，未读尾部不当空库；助手读取不冒充人格读取 |
| 可选资料助手 | core/review-assistant.js→runtime memory_assistant→reviewAssistant advisory | 默认关、共享调用预算、无patch写权或价值否决，未知不自动付费重放 |
| 来源保真 | repository实际来源目录与srcRefs核验、source-dependencies撤销链 | 不伪造人类角色、不把同源当多次，空refs解释不需证据门槛 |
| 社交身份目录 | social-identities.js→surfaces social.*／persona_platform accounts→聊天页 | 目录不授予执行能力；0.10.0的B站另有独立可选适配器，实际连接／许可分别核对；抖音等未接入平台仍仅登记与接口预留 |
| QQ官方策略 | connections/qq.js及真实driver上下文 | 官方主动推送不可用；被动窗口按平台规则，桥按自身实际能力，不改人格判断 |

详见[新增功能说明](memory-reflection-and-social-identities.md)。0.7.0[完整本地回归](verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0的495/35及当时九页GUI、0.5.0和更早结果保留历史含义。0.7.0已修改核心，不能沿用0.6.0核心九文件未变的结论。

## 0.9.0 自我连续性、用户引导与短聊参考

本轮是十四模块的横向扩展，不以新增模块数代表完成率。

| 扩展 | 实现与直接消费者 | 保留边界 |
|---|---|---|
| 自我档案 | core/self-profile.js、repository、self/profile.json→onboarding.selfProfileContext→prompts | initial/current分开、自由文字、来源/CAS/容量/撤销；不把性别年龄变成性格规则 |
| 自我资料读写 | persona_introspect section:self / action:update_self与selfPatch/expectedVersion | 仍八工具；人格改current，用户初始化与确认状态独立 |
| 状态供料 | runtime.compose.memoryAvailability→请求环境参考 | 关联与检索分别描述；未检索/无匹配不表示全库为空 |
| 用户引导 | ui/app.js、self.get/self.update、status摘要、docs/user-guide.md | 可跳过、不阻聊天、保存不调用模型、跨实例过期回执不误用 |
| 交流节奏 | config.conversationStyle→core/onboarding.js→既有nextCheckAt/原生消息/逐条回执 | 仅偏好，无硬条数/频率；不自动切句或伪造事件，可能增加模型调用 |
| 有界身份供料 | contextBudget.selfProfileTokens默认350→动态总帽2970 | current字段完整展示或明确省略，历史按需读，不把全档案灌进每轮 |

字段权威见[第20节](plan/persona/persona-schema.md#20-自我档案初始化与交流定位090)，操作见[使用说明](user-guide.md)与[管理界面](management-ui.md)。0.9.0已改变核心与适配，最终全量/SDK/GUI/真实模型结果统一见[当前验收状态](management-ui.md#090-final-acceptance)，不能继承0.8.0“后台未变”的结论。

## 0.9.0 人格生命周期横向实现

| 用户动作 | 实现与消费点 | 边界 |
|---|---|---|
| 新建与切换 | instances.js → owner instances.create/load/select → 人格管理 | 名称式新建独立根、实际active/list；单活动写者、忙碌拒绝、保留原库 |
| 归档与恢复 | instances.archive/restore与归属捕获 | 停用并保留，非独立备份；恢复需明确，clearing/partial/cleared不可恢复 |
| 文本清除 | instance-lifecycle.js扫描/token/维护门/SHA → instances.clearPreview/clear → 名称确认UI | 五分钟token；停机变化零删除重新预览；部分失败不可加载、重新确认；外部资料排除 |
| 旧会话隔离 | 库外xiangxu-session-owners/1 → canAttachAgent/attachAgent | 只保存会话ID哈希与实例归属，清除后仍有效，不删除宿主日志 |
| 技术容量 | INSTANCE_LIMITS → registry/ownership/list/scan | 16未清除+256墓碑，登记尾部20墓碑列表显式完整性，不自动淘汰或改人格判断 |

字段与范围集中在[第21节](plan/persona/persona-schema.md#21-人格实例生命周期与文本清除090)，最终0.9.0结果以[验收状态](management-ui.md#090-final-acceptance)为准。

## 0.10.0 增量消费点

| 能力 | 实现与消费点 | 实际边界 |
| --- | --- | --- |
| 混合候选／时间查询 | core/retrieval*.js、repository.search、memory_search、管理memory.search | 核心无网络；真向量可选，时间只筛仍存区间，来源与主体不混淆 |
| 向量配置与诊断 | adapters/dsh/retrieval-provider.js、surfaces.js、UI记忆子页 | 手动分页索引、共享有界文档／查询缓存、参考不等于回想 |
| QQ丰富消息 | channels/rich-media.js、incoming-media.js、native.js、normalize.js | 媒体、转写、转发与原话分别归类；附件／STT依赖真实宿主 |
| B站 | adapters/dsh/bilibili/、persona_platform、permissions | 本人扫码、逐项许可、覆盖与真实外发收据；无独立人格 |
| 自备动态／翻唱 | channels/social-provider.js、audio-transfers.js、persona_platform与owner面板 | 用户自备协议服务；真实音频与有界作业，不自动部署或付费重放 |

以上是运行接口与代码映射，不代替真实账号或供应商验收；最终范围统一见[0.10.0 接入与检索说明](integrations-and-retrieval.md)。

## 0.11.0 个人QQ接入消费者

受管NapCat准备与扫码留在DSH connections适配层；channels沿用户确认的默认自主社交或可选指定对象范围、真实账号与原生binding收发，支持NapCat原生HMAC事件验签。该版本管理桥提供qqBridgeSetup.inspect/start/poll/connect/stop，权限仍由permissions按实例／平台／账号核对。它不增加第十五个人格模块或第二套记忆，不增加关注、回复、主动和成长规则。0.11.0当时实际通过范围见[历史最终验收](qq-one-click-setup.md#0110-final-acceptance)。

## 0.12.0 QQ账号自身操作与连接恢复

| 能力 | 实现与消费点 | 当前边界 |
| --- | --- | --- |
| 修改QQ头像／资料、发表QQ空间说说 | connections/qq-account-actions.js、qq-account.js、qq-account-platform.js与persona_platform | 独立account作用域，无聊天target或伪造binding；已核NapCat或明确报告动作的驱动直连，不把所有OneBot视为支持 |
| 账号档案与许可 | QQ账号收据、permissions与管理页面 | profile.avatar沿profile.update许可；资料必须result:0、说说必须真实tid才确认完成，未知不重放，原资料保留可回查 |
| 管理口与QQ恢复 | connections/napcat-managed.js、napcat-process.js与qqBridgeSetup.recover | 管理认证／限流、真实QQ状态、owned进程归属分别核对；未核实launching阻止重复启动，不能据它停止进程 |

空间浏览、点赞、评论、好友请求处理、群管理及实时通话不因这几个账号写入接口而自动接通。当前操作参数、资产上限与静态／隔离／真实验收边界统一见[0.12.0账号能力](account-capabilities.md#0120-current-acceptance)；旧版本测试数不替代本版证据。记忆取舍和平台使用仍由人格自主判断。
