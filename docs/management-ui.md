# 相续人格原生管理界面与验收

版本0.3.0，产品dsh-Xiangxu-Persona，包名dsh-xiangxu-persona。DSH设置入口名“相续人格”，对话预设展示名也为“相续人格”；内部presetId persona-memory及数据schema persona-memory/3保持兼容。本文说明当前实现和可复核边界，最终验收回执单独维护。

## 原生入口与加载

Git安装见[README](../README.md)。正常重载DSH后打开设置中的“相续人格”；面板通过宿主原生settings.section slot注册，使用现有Connection认证载体和Electron IPC/已配置宿主连接。页面在allow-scripts sandbox内运行，消息通过nonce/MessageChannel交给宿主桥；不新开web服务，不把密钥交给iframe，不绕过宿主owner认证。

管理入口与对话预设分别存在。设置页可在实例未加载时显示真实停用状态并加载所选实例，不会为了浏览自动创建未知人物或新模型轮次。启动以保存的实例选择及技术配置为准；明确加载可能恢复此前所选定时/控制工作，这不等于只读浏览自动触发整理。

## 六页功能与真实状态

| 页面 | 已实现入口 | 状态口径 |
|---|---|---|
| 运行总览 | 实例/目录、加载、睡眠、主动暂停、容量、作业和错误 | available:false与未加载如实显示；不填演示数据 |
| 共同人格 | anchor/axes/facets/signatures/habits/retired | 按所选section分页；未读尾部显示不完整 |
| 记忆与关系 | 人物、global、unknown与全部范围；类型/线索检索，来源、原件详情、明确遗忘与单原件重归属 | personId是关系分区；role/speakerId保真实人/AI，未知不强挂 |
| 进化与变更 | job/run、暂停/未读进度、候选/validatedPatch、有限人格历史前后对比与回滚、管理操作收据 | queued/prepared/paused/failed/committed/unknown分别报告；候选不是已提交 |
| 设置与加载 | 技术存储/条目/输入输出/工作区预算、整理模式、实例登记/加载/停用/切换 | 设置说明两模式；没有“人格必须成长频率”或印象资格设置 |
| 维护与诊断 | validate/backup/restore/recover、usage/snapshot/outbox/errors/gaps | 只呈现仍保留的诊断；缺失usage为未知；维护结果与加载状态同时展示 |

明细默认16000个Unicode字符，列表最多100条，管理响应最多128KiB。nextCursor仅继续读取同一结果；选择或底层数据变了则游标失效重新查。记忆目录本身受实例容量约束；浏览不是每轮给模型灌全库。UI不把search的1000结果上限当作完整目录浏览。

## 实例与开关

实例登记persona-instances/1与人格数据schema分离，最多16条、登记文件64KiB；同一时刻一个活动实例、每根目录一个写者。实例停用释放工具、监听、计时器和写锁；暂停主动只停止主动路径，普通回复仍可进行。进行中对话、所选整理或管理长操作会阻止切换。加载失败保留错误，并尝试恢复此前可用实例；未成功不能显示为已切换。

同一个人格可以认识不同人并共享成长；不同实例有独立记忆根。已归另一个实例的会话不自动接入新实例。保存设置在下一次加载继续使用，不被bundle初值覆盖。重载/切换保持来源与消费游标，不把旧经历重演为新事件。

## 明确操作与异步回执

所有变更来自用户明确操作。wake/mute/resume/config/forget/assign/rollback通过活动coordinator执行，读取不另开第二个写者。unknown/global遗忘必须选具体ID，不能空选清库或用无对象时间范围扩成全库操作；已知人物删除保留明确targetPersonId。原件关系归属不改角色、actor、原话与源ID。

整理与回补可能耗时或调用模型，operations.start先写ops/management.json再执行；get/list只查询。同一保留中的requestId返回原收据，不重复执行；界面只点“查询结果”，不把超时当失败后自动重发。旧进程留下queued/running在恢复后标unknown，不自动付费重放。最多保留50个终态/256KiB，未完成收据不静默删除，资源队列沿技术上限拒绝超量工作。

操作回执没有会重执行副作用的分页游标。大详情仅用于只读动作，明确显示片段和完整性。模型自行选择的run/defer与用户显式整理命令分别保留来源，不新增日常行为次数、沉默惩罚、强制睡眠、印象证据门槛、话题过滤或承诺执行器。

## 有限历史、备份与恢复

人格历史受配置约束，不承诺每一模块的永久全量版本。人格版本前后对比/回滚只作用于仍保留的共同人格版本；其它模块变更从仍保留的run patch查看。明确遗忘清除相关历史与候选，回滚不能复活撤销内容。自然淘汰与明确撤销不同，摘要不保证可逆还原原文。

校验和备份先停用写者，操作结束可恢复原加载实例。恢复/恢复中断完成后保持停用，并返回requiresLoad，用户明确再加载；不会恢复旧库后悄悄开启其中旧计时任务。维护沿核心路径/SHA/版本/容量校验及Windows恢复journal，不删除未知目录，不清除独立宿主日志或外部副本。

## 代码与接口

- ui/index.html、ui/app.js、ui/style.css：六页交互；scripts/build-ui.mjs生成ui/client.js并随Git包交付。
- adapters/dsh/ui-host.js：原生Connection管理路由persona-memory.manage。
- adapters/dsh/management.js：有界查询、明确控制、配置白名单与异步收据。
- adapters/dsh/instances.js：实例登记、单写者加载/停用、切换与维护协调。
- core/：持续人格、存储、读取、撤销及运行，不导入DSH/UI。

完整行为与字段见[自包含方案](plan/persona/README.md)、[唯一字段契约](plan/persona/persona-schema.md)、[存储接口](repository-api.md)和[运行接口](runtime-api.md)。原14份reports方案保持同步，docs/plan镜像按仓库位置重写相对链接，独立clone不要求作者本机C盘目录存在。

## 最终验收回执

最终完整本地回归 **229/229通过**，0失败、0取消、0跳过，耗时92522.8601ms。核心与适配层18份运行源码在这次冷回归前后SHA一致。语法/独立核心/包入口检查57个JS/MJS通过；14份自包含方案与14份实现文档检查通过。可复核摘要见[完整回归JSON](verification/0.3.0-tests.json)与[图形验收范围](verification/0.3.0-ui.json)。

使用安装版DSH NEXT 0.2.1-rc.2的独立web profile、localhost owner认证和原生设置slot做真实浏览器验收；未发送模型请求，未访问正式记忆根。原生Connection探针实际验证owner成功、非owner拒绝；真实HTTP验证认证交换、客户端boot graph、未认证401及认证管理RPC200。浏览器从DSH设置进入，而不是仅打开独立静态页面。

实际观察：六页导航；未加载状态→明确加载；recentPreferredDays从3改4保存，卸载/重载仍为4；主动暂停/恢复；非空人格、人物、用户/助手/unknown原件与实际来源；prepared/committed批次；有限人格v1到v2前后对比；共同人格与未知标签分开；选择相续人格预设而不发prompt后设置仍可使用。所有非空数据明确标人工界面样本，不称真实模型成长。

维护页实际执行了校验、创建备份和从该人工备份恢复：校验/备份结束loaded:true；恢复结束loaded:false、requiresLoad:true，原数据通过受控rollback槽保留。最后将校验/备份回执的全量文件数组改为fileCount与总量等摘要，避免操作已成功却因128KiB响应帽报错；完整文件SHA仍在备份manifest中。最终原生API与全套回归核对这一收口，不通过手工改状态冒充结果。

本轮真实GUI发现并修复srcdoc内#链接跳出认证页面、global条目被标未知、维护文件清单过长三个问题。实例失败恢复/监听释放/配置持久失败路径也有隔离故障回归。模型相关整理/明确唤醒/遗忘/回滚语义沿核心测试与此前真实模型报告，不把这次0模型UI验收说成全部模型按钮再次付费跑通。

下图为实际DSH内截图。历史差异与维护操作使用人工构造的隔离验收样本。

![DSH原生设置中的相续人格总览](images/management-overview.png)

![已保留人格历史的修改前后](images/management-history.png)

![DSH内的维护与恢复入口](images/management-maintenance.png)

安装已通过DSH官方管理器从旧@local/persona-memory迁移到dsh-xiangxu-persona本地link，未强制重启生产DSH。正常重载后使用“设置→相续人格”和可选“相续人格”预设；内部persona-memory身份及v3数据保留兼容。

0.1/0.2真实模型结果保留历史：见[0.2.0补充唤醒与容量](evolution-and-wake-validation.md)、[0.1.1全流程](real-model-validation.md)。旧97/146派发、206回归等数字不提升成本版UI验收；长期数周/月人格质量、所有模型/渠道、外部HTTP账单和全DSH请求精确tokenizer硬帽不由本版图形层证明。
