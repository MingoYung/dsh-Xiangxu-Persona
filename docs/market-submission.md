# DSH Market 收录准备

目标仓库：[MingoYung/dsh-Xiangxu-Persona](https://github.com/MingoYung/dsh-Xiangxu-Persona)。本目录提供收录材料，不表示已向收录仓库发起申请或已获收录。

依据：[awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，核对日期2026-10-26。

插件根package.json同时声明dsh.bundle和dsh.client；cordis.patch.yml提供协调器与可选相续人格预设，ui/client.js是预构建的宿主客户端。0.5.0沿用DSH原生主题，提供八页设置、陪伴工具隔离、QQ官方Bot／微信iLink扫码、已有OneBot高级接入、实际能力权限、本机语音、形象档案及可选图片／视频服务。图片／视频默认关闭，视频需用户实际可运行的ComfyUI工作流。QQ扫码不是桌面个人账号接管；微信官方只支持私聊，朋友圈、实时通话和官方WAV语音发送未实现。当前没有本人真实扫码、真实平台往返或付费媒体生成验收。个人移动端应用／网页与Telegram仍留接口，不在本版发布入口。安装不要求新增前端依赖或自动启动模型，不复制宿主或其它插件。

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
```

GitHub Actions使用Node24，在Windows与Linux分别运行不调用真实模型的测试。实际DSH UI、模拟平台/模型的渠道专项、已生成WAV及此前真实模型验证的范围、失败与未测边界见[管理界面说明](management-ui.md)和[渠道接入](channel-integration.md)。本轮真实回执以0.5.0版本记录为准，0.4.1及更早数字保持历史含义。不要在公开issue、日志或交付中上传记忆库、模型凭据、浏览器owner URL或认证cookie。
