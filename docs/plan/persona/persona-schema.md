# 人格与记忆字段契约：persona-memory/3

当前0.8.0把管理界面重组为“相处、记忆、连接、创作、设置”五个主入口；人格、成长、独立任务和维护改从页内目的入口进入，复杂配置按所选任务分开显示。沿用DSH主题，取消原生三角折叠，先展示可读内容，再由明确按钮查看来源和技术字段。普通资料编辑一次保存；实际付费操作、扩大权限、遗忘和恢复继续明确确认。只变更界面编排，core/、adapters/、八工具和persona-memory/3不变，不增加人格回忆、进化、主动或睡眠规则。当前操作见[管理说明](../../management-ui.md)。0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](../../verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](../../verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](../../verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

本文件是本批方案的**唯一字段权威**。架构、关系说明、主计划引用这里的字段和枚举；不得各自保留另一套 `kind`、版本、对象键或控制接口。下列 TypeScript 结构由 `dsh-xiangxu-persona` 0.7.0 的 JSON 校验器与持久化适配器消费。实际宿主接口及通过范围见实现目录 `docs/host-api-evidence.md`、`docs/host-test-results.md`；首次实现和真实模型复核的兼容扩展见本文第10至12节。

本方案实现的是**同一个 AI 人格认识不同的人**。经历会影响共同人格，也会形成对某个人的独特印象。对象归属用于准确记忆、路由和检索，不是多租户权限边界；允许明确查询、正确谈论第三人。人格判断与数据可靠性分开：程序校验类型、来源、版本和目标，不能用支持次数、问卷分数或硬规则替人格决定如何相处。

## 1. 基础类型、来源与归属

```ts
type SchemaVersion = "persona-memory/3";
type PersonId = string;       // 插件生成的稳定内部键，不等于认证身份
type EpochMs = number;        // 有限、非负整数，UTC epoch milliseconds
type EventId = string;        // ev_ + 固定宽度单调序号，由本实例持久接收 journal 分配
type Scope = "global" | "person";
type Role = "user" | "assistant";
type Origin = "user" | "ai_reply" | "ai_initiated" | "system";
type Epistemic = "user_statement" | "observed" | "interpretation";
type MemoryKind = "fact" | "preference" | "decision" | "pattern";

interface SrcRef {
  sourceSessionId: string;
  sourceEventId: string;
  available: boolean;
  summary?: string;
  sourceKind?: string;
  sourceRole?: Role;
  sourceOrigin?: Origin;
}
interface MemoryMeta {
  schemaVersion: SchemaVersion;
  id: string;
  scope: Scope;
  personId: PersonId | null;
  epistemic: Epistemic;
  srcRefs: SrcRef[];
  createdAt: EpochMs;
  updatedAt: EpochMs;
  retractedBy: string | null;
}
interface Document<T> {
  schemaVersion: SchemaVersion;
  version: number;            // 非负整数；每次成功提交递增
  updatedAt: EpochMs;
  items: T[];
}
```

- `scope:"person"` 必须带非空 `personId`；`scope:"global"` 的 `personId:null` 表示共同用途，不表示没有来源。对象级文件与每条对象记录都保留归属，读写时核对路径与字段。文件可用且存在，不代表其中记载的人就等于当前人。
- 暂未认出的原始事件是例外：`personId:null` 暂存 `staging/events.jsonl`，不能硬塞到当前对象，也不强制每次新建陌生人。它还没有被声明为一个全局记忆。确认后追加 `AssignmentRecord`，由投影建立对象视图。
- 根来源键为 `(sourceSessionId, sourceEventId)`。外部渠道由适配器提供稳定命名空间与事件键；同一消息重试、重放、摘要或转存均不生成第二个根来源。`eventId` 是插件接收顺序，和宿主的 `sourceEventId` 分开。
- `sourceAt` 是来源事件发生时间，`observedAt` 是插件看到它的时间；不要用后者冒充前者，也不要用机器当前时间重写历史。显示与日界用 IANA 时区，不存固定偏移替代时区规则。
- `epistemic` 说明材料性质。`user_statement` 不承诺陈述真实，`observed` 不承诺解释客观，`interpretation` 不构成禁用资格。来源角色在根事件里保留。主观印象可直接存在并参与人格判断。
- 原文自然淘汰后可把对应 `SrcRef.available` 改为 `false`，保留有界来源摘要；可用性变化不等于语义撤回。引用不要求永久保存全部原文。尚存的宿主原件若仍可访问，`available` 可保持 `true`，实际读取需由适配器确认。

## 2. 原始聊天、临时完整过程与未归属事件

```ts
interface ChatRecord {
  schemaVersion: SchemaVersion;
  id: string;
  eventId: EventId;
  personId: PersonId | null; // 关系归属与检索分区，不等于发言者
  speakerId: string | null;  // 实际发言者：已认出的人物ID、独立AI标识或未知null
  sourceSessionId: string;
  sourceEventId: string;
  sourceKind: string;
  contentClass: "participant_dialogue";
  channelId: string;
  sourceAt: EpochMs;
  observedAt: EpochMs;
  timezone: string;
  role: Role;
  origin: "user" | "ai_reply" | "ai_initiated";
  text: string;
  chars: number;
  proactiveId: string | null;
  reactionTo: string | null;   // 明确可关联时指向主动消息/源事件；不强猜归因
}
interface AssignmentRecord {
  schemaVersion: SchemaVersion;
  id: string;
  eventId: EventId;
  sourceRef: SrcRef;
  previousPersonId: PersonId | null;
  personId: PersonId;
  decidedAt: EpochMs;
  environmentVersion: number;
  reason: string;
  supersedesAssignmentId: string | null;
}
type HotContent =
  | { mode: "cached"; text: string; chars: number }
  | { mode: "host_trace"; locator: string; available: boolean; chars: number | null };
interface HotRecord {
  schemaVersion: SchemaVersion;
  id: string;
  eventId: EventId;
  personId: PersonId | null;
  speakerId?: string | null; // 可用时保存实际actor，不用关系人物替代助手/自动材料
  sourceRef: SrcRef;
  sourceKind: string;
  origin: Origin;
  kind: "dialogue" | "reasoning" | "tool_call" | "tool_result" |
    "runtime_context" | "agent_instructions" | "plugin_state" | "agent_message";
  content: HotContent;
  navigationSummary: string | null;
  dependencyRefs?: SrcRef[];         // 本过程实际阅读的源依赖；不是认人证据门槛
  dependencyRecordIds?: string[];
  contextGroupId?: string;           // 同一已接收轮次的过程组
  dependencyScanComplete?: boolean; // false 不得冒充已完成依赖分析
  sourceAt: EpochMs;
  observedAt: EpochMs;
}
interface RecentEntry {
  schemaVersion: SchemaVersion;
  id: string;
  personId: PersonId;
  sourceRef: SrcRef;
  chatRecordId: string | null;
  sourceAt: EpochMs;
  chars: number;
}
```

`ChatRecord` 在 `people/<personId>/stream.jsonl` 保存有限的原始聊天正文，不保存 reasoning 全文。`personId`是关系归属，`role/sourceRole`与`speakerId`保留实际发言来源；人格可以选择把助手原件关联到某段关系，助手仍是assistant，不改成关系人说过的话。助手没有独立actor标识时为null，不借关系人物ID占位；原话、来源ID与发生时间不随关系归属改变。已接收的消息先入接收 journal/队列并稳定去重，记录不取决于是否回复。assistant 消息只有实际发生后才记作说过；决定发送、生成文本、入 inbox、实际交付是不同状态。

适配器必须核对真实`sourceKind`与content块，不能仅因事件叫`user/message`或消息`role:user`就判为真人。实际历史可能在该角色下承载runtime-context、agent-instructions、插件状态卡、agent-message等自动注入；这些不投影为C1用户原话，也不成为“用户要求/自述”的人格证据。C1只收实际参与者的对话正文，混合块逐块分类，不能将真实正文与注入一起全收或全丢。`contentClass:"participant_dialogue"`是适配器已经完成分类的断言，不是照抄消息role；具体源kind与块类型须在P0通过真人输入、自动注入、代理消息和工具事件对照核验。`origin:"system"`只用于系统来源材料，不能通过user角色伪装真人对话。

`hot.jsonl` 是普通主人格对话供本次梳理的过程工作区：可以缓存可用的对话、思考与工具原件，也可用宿主 trace 指针分页读取。0.6.0独立任务的工程正文保存在任务档案；主会话任务控制／结果仅留可信导航元数据，不能通过trace自动展开原文；人格显式retain的实际选段仍可进入原有自主整理。`navigationSummary` 只是导航，不能冒称完整上下文。`host_trace.available:false` 时记录降级，不伪造当时的推理。未知对象的临时过程进入 `staging/hot.jsonl`。

原始聊天活动段追加，梳理提交后可通过轮转/重写删除人格决定不再保留的原文；这不是永久事件溯源库。近期视图优先存引用，读取时再取正文，避免为了“10 万字视图”永久复制第二份全文。若实施选择缓存副本，副本也计入实例容量。

## 3. 检索条目、默契编码与明确撤销

```ts
interface MemoryItem extends MemoryMeta {
  kind: MemoryKind;
  text: string;
  keys: string[];
  importance: number | null; // 可选[0,1]检索提示；不等于人格资格分
  aboutPersonIds: PersonId[];
  validFrom: EpochMs | null;
  validTo: EpochMs | null;
  supersedesIds: string[];
}
interface CodeRecord extends MemoryMeta {
  label: string;
  meaning: string;
  cues: string[];
  expandIds: string[];
  occurrences: number;       // 去重后的根事件次数，可为0；不设>=5才能建码
  lastUsedAt: EpochMs | null;
}
interface RevocationRecord {
  schemaVersion: SchemaVersion;
  id: string;
  eventId: EventId;
  action: "forget" | "correction";
  personId: PersonId | null;
  scope?: "unknown" | "global"; // 0.3.0明确选择的空人物范围；省略沿既有人物语义
  targetIds: string[];
  targetSrcRefs: SrcRef[];
  replacementIds: string[];
  reason: string;
  createdAt: EpochMs;
}
```

`kind` 只有 `fact|preference|decision|pattern`，不同类别可共享检索器，但结果必须说明真实主体与材料性质。`aboutPersonIds` 可以包含第三人，不能因当前对话对象变化而偷偷改写主体。全局编码、共同性格可来自具体对象的经历，也可保留必要的关系解释；不把共同成长视为跨租户泄漏。检索默认目标是当前已识别对象，显式查询可以指定已知他人或全部关系。

编码必须同时有 `meaning` 和来源，`expandIds` 是可选细节的加速入口。自然裁剪掉细节后可减少展开指针、保留编码含义与重要概括，不级联抹掉全部关系记忆。是否继续保留由梳理决定。

**自然遗忘**是容量与意义取舍；**明确纠正/遗忘**是对指定内容的撤销。后者追加 `RevocationRecord`，所有重建、检索和梳理先应用未被 checkpoint 吸收的撤销记录，再消费材料；依赖它的条目更新 `retractedBy` 或按剩余材料重写。不能借恢复旧版本使明确撤销的内容重新生效。撤销记录不保存被要求忘掉的正文，只保存防止本地重建复活所需的有界标识；源回放区间也淘汰后可 checkpoint 压缩，不建立永久材料审计库。明确遗忘范围是本插件的记忆与派生内容，不假装能擦除宿主或外部软件独立保管的源日志。

## 4. 共同人格：描述、变化与主观材料

```ts
interface Axis {
  desc: string;
  position: number | null;   // 可选[0,1]描述坐标，不是人口常模
  n: number;
  sd: number | null;
  metric: string | null;
  window: { from: EpochMs; to: EpochMs } | null;
  srcRefs: SrcRef[];
}
interface TendencyFacet extends MemoryMeta {
  kind: "tendency";
  desc: string;
}
interface BoundaryFacet extends MemoryMeta {
  kind: "boundary";
  policy: "preference" | "ask_first" | "avoid";
  topic: string;
  desc: string;
}
type Facet = TendencyFacet | BoundaryFacet;
interface Signature extends MemoryMeta {
  if: string;
  then: string;
  cues: string[];             // 可为空，本地召回辅助；不是必须命中的行为条件
  observations: number;      // 根来源去重后的描述统计，不作成立闸门
}
interface Habit extends MemoryMeta {
  text: string;
}
interface RetiredEntry {
  entry: Facet | Signature | Habit;
  retiredAt: EpochMs;
  reason: string;
}
interface PersonaDocument {
  schemaVersion: SchemaVersion;
  version: number;
  updatedAt: EpochMs;
  anchor: { text: string; changedAt: EpochMs; srcRefs: SrcRef[] };
  axes: Record<string, Axis>;
  facets: Facet[];
  signatures: Signature[];
  habits: Habit[];
  retired: RetiredEntry[];
}
```

人格以描述为主。初始轴名可用 `warmth/agency/openness/order/reactivity`，这只是便于比较的工程起点，不是模型必须成为哪种人的标签。`if/then` 可以写心理情境，也可以写“在工作群”“深夜聊天”“对方刚重逢”等场景与关系线索；不设禁词、固定特征词表或每条必须指向确定行为的校验。允许同一人有矛盾、缺点和情境差异。

`anchor` 是身份基调，正常请求复用当前版本；在梳理中可以慢慢修订并说明变化，保留有限历史以回退，不能每条消息随意重写，也不要求永不变化。签名、习惯和印象从第一轮起就可存在，不设前20轮、3条独立证据、5次支持、0.6置信等形成资格。一次根事件不得因重试、摘要、多次梳理重复增加计数；自然巩固与行为延续可成为后续新的真实经历。

`Axis.sd` 只表示明确 `metric`、同一量纲、明确 `window` 内实际观测的样本标准差。`n<2` 或没有可复算的观测值时必须为 `null`；不能把“近5次命中成立比例”叫标准差。若需保存比例，另用普通观察描述或诊断指标，不写入 `sd`。`position` 可以是描述性估计，但不能由它伪造一组观测或填入默认 `sd:0.3`。数值只作内部辅助，通常向模型提供自然语言描述。

`BoundaryFacet` 与普通倾向共用文件，但字段分支明确。`policy` 是人格理解对方意愿的材料，不是硬禁止：不做每轮全量禁忌扫描、生成后话题审查或输出硬拦截。直接表达与主观猜测都能记录，靠 `epistemic` 区分，由人格结合当前关系判断如何使用。程序只防止数据结构损坏，不替它决定该不该问。

## 5. 对象、印象、承诺与暂存解释

```ts
interface IdentityDocument {
  schemaVersion: SchemaVersion;
  version: number;
  personId: PersonId;
  displayName: string | null;
  aliases: string[];
  firstMetAt: EpochMs;
  locale: string | null;
  timezone: string | null;
  clues: Array<{ channelId: string; externalId: string | null; desc: string; srcRefs: SrcRef[] }>;
  updatedAt: EpochMs;
}
interface RelationEvent extends MemoryMeta {
  type: "interaction" | "commitment";
  text: string;
  who: "ai" | "person" | "both";
  mentionedTime: EpochMs | null;
  state: "remembered" | "open" | "done" | "cancelled";
  reaction: "replied" | "not_observed" | "explicitly_rejected" | "other";
  reactionTo: string | null;
}
interface ImpressionDocument {
  schemaVersion: SchemaVersion;
  version: number;
  personId: PersonId;
  summary: string;
  signatures: Signature[];
  coordinates: Record<string, { desc: string; value: number | null; srcRefs: SrcRef[] }>;
  events: RelationEvent[];
  updatedAt: EpochMs;
}
interface InterpretationRecord extends MemoryMeta {
  text: string;
  questions: string[];
}
interface PersonState {
  schemaVersion: SchemaVersion;
  version: number;
  personId: PersonId;
  lastSeenAt: EpochMs | null;
  lastDeliveredAt: EpochMs | null;
  relationDescription: string;
  pendingEventIds: EventId[];
  updatedAt: EpochMs;
}
```

`Signature` 在印象中必须为 `scope:"person"` 且匹配该文档的 `personId`。坐标可从 `warmth/competence` 描述起步，也可以没有数值；这些是 AI 的感受，不是对方能力或道德的认证。时间过去、没有回复、又见面等事实交人格理解，不执行关系温度半衰公式、自动扣分、自动降主动频率或固定阶段门槛。

`RelationEvent.type:"commitment"` 只记“谁说过什么、提到什么时间、后来发生了什么”。`mentionedTime` 不驱动强制执行器；时间到了可作为重新判断的新事实，不把未履行定义为程序失败。是否提醒、追问、解释或暂时不提，仍由人格决定。`reaction:"not_observed"` 只表示尚未观察到回复，不等于拒绝，也不自动降重要度。主动对话按真实发生的事件完整记录，不按 `origin` 给检索打折。

P6 继续用 `pending.json` 存暂时解释，但它不再是关押猜测的池子。可以被调用、带着不确定性参与印象，也可以在梳理时合并、改变或自然忘掉。没有强制升格或14天过期资格。

## 6. 环境、路由与人格控制接口

```ts
interface EnvironmentSnapshot {
  schemaVersion: SchemaVersion;
  version: number;
  observedAt: EpochMs;
  channelId: string;
  sessionId: string;
  platform: string;
  placeDescription: string | null;
  participantClues: Array<{ externalId: string | null; displayName: string | null; avatarRef: string | null }>;
  visual: { available: boolean; adapterId: string | null; observation: string | null };
  timezone: string;
}
interface RouteBinding {
  schemaVersion: SchemaVersion;
  id: string;
  environmentVersion: number;
  channelId: string;
  sessionId: string;
  speakerExternalId: string | null;
  personId: PersonId | null;
  reason: string;
  decidedAt: EpochMs;
  supersedesId: string | null;
}
interface DeliveryTarget { channelId: string; sessionId: string; personId: PersonId | null }
interface AttentionPlan { observeChannelIds?: string[]; targetPersonIds?: PersonId[]; reason?: string }
type RecheckTrigger = "new_message" | "environment_change" | "explicit_wake";
type WakeCondition = "at_time" | "consolidation_complete" | "explicit_wake";
interface ReplyPlan {
  action: "reply" | "wait" | "listen";
  target: DeliveryTarget | null;
  pendingEventIds: EventId[];
  replyAt: EpochMs | null;
  recheckOn?: RecheckTrigger[];
  reason: string;
}
interface SleepPlan {
  action: "sleep" | "wake" | "continue";
  wakeAt: EpochMs | null;
  wakeCondition: WakeCondition | null;
  reason: string;
}
interface RetrievePlan {
  action: "search" | "skip";
  query?: string;
  targetPersonId?: PersonId;
  scope?: "person" | "global" | "all";
  limit?: number;
  reason?: string;
}
interface IdentityPlan {
  action: "new" | "associate" | "unknown";
  personId?: PersonId;
  displayName?: string;
  sourceRefs?: SrcRef[];
  reason?: string;
}
interface ConsolidationPlan {
  action: "run" | "defer";
  targetPersonIds?: (PersonId | null)[]; // null是未知/global；[]无工作
  reason?: string;
}
interface PersonaDecideInput {
  consolidationPlan?: ConsolidationPlan | null;
  identityPlan?: IdentityPlan | null;
  attention?: AttentionPlan | null;
  replyPlan?: ReplyPlan | null;
  nextCheckAt?: EpochMs | null;
  sleepPlan?: SleepPlan | null;
  retrievePlan?: RetrievePlan | null;
}
interface DecisionRecord extends PersonaDecideInput {
  schemaVersion: SchemaVersion;
  decisionId: string;
  decidedAt: EpochMs;
  contextVersion: number;
  srcRefs: SrcRef[];
}
```

`registry.json` 保存可修订的 `RouteBinding` 与 `AssignmentRecord` 索引。它记“这次环境下人格把消息指向谁”，不是 `sessionId=身份` 的只增认证表。昵称、头像、平台、房间、时间等给人格判断；视觉只声明当前可用适配器，不假设任意模型已经能接摄像头。识别改变时通过 supersedes 关系重投影，不改写根来源。

`persona_decide` 是人格表达决定的稳定控制接口，不是程序判断人格是否听话的规则引擎。工具可在正常轮次使用；必要时独立唤起一次判断并计费。人格可以按时间醒、等本次整理完成后醒，或等明确唤醒：`sleepPlan.action:"sleep"`选择相应`wakeCondition`，仅`at_time`需要有效`wakeAt`，其余可为`null`。整理完成以本次选择的整理run提交为准，空增量也可以完成，失败不能假称已完成。

`wait/listen`可以只用`recheckOn`等待新消息、环境变化或明确唤醒，不必给墙钟时间；也可以自主设置`replyAt/nextCheckAt`。校验只确认已表达的触发信号可被执行，不替它填固定3秒/10分钟。选择按时间复查时，过去的时点视为已到期并安排一次恢复判断；到了模型自己选的时点，不能因无新消息继续复用旧决定。选择只听新消息时，程序忠实保留该监听，不强制周期唤起。

观察范围必须是适配器实际可见的渠道；工具不能凭聊天材料擅自扩张系统访问能力。睡中禁止 assistant 输出，已选择观察范围内收到的消息照常排队；醒来按对象和通道汇总一次交给人格，保留原文引用，不把不同人的话合成一个人说的。

工具稳定注册为：

| 工具 | 参数 | 目标语义 |
|---|---|---|
| `memory_search` | `{query, targetPersonId?, scope?:"person"\|"global"\|"all", limit?}` | 缺省取当前已识别对象；显式可指其他已知对象或所有关系 |
| `memory_forget` | `{ids?, targetPersonId?, before?, reason}` | 清楚定位对象与内容后生成撤销记录；时间为epoch ms；歧义不批量操作 |
| `persona_introspect` | `{targetPersonId?, section?}` | section为`anchor/axes/facets/signatures/habits/relation/state/all`；可明确查看对他人的印象 |
| `persona_decide` | `PersonaDecideInput` | 写入人格的注意、回话、检索、下一判断与睡眠决定 |

缺省对象未知时，`scope:"person"` 查询返回 `needsTarget`，不偷偷绑定或新建；可继续用 `scope:"global"`、`scope:"all"` 或让人格根据环境识别。显式跨对象查询不默认加管理员 ACL，检索返回真实主体、来源和解释性质。删除必须同时解析清楚对象与内容选择；没有 `ids` 或 `before` 范围时返回 `needsSelection`，不能因对象唯一就把空选择扩成清空此人，更不能解释成全实例删除。整个人物的遗忘可先明确选择其记录，再沿同一撤销流程执行，不额外引入人格资格或权限闸门。

## 7. 运行态、请求快照、梳理提交与交付恢复

```ts
interface SourceCursor {
  sourceSessionId: string;
  receivedThroughCursor: string | null;
  recordedThroughCursor: string | null;
}
interface ConsolidationCursor { lastCommittedEventId: EventId | null; lastRunId: string | null }
interface MemoryGap {
  id: string;
  sourceSessionId: string;
  fromCursor: string | number | null;
  toCursor: string | number | null;
  reason: string;
  recoverable: boolean;
  createdAt: EpochMs;
}
interface RuntimeState {
  schemaVersion: SchemaVersion;
  version: number;
  currentDecision: DecisionRecord | null; // 当前有效决定的完整快照，含注意、目标、等待及检索计划
  globalMuted: boolean;
  sleep: {
    state: "awake" | "sleeping";
    sleepDecisionId: string | null;
    wakeAt: EpochMs | null;
    wakeCondition: WakeCondition | null;
    wakeRunId: string | null; // 旧pending run兼容
    wakeJobId?: string | null; // 新所选作业，全部子run提交才完成
  };
  schedule: { nextCheckAt: EpochMs | null; decisionId: string | null; recheckOn: RecheckTrigger[] };
  activeRunId: string | null;
  ingestCursors: SourceCursor[];
  consolidationCursors: Record<string, ConsolidationCursor>;
  memoryGaps: MemoryGap[];
  updatedAt: EpochMs;
}
interface RequestSnapshot {
  schemaVersion: SchemaVersion;
  requestId: string;
  sessionId: string;
  personId: PersonId | null;
  personaVersion: number;
  relationVersion: number | null;
  environmentVersion: number;
  now: EpochMs;
  timezone: string;
  injectedIds: string[];
  injectedText: string;
  tokens: number;
}
interface ValidatedPatchEntry {
  documentKey: string;        // 受控逻辑名，不接受模型任意文件路径
  expectedVersion: number;
  operation: "upsert" | "remove";
  recordId: string;
  value: unknown;            // 必须通过本文件对应记录类型校验后才能提交
}
interface ConsolidationRun {
  schemaVersion: SchemaVersion;
  runId: string;
  inputEndEventId: EventId;
  inputVersions: Record<string, number>;
  validatedPatch: ValidatedPatchEntry[];
  sourceDependencies?: CommittedSourceDependencyReceipt; // 0.7.0已提交源依赖摘要，见第18节
  commitMarker: { committedAt: EpochMs; manifestHash: string } | null;
  status: "prepared" | "validated" | "committed" | "failed";
  consumedHotRefs: Array<{ hotRecordId: string; eventId: EventId }>;
  cursorBefore: Record<string, ConsolidationCursor>;
  cursorAfter: Record<string, ConsolidationCursor>;
}
interface OutboxRecord {
  schemaVersion: SchemaVersion;
  deliveryId: string;
  decisionId: string;
  proactiveId: string | null;
  target: DeliveryTarget;
  text: string;
  status: "pending" | "submitted" | "delivered" | "cancelled" | "unknown";
  submittedAt: EpochMs | null;
  deliveredAt: EpochMs | null;
  receiptId: string | null;
}
```

源适配器的游标是其不透明回放位置，不以时间戳去重；`receivedThroughCursor` 与已持久记录的位置分开，便于报告缺口和回补。`consolidationCursors` 的键为 `person:<personId>` 或 `global`，值指向本地有序接收事件。迟到消息和晚到的 assignment 都产生新的接收事件，因此在下一批可见，不能被旧时间戳过滤掉。

梳理以 `runId` 固定输入上界、版本和已消费热区记录。所有 patch 先校验，单写者/文件锁负责本地写入一致性；多文件替换过程中断时用小型 journal/manifest 补齐同一批，`commitMarker` 完整后才推进业务游标。提交与应用记录按 `runId` 幂等，不能重复增加统计。只有已提交且列在 `consumedHotRefs` 内的热区前缀可清除；处理中收到的新消息原样留待下一批。执行锁只表示正在写/整理，不自动等于人格睡着。

`RequestSnapshot` 在请求准备时冻结，绑定具体请求、会话、对象和版本。并发对象各用自己的快照，不能用一个全局 `lastText` 或“当前人”串用注入。诊断快照有界；快照里的文本也要服从明确撤销和总容量，不声称能永久解释任意历史回复。

`OutboxRecord.submitted` 只表示宿主队列接收，真正交付才是 `delivered`。宿主若不给回执，应记录 `unknown` 并对账，不承诺可证明的恰好一次，也不能重启后盲目重发。适配器支持幂等键时复用同一 `deliveryId`。急停设置 `globalMuted` 后取消尚未交付的主动 outbox，并在实际交付前再检查；已交付消息不可假装撤回。急停执行用户停止主动的意图，不引入日常频控。

`global/state.json`中的`RuntimeState.currentDecision`持久保存当前有效决定的完整快照，包括attention、带目标及pending的replyPlan、retrievePlan和睡眠/复查条件。`persona_decide`的可选字段作为更新输入：未提供字段保留仍有效的旧决定，显式null清除可空字段；提供一个新的子计划时替换该子计划，不能遗留其内部旧时点。合并后的完整快照与派生sleep/schedule在同一提交中保存并返回，供人格看到仍有哪些计划有效。它只保留当前决定，旧决定按有界诊断保留，不无限追加。

启动恢复先读取currentDecision，再恢复注意范围、回复目标、replyAt和事件监听，同时对账睡眠、下一判断、未提交run、pending消息、游标与outbox。睡中继续收取已选观察范围的消息并保持无assistant输出；恢复已到的wakeAt/nextCheckAt或replyAt时只安排一次对应判断，不回放成多次主动发言。`wakeCondition:"consolidation_complete"`绑定`sleep.wakeJobId`中的所选作业，全部子run实际提交才完成；旧prepared run继续对账wakeRunId，不因别的后台run结束误醒；`explicit_wake`恢复相应信号监听。不能把所有睡眠都重建为定时闹钟。

## 8. 配置、容量与预算

```ts
interface PersonaConfig {
  schemaVersion: SchemaVersion;
  consolidationMode: "sleep" | "on_write";
  timezone: string;
  longTermTargetChars: number;
  recentTargetChars: number;
  recentPreferredDays: number;
  tempTargetChars: number;
  diskReserveBytes: number;
  capacityLimits: {
    artifactTextChars: number;
    artifactRecordBytes: number;
    documentBytes: number;
    storeBytes: number;
  };
  processingLimits: {
    consolidationInputChars: number;
    consolidationRequestTokens: number;
    consolidationContextChars: number;
    consolidationOutputTokens: number;
    controlOutputTokens: number;
    replyOutputTokens: number;
    consolidationCallsPerSegment: number;
    maxQueuedConsolidations: number;
    maxTargetsPerJob: number;
  };
  reviewAssistant?: ReviewAssistantConfig; // 缺省关闭，契约见第18节
  contextBudget: {
    totalTokens: number;
    environmentTokens: number;
    anchorTokens: number;
    personaTokens: number;
    habitTokens: number;
    relationTokens: number;
    retrievalTokens: number;
    deepMemoryTokens?: number; // 0.7.0兼容扩展，缺省600，仍受totalTokens约束
  };
  artifactLimits: {
    axes: number;
    tendencyFacets: number;
    boundaryFacets: number;
    signatures: number;
    habits: number;
    impressionSignaturesPerPerson: number;
    indexItemsPerPerson: number;
    codesPerScope: number;
    interpretationsPerPerson: number;
    relationEventsPerPerson: number;
    deepMemories?: number;    // 0.7.0缺省128
    deepMemoryChars?: number; // 0.7.0缺省100000
  };
  retention: {
    snapshotMaxRequests: number;
    personaHistoryMaxVersions: number;
    journalMaxBytes: number;
    backupMaxBytes: number;
  };
}
```

| 配置 | 工程初值/部署要求 | 含义 |
|---|---|---|
| `consolidationMode` | `sleep` | 人格自主选择睡眠及对应增量整理；可以只休息，也可清醒时显式run；on_write合并写后机会，由人格选择run/defer |
| `timezone` | 部署时设置IANA名称，如`Asia/Shanghai` | 环境可提供本次真实时区，不能由目录名推测 |
| `longTermTargetChars` | 1,000,000 | **整个实例**持久记忆正文总目标，含C1/C2/C3/印象/编码等，不按人数倍增 |
| `recentTargetChars` | 100,000 | 当前对象的近期读取目标/物化视图候选容量，不是进prompt的字数 |
| `recentPreferredDays` | 3 | 近期优先，不保证3天内任何量都100%保留 |
| `tempTargetChars` | 200,000 | 整个实例热区缓存候选总量；原件可用引用与分页读取 |
| `diskReserveBytes` | 部署填写非负字节数并检查可用空间 | 物理资源保护，不能留一个假装普适的默认值 |
| `contextBudget` | 总2,970；既有分段120/200/700/150/300/1,500，深刻参考600 | 参考段是额外分段帽，不增加总预算；合计仍受2,970最终约束，不要求填满 |
| `artifactLimits` | 原类型5/12/20/24/8/8/80/12/30/80；深刻记忆128条／100000字符 | 按类型限制存储量；与单条、文档、实例帽同时成立，无必须达到的最小条数 |
| `retention` | 快照50次、人格历史5版；journal/backup字节上限部署填写 | 有界恢复与诊断，不永久保存所有材料 |

`sleep` 是默认的睡眠整理使用方式；人格仍需选择本次整理工作。`on_write` 合并呈现写入后的整理机会，复用正常对话让人格判断是否必要，不再每写一条自动发起付费整理。`consolidationPlan.run` 是一次性所选增量，`defer` 暂缓；清醒时也可整理。两模式沿用来源和提交游标，不重放旧经历。

持久文本按Unicode code point计字符；物理空间另计UTF-8字节、JSON结构、索引、journal、快照、备份及副本。持久记忆的重复正文副本也计入总目标，不把增加文件当作绕过上限。`retired` 与旧版本同样受限；需要保留的精华可由人格合并为概括，不无限追加归档。

人格决定记住什么、何时整理。接近目标先向它提供容量、积压和调用成本事实；达到真实安全容量边界时，程序可以暂停本插件新增冗余副本，保存有界源指针、`MemoryGap` 与回补游标并报告降级，保持正常聊天可用。它仍未决定睡觉时，不伪称它已经睡着，也不强迫它梳理；源日志不可读时如实报告无法回补的缺口，不承诺零损失。

token必须用实际模型对应的统一计数方法。S6宿主历史、工具定义、输出预留与本插件各段一起纳入请求预算；分段上限不能证明整个请求一定装得下。超预算先少取材料/分页；由人格判断是否需要检索及取什么，不用固定“输入短于30字禁止检索”替代。采集、队列、索引打分为本地过程；人格判断可复用正常轮次或必要独立调用，分别统计判断、梳理、重试和回复费用，不承诺每轮零额外调用或每天固定不超过6次。

## 9. 校验、迁移与本文件的验收边界

硬校验只覆盖：版本可识别、字段类型与枚举、数值有限、对象归属可解释、来源键稳定、patch目标受控、前置版本匹配、目标通道真实可达、run提交完整。schema校验不能因为“印象不够客观”“场景用了深夜”“只有一次经历”拒绝人格表达。达到容量时要求按当前模式整理、合并、暂存引用或明确降级；不悄悄改变人格选择。

旧文件迁移须显式转换：旧`source`拆为根事件`origin`和材料`epistemic`；旧kind名称映射到四类；`traits`/旧签名自由转成描述；旧`boundary.type`转成`kind:"boundary"`与`policy`；旧固定偏移转时区只有知道真实时区时才转换，否则留空；旧假定`sd`清为`null`且`n:0`。不能把旧0.6或5次门槛带回新校验器。迁移输出使用`persona-memory/3`，保留有限可回退的改前版本；已存在的明确撤销仍优先于回滚版本。

实现验收至少覆盖：对象归属与跨对象显式查询、未知事件后续assignment、源事件重放去重、主观解释从首次经历起可用、边界与承诺参与人格判断而不触发硬执行、共同人格跨关系成长、自然裁剪后重要概括仍可用、明确遗忘在重建后不复活、run中断恢复与新热区不误删、请求快照不串用、睡眠队列与醒来接收、两模式切换、outbox交付对账、容量降级及真实token/费用。人格条目数量、受欢迎程度、承诺是否按时履行、固定预测一致性均不是软件通过与否的硬门槛。

研究出处保留在`research-persona.md`、`research-relation.md`、`external-research.md`及对应证据说明中。CAPS/Whole Trait Theory支持关注情境与变异，不直接给出本JSON结构、签名条数或禁用场景词的产品规则；锚定研究只支持其测试范围，不证明锚必须永远不变。上述schema、资源初值和控制接口是本项目的工程设计，须用插件实测验证。

## 10. 首次实现的兼容扩展

实现版本0.1.0仍使用persona-memory/3。以下增加的是已约定能力的表达与恢复元数据，没有增加人格资格或行为干预：

- identityPlan 在同一控制工具表达自主认人。new可由程序生成稳定人物键，associate使用人格选择的键和来源，unknown明确保持未知。它不是认证制度；sessionId不自动变人物键。
- 当前八工具（memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task）可带可选cursor阅读同一次有界结果，返回nextCursor、明确fragment与来源。翻页不重复执行决定/遗忘；游标绑定原参数和结果快照，过期明确报告。memory_forget另支持action:"forget"|"correction"、replacementIds。实际JSON字段使用camelCase needsTarget/needsSelection。
- RequestSnapshot增加tokenAccounting、segments及可选budgetAdjustments。完整时间、时区和真实目标不能被裁掉一半；120段预算不足可在总预算内借用并记理由，总预算放不下时报资源错误。没有模型tokenizer端口时明确估计，provider实际usage另记。稳定协议、工具、宿主历史和输出预留也占完整请求，本实现未证明全DSH请求受精确tokenizer硬限制。
- RuntimeState增加有界execution：最后路由上下文、pendingControl、pendingWake、pendingEffects、effectReceipts及pendingOffsets。分别保存控制ID、醒来页、决定副作用进度、幂等收据和已实际阅读的Unicode偏移；不保存无限第二份聊天。queued不等于已经阅读/交付，只有匹配实际通知才确认。
- ConsolidationRun增加inputSlices及记录fragment；未读完原件不越过消费游标。明确遗忘会失效并清除仍冻结着被撤销来源的prepared run，不能重试旧批次复活内容。
- OutboxRecord增加pendingEventIds、deliverySource、projectionPending等实现字段：真实交付回执先持久，重启只补本地投影，不再次外发。恢复旧备份时未确定旧交付转unknown，避免盲重发。
- MemoryGap可含sourceEventId、resolvedAt及resolvedSourceCursor。DSH另持久host-checkpoints，保留最早未回补seq；按批回读真实原件，成功后标记缺口解决，源已失效则保留缺口与诊断。继承fork前缀不当新经历。

这些字段的生产/消费方法见[存储接口](../../repository-api.md)和[运行接口](../../runtime-api.md)。停机整库备份/导入/恢复仅支持当前v3，校验hash、路径和容量，恢复携带现库较新的明确撤销。未知schema原件不被覆盖；未提供猜测式旧格式自动转换。

## 11. 真实模型复核的兼容扩展（0.1.1）

数据版本保持 persona-memory/3，新增可选来源和执行回执字段。[真实模型全流程复核](../../real-model-validation.md)记录实际调用、修复与测试边界。

- IdentityPlan.sourceRefs 是待归属/重归属的原件及其来源会话范围，不是“凭这些材料才准认人”的证据引用。省略时使用当前参与者范围；显式空数组不追溯归属历史；显式其它会话只改人格所选范围。人格仍可保持未知或直接判断身份。工具返回 identityAssociation，列出 recognizedPersonId、selectedSourceSessionIds、currentSessionWasSelected 与实际 currentRoute；语义认出人和某通道路由已关联分别报告。不会按 sessionId 强行重归整段历史。
- HotRecord 的依赖来自当次实际交给模型的快照、工具结果和原件，跨人物检索也保留真实来源；嵌套 JSON 文本中的结构引用需要解码。明确遗忘同时清除相关临时副本、同轮过程和未提交候选，不把工具事件的键追加为永久撤销源。旧无注解过程副本在受影响范围保守清理并报告；不扫描话题词、不禁用相同文字的新根事件，不清除无关 C1 或人格。
- 整理记录保留原候选、实际结构错误与可用 usage；一次失败不消费输入或冒充提交。重试由显式操作发起，模型自行修正类型，不自动付费重试或改写主观内容。兼容已观察的 persona_memory_patch.arguments.patch 外壳只做解包，值仍走严格 schema。
- attention 的缺省维度不限制，显式空数组表示该维度不接收，同时给渠道与人物时取交集；null 清除选择。它由人格设置，不是工程层话题/频率过滤。排除新来信不撤销已接收轮次里人格选择的回复继续执行。
- ReplyPlan.target 的真实 channelId 与 sessionId 分开校验。异目标回复使用实际目标环境和身份、真实 outbox 交付回执及消息根；控制事件的发生处不冒充最终收件处。environment_change 由真实可观察变化触发，不用固定轮询改写人格选择的事件等待。

0.1.1轮真实 at_time 睡醒、主动、非空成长和 sleep/on_write 整理已有运行证据；当时其它唤醒枚举、跨月人格效果等边界见该轮复核报告，不把此前 fixture 充当当时真实模型结果。0.2.0补测与当前边界统一见第12节所链报告。

## 12. 自主整理与资源边界（0.2.0）

consolidationPlan.run 是一次性决定，有稳定job/child-run和原件范围；省略目标取认人effect完成后的当前人物加null，显式[]无工作且不付费、不消费。defer不启动新工作、不要求证明不整理的理由，也不伪称取消已实际开始的单页。所有适用模块在本次增量中可更新或不变；没有单独模块选择却推进统一游标的问题。省略字段保留计划描述，不重复执行已完成作业。整理不以睡眠为前提，普通sleep可以仅休息；选择consolidation_complete表示选择对应整理，不能与明确defer或无工作范围矛盾。

容量配置capacityLimits：artifactTextChars=16000、artifactRecordBytes=65536、documentBytes=1048576、storeBytes=67108864。均是可配置技术初值，不是人格资格或变化门槛。约束进化记录正文/序列化大小、业务JSON逻辑文档及实例持久文件；冻结run和运行元数据另受journalMaxBytes的有界信封保护，不误套业务条目帽。JSONL按适用记录类型与实例计，不把整个聊天日志误当一条人格记录。数组、附加字段、retired和有限历史不能绕过容量。超限不截断条目、不消费未提交原件。

处理配置processingLimits：consolidationInputChars=4000、consolidationRequestTokens=32768、consolidationContextChars=4000、consolidationOutputTokens=16384、controlOutputTokens=4096、replyOutputTokens=4096、consolidationCallsPerSegment=8、maxQueuedConsolidations=8、maxTargetsPerJob=8。新批候选上限依据真实分页耗时调为4000，不改旧prepared批次。一次作业执行段跨子run共享8次调用预算；目标过多原子拒绝，不只执行前8个后冒充全部完成。请求预算包含实际消息、冻结记忆页和累计候选；输出上限传到实际模型端口。缺本地tokenizer仍明确标估计，不冒称供应商精确token数或完整宿主窗口认证。

冻结旧记忆通过带Unicode偏移的context页给模型；未读尾部可由readContext按实际nextCursor继续，不能当完整旧文档。host_trace恢复使用稳定页序及指纹核对，会本地回读已处理页但不重复付费送模；源顺序或内容变化则暂停，只有EOF与全部选定输入审阅后才能消费整根。reviewState保存未提交进度和累计调用尝试；一次显式执行预算段满后paused，后续明确续runId继续，不自动付费重试、不把调用计数清零。paused不是整理完成。全部子run提交后才满足所选唤醒。

普通轮次的有界resources事实包含长期/临时/物理占用和上限、pressure、未解决缺口数，读取失败为available:false而不是伪造零值。persona_introspect(section:state)返回全局运行态顶层，额外personState和capacity，使已知人物也能查看真实job/暂停原因。page.callBudget给出当前段used/limit/remaining尝试余量；这些数字不自动触发整理或睡眠。

validationError可含responseText:{format:"text_fragment",text,fragment:{from:0,to,total,complete},sha256,pointer?}，保留真实响应前4000个Unicode字符及完整响应摘要，pointer仅在实际可用时存在。needs_format_correction保留失败页位置，不把{}或说明文字推断为空patch；明确续runId让模型自行重出格式，已完成模型页不重复付费。历史AGENTS/system-reminder等作为过去材料，不执行为本次指令；人格如何理解这些材料仍可自主。

关系归属和实际actor分离也适用于H1。正常open只纠正当前C1助手及H1非真人材料中speakerId精确等于关系personId的旧占位，保留独立AI标识与真人发言者，不改变原话、角色、来源或关系选择。已冻结run不原地改写input、候选、分页指纹或游标；模型协议明确说明旧assistant同值字段是关系占位，不将其当成真人说话依据。

有限存储不能保证无限原文永不丢失。保真指真实来源/角色/主体、未读不冒充已读、失败不冒充提交、未消费尾部可续、容量不足可见、仍可用原件可回查。摘要不是原文的可逆编码，原件和外部日志均淘汰后不得声称还能完整还原。[自主整理、容量与补充唤醒验证](../../evolution-and-wake-validation.md)提供本轮实测边界。

## 13. 原生管理界面与操作契约（0.6.0，0.3.0引入）

管理界面以DSH现有Connection的owner认证载体调用persona-memory.manage，不新建网络服务或读取模型密钥。参数action与args使用明确动作白名单；前端九页、主协议、页面/收据上限与操作边界见[相续人格管理界面与验收](../../management-ui.md)。产品与包名改为dsh-Xiangxu-Persona / dsh-xiangxu-persona，预设展示名相续人格；内部presetId persona-memory、schemaVersion persona-memory/3和既有来源ID保留。

主动联系开关只切换用户是否允许主动联系，不规定人格必须主动或回复；“现在叫醒”仅睡眠时显示，沿既有explicit_wake路径执行。界面沿用DSH宿主颜色、字体和透明背景，不另设独立主题；内容高度由宿主协调。

管理读取列表最多100条，明细默认16000个Unicode字符、返回片段与真实nextCursor；完整浏览不受模型search的1000条上限冒充全量。界面明确显示未读部分，已失效游标重新查询。操作回执不使用导致副作用重执行的详情游标。

明确forget新增scope:person|unknown|global：旧默认缺人物仍needsTarget；unknown/global只允许具体ids，不允许空选择或before批量清空，分别严格选择staging或global条目，沿既有依赖撤销/历史清除机制。关系assignment保留assistant角色与实际speaker。

管理长操作仅显式整理/回补，operations.start先持久记录收据，再执行；get/list只查询。保存最多50个终态、256KiB，并受实例总量与执行队列资源约束；未完成不静默删除，重启遗留queued/running标unknown不自动重放。一次明确操作和人格自主下次选择是不同来源。

实例登记采用persona-instances/1，与人格数据schema分开，最多16个登记实例、登记文件64KiB；只一个活动写者，忙碌时拒绝切换。停止实例释放相关工具/监听/计时器与写锁；失败不假装成功。启动以存量技术配置为准，不用bundle初值覆盖用户已保存设置。备份/校验暂时关闭当前写者后可恢复原实例；恢复/恢复中断完成后保持停用，防止悄悄释放旧计时任务。

## 14. 聊天渠道与本机声音技术契约（0.5.0，0.4.0引入）

这是DSH适配配置；核心schema仍为persona-memory/3，不改变人格决定与成长频率。当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task。相续人格预设在普通DSH、IM、主动与唤醒中仍restrict({allow:[]})再注册这八工具；persona_task提供自主派发及按需回收，实际子任务显式使用独立工作预设。主会话不直接恢复裸派发、Harness或编码工具；其它DSH预设不变。内部创建／恢复接收通道的ctx.agents.create/resume保留。独立任务与原件来源契约见第16节。

### 14.1 平台配置、环境与owner管理

owner管理action为channels.status/configure/start/stop/probe/rotateIngress/capabilities、connections.status/start/poll/cancel/disconnect、permissions.inspect/configure/list/reset，以及voice.inspect/registerCatalog/configure/preview。管理页“聊天渠道与语音”，官方QQBot／微信iLink扫码为主入口，已有兼容桥参数默认折叠为高级配置；mobile网页管理不在本版主入口挂载，实验说明单独留在[未来网页接口](../../mobile-chat-and-voice.md)。

ChannelProfile固定两项：{id/platform:'qq',protocol:'onebot11'}和{id/platform:'wechat',protocol:'onebot12'}。config={mode:'official'|'bridge',apiUrl:string,accountId:string,accessToken:string,allowedPrivateIds:string[],allowedGroupIds:string[],voiceMode:'text'|'both'|'voice',allowRemote:boolean}。初值disabled，接入列表空、voiceMode:text、allowRemote:false。空API令牌配置保留旧值；clearAccessToken:true明确清除，不能同时提交新值。status只返回hasAccessToken/hasIngressToken，不回显令牌。

API默认只接受本机/私网字面地址或localhost；远程API必须明确allowRemote且HTTPS，不允许URL凭据、query令牌或fragment。独立桥回调默认127.0.0.1:17654、默认无listener，路径/channels/{qq|wechat}/events，Bearer只存SHA；生成/旋转只返回一次明文，读body后排队时再次核当前hash。Host/Origin、JSON和64KiB正文帽分别验证，没有通用RPC转发或个人网页连接。

ChannelFacts={platform,accountId,conversation:{id,type:'private'|'group'},sender:{id,name?}}，另保留源消息ID、平台sourceAt、宿主receivedAt、textComplete与未读消息段事实。OneBot只把实际text段作为原话，不从CQ码、昵称、alt_message或媒体占位猜文字。专用binding按memoryRoot/代次/platform/account/room/actor稳定生成xiangxu-social-<hash>，关系personId仍由人格选择。

### 14.2 去重、外发与生命周期

独立登记schemaVersion=xiangxu-channels/1，与人格备份分离；最多1MiB，bindings最多128，scope列表各256项、串行队列32、最近未接入对象/群元数据8项，登记不保存聊天正文。API访问令牌只在本机受限文件，入站鉴权只保存哈希。

入站先保存prepared回执，再执行native create/send/flush；稳定源ID由platform/account/messageId生成，原文只留hash于外部回执。保存native模型路由仅provider/model/reasoningEffort/maxTokens，不保存密钥。native已接收但终态落盘失败返回unknown；冷恢复prepared转unknown，不自动付费重放。

出站按sessionId/sourceEventId去重，准备前不把native生成计实际已说；只有桥明确成功并给稳定消息ID才记delivered。平台known-delivered回执返sourceSeq/seq/textHash后，可单条定位真实assistant原文补本地投影；源不可用或不匹配时如实保持缺口，不用拟发送文字冒充。未知/失败保留草稿过程与用户pending，不因DSH输出存在就虚构平台收件。

回执总数2048，未确认最多256、终态保留目标1024；prepared/unknown不静默淘汰。终态淘汰后，入站保留同真实主体范围的源时间floor，未知ID且sourceAt<=floor明确非2xx拒收、不报消费、不送模；出站高水位阻止旧seq重发，已淘汰确认不伪造为可复核ack。这些是有限传输元数据窗口，不是人格社交频率。

停止/挂起先检查所属忙碌会话再释放载体与owned handles；普通重载保留配置、代次和回执。恢复指定memoryRoot时只失效对应根：旧binding退休、代次递增、相应接入停用，用户明确启用后建新通道；保留原回执阻止旧平台事件重放，不把已退休原生对话重新导回核心。明确遗忘仍沿核心撤销链执行。

### 14.3 声音偏好、引擎与实际交付

VoiceProfile持久路径voice/profile.json，schemaVersion=xiangxu-voice/1，version/updatedAt，mode=persona|user，allowRemoteVoices:boolean，userSelection/personaSelection={voiceId:string|null,rate:0.1..10,pitch:0..2}。初值persona、网络false、voiceId:null、rate/pitch=1，最多16KiB，仅当前coordinator store事务写，不保存自由叙事理由。

persona_voice参数action=inspect|select（省略inspect）、voiceId/rate/pitch可选、reason最多256字符且仅瞬时返回；可带cursor继续同次有界结果。用户mode下人格选择保存备用，effective仍用户选择。voiceId:null使用允许的本机默认声音；明确voiceId不存在时不可用，不静默切云。音色由人格选择，不按人格标签硬映射，也不强制每轮重新选择。

catalog={supported:boolean,voices:[{id,name,lang,localService,default}]}只在内存，最多8会话、每会话32音色、总32KiB、每字符串256字符；本机目录使用win-sapi标识并按需由工具读取，不默认整目录注入每个请求。providerCapabilities如{provider:'win-sapi',rate:true,pitch:false,mime:'audio/wav'}是实际能力事实，不是人格立场或选声规则。

Windows System.Speech是本版本机WAV合成器，不下载TTS模型、不使用Edge在线服务作为默认依赖、不训练或克隆新音色。rate映射为近似SAPI音级；pitch:false，非1值明确unsupported，不静默改成1后假称应用。单次合成最多2000个Unicode字符、单文件8MiB、缓存4文件/总16MiB、60秒进程时限；容量不足或超长不截断后冒充完整朗读。

官方QQ与微信当前chat.voice:false，本机PCM WAV尚无已验证的官方发送编码链；QQ OneBot11标准record需probe实际确认can_send_record，微信OneBot12当前voice:false。text只发文字；both可由真实文字ack记成功并标voiceUnavailable；voice要求实际合成和音频回执，缺能力/失败不自动改发文字。生成WAV、入发送队列、平台ack和用户听见分别报告；短试听只返回有界data:audio/wav给播放器，用户点播放，不投递平台或写人格经历。

当前真实账号与桥前置能力、用户操作和验收分层见[聊天渠道接入](../../channel-integration.md)。未发布手机网页的设备鉴权与SpeechSynthesis字段不在当前生产契约重复定义。

### 14.4 官方连接、能力权限与平台工具

connections.start({id:'qq'|'wechat'})返回真实绑定任务，poll({id,flowId,verifyCode?})查询同任务，cancel取消当前任务，disconnect停止并删除本机凭据但不声称平台远程授权已撤销。状态phase=idle|starting|waiting|scanned|verify|authorized|expired|failed，包含flowId、qrContent／owner生成qrDataUrl、expiresAt、accountId、pairedUserId、chatTypes、supportedCapabilities与error。QQ chatTypes=[private,group]，微信=[private]；本人手机确认后仍需channels.configure选择mode:official／accountId／接入列表并明确start。QQ是官方Bot，不接管桌面个人QQ。所有状态livePlatformVerified:false不作为本人真实扫码收件证明。

xiangxu-connections/1最多两个平台档案、1MiB；传输上限来自CONNECTION_LIMITS：responseBytes=1048576、mediaBytes=16777216、textChars=16000、contexts=128、cursorBytes=16384、queue=32、flowMs=600000。它们是字节／字符／队列技术帽，不是人格行为次数或等待时限；平台可更早让二维码过期。凭据与上下文token不返回人格工具或管理前端，不在文本备份中。

权限schema=xiangxu-permissions/1，按当前memoryRoot／platform／实际accountId保存allowed，最多128条／256KiB；管理inspect返回items:{id,label,supported,allowed,available,reason}，configure只由当前真实账号保存，list与reset用于明确清理旧账号许可。默认chat.text，旧voiceMode迁移可保留chat.voice意图；不支持／未就绪时仍不可用。reset移除该账号自定义许可并释放记录，恢复渠道默认chat.text以及voiceMode=both|voice时已开启的chat.voice意图，返回实际defaults；不删记忆、不自动重连，available仍核实际能力。新增未支持许可被拒绝；旧许可可保留／撤销但不变成available。

能力ID固定为chat.text、chat.image、chat.video、chat.file、chat.voice、chat.sticker、message.reply、message.retract、contacts.read、groups.read、friend.manage、group.manage、profile.update、feed.read、feed.publish、feed.react、call.voice、call.video。它们是能力目录，当前feed.*与call.*未实现；系统表情与自定义表情包、视频文件与实时视频通话分别核实，不能凭勾选宣布支持。

persona_platform action=inspect|execute|accounts，可选capability、真实target、assetId、text、messageId、stickerId与结果cursor。inspect读取当前目标支持／许可／可用；execute校验实际原生binding、当前实例／账号、接入范围、driver、用户授权与真实资产，再调用有限平台动作，不读取任意路径或泛化客户端控制。外发prepared／unknown不自动重放；微信ret=0但无远程messageId时以client_id标注API接受回执种类，不虚构平台消息ID或用户已读。具体实现事实见[渠道接入](../../channel-integration.md)。

## 15. 形象、媒体服务与资产技术契约（0.5.0）

这是DSH适配层的可选能力，不改变核心人格／整理控制枚举。identity/profile.json采用xiangxu-identity/1：version、description、primaryAssetId、locked、history、provenance、updatedAt；description最多2048个Unicode字符，档案65536字节、历史最多8。来源字段分别关联描述和主参考，历史含版本／描述／主参考／来源与at。用户locked时persona不能改档案或锁，用户owner可改；没有自动成长频率或外貌评价规则。

Provider分image／video，默认均enabled:false。image type=openai-images|comfyui，video仅comfyui；baseUrl、model、referenceMode=none|edit、editTransport=json|multipart、downloadOrigins、workflow与节点绑定构成技术配置。apiKey只写、hasApiKey只读，clearApiKey明确清除。Images编辑传输由用户明确选定，不失败后自动换格式重发；ComfyUI必须实际API workflow，prompt／reference输入及输出节点真实存在。probe只检查连通与配置，verifiedGeneration:false。owner inspect({includeConfiguration:true})才返回工作流；persona inspect不取完整配置或密钥。

Asset安全元数据={assetId,kind:image|video,mime,bytes,sha256,width,height,name,createdAt,origin,referenceVersion,jobId,pinned,isPrimaryReference,historicalReferenceCount,sourceContributionCount}，路径／来源详情不灌入人格工具。外部库与provider文件在文本根之外且相互分离。Job含jobId／requestId／kind／status／providerType／referenceAssetId／referenceVersion／resultAssetIds／时间／error，公开摘要不含prompt、key或工作流；status=prepared|running|submitted|completed|failed|unknown|cancelled|revoked。同requestId幂等，媒体任务收据不自动淘汰，终态同样保留；达到80条拒绝新任务，避免旧请求身份丢失后重复付费。删除作品不清任务收据、不恢复作业名额，当前未提供收据清理／扩容入口。冷恢复prepared／running为unknown，不自动付费重放。Comfy按原任务查询／只取消己方队列，不全局interrupt；已撤销来源不允许迟到结果复活。

persona_media action=inspect|identity|update_identity|assets|asset|generate|job|jobs|cancel_job；按需使用，不要求调用。assets使用pageCursor继续列表，cursor续读同一有界工具结果；generate参数kind、prompt、referenceAssetId、useIdentityReference、size由适配层校验，requestId由真实调用身份派生。默认沿用共同描述与主参考，缺参考能力明确失败，不静默变纯文生图。owner另有media.configureProvider／probeProvider／importReference／updateIdentity／listAssets／getAsset／generate／getJob／listJobs／cancelJob／deleteAsset／exportManifest。生成资产与平台交付是独立回执。

MEDIA_LIMITS当前值：imageBytes=8388608、videoBytes=67108864、assetBytes=268435456、assets=256、jobs=80、activeJobs=8、profileBytes=65536、descriptionChars=2048、history=8、previewBytes=524288、imageEdge=8192、imagePixels=33554432、previewPixels=4194304、outputAssets=4、metadataBytes=1048576、workflowBytes=131072、responseBytes=25165824、promptChars=8000、requestMs=120000、sourceRefs=32、sourceRecordIds=64、provenance=16。各帽独立执行，拒绝超量，不把二进制库总量变成模型上下文。容量不足不自动删除主参考或作品；owner可明确删非当前主参考，清理历史图片引用但保留描述与referenceRemoved。

owner传输API uploadBegin／uploadChunk／uploadFinish／uploadCancel、readAssetChunk只在认证管理路径；每块raw<=32768，上传图<=8MiB、2个在途／5分钟、完成回执16条／5分钟；下载<=64MiB、单资产缓存60秒。父桥核同资产、顺序、长度和完整SHA再Blob下载，iframe仍allow-scripts。通用请求65536、响应2097152字节帽不扩大；原管理明细131072字节帽不变，大工作流不能通过这个UI完整提交时明确拒绝。

明确遗忘同步核心永久meta撤销，撤销相关作业、派生资产与档案历史；每次服务消费／迟到提交核永久撤销，无法确认撤销状态时不假装可读。用户独立导入／明确确认的同一资产依据可单独保留。删除或遗忘清owner缓存；本地清理失败与远程副本／运行状态分别报告。exportManifest仅元数据／相对文件／SHA，不复制作品；文本备份不含外部资产与凭据，完整备份另存作品原文件。操作、容量解释与未测边界见[形象与创作](../../media-and-identity.md)。


## 16. 自主委派、任务档案与来源隔离（0.6.0）

persona_task.action=inspect|create|list|status|read|cancel|retain|archive_file。create参数prompt最多16000字符、title最多128字符，workspace是实际已有授权工作目录；requestId由宿主真实session与tool callId构造，不由模型填入。taskId=task-加32位小写十六进制，子会话稳定使用xiangxu-task-键；子预设固定xiangxu-task-worker，明确新上下文，不默认fork陪伴历史。是否委派及任务内容由人格自己选择。

状态含prepared／starting／running／completed／failed／cancelled／unknown／revoked。任务执行status与capture:{afterSeq,complete,errorCode?}表示不同事实；completed不能冒充档案已完整采集。默认persona_task.status返回紧凑card，含documentCount、resultDocumentId和至多120字的summary导航预览，不自动返回完整目录；显式documentOffset／documentLimit时附documents页、documentsComplete和nextDocumentOffset。owner tasks.get仍按其目录分页接口工作；完整报告通过resultDocumentId读取。persona_task.read按Unicode offset／maxChars最多8000字符分页，返回nextOffset和complete；后续文档页传offset=nextOffset，完整性与expectedSha256分别核对。通用工具nextCursor通过cursor续同一次有界结果，list.pageCursor只续任务列表；owner／内部archive.read的nextCursor属于其自身文档读取协议。二进制走owner有界readChunk下载，不塞进模型上下文。

独立档案保留完整委派prompt、实际宿主事件和最终报告；archive_file复制任务工作区内明确文件的当时字节、SHA与指纹，不自动保存整个工程目录或宿主未暴露的内部思考。默认maxTasks=4096、maxArchiveBytes=1073741824、maxTaskBytes=67108864、maxDocumentBytes=67108864，owner可显式configureLimits；分块65536 bytes，任务／总容量及索引元数据帽一起核验。容量不足拒绝新副作用或将未采集尾部明确标为不完整，旧原件和幂等凭据不静默淘汰；增大预算不保证实际磁盘空间。

可信宿主登记worker真实sessionId／parentSessionId／taskId和assistant_delegation来源，不能靠模型消息自报身份。worker即使收到kind:user的原生委派封套，也跳过人格C1／H1。parent任务工具调用和结果的prompt、报告正文、标题／文件名与自由错误文本均不自动进入H1；只留状态、动作、真实任务／资料ID、页范围、完整性等元数据。实时、回放、trace回读沿同一投影；callId来源无法解析时明确sourceResolution:unavailable，原始资料仍按实际保存范围回查。普通主人格回复、思考、其它工具与真实用户原话不被技术话题过滤。

retain从实际资料中选取有界文本片段，保留taskId／documentId／SHA／offset和真实AI资料sourceRef，沿既有captureHot／自主整理进入候选材料；它不是直接写人格、不是必须记住该片段，也不改变任一主观条目的成立门槛。worker没有共享人格写入工具。明确遗忘按原始sourceRefs／recordIds撤销相关任务与材料，旧资料不能在重启、回读或重建时复活；外部宿主日志和其它副本并未因此保证删除。

owner动作tasks.inspect/list/get/read/readChunk/configureLimits/collect/cancel/archiveFile，list/get/read/download不会新派发模型；新增“任务与资料”页（当前共九页）无默认手动create入口。原始派发权限、工作目录访问、网络与shell仍受DSH用户已有权限控制；工作预设的工具范围不是full-access模式下额外的OS沙箱。完整消费者、资源与验证范围见[任务与资料说明](../../delegation-and-task-archives.md)。


## 0.6.0 自主委派与任务资料隔离

主人格可自主选择经persona_task委派工程、研究或其它需要的任务，不设必须派发的题型、固定次数或记忆门槛。当前八工具为memory_search、memory_forget、persona_introspect、persona_decide、persona_voice、persona_media、persona_platform、persona_task；原始全局派发／Harness／编码工具仍不直接加入主预设，独立工作预设使用宿主已有工作能力和用户权限。

任务新建独立上下文并显式选择xiangxu-task-worker，可信宿主登记taskId、真实子会话、父会话和AI委派来源后才启动。宿主初始封套即使为source.kind:user，也不会作为真人C1或共享人格H1接收。主会话的任务工具调用及结果仅把安全导航元数据投影进H1；实时、回放和trace回读采用同一投影，不能把指针重新展开成工程原文。普通主人格回复、思考、其它工具和真实用户原话保留原意义。

完整委派prompt、宿主实际可取得的会话事件、工具结果与最终报告保存在独立.tasks档案；显式archive_file将所选工作区产物复制成带SHA的快照，不等于自动备份整个工程目录。默认总容量1GiB、单任务与单资料64MiB、任务收据4096条；owner可在“任务与资料”页高级设置调整资源上限。容量满保留旧资料／幂等凭据并明确报错，未归档尾部标capture.complete:false；删除／关闭任务不假称已经保存全部原件。

父会话通过status/read查询实际状态及按需读取；status默认只返回紧凑任务卡，显式documentOffset／documentLimit才附带资料目录页。retain选择真实资料的有界片段送入既有自主整理，不直接写人格、不要求任何模块变化。资料保留真实AI／工具／网页来源与原件定位，完整性、SHA与分页状态分别报告。明确遗忘通过源依赖撤销相关任务档案，旧原始宿主日志或外部副本不被冒称已删除；unknown任务不因重载自动重新执行。

完整动作、存储范围、权限与验收口径见[自主委派与任务档案](../../delegation-and-task-archives.md)。工作预设的能力限制继承DSH用户权限；full-access模式下没有额外OS沙箱。普通对话是否关注、回复、主动、睡眠以及是否整理的原有契约未变。

### 0.6.0 自动化验证与资源边界

> 本节保留0.6.0当时源码的实测结果，不能当作0.7.0新核心已经重测。

0.6.0当时最终完整回归495/495通过，失败／取消／跳过均为0，运行期间受检源文件无变化。实际安装的DSH 0.2.1-rc.2原生委派链35/35通过；仓库可复用入口node scripts/dsh-delegation-integration.mjs另行实际运行也为35/35。两轮均使用固定响应fixture模型，真实LLM调用为0；它们验证真实宿主工具、来源、资料、整理与生命周期链路，不证明真实研究质量或长期人格效果。公开回执见[完整回归](../../verification/0.6.0-tests.json)、[两阶段原生SDK](../../verification/0.6.0-sdk-fixture.json)及[静态自主性审查](../../verification/0.6.0-autonomy-audit.json)。原生GUI验收结论在[管理说明](../../management-ui.md)单独维护。

status默认只返回紧凑任务卡和至多120字的导航摘要，不自动展开完整资料目录；明确传documentOffset／documentLimit可分页取目录，正文按documentId和Unicode offset／maxChars读取，返回nextOffset，下页传offset=nextOffset；通用工具cursor只续同一次有界响应，list.pageCursor只续任务列表。UI单次文件下载上限64MiB，不随档案扩容自动提高。archive_file虽按64KiB读取源文件，归档时仍组合受单资料容量限制的整份文件缓冲，内存随该文件大小增长；DSH冷查询也可能内部载入目标子会话日志，不能将逐页采集宣称为宿主恒定RAM。明确遗忘清理插件任务正文并保留永久撤销凭据，清理失败如实报告；它不会删除DSH原始会话历史或用户另存的工程副本。


## 17. 深刻记忆参考与自主演化（0.7.0）

深刻记忆统一保存各种情绪的经历，逻辑文档键global:deep映射global/deep.json。它属于同一人格的共同记忆，不按情绪或关系另起多个人格；scope固定global、personId固定null，aboutPersonIds描述涉及的人物。记忆是否触发、触发情境、反应以及重释、淡化、合并、替换、修剪均由人格判断。

~~~ts
interface DeepMemoryItem extends MemoryMeta {
  scope: "global";
  personId: null;
  title: string;             // 最多256个Unicode字符，可以为空
  reference: string;         // 最多512字符；人格留下的参考，不是触发器
  experience: string;        // 记得的经历，不伪造原件或实际角色
  feltThen: string;          // 当时感受
  meaningNow: string;        // 当前理解，可继续改变
  cues: string[];            // 联想描述，最多32项、每项256字符，不做程序匹配
  aboutPersonIds: PersonId[];// 最多128项
  relatedMemoryIds: string[];// 最多128项，条目联系不是新来源根
  supersedesIds: string[];   // 最多128项，表达自主替代关系
}
interface DeepMemoryReferenceCard {
  id: string;
  title: string;
  reference: string;
  cues: string[];
  aboutPersonIds: PersonId[];
  updatedAt: EpochMs;
  partial?: true;            // 仅首张超限卡的显式缩略
  titleTotalChars?: number;
  referenceTotalChars?: number;
  omittedFields?: ("cues" | "aboutPersonIds")[];
}
~~~

写入使用现有ValidatedPatchEntry，documentKey为global:deep、recordId为稳定条目ID，upsert/remove均由人格所选整理提出。空模块和空patch有效，没有必须形成或治愈的条目。修改沿用版本、冻结run与有限journal；不保证每次历史变化永久保留。srcRefs追同一原件，feltThen和meaningNow分开表达，并不强制人格原谅、遗忘或采取固定情绪反应。

artifactLimits.deepMemories默认128、deepMemoryChars默认100000；全部字符串值计入文本量，单条16,000字符／65,536序列化字节、业务JSON1MiB和实例物理64MiB等帽继续同时成立。深刻记忆纳入原长期文本目标，不能通过另增文件绕过容量。满容量时明确拒绝超限变更并保留旧内容，不按情绪、重要度分数或时间自动裁剪。

普通snapshot可含deep_memory_reference参考段。contextBudget.deepMemoryTokens默认600，总预算仍为2970；空模块不添加该段，非空时在实际剩余预算内优先保留完整参考卡；首张完整卡超限时可显式缩略为partial:true，附titleTotalChars、referenceTotalChars与omittedFields，不冒称全文。参考段给出referenceOnly:true、automaticRecall:false、total、shown、truncated、nextOffset和实际items。nextOffset只标记参考目录尚未显示的位置，不是人格回忆条件或通用工具cursor。snapshot.deepMemoryReference另保留实际显示ID与完整性元数据；参考进入本轮不代表已触发回忆。没有关键词命中、强制重播、固定频率、情绪比例或自动衰减。

persona_introspect section新增deep，返回模块schemaVersion/version/items及referenceOnly、automaticRecall。管理memory.list recordType新增deep，detail保留experience/feltThen/meaningNow与实际来源；列表／详情阅读走原有有界游标。memory_search可提供相关深刻条目，但检索不替人格决定联想和反应。

## 18. 整理资料供给、来源与可选助手（0.7.0）

~~~ts
interface CommittedSourceDependencyReceipt {
  format: "sha256-identities/1";
  sourceHashes: string[];     // 最多8192个SHA-256来源身份摘要
  recordHashes: string[];     // 最多16384个SHA-256记录身份摘要
  complete: boolean;         // 完整性事实，不是人格记忆资格
}
interface ReviewAssistantConfig {
  enabled: boolean;          // 默认false
  maxOutputTokens: number;   // 默认1024，1..8192
  maxReportChars: number;    // 默认4000，1..16000 Unicode字符
}
interface ReviewAssistantObservation {
  category: string;
  detail: string;
  recordIds: string[];
}
~~~

PersonaConfig新增reviewAssistant及第17节的深刻容量／参考预算。旧persona-memory/3库缺少新增字段时由默认配置合并；不重写原件、不要求格式迁移到另一个schema。辅助配置是技术资源和工具选择，不是人格成立资格或成长频率。

prepareConsolidation／refreshConsolidationContext的冻结context新增memoryIndexes:{global,person}、deepMemories与deepMemoryVersion；普通索引携带其真实文档版本。context页可展示persona、identity、impression、interpretations、codes、memoryIndexes和deepMemories，继续采用实际Unicode游标。未读尾部不视为空，人格只需读其选择需要的材料，不要求每轮全库加载。助手读取不推进人格contextReadRanges或源消费游标。

applyConsolidation中的srcRefs须指向已接收的真实源根，存在的角色、sourceKind和origin与实际记录核对，撤销不能复活；来源字段不能把AI材料变成人类发言。同一根来源的多次检索、摘要、转存不增加独立事件。空srcRefs仍可表达未引用来源的主观解释，不设支持数量或客观印象审批。

可选model.complete purpose为memory_assistant，使用当前DSH模型路由，只接收本次有界input、traceMaterial和memoryContext；输出observations数组。接纳报告仅包含有界观察，最多16条，category最多80字符，detail先受16000字符帽，实际总量再按maxReportChars和进度记录容量缩小；recordIds只保留实际提供的记录ID，未知引用标unverifiedReferences。模型返回的patch、工具动作或权威声明不获得写入权。报告附advisoryOnly、scope、complete及实际展示量，可能错误且人格可以不采纳。

reviewState.assistantReceipt用材料指纹key登记in_flight、completed、unknown或unavailable等实际结果，并可在运行回执中查看。助手与人格共用consolidationCallsPerSegment；只有至少剩两次调用机会才尝试助手，保留人格最后一次机会。材料相同的已得报告复用，未知不自动付费重放；失败降低可选建议的可用性，不形成价值否决，不把建议写成validatedPatch。即使启用助手，最终记什么、怎样理解和是否改变仍由人格决定。

提交后保留的sourceDependencies采用sha256-identities/1来源／记录摘要收据，追踪实际读入材料而不另存原话。明确遗忘会清除受影响已提交journal的patch、助手报告与可回读诊断正文，保留提交标记、调用数等技术回执；旧档缺完整依赖时在撤销后保守去诊断正文，不删除无关人格记录。自然原件淘汰保留人格解释和仍受容量约束的诊断。人格所选retain片段本身也是来源；明确遗忘命中task-material时按真实任务会话、文档ID、SHA与Unicode范围撤销该任务资料，不能换页重新保留；自然淘汰和无关新任务不受影响。

显式遗忘去正文后的journal只承诺提交／状态／调用等最小技术回执，不将已移除的正文视图字段冒充完整ConsolidationRun。助手调度前为建议或明确遗漏状态及真实共享调用数预留完整请求空间；主整理与助手使用同一实际源片段。空间不足时跳过未付费助手并说明原因，不通过丢源正文或隐去调用事实腾位置。

## 19. 社交身份目录与实际平台能力（0.7.0）

~~~ts
interface SocialIdentityProfile {
  identityId: string;        // social-<32hex>，由实际人格目录／平台／账号计算
  platform: string;          // 小写安全平台标识，最多48字符
  accountId: string;         // 稳定账号标识，最多256字符，不是密码
  displayName: string;       // 最多120字符
  accountType: string;       // 最多48字符；界面提供bot/personal/creator/other
  profileUrl: string | null;
  avatarUrl: string | null;
  notes: string;             // 最多1000字符
  bindingSource: "manual" | "current_connection";
  createdAt: EpochMs;
  updatedAt: EpochMs;
}
~~~

账号档案使用xiangxu-social-identities/1，默认每实例32条、全登记256条、256KiB；能力目录最多64项，列表页默认最多32条。它与人格文本schema分离，仅保存身份元数据，不新增Token、AppSecret或Cookie副本。注册／认证在平台完成；手工登记不产生登录态，不新增平台权限。URL只允许无凭据、query或fragment的HTTP(S)地址；昵称和备注可清空，URL空值归为null，省略字段保留已有值。

owner白名单为social.inspect/list/upsert/remove/linkCurrent/refresh，均以实际当前人格实例定位。upsert只接受profile输入字段；不接受自报verified、capabilities、memoryRoot或密钥。linkCurrent仅QQ／微信，要求真实连接和渠道账号ID一致且在线后登记；兼容桥也按真实账号核对。remove只解除身份登记，不退出平台、不改许可、不删记忆。list返回items、total、offset、limit、nextOffset、complete、limits和platforms；inspect可按identityId读取单item。

每项connection分别报告adapterAvailable、currentAccount、connected、status、verification和credentialReference；只有实际连接、账号相符才为verified。capabilities逐项报告supported、allowed、available、status和reason；allowed:null表示授权未核实，不能冒充许可。status可能是unsupported、unavailable、unverified、needs_grant或available。人工修改档案不覆盖真实能力。当前同平台只一个活动连接；B站／抖音等无适配器时仅登记，注入socialAdapters的只读能力接口不等于已经实现该平台动作执行器。

persona_platform新增action:accounts读取当前人格身份目录；其余inspect／execute与实际target、授权和回执链继续沿原契约。工具总数仍为八个，不因登记账号获得任意客户端控制权。

QQ官方driver报告proactive:false、passiveReplyRequired:true及私聊60分钟／群聊5分钟被动回复窗口。自2025-04-21官方主动推送取消，缺有效被动上下文返回QQ_PUSH_UNAVAILABLE，不伪造发送或重放未知结果。此策略是平台执行条件，不能反向改写人格“是否想主动联系”的选择；OneBot桥按实际驱动能力处理，不套官方推送策略。平台身份和能力授权分开，不能从扫码登录推导全部朋友圈、投稿或通话权限。

新增完整消费者、参考机制、容量、平台依据与验证口径见[深刻记忆、整理资料助手与社交身份](../../memory-reflection-and-social-identities.md)。


## 0.8.0 管理入口与任务式子页

顶层五个入口始终保留；打开任务式子页后，“返回”回到实际来处，当前主入口保持选中。相处提供日常状态、主动联系开关、了解人格和独立任务；记忆把可读原文、深刻经历、人物与成长记录分开；连接把QQ、微信、声音、社交身份分开，单平台再分扫码步骤、能力权限和兼容桥；创作分形象、图片服务、视频服务、生成与作品任务；设置再分实例列表、启动时加载、使用其他记忆库、交流时间、资料助手、分类容量和维护；同实例切换容量类别保留草稿，一次保存已改字段，不同实例草稿隔离。成长记录分整理进度／人格变化／手动操作，任务先显示摘要、技术元信息按需要打开。命名按钮替代原生details三角，不把所有表单同时摊开。

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。本版[完整本地回归](../../verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](../../verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](../../verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。
