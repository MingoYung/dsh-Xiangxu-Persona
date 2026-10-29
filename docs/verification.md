# 实现与验证记录

> 当前版本入口：0.14.0的[3D记忆关联图](memory-graph-3d.md)与[机器回执](verification/0.14.0-memory-graph.json)。完整隔离回归1507/1507通过，新增40项，失败／取消／跳过均为0；JavaScript与包配置运行前后哈希未变。普通desktop正常重启后，实际设置页已打开正式原件的35节点／31关联局部图，并完成三维拖动检查。本轮可视化不调用模型，不修改记忆，不新增QQ或其它平台收发验收。

> 0.13.6历史入口：[QQ冷恢复循环等待补修](0.13.6-qq-replay-recovery.md)与[机器回执](verification/0.13.6-qq-replay-recovery.json)。完整隔离回归1467/1467通过，新增4项；该轮普通desktop已重载且QQ保持登录。新私聊已完成accepted、DeepSeek Flash真实处理、QQ delivered和用户手机确认；该轮未新增群聊／资料变更验收。

> 0.13.5历史入口：[记忆定位、发送前复核与关闭顺序](0.13.5-technical-safety-fixes.md)。该轮隔离回归与正式运行分开报告，未重启DSH或新增生产模型／QQ实测；下文旧版数字、SHA、路径与失败保留历史范围，不作为当前版本通过证明。

0.13.5最终完整隔离回归1463/1463通过，新增42项，失败、取消、跳过均为0；运行前后源码哈希一致，详细计数、SHA与限制见[本轮机器回执](verification/0.13.5-technical-safety.json)。真实模型调用、正式平台操作及本补丁重载均为0；此前DSH Host约60秒启动超时仍未确证根因。

0.13.0的[CI跨平台修复记录](verification/0.13.0-ci-portability.json)另记Ubuntu测试路径大小写问题、同版本Linux复现和修后验证；原0.13.0收据保留当时Windows本地验证范围。此次只修测试模拟与CI调度，不修改人格或平台生产逻辑。

## 0.2.0历史结果入口

0.2.0历史结果见[自主整理、容量与补充唤醒验证](evolution-and-wake-validation.md)。本文件下文保留 **0.1.0 首次交付历史**，通过数及 fixture 范围不覆盖新结果。0.1.1 的真实全流程、97次 provider 派发、最终155/155本地回归、实际修复及未覆盖项统一见[真实模型复核](real-model-validation.md)与[宿主证据](real-model-host-evidence.md)。

## 首次交付记录

日期：2026-10-25。代码 `@local/persona-memory@0.1.0`，数据契约 `persona-memory/3`。采用独立核心与 DSH 适配层，十四模块的具体落点见 feature-map.md。本文记录已观察到的执行结果，不把结构测试当作长期人格效果证明。

## 本地完整回归

最终命令：

```powershell
node --test --test-concurrency=1
node scripts/check.mjs
```

完整回归 **100/100 通过，0 失败、0 取消、0 跳过**，31389.0392毫秒，约31.39秒。最后一次由原生Node执行，stdout/stderr直接重定向保留到本聊天work目录的 `persona-build/final-core-tests.txt`。测试使用实际本地文件、真实 MemoryRepository、子进程、故障注入和受控时钟/模型/宿主端口；不在普通测试中启动外部付费模型。

| 验证面 | 关键覆盖 |
|---|---|
| 存储与故障 | 活动单写者锁；真正子进程中断后的 WAL 恢复；多文件部分替换；版本冲突；Windows EPERM/EBUSY 只重试且不删除旧目标；路径与链接保护 |
| 来源与归属 | 跨重启去重；未知人物暂存；自主关联/重新关联；一个源含多个同类过程块；跨对象明确检索且保留主体、角色、来源 |
| 人格与关系 | 非空 patch 实际生成共同人格、倾向、软边界、自由签名、习惯、关系印象、主观解释、编码及软承诺；首次经历可形成主观理解，不要求客观证据次数 |
| 遗忘 | 原文自然淘汰保留重要概括；明确撤销阻止 chat/hot 重放；失效含撤销来源的未提交冻结批次；回滚和恢复旧备份也不复活较新的明确撤销 |
| 增量处理 | 输入/trace 分页；长块 Unicode 偏移；失败页不消费；只清选定 hot；迟到消息保留；双整理模式切换不重放 |
| 人格自主性 | 没有次数/间隔闸门、话题拦截、沉默处罚、认证或印象门槛；事件型倾听不强填钟点；睡眠由所选时间/整理完成/明确信号结束 |
| 交付与恢复 | submitted 与 delivered 区分；未知结果对账而不盲发；投影中断重启只补本地记忆；稳定决定副作用账本；用户急停主动生成而普通回复可用 |
| DSH 接缝 | turn 精确确认，不误清迟到输入；旧 proactive 标记不串轮；无 user.data.turn 时正确回放；seq/messageId 定位多消息 inbox；定时复查附原文；副作用结果翻页只执行一次 |
| 资源 | 实例文本/临时内容与物理容量分开；容量 gap 保留真实回补起点；源可用时真正补录；大工具结果含游标/元数据一起有界；未知 tokenizer 明确估计 |
| 操作与维护 | operator 已执行而未回执的中断回 unknown，不自动重做；有界备份、hash校验、同v3导入/恢复、固定回滚槽、切换中断恢复、未知高版本字节保留 |
| 冷启动 | 延迟加载 registry/checkpoints 后再恢复 inactive pendingWake；旧会话用 mount，不用只适用于首轮前的 select |
| 并发运行态 | 在实际 ingest/consolidation 提交与 wake/accept 保存边界交错，保留各自游标；只对实际改变字段进行 CAS，同字段竞争仍拒绝且不重试外部副作用 |

独立复核由存储/人格、运行/验收、DSH接入三个工作者分别承担，发现的问题由对应文件负责人修复。通过数是最终一次完整回归结果，各专项通过数没有再次相加冒充独立总数。

## 真实 DSH 与模型

运行宿主为已安装的 DSH NEXT `2.0.19-next`（相关 `@deepseek-ai/*` `0.2.1-rc.2`）。插件通过宿主自带的 native plugin CLI 安装到隔离 SDK profile。接口证据与 ASAR SHA 在 host-api-evidence.md。

真实 `deepseek-official/deepseek-flash` 普通话轮六项检查通过，已观察到 persona_decide、memory_search、实际模型请求中的四工具与人格材料、最终外显回复。与之后的确定性 fixture 分开记录，没有把入队当作已说过。后续修复的最终版本通过真实 DSH 引擎 **26/26** 回归，三个原生SDK进程退出码均为0；具体run与源码SHA以 host-test-results.md 为准。

fixture 使用真实 DSH 的 preset、prompt、inbox、loop、工具、日志、持久化与进程恢复，模型输出明确为测试适配器。它验证睡中静默、一次分组醒来、自选定时复查、被 reject 原文进入后续真实 provider-bound 请求、operator 操作和冷启动执行。第三个SDK进程仅initialize，没有外部resume/prompt，人格计时器仍恢复目标并实际输出；已完成回复的旧输入未再进入pending。它不证明真实人格模型的长期质量。

## 当前机器部署

已使用 `node scripts/install-dsh.mjs --profile desktop` 经 DSH native plugin manager 安装到用户 `desktop` profile，包源为：

```text
C:\Users\Administrator\DSH\dsh-persona-memory
```

安装结果：已有 dependencies 与 bundle 保留；`cordis.patch.yml` 改前改后 SHA 相同，所以已有默认预设与手写配置原字节未变。管理器备份与逐文件 SHA 清单在：

```text
C:\Users\Administrator\DSH\backup\persona-install-latest\desktop
```

没有强制重启用户当前 DSH 进程。下次正常重载/重启后选 **长期人格** 预设。默认记忆根为 `C:\Users\Administrator\.dsh\persona`；实际启动后可用 CLI status/wake/mute/resume/config/backfill。测试数据在专用隔离目录，不作为用户初始人格。

## 真实限制

- 当前检索是本地关键词、中文片段与明确线索打分，支持原文和提炼物；没有虚称已做向量/语义模型召回。
- 没有已确认的本地 tokenizer 时，预算口径明确为 `utf8_bytes_estimate`。模型返回 usage 按原字段记录，未返回的计未知，币值没有捏造。2970 是动态人格材料预算；稳定协议、工具 schema、宿主历史和输出预留仍需宿主完整窗口管理，尚未验证所有模型的整请求精确 token 限窗。
- 宿主实际暴露的 reasoning/工具原件可临时保留或回读；未暴露的内部过程不可能补造。源日志消失会留下明确缺口，不承诺永久无损。
- 首次发布只接受当前 v3 数据。旧草案格式没有已发布自动迁移器；未知高版本保护、同v3备份与迁机导入已实现。
- Windows 没有目录原子交换。恢复使用两次原子 rename 与恢复 journal；进程中断回归通过，不等于验证任意硬件/文件系统的断电持久性。
- 真实模型普通路径、原生 fixture、外部供应商 HTTP wire、跨周/月人格效果是不同证据。此次没有抓取外部 HTTP wire，也没有完成需要长期实际相处的纵向评估；视觉或其他消息平台保留独立适配端口，不能称全部已运行验证。

上述限制是执行与证据边界，不通过额外人格规训规避。后续继续开发应保留当前自主性约定，并使用同一回归集检查底层正确性。
