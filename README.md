# dsh-Xiangxu-Persona · 相续人格

相续人格是面向DSH的长期人格与记忆插件，版本 **0.8.0**，包名 `dsh-xiangxu-persona`。采用独立核心＋DSH适配层；在DSH设置里提供五个主入口和任务式子页，在对话里提供连续记忆、主观人格成长、主动聊天和睡眠唤醒。

这是同一个跨关系成长的人格。它自己判断认出谁、注意谁、记什么、回不回复、何时主动、是否有必要整理、何时睡和怎样醒。软件保存来源与归属、执行选择、控制资源并恢复故障，没有每日主动额度、最短交流间隔、沉默惩罚、印象证据门槛、强制睡眠、话题硬拦截或承诺履约器。

## 安装与打开

使用DSH原生插件安装入口安装Git仓库：

```powershell
dsh plugin add https://github.com/MingoYung/dsh-Xiangxu-Persona
```

正常重载或重启DSH后，打开 **设置 → 相续人格** 管理实例与数据；新对话选择 **相续人格** 预设使用记忆功能。设置页和对话预设是两个入口，安装不替换其它预设的默认选择。Node.js要求22以上。管理客户端随插件交付，使用DSH现有连接、设置slot和宿主React。QQ／微信可选官方扫码连接；已有OneBot兼容桥保留为高级接入，不要求部署个人聊天网站。

产品名、Git仓库名为`dsh-Xiangxu-Persona`，安装包名用小写`dsh-xiangxu-persona`。为兼容已保存会话，内部presetId仍为`persona-memory`，数据格式仍为`persona-memory/3`，无需因改名重写原记忆。

本机源码开发/旧本地链接迁移可在项目目录执行：

```powershell
node scripts/install-dsh.mjs --profile desktop
```

脚本通过宿主包管理器安装或对账，具体迁移结果以实际输出为准；不会手工覆盖其它插件配置或强制结束用户正在使用的DSH进程。Git安装与本地link使用同一套bundle和客户端；本地link安装时应保留源目录。

## 从五个入口开始

| 主入口 | 日常用途与下一步 |
|---|---|
| 相处 | 查看近况、允许或暂停主动联系；休息时可明确叫醒。需要时进入“了解相续”“独立任务与资料”或“运行与用量” |
| 记忆 | 先阅读已保留的内容，再按需要查看深刻经历、认识的人、来源与成长记录；明确遗忘仍有确认 |
| 连接 | 先选QQ、微信、声音或社交身份；单平台的扫码、能力权限、已有兼容桥分别处理 |
| 创作 | 分别进入形象档案、图片服务、视频服务、开始创作和作品任务；保存配置与实际生成分开 |
| 设置 | 分别管理人格与记忆库、启动时加载、使用其他记忆库、交流时间、资料助手、分类容量及维护；切换容量类别保留当前实例草稿，一次保存已改字段 |

子页有明确返回入口。资料以正文和人能理解的标题为先，来源、记录编号和原始字段由命名按钮展开；管理页沿用DSH主题，不再把九个分类和长表单同时铺开。助手与社交资料编辑后点一次保存，保存本身不启动整理或登录。

完整操作说明与本版验收范围见[管理界面说明](docs/management-ui.md)。界面明确区分尚未读取、已提交、暂停、失败和结果未知；分页按钮只继续读同次结果。所有数据来自所选真实实例，不用示例数据冒充当前状态。

## QQ、微信聊天与本机声音

管理页沿用DSH宿主的颜色、字体和透明背景。打开“连接”，选择QQ或微信，由本人手机扫描平台返回的真实二维码并确认，再选择该驱动支持的私聊／群聊范围，明确完成连接并启用。QQ连接的是官方Bot，微信使用官方iLink私聊；这不会自动接管桌面已登录的个人QQ／微信。QQ官方群聊还取决于账号的平台资质与授权；微信官方连接当前没有普通群聊、朋友圈或实时通话能力。已有QQ OneBot11／微信OneBot12兼容桥的配置仍放在高级选项中。

每项平台能力都分别显示驱动支持、用户许可与当前可用；不支持的项目说明原因并禁用新增授权。用户选择接入哪些对象和群，接入后仍由人格判断是否关注、回应、主动或休息。当前没有本人完成真实扫码及真实平台往返的验收记录，配置成功与真实送达分别报告。个人网页与Telegram保留后续接口，本版不挂载手机网页主入口。

声音使用Windows现有System.Speech生成WAV，由人格按需选择已安装音色，用户也可指定。官方QQ／微信当前都缺少已验证的本机WAV语音发送编码链；QQ OneBot11语音需实际桥确认record能力，微信OneBot12不宣称语音可用。语音消息与实时语音通话是两种能力。语速近似SAPI音级、音高暂不支持；具体操作与限制见[渠道接入](docs/channel-integration.md)。

## 陪伴工具与形象创作

“相续人格”陪伴预设在普通DSH、IM、主动与唤醒中提供八个人格工具：memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task。人格可通过persona_task自主派发工程、研究或其它任务；是否派发、给什么材料及记什么仍由它决定。子任务新建独立上下文并显式使用xiangxu-task-worker工作预设，完整prompt、宿主过程与报告留在独立任务档案，主会话按需读取；retain自主选择实际片段供原有记忆整理。主预设不直接恢复全部裸派发、Harness和编码工具，其它DSH预设保留原工具。详见[自主委派与任务档案](docs/delegation-and-task-archives.md)。

“创作 → 形象档案”保存共同形象描述、主参考图和有限版本。用户可锁定档案，或允许人格通过persona_media按需修改；参考档案与实际模型能力一起服务形象连续性，不保证生成结果像素级一致。图片与视频服务分开配置、默认关闭；图片可接OpenAI风格Images或ComfyUI，视频需用户实际可运行的ComfyUI工作流。连接测试不生成作品；明确生成先返回持久任务号，再查询同一任务，结果未知不自动付费重试。生成和平台发送分别取得回执。详见[形象、作品与可选创作服务](docs/media-and-identity.md)。

## 深刻记忆与整理资料助手

深刻记忆把人格认为重要的全部情绪经历放在一个有容量上限的模块中。它是人格参考，不表示当前已回忆或必须反应；什么时候联想到、怎样反应以及重释、淡化、合并、替换或修剪，都由人格自己决定。程序不做关键词触发、自动治愈、时间衰减或情绪比例。经历、当时感受和当前理解分开保存并引用实际来源；默认128条／100000字符，仍计入现有长期文本与实例容量。参考段默认600计数单位，总动态预算仍为2970。

整理时可分页读取本次目标与全局的旧普通记忆索引和深刻记忆。默认关闭的整理资料助手沿用DSH当前模型，只给本次片段的信息保真建议；人格可不采纳，最终意义与变化仍由它决定。助手共享原整理调用预算，未知结果不自动付费重放；浏览和保存设置不启动整理。详见[深刻记忆、整理助手与社交身份](docs/memory-reflection-and-social-identities.md)。

“连接 → 社交身份”可登记用户为人格准备的账号，或从当前真实QQ／微信连接核对后登记。多个档案不等于同平台多账号同时在线；B站、抖音等尚无适配器时只登记参考，不冒称已连接或已获得私信／投稿能力。persona_platform的accounts动作只读目录，不授予执行权。QQ官方取消主动推送，缺有效被动回复上下文返回QQ_PUSH_UNAVAILABLE；这个驱动限制不改变人格主动联系的自主判断，也不套用至OneBot桥。

## 实例、开关与加载

默认记忆目录为DSH数据目录下的`persona`，Windows常见为`%USERPROFILE%\.dsh\persona`。可通过管理页选择明确的绝对目录；部署时仍可用coordinator配置`memoryRoot`或环境变量`PERSONA_MEMORY_ROOT`指定初始目录。实例登记与人格数据分开，同一时刻只加载一个活动写者。

“停用实例”停止该实例接收、调度和写入并释放工具/监听与写锁，保留原数据。总览中的主动联系开关决定是否允许它主动找人聊天：关闭只停止后续主动判断及可取消的待交付主动消息，你发来的消息仍会接收，是否回应由人格判断；开启也不要求它一定主动。睡眠时才显示“现在叫醒”，表示这次由你明确唤醒它，恢复后由它判断怎样处理待办来信，不保证立即发出回复。忙碌对话、整理或管理长操作期间不切换实例。已归属于另一实例的旧会话不自动带入新实例；一个实例里的不同人物仍共享共同人格，人物分区不是多租户权限制度。

已保存的加载选择和技术配置在重载后保留。恢复/恢复中断完成后保持停用，需你明确再次加载，避免恢复旧库时悄悄启动其旧计时工作。备份与校验先释放写者，结束后恢复此前加载的实例。

## 整理、容量与保真

`consolidationPlan.run`选择本次有界增量，`defer`暂缓；人格、印象、关系、习惯、编码等各模块都可不变。默认`sleep`可配合人格选择的睡眠整理，也可只休息或清醒时明确run；`on_write`合并写入后的机会事实，由正常人格轮判断，不在每条消息后擅自付费。切换模式保留来源与消费游标。

初值为实例长期文本100万字符、近期视图10万字符、临时过程20万字符；普通动态注入2970计数单位。单条进化记录16,000字符/64KiB、业务JSON每文件1MiB、实例物理64MiB；新整理增量与冻结上下文分页默认各4,000字符，核心完整输入预算32,768计数单位。实际帽和可调字段见[字段契约](docs/plan/persona/persona-schema.md)。缺tokenizer时明确标`utf8_bytes_estimate`，不能把这些数字冒称整个DSH请求的精确tokenizer硬帽。

未读尾部不冒称已消费，失败不冒称提交；助手角色与实际发言者不因关系归属改变。明确遗忘按源依赖清理相关派生、临时副本和未提交候选，并防止通过回滚/重建复活。自然淘汰可保留重要概括；有限存储与摘要不保证无限原文永久无损。

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

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](docs/verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](docs/verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](docs/verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。


- [自包含完整方案入口](docs/plan/persona/README.md)与[主实施计划](docs/plan/长期AI人格插件-实施计划.md)
- [当前管理界面与验收范围](docs/management-ui.md)
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
