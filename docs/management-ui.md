# 相续人格原生管理界面与验收

版本0.4.0，产品dsh-Xiangxu-Persona，包名dsh-xiangxu-persona。DSH设置入口名“相续人格”，对话预设展示名也为“相续人格”；内部presetId persona-memory及数据schema persona-memory/3保持兼容。本文说明当前实现和可复核边界，最终验收回执单独维护。

## 原生入口与加载

Git安装见[README](../README.md)。正常重载DSH后打开设置中的“相续人格”；面板通过宿主原生settings.section slot注册，使用现有Connection认证载体和Electron IPC/已配置宿主连接。页面在allow-scripts sandbox内运行，消息通过nonce/MessageChannel交给宿主桥；管理页面本身不新开web服务，不把密钥交给iframe，不绕过宿主owner认证。

管理入口与对话预设分别存在。设置页可在实例未加载时显示真实停用状态并加载所选实例，不会为了浏览自动创建未知人物或新模型轮次。启动以保存的实例选择及技术配置为准；明确加载可能恢复此前所选定时/控制工作，这不等于只读浏览自动触发整理。

## 七页功能与真实状态

| 页面 | 已实现入口 | 状态口径 |
|---|---|---|
| 运行总览 | 实例/目录、加载、睡眠、主动暂停、容量、作业和错误 | available:false与未加载如实显示；不填演示数据 |
| 共同人格 | anchor/axes/facets/signatures/habits/retired | 按所选section分页；未读尾部显示不完整 |
| 记忆与关系 | 人物、global、unknown与全部范围；类型/线索检索，来源、原件详情、明确遗忘与单原件重归属 | personId是关系分区；role/speakerId保真实人/AI，未知不强挂 |
| 进化与变更 | job/run、暂停/未读进度、候选/validatedPatch、有限人格历史前后对比与回滚、管理操作收据 | queued/prepared/paused/failed/committed/unknown分别报告；候选不是已提交 |
| 设置与加载 | 技术存储/条目/输入输出/工作区预算、整理模式、实例登记/加载/停用/切换 | 设置说明两模式；没有“人格必须成长频率”或印象资格设置 |
| 维护与诊断 | validate/backup/restore/recover、usage/snapshot/outbox/errors/gaps | 只呈现仍保留的诊断；缺失usage为未知；维护结果与加载状态同时展示 |
| 聊天渠道与语音 | QQ/微信本地桥、私聊/群接入范围、连接检查、事件上报鉴权、本机音色与试听 | 默认无listener；真实平台能力与缺失前置条件如实报告 |

记忆、进化等原有管理数据的明细默认16000个Unicode字符、列表最多100条，响应最多128KiB。短声音试听走独立有界动作：原始WAV最多512KiB，Base64编码后仍受外层管理载体2MiB硬帽约束；音频不进入模型上下文。nextCursor仅继续读取同一结果；选择或底层数据变了则游标失效重新查。记忆目录本身受实例容量约束；浏览不是每轮给模型灌全库。UI不把search的1000结果上限当作完整目录浏览。

## 实例与开关

实例登记persona-instances/1与人格数据schema分离，最多16条、登记文件64KiB；同一时刻一个活动实例、每根目录一个写者。实例停用释放工具、监听、计时器和写锁；暂停主动只停止主动路径，普通回复仍可进行。进行中对话、所选整理或管理长操作会阻止切换。加载失败保留错误，并尝试恢复此前可用实例；未成功不能显示为已切换。

同一个人格可以认识不同人并共享成长；不同实例有独立记忆根。已归另一个实例的会话不自动接入新实例。保存设置在下一次加载继续使用，不被bundle初值覆盖。重载/切换保持来源与消费游标，不把旧经历重演为新事件。

## 明确操作与异步回执

本节管理动作来自用户明确操作；人格自主的记忆与成长仍经既有运行路径执行。wake/mute/resume/config/forget/assign/rollback通过活动coordinator执行，读取不另开第二个写者。unknown/global遗忘必须选具体ID，不能空选清库或用无对象时间范围扩成全库操作；已知人物删除保留明确targetPersonId。原件关系归属不改角色、actor、原话与源ID。

整理与回补可能耗时或调用模型，operations.start先写ops/management.json再执行；get/list只查询。同一保留中的requestId返回原收据，不重复执行；界面只点“查询结果”，不把超时当失败后自动重发。旧进程留下queued/running在恢复后标unknown，不自动付费重放。最多保留50个终态/256KiB，未完成收据不静默删除，资源队列沿技术上限拒绝超量工作。

操作回执没有会重执行副作用的分页游标。大详情仅用于只读动作，明确显示片段和完整性。模型自行选择的run/defer与用户显式整理命令分别保留来源，不新增日常行为次数、沉默惩罚、强制睡眠、印象证据门槛、话题过滤或承诺执行器。

## 有限历史、备份与恢复

人格历史受配置约束，不承诺每一模块的永久全量版本。人格版本前后对比/回滚只作用于仍保留的共同人格版本；其它模块变更从仍保留的run patch查看。明确遗忘清除相关历史与候选，回滚不能复活撤销内容。自然淘汰与明确撤销不同，摘要不保证可逆还原原文。

校验和备份先停用写者，操作结束可恢复原加载实例。恢复/恢复中断完成后保持停用，并返回requiresLoad，用户明确再加载；不会恢复旧库后悄悄开启其中旧计时任务。维护沿核心路径/SHA/版本/容量校验及Windows恢复journal，不删除未知目录，不清除独立宿主日志或外部副本。

## 代码与接口

- ui/index.html、ui/app.js、ui/style.css：七页交互；scripts/build-ui.mjs生成ui/client.js并随Git包交付。
- adapters/dsh/ui-host.js：原生Connection管理路由persona-memory.manage。
- adapters/dsh/management.js：有界查询、明确控制、配置白名单与异步收据。
- adapters/dsh/instances.js：实例登记、单写者加载/停用、切换与维护协调。
- adapters/dsh/channels/：普通IM桥、原生通道、真实外发回执与Windows本机音频。
- adapters/dsh/voice.js与surfaces.js：五工具中的声音偏好及owner管理动作。
- core/：持续人格、存储、读取、撤销及运行，不导入DSH/UI。

完整行为与字段见[自包含方案](plan/persona/README.md)、[唯一字段契约](plan/persona/persona-schema.md)、[存储接口](repository-api.md)和[运行接口](runtime-api.md)。原14份reports方案保持同步，docs/plan镜像按仓库位置重写相对链接，独立clone不要求作者本机C盘目录存在。

## 0.4.0 渠道、声音与外观

管理主题为中性浅/深色与蓝紫点缀，可跟随系统或手动选择；偏好由现有宿主页面桥保存，sandbox仍只allow-scripts。试听仅允许data音频，不放宽网络或同源能力。

“聊天渠道与语音”使用QQ OneBot11和微信OneBot12兼容本地桥。页面显示配置、启用、实际连接、错误和私聊/群聊/文字/音频能力；令牌不回显，上报鉴权只在生成时显示。空接入列表表示未接入该范围，显式*才开放相应全部对象/群；它们不规定人格该回应谁、必须被@或多久回复。详细使用与接口见[聊天渠道接入](channel-integration.md)。

语音基于本机Windows System.Speech，不下载TTS模型；人格可自主选声，用户也可指定。生成试听只产生实际短WAV，再由用户点播放器收听，不自动投递到平台。当前rate为近似SAPI音级、pitch:false；缺能力或失败如实呈现。QQ标准record需桥确认，微信OneBot12不宣称音频能力。网页聊天和Telegram只列未来接口，默认不挂载网页服务。

## 0.4.0 最终验收回执

完整本地回归 **336/336通过**，0失败、0取消、0跳过；所记录29份核心/适配运行源码在回归前后SHA一致。语法、独立核心和包入口检查覆盖79个JS/MJS并通过。全套回归包含源码库中明确保留的实验模块测试，不能因此把实验网页算作已发布入口。详见[0.4.0完整回归摘要](verification/0.4.0-tests.json)。

最终原生SDK渠道专项 **67/67通过**，使用真实DSH引擎、固定模拟模型和loopback模拟QQ/微信桥。实际42个宿主请求与42个fixture请求均走`persona-social-fixture/fixture-v1`，共11次模拟HTTP发送（QQ7、微信4）；没有真实模型或真实平台账号登录。检查包括私聊/群聊与actor隔离、共同人格、原话和平台发生时间、重复回调、自主目标、倾听/睡眠/明确唤醒、未知交付不入已说C1，以及实际音频与模拟record回执。详见[0.4.0原生SDK与音频摘要](verification/0.4.0-sdk-fixture.json)。

本机实际使用Microsoft Huihui Desktop生成457852字节PCM WAV，格式为16位、单声道、22050Hz，并通过模拟QQ桥取得record消息回执。这证明本机生成到该模拟协议交付的链路，不证明用户真实QQ/微信收到了语音；没有播放到声卡。实际账号、已登录桥和平台客户端仍需用户自己的接入环境，当前页面如实显示未配置状态。

SDK正常shutdown退出后曾留下已退出PID的语音lease元数据；另行进行的定向恢复9/9通过，验证合法接管死PID租约、生成短真实WAV、清理自己拥有的音频和显式关闭后释放租约。该9项在SDK摘要的leaseRecovery单列，不并入67项或336项重复计数。

最终冷构建的真实DSH原生GUI验证了七页导航、QQ/微信私群配置字段、未配置连接状态、两个实际本机音色、用户选择Huihui保存并冷加载保持、pitch不支持时控件禁用、实际WAV试听播放器有controls且不autoplay，以及深色主题在设置页重新挂载后保持。本轮GUI发现的textarea只读type赋值和append(null)裸文本已修复，并用最终冷构建复验。该图形验收没有提交模型prompt，也没有重启正式DSH；详见[0.4.0原生界面摘要](verification/0.4.0-native-ui.json)。

全部隔离SDK/GUI载体已停止，复查进程与写锁均为0；正式DSH没有被强制重启。

以下截图来自隔离DSH真实原生设置；未配置状态没有用演示连接冒充真实平台登录。

![0.4.0原生设置深色总览](images/0.4.0-overview-dark.png)

![0.4.0浅色QQ与微信接入设置](images/0.4.0-channels-light.png)

![0.4.0深色本机音色与试听播放器](images/0.4.0-voice-dark.png)

早期文字主链专项55/55（37个宿主请求、37个fixture请求、10次模拟HTTP发送）保留其当时源码与范围，不冒充最终67项结果。未发布手机网页原型的27项只属于实验范围；0.3.0的229/26及更早真实模型数字继续保持历史含义。

## 0.3.0 历史验收回执

最终完整本地回归 **229/229通过**，0失败、0取消、0跳过，耗时92522.8601ms。核心与适配层18份运行源码在这次冷回归前后SHA一致。语法/独立核心/包入口检查57个JS/MJS通过；14份自包含方案与14份实现文档检查通过。可复核摘要见[完整回归JSON](verification/0.3.0-tests.json)与[图形验收范围](verification/0.3.0-ui.json)。

改名后的原生SDK确定性流程 **26/26通过**，8项profile安装/迁移保护检查全部通过，成功profile再次准备可复用。实际17个宿主模型请求均送往测试专用persona-fixture-validation/fixture-v1，观察到真实provider派发0次，退出码0，专用SDK进程0；这属于真实宿主加模拟模型响应的集成验收，不充当真实模型人格质量证据。详见[SDK流程与安装兼容摘要](verification/0.3.0-sdk-fixture.json)。原fixture把普通睡眠误当必定整理，首次等待超时的证据保留在本地工作目录；测试场景现明确选择整理run，生产仍由人格选择run/defer/rest，没有改成强制进化。

使用安装版DSH NEXT 0.2.1-rc.2的独立web profile、localhost owner认证和原生设置slot做真实浏览器验收；未发送模型请求，未访问正式记忆根。原生Connection探针实际验证owner成功、非owner拒绝；真实HTTP验证认证交换、客户端boot graph、未认证401及认证管理RPC200。浏览器从DSH设置进入，而不是仅打开独立静态页面。

实际观察：六页导航；未加载状态→明确加载；recentPreferredDays从3改4保存，卸载/重载仍为4；主动暂停/恢复；非空人格、人物、用户/助手/unknown原件与实际来源；prepared/committed批次；有限人格v1到v2前后对比；共同人格与未知标签分开；选择相续人格预设而不发prompt后设置仍可使用。所有非空数据明确标人工界面样本，不称真实模型成长。

维护页实际执行了校验、创建备份和从该人工备份恢复：校验/备份结束loaded:true；恢复结束loaded:false、requiresLoad:true，原数据通过受控rollback槽保留。最后将校验/备份回执的全量文件数组改为fileCount与总量等摘要，避免操作已成功却因128KiB响应帽报错；完整文件SHA仍在备份manifest中。最终原生API与全套回归核对这一收口，不通过手工改状态冒充结果。

本轮真实GUI发现并修复srcdoc内#链接跳出认证页面、global条目被标未知、维护文件清单过长三个问题。实例失败恢复/监听释放/配置持久失败路径也有隔离故障回归。模型相关整理/明确唤醒/遗忘/回滚语义沿核心测试与此前真实模型报告，不把这次0模型UI验收说成全部模型按钮再次付费跑通。

下图为0.3.0历史实际DSH截图，不能当作0.4.0新主题截图；历史差异与维护操作使用人工构造的隔离验收样本。

![DSH原生设置中的相续人格总览](images/management-overview.png)

![已保留人格历史的修改前后](images/management-history.png)

![DSH内的维护与恢复入口](images/management-maintenance.png)

安装已通过DSH官方管理器从旧@local/persona-memory迁移到dsh-xiangxu-persona本地link，未强制重启生产DSH。正常重载后使用“设置→相续人格”和可选“相续人格”预设；内部persona-memory身份及v3数据保留兼容。

0.1/0.2真实模型结果保留历史：见[0.2.0补充唤醒与容量](evolution-and-wake-validation.md)、[0.1.1全流程](real-model-validation.md)。旧97/146派发、206回归等数字不提升成本版UI验收；长期数周/月人格质量、所有模型/渠道、外部HTTP账单和全DSH请求精确tokenizer硬帽不由本版图形层证明。
