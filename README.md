# dsh-Xiangxu-Persona · 相续人格

相续人格是面向DSH的长期人格与记忆插件，版本 **0.4.0**，包名 `dsh-xiangxu-persona`。采用独立核心＋DSH适配层；在DSH设置里提供七页图形管理界面，在对话里提供连续记忆、主观人格成长、主动聊天和睡眠唤醒。

这是同一个跨关系成长的人格。它自己判断认出谁、注意谁、记什么、回不回复、何时主动、是否有必要整理、何时睡和怎样醒。软件保存来源与归属、执行选择、控制资源并恢复故障，没有每日主动额度、最短交流间隔、沉默惩罚、印象证据门槛、强制睡眠、话题硬拦截或承诺履约器。

## 安装与打开

使用DSH原生插件安装入口安装Git仓库：

```powershell
dsh plugin add https://github.com/MingoYung/dsh-Xiangxu-Persona
```

正常重载或重启DSH后，打开 **设置 → 相续人格** 管理实例与数据；新对话选择 **相续人格** 预设使用记忆功能。设置页和对话预设是两个入口，安装不替换其它预设的默认选择。Node.js要求22以上。管理客户端随插件交付，使用DSH现有连接、设置slot和宿主React。可选IM接入由用户明确启用本机回调并配置自己的平台桥，不要求部署个人聊天网站。

产品名、Git仓库名为`dsh-Xiangxu-Persona`，安装包名用小写`dsh-xiangxu-persona`。为兼容已保存会话，内部presetId仍为`persona-memory`，数据格式仍为`persona-memory/3`，无需因改名重写原记忆。

本机源码开发/旧本地链接迁移可在项目目录执行：

```powershell
node scripts/install-dsh.mjs --profile desktop
```

脚本通过宿主包管理器安装或对账，具体迁移结果以实际输出为准；不会手工覆盖其它插件配置或强制结束用户正在使用的DSH进程。Git安装与本地link使用同一套bundle和客户端；本地link安装时应保留源目录。

## 七页管理界面

| 页面 | 作用 |
|---|---|
| 运行总览 | 当前实例、实际加载/睡眠/主动暂停状态、容量、作业与错误 |
| 共同人格 | 身份基调、坐标、倾向、签名、习惯与退役条目 |
| 记忆与关系 | 按人物/global/unknown检索原件与提炼，查看来源，执行明确遗忘与单条原件关系重归属 |
| 进化与变更 | 所选job/run、未读进度、候选与提交patch、有限人格历史前后对比/回滚及操作收据 |
| 设置与加载 | 整理方式、技术容量和处理预算、登记/加载/停用/切换实例 |
| 维护与诊断 | 校验、备份、恢复、恢复中断、用量/缺口/错误等可用诊断 |
| 聊天渠道与语音 | QQ/微信本地桥配置、私聊/群接入范围、真实连接状态、本机音色和试听 |

完整操作说明与本版验收范围见[管理界面说明](docs/management-ui.md)。界面明确区分尚未读取、已提交、暂停、失败和结果未知；分页按钮只继续读同次结果。所有数据来自所选真实实例，不用示例数据冒充当前状态。

## QQ、微信聊天与本机声音

管理页提供跟随系统、浅色和深色主题，使用中性底色与蓝紫点缀。第七页“聊天渠道与语音”接入用户已有QQ、微信软件的私聊与群聊：QQ使用NapCat等OneBot11本地桥；微信需要用户自行准备具备相应能力的OneBot12兼容桥，微信官方接口当前不提供本方案所需普通群聊能力。保存配置、检查桥连接和平台真实往返分别报告，当前没有真实账号登录证据。

每个账号、房间和实际发言者保留真实来源，不把群或昵称自动当作人物。用户选择接入哪些对象与群，接入后仍由人格判断是否关注、回应、主动或休息。默认不监听；用户明确启用后仅在本机提供桥事件回调。个人网页与Telegram保留为后续接口，本版不挂载手机网页或扫码主入口。

声音使用Windows现有System.Speech音色合成WAV，可由人格通过`persona_voice`自主选择或由用户指定。QQ标准record能力需桥实际确认；当前微信OneBot12不宣称语音发送。语速按近似SAPI音级映射，当前引擎不支持音高调整；未训练或克隆新音色。音频生成、平台交付和用户听到分开记结果。具体前置条件、操作和容量见[聊天渠道接入](docs/channel-integration.md)。

## 实例、开关与加载

默认记忆目录为DSH数据目录下的`persona`，Windows常见为`%USERPROFILE%\.dsh\persona`。可通过管理页选择明确的绝对目录；部署时仍可用coordinator配置`memoryRoot`或环境变量`PERSONA_MEMORY_ROOT`指定初始目录。实例登记与人格数据分开，同一时刻只加载一个活动写者。

“停用实例”停止该实例接收、调度和写入并释放工具/监听与写锁，保留原数据；“暂停主动”只停止后续主动判断及可取消的待交付主动消息，普通回复仍可进行。忙碌对话、整理或管理长操作期间不切换实例。已归属于另一实例的旧会话不自动带入新实例；一个实例里的不同人物仍共享共同人格，人物分区不是多租户权限制度。

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

`export/import`等价于`backup/restore`。备份校验路径、版本、容量与SHA，使用固定previous槽；Windows恢复通过可恢复journal处理两次rename之间中断，不删除未知目录。恢复携带现库较新的明确撤销。它不能清除独立宿主日志或他人另存的副本。

## 文档与验证

- [自包含完整方案入口](docs/plan/persona/README.md)与[主实施计划](docs/plan/长期AI人格插件-实施计划.md)
- [当前管理界面与验收范围](docs/management-ui.md)
- [QQ、微信聊天渠道与本机声音](docs/channel-integration.md)
- [DSH Market 收录材料与申请条件](docs/market-submission.md)
- [十四模块映射](docs/feature-map.md)、[核心接口](docs/runtime-api.md)、[存储接口](docs/repository-api.md)
- [0.2.0自主整理、容量与唤醒历史](docs/evolution-and-wake-validation.md)
- [0.1.1真实模型全流程历史](docs/real-model-validation.md)

0.4.0完整本地回归**336/336通过**，最终原生SDK渠道专项**67/67通过**；已在隔离的真实DSH原生设置中验证七页、新主题、声音保存与冷加载及实际WAV试听播放器。渠道专项使用固定模拟模型和模拟QQ/微信桥，包含真实本机Huihui音频生成；没有真实平台账号往返或声卡播放证明。完整证据与截图见[当前验收](docs/management-ui.md#040-最终验收回执)。0.3.0历史完整本地回归229/229通过；当时在安装版DSH原生设置中验证六页导航、实例加载、配置持久、主动暂停/恢复、数据来源、历史对比和人工样本备份恢复。具体范围、截图及未测边界见管理说明。旧报告里的测试数、源码SHA和模型调用数仍保持历史范围。真实模型测试、原生宿主fixture和本地单测分别报告，不把结构通过等同跨月人格质量证明。

```powershell
npm test
npm run check
npm run build
node scripts/check-docs.mjs
```

`npm run build`从本地ui源生成随插件交付的客户端，无需新增第三方打包依赖；修改页面后运行。真实集成脚本只使用隔离profile/记忆根，`--real-only`会产生已配置供应商的正常调用费用，不读取或复制密钥。

## 适配其他宿主

`core/`不导入DSH、不读取环境变量或凭据。接入方注入模型、时钟、实际交付/对账和trace读取端口，通用入口为`dsh-xiangxu-persona/core`。DSH事件、预设、inbox、模型路由、管理RPC与图形入口均留在适配层。详见[移植说明](docs/porting.md)。
