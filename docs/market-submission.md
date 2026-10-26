# DSH Market 收录准备

目标仓库：[MingoYung/dsh-Xiangxu-Persona](https://github.com/MingoYung/dsh-Xiangxu-Persona)。本目录提供收录材料，不表示已向收录仓库发起申请或已获收录。

依据：[awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，核对日期2026-10-26。

插件根package.json同时声明dsh.bundle和dsh.client；cordis.patch.yml提供协调器与可选相续人格预设，ui/client.js是预构建的宿主客户端。0.8.0沿用DSH原生主题，以五个主入口和任务式子页管理既有能力，包括可演化的深刻记忆参考、默认关闭的整理资料助手、账号与社交身份目录、persona_task自主委派、独立工作预设与任务档案、陪伴工具范围、QQ官方Bot／微信iLink扫码、已有OneBot高级接入、实际能力权限、本机语音、形象档案及可选图片／视频服务。图片／视频默认关闭，视频需用户实际可运行的ComfyUI工作流。QQ扫码不是桌面个人账号接管；微信官方只支持私聊，朋友圈、实时通话和官方WAV语音发送未实现。当前没有本人真实扫码、真实平台往返或付费媒体生成验收。个人移动端应用／网页与Telegram仍留接口，不在本版发布入口。安装不要求新增前端依赖或自动启动模型，不复制宿主或其它插件。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

自主委派使用独立新会话和xiangxu-task-worker预设，任务过程／完整报告在外置档案保留，主会话按需读取并自主retain；委派封套的kind:user不会自动成为人类对话。用户已有DSH权限继续执行，工作预设不是额外OS沙箱；任务不规定人格派发或记忆频率。使用及资源边界见[自主委派与任务档案](delegation-and-task-archives.md)。

深刻记忆的触发、反应与演化修剪由人格决定，资料助手只提供可忽略的保真建议，不形成性格纠偏关卡。账号目录不授予平台能力，B站／抖音等当前仅登记与适配接口预留；QQ官方不提供主动推送，OneBot按实际桥能力执行。详情见[新增功能说明](memory-reflection-and-social-identities.md)。

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
