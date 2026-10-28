# DSH Market 收录申请

当前发布补丁：**0.13.3**。本补丁修复自我档案来源容量及文字渠道的卡片显示，范围见[QQ资料与文字输出修复](qq-profile-output-recovery.md)；0.13.2的[QQ恢复记录](qq-reply-recovery.md)与0.13.1的申请验收仍保留原范围。目标仓库：[MingoYung/dsh-Xiangxu-Persona](https://github.com/MingoYung/dsh-Xiangxu-Persona)。2026-10-28已按用户决定提交[收录申请PR #10004](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10004)，**自动检查已通过，当前开放且未合并，待维护者审核，尚未获收录**。旧版关于暂缓申请的文字仅记录当时状态，不覆盖本轮决定。

## 本轮材料与反馈入口

- 插件包保留独立核心＋DSH适配层、预构建管理界面与五个主入口，dsh.bundle和dsh.client由根package.json声明。0.13.1只增加报错入口及交付材料，persona-memory/3和0.13.0统一时间线、必要上下文继续兼容；不增加人格自主判断规则。
- 报错入口：[中文Issue表单](https://github.com/MingoYung/dsh-Xiangxu-Persona/issues/new?template=bug_report.yml)，新报错默认带bug标签并指派MingoYung；GitHub Issues已启用。设置里的最小诊断摘要在本机生成，用户检查后主动提交公开Issue。说明见[问题反馈](support.md)和[SUPPORT.md](../SUPPORT.md)。
- 目录条目为[market/MingoYung__dsh-Xiangxu-Persona.yml](../market/MingoYung__dsh-Xiangxu-Persona.yml)，使用memory分类。申请只在收录仓库data/plugins/增加同名文件，不修改自动生成的README。描述须区分已实现、可选服务与真实账号未测范围。
- 2026-10-28核对仓库管理权限、启用Issues、dsh-plugin topic与至少一天仓库年龄均符合当时要求。贡献指南仍以[上游当前指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)为准，最终收录由上游维护者审查。

## 验证与未测边界

0.13.0统一时间线的证据见[历史机器回执](verification/0.13.0-memory-timeline.json)。该版可移植性修复后GitHub Actions运行40624830474在Windows通过1343项，在Linux通过1342项并保留1项Windows专用跳过；结果属于原提交4013d009164c10848f50e903eedd7f2f409b8b8a，不是0.13.1新增报错功能的验收。0.13.1在Windows、Node.js 24.16.0下完成本机全量1357/1357，失败、取消和跳过均为0；源文件哈希在测试前后不变。定向49/49包含本轮新增14项，与全量不叠加计算，详见[0.13.1报错通道回执](verification/0.13.1-support-channel.json)。本轮源码已推送，远程CI以[插件仓库Actions](https://github.com/MingoYung/dsh-Xiangxu-Persona/actions/workflows/ci.yml)对应提交的实际结果为准，不由本机结果推断。

本轮报错通道、文档与收录材料不运行真实模型或社交账号测试，不因申请收录宣称QQ、B站或其他社交平台已全部验证。QQ按用户安排自行验证；其他社交连接继续显示未测试，旧版真实验收仍保留原范围。问题反馈不会自动上传记忆库，也不承诺持续调用付费模型来监控工单。

## 申请进度

本轮申请为[awesome-dsh-plugin/awesome-dsh-plugin#10004](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10004)，创建于2026-10-28T04:28:39Z。2026-10-28（北京时间）复核时，[上游PR check](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/40632538658)与[Submission gate](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/runs/122677392329)均已通过，之前的action_required已解除。PR仍为开放、非草稿、未合并，未发现合并冲突；只新增一条目录记录，等待上游维护者审核与合并。当前MingoYung账号对上游只有读取权限，不能代替上游维护者批准或合并。申请目标为main，提交头为d6e56096044211a0db9e8b791efe54b5c2514b65；插件0.13.1源码提交为86f0677，后续申请材料已同步。CI通过不表示已获收录；后续以PR检查、维护者意见与最终合并状态为准。

## 历史材料与当时状态

以下保留0.8.0–0.11.0材料、数字和当时未提交的状态，仅供回查，不代表0.13.1当前发布结论。

目标仓库：[MingoYung/dsh-Xiangxu-Persona](https://github.com/MingoYung/dsh-Xiangxu-Persona)。本目录提供收录材料，不表示已向收录仓库发起申请或已获收录。

0.11.0当前增加个人QQ受管准备与扫码，默认自主社交接入该独立QQ的私聊与群聊，指定对象范围可选；真实安装、本人登录、正式人格接入、收发与停止分别见[本轮最终验收](qq-one-click-setup.md#0110-final-acceptance)。以下旧版说明和数字保留历史含义，不作为本轮申请所需的实际平台证据。

依据：[awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，核对日期2026-10-26。

插件根package.json同时声明dsh.bundle和dsh.client；cordis.patch.yml提供协调器与可选相续人格预设，ui/client.js是预构建的宿主客户端。0.8.0沿用DSH原生主题，以五个主入口和任务式子页管理既有能力，包括可演化的深刻记忆参考、默认关闭的整理资料助手、账号与社交身份目录、persona_task自主委派、独立工作预设与任务档案、陪伴工具范围、QQ官方Bot／微信iLink扫码、已有OneBot高级接入、实际能力权限、本机语音、形象档案及可选图片／视频服务。图片／视频默认关闭，视频需用户实际可运行的ComfyUI工作流。QQ扫码不是桌面个人账号接管；微信官方只支持私聊，朋友圈、实时通话和官方WAV语音发送未实现。0.10.0交付时没有本人真实扫码、真实平台往返或付费媒体生成验收；0.10.1的B站本人扫码与仅feed.read只读范围另见[当前验收](ui-retrieval-context-validation.md)，不据此宣称平台外发通过。个人移动端应用／网页与Telegram仍留接口，不在本版发布入口。安装不要求新增前端依赖或自动启动模型，不复制宿主或其它插件。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

自主委派使用独立新会话和xiangxu-task-worker预设，任务过程／完整报告在外置档案保留，主会话按需读取并自主retain；委派封套的kind:user不会自动成为人类对话。用户已有DSH权限继续执行，工作预设不是额外OS沙箱；任务不规定人格派发或记忆频率。使用及资源边界见[自主委派与任务档案](delegation-and-task-archives.md)。

深刻记忆的触发、反应与演化修剪由人格决定，资料助手只提供可忽略的保真建议，不形成性格纠偏关卡。账号目录本身不授予平台能力；0.10.0的B站另有已实现的独立可选适配器，需实际扫码、启用及逐项授权，抖音等未接入平台仍仅登记与适配接口预留；QQ官方不提供主动推送，OneBot按实际桥能力执行。详情见[新增功能说明](memory-reflection-and-social-identities.md)。

收录草稿在[market/MingoYung__dsh-Xiangxu-Persona.yml](../market/MingoYung__dsh-Xiangxu-Persona.yml)。以后申请时，将该文件放到收录仓库的data/plugins/同名位置并发起PR；无需手工改收录仓库生成的README。草稿使用memory分类，只描述已实现功能，不宣称长期人格质量保证。

贡献指南要求目标仓库存在至少一天，并带dsh-plugin topic。GitHub公开元数据记录本仓库创建于2026-10-25T12:13:18Z，即北京时间2026-10-25 20:13:18；满一天为2026-10-26 20:13:18。收录前需按当时指南与仓库实际状态复核。CI通过只代表检查通过，最终收录由维护者审查。

发布集合包含预构建前端；推送后的源码安装路径为：

```sh
dsh plugin add https://github.com/MingoYung/dsh-Xiangxu-Persona
```

本地构建与测试：

```sh
node scripts/build-ui.mjs
npm test
npm run check
node scripts/check-docs.mjs
npm pack --dry-run
# Windows已安装DSH时，可另跑隔离的真实宿主确定性委派专项
node scripts/dsh-delegation-integration.mjs
```

GitHub Actions使用Node24，在Windows与Linux分别运行不调用真实模型的测试。实际DSH UI、模拟平台/模型的渠道专项、已生成WAV及此前真实模型验证的范围、失败与未测边界见[管理界面说明](management-ui.md)和[渠道接入](channel-integration.md)。0.6.0历史回执：完整回归495/495、真实DSH加固定fixture专项35/35，仓库可复用脚本另一次35/35；真实语言模型调用数为0。原生GUI只按实际检查记录，不预填结果。0.5.0的422项／85＋22项及0.4.1和更早数字保持历史含义。不要在公开issue、日志或交付中上传记忆库、模型凭据、浏览器owner URL或认证cookie。


0.7.0历史回执：[完整本地回归](verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0的495/35及当时九页GUI、0.5.0和更早结果保留历史含义。0.7.0已修改核心，不能沿用0.6.0核心九文件未变的结论。

## 0.10.0 材料更新状态

本轮补充混合候选检索、有效时间与参考诊断、QQ丰富消息、B站可选适配和用户自备动态／翻唱协议。介绍时须同时说明可选服务、真实账号、字幕／故事板覆盖与外发回执限制，不能把功能目录当成真实平台全部可用。persona-memory/3、八工具与动态快照2970预算保持兼容；不导入第三方人格裁决规则。

当前仍是收录准备，尚未向awesome-dsh-plugin提交申请，也未获收录。最终回归、原生宿主、界面、包闭包和未测边界在[0.10.0 接入与检索说明](integrations-and-retrieval.md)统一维护；0.9.0及更早通过数不能充当本轮新能力的验收。后续是否申请由用户已约定的测试与实际发布步骤决定，本次文档同步不发布申请。

## 0.10.1 发布前状态

本轮补齐操作可见性／翻页／扫码恢复及同源旧系统投影重复修复，最终证据集中于[0.10.1 界面、检索与上下文验收](ui-retrieval-context-validation.md)。市场仍未提交；当前B站只读许可不等于QQ真人往返或B站外发验收，费用与长期人格效果不作保证。历史0.10.0／0.9.0数字保持原版本范围。
