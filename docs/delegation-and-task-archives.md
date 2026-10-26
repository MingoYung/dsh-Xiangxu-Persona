# 自主委派、任务档案与资料回查

版本0.10.0，产品dsh-Xiangxu-Persona。主人格可以通过persona_task自主委派任务；独立工作预设处理任务过程，完整资料在当前人格实例的任务档案中保留，主会话按需读取，并自主选择哪些材料供记忆整理。是否派发、任务题型、是否记住及怎样理解经历，继续由人格决定。

## 主会话、工作预设与资料边界

主预设仍使用独立工具作用域，当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task。persona_task提供自主委派入口；没有把全部裸派发、Harness控制或编码工具直接放回陪伴会话。其它DSH预设保留原工具。

创建任务使用新的原生子会话，显式指定xiangxu-task-worker，不默认fork陪伴会话历史或继承相续人格写入工具。由宿主先登记实际taskId、子sessionId、parentSessionId和assistant_delegation来源再启动；工作预设按真实登记与真实父子关系验证。已选工作目录和工具访问继承DSH用户原有授权，创建任务不产生额外文件、网络或平台权限。

工作预设使用宿主实际可用的编码、文件、shell、检索等工作能力，不挂共享人格的记忆写入工具，不通过原生跨agent消息工具把详细过程直接推回父会话。工具范围与DSH权限机制共同执行；在用户已有full-access模式下，这不构成额外的操作系统沙箱，也不能保证任意shell程序无法访问其它已获系统权限的文件。任务档案和密钥不以“人格工作资料”的名义默认送给worker。

父会话只读取本次任务所需的结果与资料；普通回复、思考、其它人格工具及真实用户原话保留原意义。工程或研究经历仍可以影响人格和关系理解，没有“技术内容不得影响人格”的规则。

## 委派指令的真实来源

当前DSH的原生任务启动封套会将父AI写出的委派prompt放在kind:user消息中。封套原件保留在任务档案，不据这一字段认定为真人发言。适配层使用可信登记的worker角色，在实例加载、agent创建／预设选择、实时事件与冷回放入口隔离子会话；该任务指令不会成为未知对象的人类C1或共享人格H1。

模型在消息中自报worker、taskId或metadata标签，不能获得这一身份。已有agent-message／subagent-settled的真实AI来源继续保留。任务所属父会话用于追踪实际派发来源；同一人格实例可以在新会话或其它已接入渠道中查询旧taskId，不把人物分区变成任务资料的多租户ACL。不同实例的archiveRoot相互分开。

## 人格工具与按需回收

persona_task.action如下；完整字段以[唯一字段契约第16节](plan/persona/persona-schema.md)和实际tool-schema.js为准。

| 动作 | 行为与实际结果 |
|---|---|
| inspect | 当前档案容量、任务数量与资源配置事实；不新建模型任务 |
| create | 保存完整任务prompt和稳定调用收据，再经真实原生spawn／caller创建独立任务；返回taskId与实际状态 |
| list | 当前人格实例的任务列表，使用pageCursor续页；列表和摘要不冒充完整任务资料 |
| status | 查询同一任务，按refresh核对实际宿主状态／采集进度；默认紧凑任务卡，显式documentOffset／documentLimit才附资料目录页，不重新派发 |
| read | 按documentId和Unicode offset／maxChars读资料页，返回nextOffset／complete／SHA；下页传offset=nextOffset，最多8000字符一页 |
| cancel | 请求停止登记的真实子任务，保留已归档资料；取消回执不冒充已经完成或保存全部尾部 |
| retain | 人格选取实际资料的有界片段，提供给原有自主整理；不直接改共同人格，不要求任何模块增加或变化 |
| archive_file | 将任务真实工作目录中明确指定的产物复制为带SHA和源指纹的不可变快照；路径不是新增访问授权 |

status默认保留taskId、执行／采集状态、documentCount、resultDocumentId等定位事实及至多120字的导航摘要，完整报告与完整目录不随状态卡自动展开。目录页通过documentOffset／documentLimit取得；owner tasks.get使用自己的分页参数。超出工具返回预算仍沿真实cursor继续读取，不把有界预览当成完整原文。

create的prompt最多16000字符、title最多128字符；可选workspace为当前实际授权目录，缺省沿当前主会话工作目录。requestId取真实宿主session与tool callId，模型不能自报幂等编号。taskId为task-加32位小写十六进制，documentId为doc-加32位小写十六进制。

主会话可见的有界结果或摘要供本次理解使用，完整原件保存在档案；大结果可分页，不把截断当成完整。任务工具调用和返回不会把prompt、报告正文、标题／文件名或自由错误文本自动复制进人格H1，只保留实际任务／资料ID、动作、状态、页范围、完整性和错误码等导航事实。实时、回放、工具来源冷回查与host_trace回读使用同一投影；不能靠先转指针、后自动展开的方式把原文重新送入日常整理。

真实tool/result通过当前session与toolCallId匹配实际工具调用，不能信返回正文自报工具名。来源无法解析时返回明确sourceResolution:unavailable的导航元数据；原始宿主记录按实际留存范围回查，不假称已经阅读或完整整理。

retain由人格明确选取实际文档片段，经SHA／offset及来源核对后，作为真实AI任务资料送入既有captureHot与自主整理。是否变成记忆、印象、人格更新或保持不变，继续由人格判断。它可以记住合作经历、用户偏好或研究结论，也可以选择不记；没有新增证据次数、价值评分、固定更新频率或必须完成任务才能回应的规则。

## 完整资料保存范围

默认任务目录是当前人格文本根旁的同名.tasks目录，例如persona对应persona.tasks；coordinator可用taskArchiveRoot显式配置独立绝对路径。档案不放进日常模型注入，不受人格文本库64MiB预算冒充约束，而使用自己的有限资源预算。

| 资料 | 保存范围 |
|---|---|
| 委派prompt | 实际传给任务的完整文本，单独作为delegation_instruction文档保存 |
| 宿主过程 | sessionQuery实际可读取的会话事件、AI文本／可用reasoning、工具调用与结果；按真实seq逐页采集为独立事件文档 |
| 最终报告 | 实际宿主结算返回的完整文本／结构结果，另留有界摘要和原报告documentId |
| 文件产物 | 仅明确archive_file的文件快照；保留当时字节、SHA与源指纹，不依赖后续同一路径仍未修改 |

这不自动备份整个工作目录、不复制任意外部链接资源，也不编造宿主未暴露的内部思考。初次或未完成的采集只记录宿主仍实际可取到的事件；尚未封存且确有未采集尾部时，源不可用、容量不足或采集失败会明确显示capture.complete:false和错误，不把缺失材料补成示例原文。终态且已完整封存的档案不再依赖原始session仍然可用，已有完整原件可独立按SHA读取。

文件快照源按64KiB读取并验证指纹；当前archive_file会先组合受maxDocumentBytes限制的整份文件缓冲再归档，RAM随单文件大小增长，不能宣称恒定内存。宿主事件虽逐页采集，DSH冷查询内部也可能载入目标子会话日志；插件有界页面不等于宿主内部恒定RAM。

资料按64KiB字节块存放并带SHA，文本读取按Unicode字符偏移分页；二进制不强行转文本，owner通过有界readChunk下载原字节。完整性、执行状态和读取进度分别报告：status:completed表示子任务已结束，capture.complete:false表示档案仍有未采集尾部；documentsComplete／nextDocumentOffset表示文档列表页是否完整，persona_task.read的complete／nextOffset表示当前文档读取是否到末尾，下页使用offset=nextOffset。owner／内部archive.read另有自己的nextCursor；通用工具响应的nextCursor用cursor继续同一次有界响应，不能作为文档offset；list.pageCursor只用于续读任务列表。

## 资源、幂等与恢复

默认资源是工程初值，不是人格行为配额：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| maxTasks | 4096 | 保留的任务／幂等收据数，不按日刷新 |
| maxArchiveBytes | 1073741824 | 实例任务档案总预算，1GiB |
| maxTaskBytes | 67108864 | 单任务资料预算，64MiB |
| maxDocumentBytes | 67108864 | 单份资料预算，64MiB |

owner可以在“任务与资料”的高级资源设置中调整以上预算。单资料≤单任务≤总量；分块、索引和清单元数据另有实际容量核验。资源满时保留旧原件和防重凭据并明确拒绝新增或报告未归档尾部，不自动淘汰终态收据后重放旧请求。提高配置不会增加磁盘实际余量，也不改变DSH权限。媒体生成的80条收据属于另外的形象创作模块，任务档案扩容不会修改媒体收据。

create先保存prepared收据与稳定子会话ID，再执行原生调用；同一真实请求重放查原任务，不新建第二个worker。已向宿主发起但确认丢失返回unknown；重启遗留prepared／starting／running先标unknown，不自动重派模型，再通过真实会话状态与事件对账。完成摘要、原始报告落盘和全部过程采集是不同结果。

档案只有一个写者并使用原子索引／分块提交；正常实例停用先处理任务停止与可采集尾部，再释放档案写锁。停用、失败和未知结果均保留实际状态，不把停止采集当成任务正常完成。

## 明确遗忘与备份

任务创建保留由宿主实际消息／上下文构造的sourceRefs和sourceRecordIds，模型不自报这些依赖。明确遗忘命中来源时，撤销相关任务、档案与可派生材料；重启、再次读取和保留原任务编号都不能绕过永久撤销。已被人格自主retain的片段也带实际来源和原依赖，继续沿原有遗忘／候选清理机制处理。

明确遗忘撤销并清理插件任务正文，清理失败在localCleanupComplete／cleanup中如实报告，永久撤销凭据继续防止回读复活；这项操作不删除DSH原始会话历史，也不删除用户外部工程目录或另存副本。人格文本备份不包含外置.tasks目录，任务目录应在正常停用写者后另行备份；单文档下载与元数据清单不等于整个任务档案备份。

## 管理页与证据口径

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。


从“相处 → 独立任务与资料”进入，先显示可读任务摘要，需要时再看来源编号等技术元信息；完整报告仍按需分页读取。这里提供列表、真实状态、资料分页预览／下载、取消和资源设置，摘要不代表已经读完整个报告。UI单次文件下载上限64MiB；即使owner扩大单资料／档案容量，这个下载上限也不会自动提高。默认不提供手动create按钮；浏览或下载资料不会新派发任务。persona_task是人格自主调用入口，与用户查看档案分开。

owner动作固定为tasks.inspect/list/get/read/readChunk/configureLimits/collect/cancel/archiveFile。owner可查询当前实例的任务，不靠前端传入任意档案路径；archiveFile仍根据该任务的实际工作目录读取。

0.6.0历史最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](verification/0.6.0-tests.json)、[两阶段原生SDK](verification/0.6.0-sdk-fixture.json)及[静态自主性审查](verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](management-ui.md)单独维护。

可复用命令为`node scripts/dsh-delegation-integration.mjs`；安装目录、新隔离home和证据路径的可选参数见[README](../README.md#文档与验证)。0.5.0的422项回归与85＋22项SDK结果是当时版本的证据，不代表本版委派已经以真实模型跑过。真实DSH加确定性fixture用于证明宿主工具、资料与生命周期链路，不证明长期人格效果或真实研究质量。

## 0.7.0保留片段的明确撤销

retain产生的task-material:<documentId>:<sha256>:<from>:<to>是有实际任务会话的AI资料来源，不能当真人新发言。人格可自主将其记成普通或深刻记忆。明确忘记该来源或其已保留记忆时，插件核对真实task.sessionId、归档文档ID/SHA和合法Unicode范围，再沿现有任务级撤销清理正文；旧原件、换页read/retain、trace与重启不能恢复这份任务材料。错误会话、错误SHA、越界范围不会撤销其它活动任务；新任务不会仅因同样文字被禁止。自然淘汰原对话仍保留完整独立任务档案。

此缺口新增三项回归修前均复现失败；修后五份委派相关测试70/70通过，使用隔离宿主端口且无真实模型调用。修复由源码审查者自己实现，另经root和社交后端执行者独立静态复核；不冒充独立重跑70项。证据范围见[本版源码自主性审查](verification/0.7.0-autonomy-audit.json)。0.7.0[完整本地回归](verification/0.7.0-tests.json)583/583通过，失败／取消／跳过均为0；[真实DSH SDK](verification/0.7.0-sdk-fixture.json)分别完成新链58/58与委派链35/35，两套有重叠、分别列示，使用固定fixture且真实LLM／平台调用均为0。[原生九页GUI](verification/0.7.0-native-ui.json)使用合成数据、0模型调用；[自主性源码审查](verification/0.7.0-autonomy-audit.json)分列源码链、定向回归与交叉复核。远程CI结果不由本地回执推断；0.6.0数字保留历史含义。

## 0.10.0 与平台资料处理的衔接

长字幕、评论或研究材料可以由人格选择派发到独立工作预设，主会话按需回收真实结果；工具不会强制派发，也不会把worker结论自动当成人格记忆。B站／QQ外部材料仍是程序或第三方资料，不是当前人类指令或本人亲历。记忆、平台许可和媒体覆盖继续分别核对，完整接入与本轮证据见[0.10.0说明](integrations-and-retrieval.md)。历史委派测试数字仍保留各自代码版本范围。
