# 深刻记忆、整理资料助手与社交身份

版本0.8.0，修订日期2026-10-26；核心功能仍为0.7.0实现，数据契约继续采用persona-memory/3。本文说明已实现能力的职责和资源边界。0.7.0[完整本地回归](verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；旧0.6.0及更早数字保留历史含义，不作为新核心的验收。

## 深刻记忆是人格的参考

深刻记忆把人格认为重要的经历保存在同一个模块里，不按痛苦、感动、快乐或幸福拆库。参考存在不等于当前已经想起，也不等于本轮必须产生相应情绪、回应或行动。是否回忆、什么情境会勾起回忆、怎样反应，以及后来如何重新理解、淡化、合并、替换或修剪，均由人格自己决定。

程序没有关键词命中触发器、情绪强度门槛、固定回忆频率、正负情绪比例、自动衰减或治愈期限。cues保存人格自己的联想描述，不作为规则引擎的匹配条件。普通轮次提供的有界参考卡不自动检索原文、不发起额外模型调用、不设置“已经回忆”状态。管理页查看条目也是用户浏览，不代表人格本轮已被勾起回忆。

### 保存内容与自主演化

单实例统一文档为global/deep.json，逻辑写入键为global:deep。条目沿用来源、版本、撤销等MemoryMeta，且scope为global、personId为null；关联人物通过aboutPersonIds描述，不把共同深刻记忆拆成另一套人物身份。

| 字段 | 含义 |
|---|---|
| title / reference | 标题和人格留下的简短参考；reference不是自动触发条件 |
| experience | 人格记得的经历，保留其实际来源和材料性质 |
| feltThen | 当时感受的描述，不因后来理解变化而被冒称为当时没有这种感受 |
| meaningNow | 当前理解；可以与当时感受不同，也可以继续保持原看法 |
| cues | 自主联想描述，不是关键词触发器 |
| aboutPersonIds | 涉及的真实内部人物ID |
| relatedMemoryIds / supersedesIds | 关联、替代的条目ID，避免复制出相互冲突的多份原件 |

深刻记忆通过人格所选整理的upsert/remove操作演化。不存在程序按负面程度自动移除或因时间经过自动宣称伤痛已治愈的流程；形成更深的回忆、重释旧经历或修剪旧条目仍是人格的选择。修改沿用有限journal、冻结输入和版本机制，不承诺永久保存每个历史版本。原始来源可回查时使用同一来源，不将普通记忆、深刻记忆和人格概括复制成彼此独立的“多次经历”。

persona_introspect的section:deep可以查看深刻记忆模块；管理页memory.list的recordType:deep和memory.detail沿用有界分页与真实来源。普通memory_search可返回相关深刻条目，但检索结果只是提供材料，不替人格决定是否回忆或应该怎样反应。

### 有限参考与容量

artifactLimits.deepMemories默认128条，deepMemoryChars默认100000个字符串字符；单条仍受artifactTextChars=16000和artifactRecordBytes=65536限制，业务JSON默认1MiB、实例物理默认64MiB。上述帽同时成立，不能把128乘单条上限解释成保证可写容量。深刻记忆属于原有实例长期文本预算，不另复制一份无限原文库。达到容量时拒绝超限写入并保留旧数据，由人格选择怎样整理取舍或由用户调整技术容量，程序不静默选取情绪进行淘汰。

contextBudget.deepMemoryTokens默认600计数单位，仍受普通动态材料总预算2970约束。空模块不会添加参考段；非空时优先保留完整参考卡；首张完整卡超出预算时，可提供带partial:true、titleTotalChars、referenceTotalChars和omittedFields的显式缩略参考。返回total/shown/truncated等事实，缩略内容不冒充完整条目；目录未展示尾部的位置用nextOffset标识，不冒称全部已读。这个数字不是回忆触发时点。snapshot.deepMemoryReference保留referenceOnly:true与automaticRecall:false及实际显示ID；完整模块读取继续使用现有工具结果游标，不能把参考目录nextOffset当成通用工具cursor。缺tokenizer时仍明确标utf8_bytes_estimate，不将600或2970冒称整个DSH请求的精确tokenizer硬帽。

## 整理资料供给与来源保真

人格继续选择run/defer与整理目标；程序按持久源游标选择该目标的未消费增量。冻结上下文现在包含persona、identity、impression、interpretations、codes，以及memoryIndexes:{global,person}、deepMemories和相应版本。普通旧记忆索引不再被排除在整理可读材料之外；person只对应本次所选人物，global为共同索引，不把所有人物的库每次灌入请求。

冻结材料通过带Unicode位置、实际nextCursor和完整性标记的页提供。人格可选择继续读需要的旧材料；未读尾部不能当成空库，助手读过也不计作人格读过。版本冲突、来源变动、容量和撤销继续沿既有事务路径校验，失败不消费源游标。

srcRefs机械核对实际已登记来源、角色和撤销状态，不能把委派指令、助手解释或工具结果伪造成真人原话。同一源根重试、转存、反复检索或摘要不成为多个独立经历。允许空来源的主观解释；没有新增“几条证据才能形成印象”的资格要求。来源检查证明记录归属，不证明每个解释一定正确。语义保真仍需实际回放评测，不能把JSON正确等同于长期人格效果已经证明。

提交后保留的sourceDependencies采用sha256-identities/1来源／记录摘要收据，追踪实际读入材料而不另存原话。明确遗忘会清除受影响已提交journal的patch、助手报告与可回读诊断正文，保留提交标记、调用数等技术回执；旧档缺完整依赖时在撤销后保守去诊断正文，不删除无关人格记录。自然原件淘汰保留人格解释和仍受容量约束的诊断。人格所选retain片段本身也是来源；明确遗忘命中task-material时按真实任务会话、文档ID、SHA与Unicode范围撤销该任务资料，不能换页重新保留；自然淘汰和无关新任务不受影响。

## 可选的整理资料助手

reviewAssistant默认{enabled:false,maxOutputTokens:1024,maxReportChars:4000}。maxOutputTokens可设1..8192，maxReportChars可设1..16000；它们是资源上限，不是形成记忆或人格变化的阈值。DSH适配沿当前模型路由执行，不新读或另存供应商密钥。

启用后，独立的memory_assistant模型调用只接收当前有界材料与冻结上下文页，输出observations:[{category,detail,recordIds}]。它可以提示遗漏上下文、来源或主语混淆、否定词丢失、同源重复计数等可能的信息问题。强烈、痛苦、依恋或不寻常的主观感受本身不构成格式错误；助手不能规定性格目标、情绪平衡、治愈期限、记忆资格或整理频率。

助手没有工具或持久化写入权限，返回的patch或自报权威字段不进入人格补丁。实际建议带advisoryOnly:true、材料范围和完整性，recordIds只保留本次实际暴露的记录ID，未知引用明确标记。人格可以不采纳、反驳、修改理解或返回空patch；不存在“第三方判定性格正常后才提交”的关卡。

助手和人格整理共用原有consolidationCallsPerSegment调用预算。剩余预算不足两次时优先保留人格的调用机会，不为助手新增每日频率。调用前持久登记assistantReceipt；同材料已取得的报告复用，未知或失败不会自动付费重放。错误或不可用作为辅助状态交给人格，不能冒充助手已经看完资料或人格已经采纳。观察建议可能因输入预算进一步缩短并标记不完整。receipt位于对应run的reviewState或完成回执中，仍受journal和进度记录容量约束，不是永久审计库。

助手调用前按完整请求预算为报告或明确的省略状态以及真实callBudget留空间；助手与人格看同一实际源片段，不为容纳建议悄悄省掉原件。报告过长时有界缩略并标记，仍放不下则交给人格明确的省略状态。窄预算下无法使用的额外助手调用会跳过，完全放不下时不调用模型、不消费原件。

这是一种工程分工，不能由人类睡眠类比推导出防止所有人格极端化的保证。人类研究支持睡眠中的再激活、整合和选择性保留，也显示负面中心片段可能较背景保留得更好；不能据此设定“睡眠自动消除负面情绪”的产品规则。参考[Rasch与Born综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC3768102/)与[Payne等情绪场景实验](https://pmc.ncbi.nlm.nih.gov/articles/PMC5846336/)。

## 账号与社交身份

社交身份把用户为人格准备的平台账号关联到当前人格；账号注册、平台认证和实际授权仍在相应平台完成。当前QQ／微信复用既有连接，B站、抖音及其他平台可先登记账号档案并预留适配接口；没有适配器时只表示“已登记”，不显示成已经登录、能发私信、投稿或通话。

owner动作是social.inspect/list/upsert/remove/linkCurrent/refresh。upsert只接受platform、accountId、displayName、accountType、profileUrl、avatarUrl、notes及instanceId；不接受模型或前端自报verified、权限、memoryRoot或凭据。linkCurrent从当前实际连接核对QQ／微信账号，不能以用户填写的昵称替代实际账号。解除登记只删除该人格的账号档案，不退出平台、不改授权、不删记忆。

身份登记schema为xiangxu-social-identities/1，默认每人格32条、总256条、登记256KiB。稳定identityId绑定实际人格目录、平台和账号；不存新Token/AppSecret/Cookie，只引用当前连接。查询返回offset/nextOffset/complete；账号verification、currentAccount、connected，以及每项supported/allowed/available分别呈现。未核实授权的allowed为null，不冒充未使用或已允许。

目前每个平台只有一个活动连接；保存多个档案不代表已实现同平台多账号并发。persona_platform新增action:accounts只读当前人格的账号目录，工具总数仍为八个；它不因目录中有账号就取得执行权限。实际操作继续经过当前原生绑定、平台能力和用户授权。

### QQ官方发送策略

腾讯官方发送文档顶部说明主动推送自2025-04-21起不再提供，同页下方仍有旧额度文字。适配器采用当前顶部说明并返回deliveryPolicy:{proactive:false,passiveReplyRequired:true,...}；没有有效被动回复上下文时返回QQ_PUSH_UNAVAILABLE，不把人格的主动意图冒充实际发出。被动私聊窗口为60分钟、群聊为5分钟；实际账号和API仍可能拒绝。这个限制只作用于QQ官方driver，不套用到OneBot兼容桥，也不改变人格是否想主动联系的自主决定。依据：[腾讯官方发送文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)，核对日期2026-10-26。

扫码登录也不等于全部账号控制权。例如抖音官方把登录身份与具体能力scope授权分开；本版保留平台适配接口，不由扫码或手工登记推断私信、投稿、朋友圈或RTC能力。依据：[抖音登录和授权](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/opensdk/user-authorization/solution)，核对日期2026-10-26。

## 原生设置与验收边界

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。


五个主入口沿用DSH宿主样式：在“记忆”查看深刻经历、正文与来源；在“设置 → 整理资料助手”编辑开关和预算后一次保存；在“连接 → 社交身份”登记账号并查看真实能力。浏览不启动助手、人格整理、扫码或账号操作；保存助手设置也不启动一次整理。UI没有自动治愈、关键词触发或强制添加深刻记忆按钮。

0.7.0涉及核心与适配层变化，不能沿用0.6.0“核心九文件未变”的历史结论。0.7.0[完整本地回归](verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI仍以实际结果为准；[管理说明](management-ui.md)维护分级证据和使用边界。0.6.0的495/35项和当时九页GUI结果仍是历史证据，不证明本版真实模型质量或真实社交账号已经验收。

完整字段见[唯一字段契约第17至19节](plan/persona/persona-schema.md)，执行与存储端口见[运行接口](runtime-api.md)和[存储接口](repository-api.md)。

### 0.7.0已取得的分级证据

[原生GUI回执](verification/0.7.0-native-ui.json)记录九页、合成深刻记忆、助手开关保存及未核实社交身份的实际显示，模型调用为0；[源码自主性审查](verification/0.7.0-autonomy-audit.json)说明源码链、来源SHA、发现与修复、本人定向测试及其他执行者回执的不同证据强度。它们不证明真实平台已经登录、模型整理质量或长期人格结果。
