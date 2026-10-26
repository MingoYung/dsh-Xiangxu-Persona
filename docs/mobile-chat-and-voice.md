# 个人网页聊天原型与未来接口

0.4.0实验原型范围说明；当前产品入口同步于0.10.0（2026-10-27）。用户已明确本轮移动端是QQ、微信等现有软件的私聊和群聊；当前交付入口与使用步骤见[聊天渠道接入](channel-integration.md)。个人网页只保留未来接口，不是本版主入口。

## 当前发布状态

当前主协调器没有挂载mobile服务，五个主入口中没有手机网页开关、个人网页配对链接或手机网页专用二维码；“连接”中的QQBot／微信iLink／B站二维码用于各自平台绑定，由本人在手机确认，与这个网页原型的设备配对不同。发布包白名单排除ui/chat及mobile/mobile-host等实验运行文件；源码库保留原型供以后明确需求时继续，不能因为文件存在就写作用户已经可以扫码使用。

原型曾验证单独受限网页、一次性配对、设备授权、只读分页、发送回执和浏览器设备语音；原生DSH＋模拟模型的27项实验结果只属于该原型，不是QQ/微信接入或当前音频链的证据。主方案不再重复列这些实验字段和启动步骤。

## 保留的技术接口

实验源码包含mobile.js、mobile-host.js、ui/chat和本地二维码生成器，分别研究设备鉴权、普通聊天作用域、fragment读取、未知发送不自动重放和设备SpeechSynthesis。它们保持独立于便携核心，不替换当前channels服务，也不会因为浏览文档而开始监听或调用模型。0.5.0通过persona_platform使用实际已支持且用户许可的平台动作，通过persona_media使用可选形象／图片视频接口；它们不启用个人手机应用或网页。

以后若明确启用网页路线，仍需重新检查设备凭据、Host/Origin、实例与恢复撤销、真正用户点击的声音激活、同源静态资源、只读回执以及有限目录/消息窗口；测试必须按届时代码重新完成，旧27项不能直接提升为已发布质量结论。

## 与当前声音方案的区别

浏览器SpeechSynthesis是设备端播放能力，不能当成能向QQ/微信发送的音频文件。当前IM使用Windows System.Speech生成WAV，QQ OneBot11需桥实测record能力并另取音频回执；官方QQ／微信尚无已验证的本机PCM WAV编码发送链，实时通话未实现；具体音色、近似语速、pitch:false、容量与实测边界以[渠道接入](channel-integration.md)及[唯一字段契约](plan/persona/persona-schema.md)为准。

该原型没有训练或克隆专属声音，也没有把Edge在线TTS称作本地服务。保留研究依据：[SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)、[本机/网络音色区分](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)、[edge-tts原仓库](https://github.com/rany2/edge-tts)。

## 0.10.0 与现有软件的连接

本轮补充QQ丰富消息与B站可选接入，不发布个人手机应用或网页。自备翻唱服务生成真实音频资产，可下载或按驱动实际能力发送语音；它不等于RTC通话，也不替代System.Speech日常TTS。入站语音转写默认关闭并依赖实际DSH识别服务。配置、操作回执和未测范围统一见[0.10.0 接入与检索说明](integrations-and-retrieval.md)；历史27项网页实验不作为这些新平台能力的验收。
