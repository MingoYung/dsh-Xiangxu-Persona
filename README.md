# dsh-Xiangxu-Persona · 相续人格

当前版本0.13.3修复自我档案写入来源容量与实际上下文不匹配，以及QQ等文字渠道收到桌面卡片源码的问题。内部自我档案与QQ账号资料工具分开说明，发送、记忆与回执使用同一文字投影；根因和本轮未测边界见[QQ资料与文字输出修复](docs/qq-profile-output-recovery.md)。0.13.2的[QQ无回复修复](docs/qq-reply-recovery.md)及0.13.1的问题反馈通道继续保留；见[问题申报](docs/support.md)与[收录记录](docs/market-submission.md)。

0.13.0引入的统一短期、长期与归档记忆继续兼容：同一格式按时间线转层，长期活动正文默认100万字符，最旧内容超额时完整转入可回查归档；每轮人格请求必须取得当前人格及必要近况，加载故障明确报错。说明见[时间线记忆与上下文](docs/memory-timeline-and-context.md)，唯一字段见[第26节](docs/plan/persona/persona-schema.md#0130-memory-timeline-contract)。0.13.0的原始验收范围保留历史含义；本轮资料与文字输出修复状态以[本轮说明](docs/qq-profile-output-recovery.md)为准，其他社交连接仍显示未测试。此前账号功能与0.12.0实测保留其[历史范围](docs/account-capabilities.md#0120-current-acceptance)。

0.8.1历史补丁增强透明主题下的操作提示：主导航和内容分类的选中项有常驻下划线，功能入口有“打开 →”轮廓标记，状态单独显示；悬停与键盘焦点可见。颜色继续取自DSH主题，0.8系列操作流程及后台契约不变。 相关55项回归与三种主题检查已通过，范围见[本补丁回执](docs/verification/0.8.1-affordance.json)。

相续人格是面向DSH的长期人格与记忆插件，版本 **0.13.3**，包名 `dsh-xiangxu-persona`。采用独立核心＋DSH适配层；在DSH设置里提供五个主入口和任务式子页，在对话里提供连续记忆、主观人格成长、主动聊天和睡眠唤醒。

这是同一个跨关系成长的人格。它自己判断认出谁、注意谁、记什么、回不回复、何时主动、是否有必要整理、何时睡和怎样醒。软件保存来源与归属、执行选择、控制资源并恢复故障，没有每日主动额度、最短交流间隔、沉默惩罚、印象证据门槛、强制睡眠、话题硬拦截或承诺履约器。

## 问题反馈

遇到报错、记忆或连接异常，或某项操作看不懂，可从 **设置 → 报告问题** 复制／保存最小诊断摘要，再打开[中文问题申报表单](https://github.com/MingoYung/dsh-Xiangxu-Persona/issues/new?template=bug_report.yml)。报告会分派给维护者MingoYung，在[仓库Issues](https://github.com/MingoYung/dsh-Xiangxu-Persona/issues)跟进。没有GitHub账号时可先保存摘要和复现步骤，经已有人工渠道转交。

摘要只在本机生成，用户主动提交才会发往GitHub；Issue是公开的。不要上传记忆库、完整聊天、密钥、Cookie或二维码，截图请遮个人信息。说明、摘要范围与通知边界见[SUPPORT.md](SUPPORT.md)和[问题反馈指引](docs/support.md)。

## 安装与打开

使用DSH原生插件安装入口安装Git仓库：

```powershell
dsh plugin add https://github.com/MingoYung/dsh-Xiangxu-Persona
```

正常重载或重启DSH后，打开 **设置 → 相续人格** 管理实例与数据；新对话选择 **相续人格** 预设使用记忆功能。设置页和对话预设是两个入口，安装不替换其它预设的默认选择。Node.js要求22以上。管理客户端随插件交付，使用DSH现有连接、设置slot和宿主React。个人QQ默认一键准备NapCat并扫码，核对账号并确认自主社交后接入当前人格，也可选指定对象范围；QQ官方Bot、微信iLink与已有OneBot兼容桥继续保留，不要求部署个人聊天网站。

产品名、Git仓库名为`dsh-Xiangxu-Persona`，安装包名用小写`dsh-xiangxu-persona`。为兼容已保存会话，内部presetId仍为`persona-memory`，数据格式仍为`persona-memory/3`，无需因改名重写原记忆。

本机源码开发/旧本地链接迁移可在项目目录执行：

```powershell
node scripts/install-dsh.mjs --profile desktop
```

脚本通过宿主包管理器安装或对账，具体迁移结果以实际输出为准；不会手工覆盖其它插件配置或强制结束用户正在使用的DSH进程。Git安装与本地link使用同一套bundle和客户端；本地link安装时应保留源目录。

## 初次认识与日常表达

第一次打开可设置初始资料，也可选择“以后再说”直接聊天。“了解相续 → 自我档案”提供一起确定、由相续选择、暂不设置；名字、称呼、性别表达、设定或外观年龄、生日、背景与自我描述都可留空。用户的初始想法和人格当前采用的描述分别保存，不从年龄或性别推导性格、亲密关系或成熟度；档案建立时间不是人格生日。

“相处 → 交流节奏”可选自然短聊（默认）、按内容决定、完整展开。它只给表达偏好，不设硬字数、条数或频率；人格可用已有nextCheckAt选择稍后重新判断，定向续聊要同时保留当前replyPlan.target。每次结合最新来信决定是否补充，由原生独立消息和平台逐条回执记录；不自动拆句、随机延时播放旧台词或伪造assistant事件。可以分次表达但不保证每次多条，每次补充可能增加模型调用；生成开始后新来信可能下一轮才处理，globalMuted与平台实际限制仍适用。

普通用户先读[使用说明](docs/user-guide.md)，技术字段见[自我档案契约](docs/plan/persona/persona-schema.md#20-自我档案初始化与交流定位090)。说明由界面提供，不整份塞进每轮人格提示；新窗口、未认出、未检索和无匹配不等于全库为空。

## 从五个入口开始

| 主入口 | 日常用途与下一步 |
|---|---|
| 相处 | 查看近况、允许或暂停主动联系、选择交流节奏；休息时可明确叫醒。需要时进入“了解相续”（含自我档案）、“独立任务与资料”“运行与用量”或“使用说明” |
| 记忆 | 阅读已保留内容，查找关联记忆与过去／现在的理解；语义服务可选，参考记录可核对；明确遗忘仍有确认 |
| 连接 | 个人QQ先一键准备并扫码，默认自主社交接入当前人格；指定对象范围可选；微信、B站、能力权限、已有桥与可选QQ动态分别配置 |
| 创作 | 分别进入形象档案、图片服务、视频服务、可选翻唱、开始创作和作品任务；保存配置与实际生成分开 |
| 设置 | 分别管理人格与记忆库、加载方式、交流时间、资料助手、容量及维护，也可回看说明或报告问题；容量草稿一次保存，问题摘要检查后再提交 |

子页有明确返回入口。资料以正文和人能理解的标题为先，来源、记录编号和原始字段由命名按钮展开；管理页沿用DSH主题，不再把九个分类和长表单同时铺开。助手与社交资料编辑后点一次保存，保存本身不启动整理或登录。

完整操作说明与本版验收范围见[管理界面说明](docs/management-ui.md)。界面明确区分尚未读取、已提交、暂停、失败和结果未知；分页按钮只继续读同次结果。所有数据来自所选真实实例，不用示例数据冒充当前状态。

## 本轮可选检索与平台扩展

“记忆 → 查找关联记忆”默认使用文字和已存关联，不要求额外模型；可配置真实embeddings服务，手动分批建立有界向量缓存。查询也会向所选服务提交查询文字，可能计费。缓存不等于原始记忆，TTL、换服务和重启可降低索引覆盖；未配服务如实降级，不自动上传全库。过去／指定时间只筛选仍保留资料的已有有效区间，不恢复已删除内容。找到候选、提供过参考都不代表人格一定回忆，也不会自动修改重要度。

QQ OneBot11可保留表情、提及、引用、合并转发和媒体事实；附图需要宿主附件与视觉模型，入站语音识别默认关闭并依赖实际DSH STT与可处理的音频字节。B站可选扫码后读取视频资料、字幕、评论和故事板，授权后评论／回复／私信／分享链接；故事板采样不等于完整看视频。QQ空间说说新增受核实的个人QQ账号接口，读取动态／评论、点赞等仍按实际驱动或自备服务；翻唱继续采用用户自备服务协议，普通TTS不等于翻唱或实时通话。未真实登录或未配置服务时不宣称已完成账号往返，详见[0.10.0接入与检索说明](docs/integrations-and-retrieval.md)。

## QQ、微信聊天与本机声音

管理页沿用DSH宿主的颜色、字体和透明背景。“连接 → QQ”默认提供个人QQ的受管NapCat准备与真实扫码，核对账号后默认将该独立QQ的私聊与群聊接到当前已加载人格。自主社交无需用户逐个预选联系人或群；是否关注、联系、尝试加好友、回应、主动或休息仍由人格判断。指定对象作为可选隐私／测试范围，属于用户的平台授权。Windows受管入口检查已有QQ，固定来源下载和校验NapCat，使用独立运行目录；它启动QQ桥进程，不接管一个已经打开的桌面窗口。操作、停止与恢复边界及好友能力状态见[个人QQ一键接入](docs/qq-one-click-setup.md)。主动申请在固定版公开OneBot中仍无action；原创原生账号工具已在本轮源码接线，正式DSH加载后的工具实测另验。收到好友申请的事件／处理链仍未接线；两项能力分别见[QQ账号操作](docs/qq-account-operations.md)，不把接口状态写成人格社交禁令。

QQ官方Bot与使用已有OneBot11桥保留次级方式；官方Bot的资质与被动回复限制不套到个人QQ桥。微信官方iLink仍只支持私聊，普通微信群、朋友圈或实时通话不因本轮QQ改动而开放；已有微信OneBot12桥按实际能力接入。当前能力分别显示驱动支持、用户许可与实际可用。

0.10.1完成的B站本人扫码与仅feed.read只读范围仍见[历史说明](docs/ui-retrieval-context-validation.md)；0.11.0的安装、本人扫码、正式人格接入、私聊／群聊收发与真实停止分别在[0.11.0历史验收](docs/qq-one-click-setup.md#0110-final-acceptance)报告，不能从旧版数字推断成功。个人网页与Telegram继续保留后续接口。

声音使用Windows现有System.Speech生成WAV，由人格按需选择已安装音色，用户也可指定。官方QQ／微信当前都缺少已验证的本机WAV语音发送编码链；QQ OneBot11语音需实际桥确认record能力，微信OneBot12不宣称语音可用。语音消息与实时语音通话是两种能力。语速近似SAPI音级、音高暂不支持；具体操作与限制见[渠道接入](docs/channel-integration.md)。

## 账号能力与连接恢复

QQ权限页分别显示“修改自己的头像与资料”和“发表QQ空间说说”，并展示驱动来源、未授权／离线／未提供等真实状态；语音消息与实时通话分开。账号操作记录按真实operation展示“账号自身”与completed，不把资料更新叫作好友申请。发布范围、图片容量和成功回执见[完整账号说明](docs/qq-account-operations.md)。

管理受限时等本地倒数后点“重新检查连接”；新鲜查询证实QQ离线且无QR时才提供本人一次“重新连接QQ”。只有拿到当前有效QR才提示手机扫码；保持原人格、账号、范围与许可，不重置记忆或自动扩大接入。微信／B站／Telegram／抖音的真实边界见[跨平台能力表](docs/account-capabilities.md#按平台核对实际范围)。

## 陪伴工具与形象创作

“相续人格”陪伴预设在普通DSH、IM、主动与唤醒中提供八个人格工具：memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task。人格可通过persona_task自主派发工程、研究或其它任务；是否派发、给什么材料及记什么仍由它决定。子任务新建独立上下文并显式使用xiangxu-task-worker工作预设，完整prompt、宿主过程与报告留在独立任务档案，主会话按需读取；retain自主选择实际片段供原有记忆整理。主预设不直接恢复全部裸派发、Harness和编码工具，其它DSH预设保留原工具。详见[自主委派与任务档案](docs/delegation-and-task-archives.md)。

“创作 → 形象档案”保存共同形象描述、主参考图和有限版本。用户可锁定档案，或允许人格通过persona_media按需修改；参考档案与实际模型能力一起服务形象连续性，不保证生成结果像素级一致。图片与视频服务分开配置、默认关闭；图片可接OpenAI风格Images或ComfyUI，视频需用户实际可运行的ComfyUI工作流。连接测试不生成作品；明确生成先返回持久任务号，再查询同一任务，结果未知不自动付费重试。生成和平台发送分别取得回执。详见[形象、作品与可选创作服务](docs/media-and-identity.md)。

## 深刻记忆与整理资料助手

深刻记忆把人格认为重要的全部情绪经历放在一个有容量上限的模块中。它是人格参考，不表示当前已回忆或必须反应；什么时候联想到、怎样反应以及重释、淡化、合并、替换或修剪，都由人格自己决定。程序不做关键词触发、自动治愈、时间衰减或情绪比例。经历、当时感受和当前理解分开保存并引用实际来源；默认128条／100000字符，仍计入现有长期文本与实例容量。参考段默认600计数单位，总动态预算仍为2970。

整理时可分页读取本次目标与全局的旧普通记忆索引和深刻记忆。默认关闭的整理资料助手沿用DSH当前模型，只给本次片段的信息保真建议；人格可不采纳，最终意义与变化仍由它决定。助手共享原整理调用预算，未知结果不自动付费重放；浏览和保存设置不启动整理。详见[深刻记忆、整理助手与社交身份](docs/memory-reflection-and-social-identities.md)。

“连接 → 社交身份”可登记用户为人格准备的账号，或从当前真实QQ／微信连接核对后登记。多个档案不等于同平台多账号同时在线；B站现有独立可选适配器，需要本人实际扫码及逐项授权；抖音等尚无适配器时只登记参考，不冒称已连接或已获得私信／投稿能力。persona_platform的accounts动作只读目录，不授予执行权。QQ官方取消主动推送，缺有效被动回复上下文返回QQ_PUSH_UNAVAILABLE；这个驱动限制不改变人格主动联系的自主判断，也不套用至OneBot桥。

## 实例、开关与加载

默认记忆目录为DSH数据目录下的`persona`，Windows常见为`%USERPROFILE%\.dsh\persona`。可通过管理页选择明确的绝对目录；部署时仍可用coordinator配置`memoryRoot`或环境变量`PERSONA_MEMORY_ROOT`指定初始目录。实例登记与人格数据分开，同一时刻只加载一个活动写者。

“设置 → 人格管理”支持只填名称的新建独立人格、明确切换、归档保留和恢复。归档停止使用但保留全部资料，它不是独立备份。“清除文本资料…”先显示后台实际范围/排除项/文件数/大小，五分钟内精确输入名称后才提交；停机后变化会零删除要求重新预览，部分失败保持不可加载并需重新确认。清除只处理目标库受管文本、索引和收据，外部任务原件、作品二进制、共享账号凭据、DSH旧会话与外部备份均保留。清除后旧根不可重用，不自动创建或切换新人格；库外会话归属哈希阻止旧会话自动混入新库。最多16个未清除实例（归档/partial仍计入）与256个清除墓碑，满时明确报错，不自动淘汰。字段和动作见[第21节](docs/plan/persona/persona-schema.md#21-人格实例生命周期与文本清除090)，日常操作见[使用说明](docs/user-guide.md#人格管理切换归档与清除)。

“停用实例”停止该实例接收、调度和写入并释放工具/监听与写锁，保留原数据。总览中的主动联系开关决定是否允许它主动找人聊天：关闭只停止后续主动判断及可取消的待交付主动消息，你发来的消息仍会接收，是否回应由人格判断；开启也不要求它一定主动。睡眠时才显示“现在叫醒”，表示这次由你明确唤醒它，恢复后由它判断怎样处理待办来信，不保证立即发出回复。忙碌对话、整理或管理长操作期间不切换实例。已归属于另一实例的旧会话不自动带入新实例；一个实例里的不同人物仍共享共同人格，人物分区不是多租户权限制度。

已保存的加载选择和技术配置在重载后保留。恢复/恢复中断完成后保持停用，需你明确再次加载，避免恢复旧库时悄悄启动其旧计时工作。备份与校验先释放写者，结束后恢复此前加载的实例。

## 整理、容量与保真

`consolidationPlan.run`选择本次有界增量，`defer`暂缓；人格、印象、关系、习惯、编码等各模块都可不变。默认`sleep`可配合人格选择的睡眠整理，也可只休息或清醒时明确run；`on_write`合并写入后的机会事实，由正常人格轮判断，不在每条消息后擅自付费。切换模式保留来源与消费游标。

初值为近期3天／10万字符、长期活动时间线正文100万字符、临时过程20万字符。近期超时或超量转长期，长期超量将最旧记录完整转归档，不调用模型重新概括。人格、索引、关系和深刻参考仍分别受业务文档及实例物理容量约束，不占长期活动时间线的100万字符配额。归档不自动删除；物理存储不足明确报告，既有资料保留，用户可备份、增加容量或明确选择旧归档遗忘。单条进化记录16,000字符／64KiB、业务JSON1MiB、实例物理默认64MiB等硬帽继续成立，具体口径见[时间线说明](docs/memory-timeline-and-context.md)。

未读尾部不冒称已消费，失败不冒称提交；助手角色与实际发言者不因关系归属改变。转层保留原文、编号、来源、时间与已有注释，不把离开短期或活动长期层当成遗忘。明确遗忘仍按源依赖清理相关派生、临时副本和未提交候选，并防止通过回滚／重建复活。转层保真不等于无限硬盘或硬件故障备份保证，外部宿主资料也不由本插件承诺永久保存。

显式整理/回补可能调用模型，页面先获得持久操作收据，再查询实际结果；不要在结果未知时重复发起。旧进程遗留queued/running标为unknown，不自动付费重放。只读浏览、设置页加载和本地维护本身不调用模型；明确加载已有实例可能恢复它此前已选的计时/控制工作，界面会说明。

## 命令行与维护

图形页之外仍保留命令行，适合脚本和离线操作：

```powershell
node scripts/persona-cli.mjs status
node scripts/persona-cli.mjs wake
node scripts/persona-cli.mjs mute
node scripts/persona-cli.mjs resume
node scripts/persona-cli.mjs config '{"consolidationMode":"on_write"}'
node scripts/persona-cli.mjs config '{"consolidationMode":"sleep"}'
```

可用`--root '绝对记忆目录'`选择实例。CLI超时代表结果未知，先查状态/回执，不盲目重发副作用操作。若强行结束CLI留下`operator/client.lock`，先确认所记PID已结束再移除该锁。

离线备份/导入/恢复只支持v3；先停止写者，维护命令拒绝活动数据库。图形页会协调停用/重载，命令行需要手工先停用实例：

```powershell
node scripts/persona-cli.mjs validate
node scripts/persona-cli.mjs backup 'C:\path\to\persona-data-latest'
node scripts/persona-cli.mjs restore 'C:\path\to\persona-data-latest'
node scripts/persona-cli.mjs recover
```

`export/import`等价于`backup/restore`。备份校验路径、版本、容量与SHA，使用固定previous槽；Windows恢复通过可恢复journal处理两次rename之间中断，不删除未知目录。恢复携带现库较新的明确撤销。它不能清除独立宿主日志或他人另存的副本。形象档案随实例文本保存，作品字节和生成服务凭据在文本库之外；文本备份不包含这些外部文件，作品清单也仅有元数据和SHA，需另存原文件。

任务档案初值为总量1GiB、单任务／单资料64MiB、4096条任务收据，按实例独立保存，可在“任务与资料”的高级设置调整。容量满明确报错，旧资料／防重凭据不自动淘汰。形象作品的80条生成收据上限属于另一媒体模块，任务档案扩容不会改它。UI单次文件下载上限64MiB；status默认返回紧凑任务卡，资料目录和正文按需分页。文件快照归档使用受单资料上限约束的整份文件缓冲，DSH冷查询也可能载入单个子会话日志，不能把分页等同于恒定RAM。明确遗忘清理插件任务正文与派生材料，不删除DSH原始历史。

## 文档与验证

0.13.0的时间线与必要上下文历史验证见[本版机器回执](docs/verification/0.13.0-memory-timeline.json)，使用方式见[时间线说明](docs/memory-timeline-and-context.md)。本轮0.13.3冻结完整回归1400/1400通过，失败／取消／跳过均为0，见[机器回执](docs/verification/0.13.3-qq-profile-output.json)；隔离验证与真实加载边界见[修复说明](docs/qq-profile-output-recovery.md)。本轮尚未重载真实桌面或重新进行真实模型／QQ资料修改验收，QQ资料变更由用户自行测试，其他社交入口继续标未测试；0.12.0的[账号能力与当时待验收表](docs/account-capabilities.md#0120-current-acceptance)、0.11.0的[好友／聊天历史结果](docs/qq-one-click-setup.md#0110-final-acceptance)保留原范围。本轮按用户决定推进Market申请，实际PR与审核状态见[收录记录](docs/market-submission.md)，不能由本地测试推断已获收录。

0.12.0历史阶段的真实Flash早期验证已完成lexical／association记忆检索、QQ账号只读检查与已有好友查询，模型自主选择不改资料、不发空间，真实写入未验收。冻结源码完整回归1289／1289与实际ownership残锁自动恢复已通过；累计17次真实模型请求，修后3次工具调用已核当前QQ／B站未登录的能力状态与明确错误。本次新受控QQ和B站仍等待本人扫码，OneBot API尚不可用，登录后材料、平台写入和新群消息往返待验；前阶段在线不代表当前已登录。结果见[本轮观测](docs/account-capabilities.md#0120-stage-observations)与[公开收据](docs/verification/0.12.0-account-recovery.json)。

0.9.0已修改核心与适配层，自我档案、关联/检索状态、交流定位、人格生命周期和新增界面需要本轮重新验收。统一结论与证据在[0.9.0最终验收状态](docs/management-ui.md#090-final-acceptance)更新，不能从以下历史通过数推定。尤其0.8.0“50份后台及配套文件未变”不适用于本轮。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。该历史版本[完整本地回归](docs/verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](docs/verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](docs/verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。


- [自包含完整方案入口](docs/plan/persona/README.md)与[主实施计划](docs/plan/长期AI人格插件-实施计划.md)
- [面向普通用户的使用说明](docs/user-guide.md)
- [当前管理界面与验收范围](docs/management-ui.md)
- [个人QQ一键准备、扫码与接入](docs/qq-one-click-setup.md)
- [QQ、微信聊天渠道与本机声音](docs/channel-integration.md)
- [形象档案、图片／视频接口与作品容量](docs/media-and-identity.md)
- [自主委派、任务档案与资料保真](docs/delegation-and-task-archives.md)
- [深刻记忆、整理资料助手与社交身份](docs/memory-reflection-and-social-identities.md)
- [DSH Market 收录材料与申请条件](docs/market-submission.md)
- [十四模块映射](docs/feature-map.md)、[核心接口](docs/runtime-api.md)、[存储接口](docs/repository-api.md)
- [0.2.0自主整理、容量与唤醒历史](docs/evolution-and-wake-validation.md)
- [0.1.1真实模型全流程历史](docs/real-model-validation.md)

0.6.0历史：当时开放persona_task自主委派、独立工作预设、任务过程隔离和自主retain。当时最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](docs/verification/0.6.0-tests.json)、[两阶段原生SDK](docs/verification/0.6.0-sdk-fixture.json)及[静态自主性审查](docs/verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](docs/management-ui.md)单独维护。

0.7.0[完整本地回归](docs/verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](docs/verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](docs/verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](docs/verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0的495/35及当时九页GUI、0.5.0和更早结果保留历史含义。0.7.0已修改核心，不能沿用0.6.0核心九文件未变的结论。

0.5.0历史：当时新增陪伴工具隔离、官方扫码连接、实际能力授权与形象创作接口。本地完整回归422/422通过；真实DSH SDK主链85项和最终作用域专项、八页原生设置与真实二维码获取均有分阶段回执，详见[管理说明](docs/management-ui.md#050-实现与验证范围)。未完成的本人扫码收发、真实供应商生成及GUI文件选择器自动化不列为已通过。0.4.1原生界面、0.4.0的336项本地回归／67项渠道专项和更早真实模型记录保留为各自版本的历史证据，不充当0.7.0重新运行结果，也不证明跨月人格质量。

```powershell
npm test
npm run check
npm run build
node scripts/check-docs.mjs
node scripts/dsh-delegation-integration.mjs
```

`npm run build`从本地ui源生成随插件交付的客户端，无需新增第三方打包依赖；修改页面后运行。

`node scripts/dsh-delegation-integration.mjs`在Windows已安装的真实DSH NEXT中运行独立委派集成测试，自动建立新的隔离home、profile和记忆根，只使用固定响应fixture，不读取生产模型凭据或产生真实LLM调用。默认安装目录为`%LOCALAPPDATA%\Programs\DSH NEXT`，默认证据目录为项目下`work/dsh-delegation-integration`的独立run子目录；home缺省位于该次run内。可选参数如下：

| 环境变量 | 对应参数 | 实际含义 |
|---|---|---|
| DSH_TEST_INSTALL | --install PATH | DSH NEXT安装目录，包含DSH NEXT.exe与resources/app.asar |
| DSH_TEST_HOME | --home NEW_PATH | 必须尚不存在的新隔离目录；已有目录拒绝复用，每次显式指定时使用新路径 |
| DSH_TEST_ARTIFACTS | --artifacts PATH | 验收产物根，脚本在其中新建独立run目录 |

home和证据目录必须位于生产DSH home之外；Windows／DSH缺失明确返回unsupported、退出码2，不冒称通过。`--prepare-only`只准备隔离profile，不能当作完成验收；`--help`显示当前参数。此委派脚本始终为fixture-only，不接受`--real-only`。较早的`scripts/dsh-integration.mjs --real-only`属于另一条真实模型测试入口，会产生所配置供应商的正常调用费用。

## 适配其他宿主

`core/`不导入DSH、不读取环境变量或凭据。接入方注入模型、时钟、实际交付/对账和trace读取端口，通用入口为`dsh-xiangxu-persona/core`。DSH事件、预设、inbox、模型路由、管理RPC与图形入口均留在适配层。详见[移植说明](docs/porting.md)。

## QQ账号工具、思考设置与资料维护

persona_platform新增scope:account分支，不需要先伪造QQ私聊目标或绑定；查询对象、是否申请、验证文字与记什么仍由人格决定。能力只授予一次，执行时核当前人格、真实账号和接口状态，不逐次要求用户选择朋友或批准申请。完整技术档案保留工具来源，不自动成为人类对话或人格记忆；入站friend.manage、群管理和实时通话继续按实际未接线状态报告。

本轮CONTROL_GUIDANCE增加这条API用法和事实回执说明；core增加的是通用maintenance extensionValidator端口，使精确扩展档案进入备份／恢复校验，未引入QQ依赖或人格规则，不能称本轮核心全部未变。当前人格内的QQ账号档案可在原目录备份恢复并纳入明确文本清除，库外共享native journal仍排除；跨人格／换目录档案迁移未实现。思考强度与同名、改名、换号的区别见[使用说明](docs/user-guide.md#qq聊天的思考强度与认人)。
