# 十四模块实现映射

本表说明代码落点；0.6.0当前实现及0.4.1／0.4.0历史测试与限制以[管理说明](management-ui.md)和[渠道接入](channel-integration.md)为准。verification.md与host-test-results.md保留早期实现范围，不能当作当前验收。人格表达的正确性、讨喜程度或持续性不能仅由结构测试断言。

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
| 潜意识 | buildSnapshot六段材料与完整路由/时间 | 分段/总预算、独立冻结、无全局lastText串对象 |
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

> 本节是0.5.0历史实现，当时七工具并禁止人格派发；当前0.6.0使用八工具与独立任务预设。

| 扩展 | 实现与消费点 | 验证含义 |
|---|---|---|
| 陪伴工具范围 | companion-scope.js与index.js：相续人格preset在普通DSH／IM／主动／唤醒中清空继承allow，再注册七个工具 | 不向人格提供子agent派发；其它预设不变，内部原生通道API保留 |
| 官方扫码 | connections/service.js、qq.js、wechat.js、login-qr.js；surfaces.js将真实绑定内容转二维码 | 本人手机确认后仍需选范围并启用；模拟流程不代表真实账号已登录 |
| 实际能力与许可 | channels.capabilities／execute、permissions.js、persona_platform | supported、allowed、available分开；未实现动态／RTC禁用，不凭目录伪造支持 |
| 形象档案与生成 | media/service.js、providers.js、io.js，persona_media；形象页与owner-actions | 描述／主参考／版本／锁定，图片和视频分开开关，真实任务与结果资产 |
| 有界外部资产 | owner-assets.js与父桥分块上传／下载、媒体manifest、永久撤销同步 | 不把二进制塞进每轮上下文；完整SHA，文本备份／元数据清单不冒充作品字节备份 |

0.5.0当时七工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform。新增工具不要求人格一定使用能力或固定频率更新形象，不改认人、注意、主动、睡眠与整理必要性的判断。平台媒体发送与生成分别取得回执。完整操作、容量和当前／历史证据见[渠道接入](channel-integration.md)、[形象与创作](media-and-identity.md)及[管理说明](management-ui.md#050-实现与验证范围)。


## 0.6.0 自主委派、独立工作预设与任务资料

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
