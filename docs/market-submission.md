# DSH Market 收录准备

目标仓库：[MingoYung/dsh-Xiangxu-Persona](https://github.com/MingoYung/dsh-Xiangxu-Persona)。本目录提供收录材料，不表示已向收录仓库发起申请或已获收录。

依据：[awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，核对日期2026-10-26。

插件根package.json同时声明dsh.bundle和dsh.client；cordis.patch.yml提供协调器与可选相续人格预设，ui/client.js是已经构建的宿主客户端模块。0.4.1沿用DSH宿主颜色、字体和透明背景，简化日常操作说明；功能包含可选QQ OneBot11、微信OneBot12兼容桥接入与Windows本机语音；默认不监听，不提供个人手机网页主入口。真实使用需要用户已有平台桥和账号，微信官方接口不保证普通群聊能力，当前没有真实QQ/微信账号往返证据。安装不要求下载第三方前端依赖，也不在安装时自动启动模型。安装来源为本仓库，不复制宿主实现或其他插件。

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

GitHub Actions使用Node24，在Windows与Linux分别运行不调用真实模型的测试。实际DSH UI、模拟平台/模型的渠道专项、已生成WAV及此前真实模型验证的范围、失败与未测边界见[管理界面说明](management-ui.md)和[渠道接入](channel-integration.md)。不要在公开issue、日志或交付中上传记忆库、模型凭据、浏览器owner URL或认证cookie。
