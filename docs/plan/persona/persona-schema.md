# 人格与记忆字段契约：persona-memory/3

当前0.13.2兼容增量以第26节为权威：统一persona-timeline/1注释、短期／长期／归档转层与必要人格上下文。第20–25节自我档案、生命周期、检索、受管连接和账号工具按兼容范围继续有效；历史证据不提升为本轮验收。

> 0.13.2当前维护：修复QQ原生人格上下文组装失配，分清过程资料依赖问题与交流原文保存问题，见[QQ故障修复](../../qq-reply-recovery.md)。必要人格校验继续保留，原始资料与既有缺口记录不清除；本轮隔离回归、真实宿主及QQ收发的证据范围以修复说明登记为准。0.13.0统一时间线与必需上下文仍以[persona-schema第26节](persona-schema.md#0130-memory-timeline-contract)为字段权威。记什么、怎样成长和是否回复仍由人格判断；0.13.1及更早验收保留历史范围，其他社交平台未测状态不变。

本文件是本批方案的**唯一字段权威**。架构、关系说明、主计划引用这里的字段和枚举；不得各自保留另一套 `kind`、版本、对象键或控制接口。下列 TypeScript 结构由 `dsh-xiangxu-persona` 0.13.2 的 JSON 校验器与持久化适配器消费。实际宿主接口及通过范围见实现目录 `docs/host-api-evidence.md`、`docs/host-test-results.md`；首次实现和真实模型复核的兼容扩展见本文第10至12节。

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
- 短期→长期→归档转层保留同一原件，`SrcRef.available`不因转层变为false。实际来源在明确遗忘、人工清理或外部宿主不可用后才如实报告可用性；可用性变化与语义撤回分别表达，不伪造仍可展开的原文。

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

原始聊天采用第26节统一时间线注释，原文text与实际来源是权威。同一条记录在短期、长期或归档只保留一份活动原件，WAL转层完整复制后在同一提交中移出原层；不因普通梳理提交或活动层容量达到上限就删除原文。近期模型参考优先使用有界片段与原件引用，不为每轮参考再维护一份独立日记。明确遗忘仍单独撤销，归档不是硬件备份保证。

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

编码必须同时有 `meaning` 和来源，`expandIds` 是可选细节的加速入口。原件转入长期或归档后，已有展开指针仍可定位同一记录；不能因离开近期层就剪掉来源或关系解释。人格可自主修订编码和理解，明确遗忘按实际依赖撤销。

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
  mode?: "auto" | "lexical" | "hybrid";
  timeMode?: "all" | "current" | "past" | "asOf";
  asOf?: EpochMs;
  seedIds?: string[];
  associationDepth?: number;
  diversity?: "none" | "source";
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
| `memory_search` | `{query,targetPersonId?,scope?,limit?,mode?,timeMode?,asOf?,seedIds?,associationDepth?,diversity?,cursor?}` | 缺省取当前已识别对象；显式可指其他已知对象或所有关系 |
| `memory_forget` | `{ids?, targetPersonId?, before?, reason}` | 清楚定位对象与内容后生成撤销记录；时间为epoch ms；歧义不批量操作 |
| `persona_introspect` | `{targetPersonId?,section?,action?,selfPatch?,expectedVersion?,cursor?}` | section为`self/anchor/axes/facets/signatures/habits/relation/deep/state/all`；可明确查看对他人的印象。0.9.0的self读取与update_self当前自我资料更新见第20节 |
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
  conversationStyle?: "short_chat" | "balanced" | "detailed"; // 0.9.0缺省short_chat，仅表达偏好
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
  retrieval?: RetrievalConfig; // 0.10.0兼容扩展，字段见第22节；默认／范围由retrieval-config.js定义
  contextBudget: {
    totalTokens: number;
    environmentTokens: number;
    anchorTokens: number;
    personaTokens: number;
    habitTokens: number;
    relationTokens: number;
    retrievalTokens: number;
    deepMemoryTokens?: number; // 0.7.0兼容扩展，缺省600，仍受totalTokens约束
    selfProfileTokens?: number; // 0.9.0兼容扩展，缺省350，仍在totalTokens内
    recentMemoryTokens?: number; // 0.13.0兼容扩展，缺省600，仍在totalTokens内
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
| `conversationStyle` | `short_chat` | 表达偏好；另可选balanced/detailed，无硬字数、条数或频率 |
| `timezone` | 部署时设置IANA名称，如`Asia/Shanghai` | 环境可提供本次真实时区，不能由目录名推测 |
| `longTermTargetChars` | 1,000,000 | 整个实例活动长期时间线原文与注释字符，超额最旧记录完整转归档，不按人数倍增 |
| `recentTargetChars` | 100,000 | 整个实例短期时间线容量，超额转长期；模型仅取得当前对象的有界参考 |
| `recentPreferredDays` | 3 | 近期存放跨度，和近期字符上限共同决定转入长期；转层不丢内容 |
| `tempTargetChars` | 200,000 | 整个实例热区缓存候选总量；原件可用引用与分页读取 |
| `diskReserveBytes` | 部署填写非负字节数并检查可用空间 | 物理资源保护，不能留一个假装普适的默认值 |
| `contextBudget` | 总2,970；既有分段120/200/700/150/300/1,500，深刻参考600、自我资料350、近期参考600 | 参考段是局部分段帽，不增加总预算；合计仍受2,970最终约束，不要求填满 |
| `artifactLimits` | 原类型5/12/20/24/8/8/80/12/30/80；深刻记忆128条／100000字符 | 按类型限制存储量；与单条、文档、实例帽同时成立，无必须达到的最小条数 |
| `retention` | 快照50次、人格历史5版；journal/backup字节上限部署填写 | 有界恢复与诊断，不永久保存所有材料 |

`sleep` 是默认的睡眠整理使用方式；人格仍需选择本次整理工作。`on_write` 合并呈现写入后的整理机会，复用正常对话让人格判断是否必要，不再每写一条自动发起付费整理。`consolidationPlan.run` 是一次性所选增量，`defer` 暂缓；清醒时也可整理。两模式沿用来源和提交游标，不重放旧经历。

时间线字符按Unicode code point计数；longTermTargetChars只约束活动长期层的原文与统一注释文本，默认1000000。超过时将最旧记录完整转入归档，不自动删除。人格、关系、索引、深刻记忆与有限旧版本仍受各自文档／条目／实例物理帽约束，不占该100万活动时间线配额。全部层、JSON结构、来源索引、journal、快照、备份及副本的UTF-8字节仍计入真实物理空间，归档不能绕过storeBytes与磁盘安全余量。

人格决定如何理解、补充注释、形成何种记忆及何时整理；短期／长期／归档的时间与容量转层是程序本地执行，不依赖一次模型整理成功。达到实例物理上限或真实磁盘安全边界时保留旧资料，拒绝无法安全提交的新副本，保存可用的有界源指针、MemoryGap与回补位置并明确报告；不自动删归档、不强迫梳理或睡觉。源不可用时如实报告缺口，不能把未保存说成已完整保存。

token必须用实际模型对应的统一计数方法。S6宿主历史、工具定义、输出预留与本插件各段一起纳入请求预算；分段上限不能证明整个请求一定装得下。超预算先少取材料/分页；由人格判断是否需要检索及取什么，不用固定“输入短于30字禁止检索”替代。采集、队列、索引打分为本地过程；人格判断可复用正常轮次或必要独立调用，分别统计判断、梳理、重试和回复费用，不承诺每轮零额外调用或每天固定不超过6次。

## 9. 校验、迁移与本文件的验收边界

硬校验只覆盖：版本可识别、字段类型与枚举、数值有限、对象归属可解释、来源键稳定、patch目标受控、前置版本匹配、目标通道真实可达、run提交完整。schema校验不能因为“印象不够客观”“场景用了深夜”“只有一次经历”拒绝人格表达。达到容量时要求按当前模式整理、合并、暂存引用或明确降级；不悄悄改变人格选择。

旧文件迁移须显式转换：旧`source`拆为根事件`origin`和材料`epistemic`；旧kind名称映射到四类；`traits`/旧签名自由转成描述；旧`boundary.type`转成`kind:"boundary"`与`policy`；旧固定偏移转时区只有知道真实时区时才转换，否则留空；旧假定`sd`清为`null`且`n:0`。不能把旧0.6或5次门槛带回新校验器。迁移输出使用`persona-memory/3`，保留有限可回退的改前版本；已存在的明确撤销仍优先于回滚版本。

实现验收至少覆盖：对象归属与跨对象显式查询、未知事件后续assignment、源事件重放去重、主观解释从首次经历起可用、边界与承诺参与人格判断而不触发硬执行、共同人格跨关系成长、短期／长期／归档转层后原件与重要概括仍可用、明确遗忘在重建后不复活、run中断恢复与新热区不误删、请求快照不串用、睡眠队列与醒来接收、两模式切换、outbox交付对账、容量降级及真实token/费用。人格条目数量、受欢迎程度、承诺是否按时履行、固定预测一致性均不是软件通过与否的硬门槛。

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

> 本节保留0.2.0当时的资源与实测范围；0.13.0时间线活动容量、归档保真和必要上下文按第26节执行，不将本节旧的自然淘汰口径继续作为当前存储策略。

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

owner管理action为channels.status/configure/start/stop/probe/rotateIngress/capabilities、connections.status/start/poll/cancel/disconnect、permissions.inspect/configure/list/reset，以及voice.inspect/registerCatalog/configure/preview。当前管理页“连接 → QQ”以个人QQ受管准备与扫码为默认向导，官方QQBot与已有兼容桥为次级方式；微信iLink保持自己的私聊扫码；mobile网页管理不在本版主入口挂载，实验说明单独留在[未来网页接口](../../mobile-chat-and-voice.md)。

ChannelProfile固定两项：{id/platform:'qq',protocol:'onebot11'}和{id/platform:'wechat',protocol:'onebot12'}。config={mode:'official'|'bridge',apiUrl:string,accountId:string,accessToken:string,allowedPrivateIds:string[],allowedGroupIds:string[],voiceMode:'text'|'both'|'voice',allowRemote:boolean}。初值disabled，接入列表空、voiceMode:text、allowRemote:false。空API令牌配置保留旧值；clearAccessToken:true明确清除，不能同时提交新值。status只返回hasAccessToken/hasIngressToken，不回显令牌。

API默认只接受本机/私网字面地址或localhost；远程API必须明确allowRemote且HTTPS，不允许URL凭据、query令牌或fragment。独立桥回调默认127.0.0.1:17654、默认无listener，路径/channels/{qq|wechat}/events，Bearer模式只存SHA；0.11.0另有明确onebot-hmac模式保留本机专用HMAC secret，以便对原始字节验签，普通status不回显。生成/旋转只返回一次明文，排队时再次核当前hash／模式。Host/Origin、JSON和64KiB正文帽分别验证，没有通用RPC转发或个人网页连接。

ChannelFacts={platform,accountId,conversation:{id,type:'private'|'group'},sender:{id,name?}}，另保留源消息ID、平台sourceAt、宿主receivedAt、textComplete与未读消息段事实。OneBot只把实际text段作为原话，不从CQ码、昵称、alt_message或媒体占位猜文字。专用binding按memoryRoot/代次/platform/account/room/actor稳定生成xiangxu-social-<hash>，关系personId仍由人格选择。

### 14.2 去重、外发与生命周期

独立登记schemaVersion=xiangxu-channels/1，与人格备份分离；最多1MiB，bindings最多128，scope列表各256项、串行队列32、最近未接入对象/群元数据8项，登记不保存聊天正文。API访问令牌只在本机受限文件；Bearer入站仅保存哈希，明确选择的NapCat HMAC模式额外保留专用secret，状态不回显。

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

能力目录保留chat.text、chat.image、chat.video、chat.file、chat.voice、chat.sticker、message.reply、message.retract、contacts.read、groups.read、friend.manage、group.manage、profile.update、feed.read、feed.publish、feed.react、call.voice、call.video；0.10.0兼容增加chat.mention、message.read、message.forward.read与media.cover。它们是能力目录，当前call.*仍未实现；0.10.0的feed.*、media.cover、chat.mention、message.read、message.forward.read按第22节的实际适配／服务核对；系统表情与自定义表情包、视频文件与实时视频通话分别核实，不能凭勾选宣布支持。

本节普通聊天分支persona_platform action=inspect|execute|accounts，可选capability、真实target、assetId、text、messageId、stickerId与结果cursor；0.11.0独立QQ账号scope:account分支另见第24节，不套用聊天target要求。inspect读取当前目标支持／许可／可用；execute校验实际原生binding、当前实例／账号、接入范围、driver、用户授权与真实资产，再调用有限平台动作，不读取任意路径或泛化客户端控制。外发prepared／unknown不自动重放；微信ret=0但无远程messageId时以client_id标注API接受回执种类，不虚构平台消息ID或用户已读。具体实现事实见[渠道接入](../../channel-integration.md)。

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

artifactLimits.deepMemories默认128、deepMemoryChars默认100000；全部字符串值计入文本量，单条16,000字符／65,536序列化字节、业务JSON1MiB和实例物理64MiB等帽继续同时成立。0.13.0起深刻记忆受本模块字符／条目和实例物理帽约束，不占活动长期时间线的longTermTargetChars；不能通过另增文件绕过物理容量。满容量时明确拒绝超限变更并保留旧内容，不按情绪、重要度分数或时间自动裁剪。

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

提交后保留的sourceDependencies采用sha256-identities/1来源／记录摘要收据，追踪实际读入材料而不另存原话。明确遗忘会清除受影响已提交journal的patch、助手报告与可回读诊断正文，保留提交标记、调用数等技术回执；旧档缺完整依赖时在撤销后保守去诊断正文，不删除无关人格记录。时间线转入长期或归档保留原件、人格解释和仍受容量约束的诊断；转层本身不撤销来源。人格所选retain片段本身也是来源；明确遗忘命中task-material时按真实任务会话、文档ID、SHA与Unicode范围撤销该任务资料，不能换页重新保留；时间线转层和无关新任务不受影响。

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

0.8.0只重整管理界面的导航、内容层次与交互流程，core/、adapters/和运行时schema相对0.7.0未改，八个人格工具与persona-memory/3保持兼容。该历史版本[完整本地回归](../../verification/0.8.0-tests.json)605/605通过，失败／取消／跳过均为0；UI与宿主专项55/55（50项UI＋5项host）属于同批验证，不另算独立需求。[真实DSH界面](../../verification/0.8.0-native-ui.json)完成5个主入口与16项任务式旅程、浅深主题及保存回读，使用隔离样本、无真实模型或平台调用。[后端兼容回执](../../verification/0.8.0-backend-compatibility.json)逐SHA核对50份后台及配套文件，继承0.7.0 SDK证据，未声称重新执行本版SDK。0.7.0的583/58/35与当时九页GUI保留历史含义；远程CI和发布状态另以实际结果为准。

## 20. 自我档案、初始化与交流定位（0.9.0）

本节是兼容扩展的唯一字段权威。可选self/profile.json使用xiangxu-self/1，实例其余文件继续persona-memory/3；旧实例没有该文件时只返回空视图，不写假建立时间，不清空既有anchor。self/persona.json的anchor是经历形成的共同身份基调；profile.current是当前采用的身份资料，profile.initial只是用户提供的起点，两类内容分别供料，不自动复制或覆盖。形象与音色仍有原档案权威。

~~~ts
type SelfProfileMode = "together" | "autonomous" | "unset";
type SelfProfileActor = "user" | "persona";
type SelfProfileField = "name" | "pronouns" | "gender" | "ageDescription" |
  "birthday" | "background" | "selfDescription";
type SelfProfileValues = Record<SelfProfileField, string>;
interface SelfProfileSource {
  actor: SelfProfileActor;
  at: EpochMs;
  sourceRefs: Array<Pick<SrcRef, "sourceSessionId" | "sourceEventId"> & Partial<SrcRef>>;
  sourceRecordIds: string[];
}
type SelfProfileProvenance = {
  initial: Partial<Record<SelfProfileField, SelfProfileSource>>;
  current: Partial<Record<SelfProfileField, SelfProfileSource>>;
};
interface SelfProfileHistory {
  version: number;
  at: EpochMs;
  actor: SelfProfileActor;
  mode: SelfProfileMode;
  onboardingAcknowledged: boolean;
  initial: SelfProfileValues;
  current: SelfProfileValues;
  provenance: SelfProfileProvenance;
}
interface SelfProfile {
  schemaVersion: "xiangxu-self/1";
  version: number;
  createdAt: EpochMs | null;
  updatedAt: EpochMs | null;
  mode: SelfProfileMode;
  onboardingAcknowledged: boolean;
  initial: SelfProfileValues;
  current: SelfProfileValues;
  provenance: SelfProfileProvenance;
  history: SelfProfileHistory[];
}
interface SelfProfilePatch {
  mode?: SelfProfileMode;
  onboardingAcknowledged?: boolean;
  initial?: Partial<SelfProfileValues>;
  current?: Partial<SelfProfileValues>;
}
~~~

七项资料均为自由字符串，可以空白；不把生日解析为真实出生，不根据年龄、性别或称呼推导人格。createdAt只记录此档案首次实质保存，不等于实例出生、设定生日或相处开始。initial/current各合计最多2400个Unicode code points，整个档案最多65536字节，history最多8版；只轮转有限旧版，不截断当前字段凑容量。每次写入来源最多16个sourceRefs、32个sourceRecordIds，保留每字段实际actor和来源。重复无变化不写入，expectedVersion冲突报错；检查通过后沿现有事务、实例容量和单写者落盘。

repository.getSelfProfile()读取，updateSelfProfile(patch,{actor,expectedVersion?,sourceRefs?,sourceRecordIds?})写入。persona主体只能改current；用户管理可明确改初始化元数据与资料，并保留actor，界面当前仅编辑initial/mode，不自动接受为人格当前认同。来源存在性、撤销、结构与容量校验不判定自我认同应当怎样。明确遗忘覆盖initial/current/history对应依赖，旧备份恢复不能复活已撤销资料；此文件随实例文本备份，不包含外部作品或音色资产。

不新增第九个人格工具。persona_introspect兼容原用法，增加section:"self"、action:"inspect"读取完整档案；action:"update_self"携带selfPatch（七字段的局部字符串对象）与expectedVersion更新current，来源由真实本轮上下文绑定，不能借此改用户的初始想法或引导确认状态。缺少版本返回SELF_VERSION_REQUIRED，旧版本返回VERSION_CONFLICT，超过工具输出预算继续用真实游标读同次结果。

owner管理增加self.get和self.update。后者参数为{instanceId?,patch,expectedVersion}，expectedVersion在顶层且必需，actor由管理端固定为user。status只给selfProfile:{mode,version,onboardingAcknowledged}摘要，不把全档案与历史铺进总览。首次轻提示仅在unset且未确认时出现；“以后再说”保存onboardingAcknowledged:true，不造身份、不发起模型、不阻止聊天。

PersonaConfig增加可选conversationStyle:"short_chat"|"balanced"|"detailed"，缺省short_chat；contextBudget增加可选selfProfileTokens，缺省350。self_profile段先放current，再放标明initialWishes的用户想法；每个展示字段完整保留，放不下的字段记录omitted且可用内省读全，历史不逐轮发送。350是局部帽，仍受totalTokens=2970动态总帽约束，不是额外增加350；工具定义、宿主历史和输出仍按原请求预算另行核算。

RequestSnapshot增加conversationStyle及selfProfileReference:{version,shown,omitted,fullProfileAvailable}技术摘要。memoryAvailability分别给personAssociation（associated/unassociated）、retrieval（not_requested/provided/found/no_matches）、returnedItems和已知来源计数；storeContent保持not_assessed时不能推断全库为空。读取故障沿实际错误处理，不伪装空记录。

短聊偏好不设固定字数、条数、最短间隔或必须续发。自主补充复用persona_decide.nextCheckAt与既有调度/等待/停止/平台限制；每次重新判断能结合新来信，发出的每条都须有真实原生assistant来源及实际渠道回执。待发送、取消、结果未知不写成已说过。不使用标点切割、随机延时或手工合成assistant事件。每次补充可能增加模型调用；用户说明和界面展示此代价，完整说明不进入每轮人格提示。

定向续聊需要一并保留当前replyPlan.target，单独设置nextCheckAt不保证回到原会话。每次到期重新读取pending和上下文交模型判断，不播放旧台词；这不是实时打断机制，生成已开始后到来的新消息可能要下一原生轮次才处理，不能承诺插话绝不出现旧半句。globalMuted及QQ官方等实际平台能力限制继续适用。

0.9.0新增字段与流程的最终全量、SDK、GUI和真实模型对照统一见[当前验收状态](../../management-ui.md#090-final-acceptance)；本节结构定义不代替运行结果，也不继承0.8.0后台未变的历史结论。

## 21. 人格实例生命周期与文本清除（0.9.0）

本节定义DSH适配层的实例管理契约；人格内容仍使用persona-memory/3，自我资料仍为xiangxu-self/1。实例切换、归档与用户明确清除是宿主生命周期操作，不增加人格记什么、如何成长或何时主动的规则。实际实现为adapters/dsh/instances.js与instance-lifecycle.js，owner动作见[接口说明](api-surface.md#090-人格实例管理接口)。

~~~ts
type InstanceClearStatus = "clearing" | "partial" | "cleared";
interface PersonaInstanceRecord {
  instanceId: string;
  name: string;                  // trim后1..80个JS字符串长度单位
  memoryRoot: string;            // 受核验的绝对目录
  archivedAt?: string | null;    // ISO时间；归档保留资料
  clearedAt?: string | null;     // 只有确认清空受管文件后才设置
  clearStatus?: InstanceClearStatus | null;
  retiredSessionCount?: number;
  clearStartedAt?: string;
  remainingFiles?: number;
  remainingBytes?: number;
  clearErrorCount?: number;
}
interface PersonaInstanceRegistry {
  schemaVersion: "persona-instances/1";
  version?: number;              // 兼容旧登记；每次持久变更递增
  selectedInstanceId: string;
  autoLoad: boolean;
  items: PersonaInstanceRecord[];
}
interface PersonaInstancesList {
  items: Array<PersonaInstanceRecord & { loaded: boolean; selected: boolean }>;
  activeInstanceId: string | null;
  selectedInstanceId: string | null;
  autoLoad: boolean;
  error: { code: string; message: string } | null;
  counts: { live: number; cleared: number };
  clearedListComplete: boolean;
}
interface InstanceClearPreview {
  instanceId: string;
  name: string;
  memoryRoot: string;
  scope: string[];
  excluded: string[];
  files: number;                 // 当前实际文件数
  bytes: number;                 // 当前实际字节数
  requiresName: string;          // 必须精确匹配，不能先trim输入
  confirmationToken: string;
  version: string;               // 64位小写hex SHA256，不是整数版本
  expiresAt: string;             // ISO时间；签发后5分钟到期
}
interface InstanceClearResult {
  status: "cleared" | "partial";
  instanceId: string;
  deletedFiles: number;
  remainingFiles: number;
  remainingBytes: number;
  errors: Array<{ path: string; code: string }>;
}
~~~

实例登记默认位于初始人格目录旁的<初始目录名>.instances.json，归属文件位于该登记路径加.ownership.json；二者必须在所有受管人格库之外。新建人格只需name，可给autoLoad；后台生成与初始库同级的新UUID目录，不继承旧人格资料。高级memoryRoot入口可以登记兼容v3库，已清除旧根不能再次加载或拿来复用；根路径不能是磁盘根目录，不能经过链接、junction或重定向。清除前拒绝与其他实例根目录及管理文件重叠。

归档先核当前工作、保存会话归属并停用，保留资料且关闭所选实例的自动加载；它不是一份独立备份。恢复只接受已归档、未进入清除状态的实例；activate:true才恢复并加载，缺省仅取消归档。普通load/select拒绝archivedAt或clearing/partial/cleared记录，重启也不自动加载这些记录。普通停用、切换或归档不触发文本清除，也不登录、退出或解绑共享平台账号。接入任务独立跟踪并固定原协调器/实例；停用先排空渠道，再关闭挂接入口、等待已登记接入完成，最后关闭协调器，避免渠道与生命周期队列互等。入口关闭后拒绝新挂接，旧任务不能改挂新实例。

清除范围仅为目标根中白名单受管文本：config与库内registry、meta/self/global、人物资料和索引/原文/临时区、journal/WAL、形象与声音文字档案、宿主检查点及操作收据等；精确文件/目录白名单由instance-lifecycle.js扫描器核验，界面显示实际scope、excluded、files、bytes。writer.lock由原写者正常关闭释放，不由清除器越权删除。未知文件、未知目录、链接、根重叠及超扫描容量会阻断，不递归删除整个目录来绕过核验。

目录外独立任务原件和完整任务档案、图片/视频/音频等作品二进制、共享账号/连接/密钥/权限、DSH旧会话历史与日志、外部备份和导出副本、实例登记及无正文归属墓碑均排除。清除不自动建立隐藏备份。文本库里的索引或收据被清除不等于对应外部作品、任务或平台消息也删除；普通明确遗忘仍沿原来源撤销契约，不与此生命周期操作混同。

clearPreview只扫描、计算指纹并签发本进程内临时token，不删除人格文件。token绑定instanceId、实例名称/根、状态、登记版本与文件内容，最多保存8份，有效期300000ms；进程重启、淘汰或过期后需重新预览。clear只接收instanceId、confirmationToken和typedName，精确核名称、token有效性、磁盘登记指纹及资料版本，再核闲置与维护互斥并保存旧会话归属。停用后再次扫描；若停机收据或资料变化，返回INSTANCE_CLEAR_STALE，保持停用且尚未删除任何文件，必须重新预览。不能把一次预览当作以后任意清除的授权。

进入删除前持久记录clearing；逐文件校验预览中的大小与SHA，再删除该受管文件。删除阶段遇到锁占用、权限失败或后续变化可能已经部分完成，不能一律宣称零删除。最终重新扫描能证明没有受管文件时才记cleared/clearedAt；否则保守记partial和剩余量/错误。partial/clearing不可加载、恢复或归档；重新预览、精确输入名称并明确确认后才能继续，程序不自动重试删除。完成后保留不可加载墓碑，不自动新建人格或切换其他实例；新的人格使用独立新根。

清除确认固定的是预览列出的受管文本精确清单与内容、实例登记和目标状态，不是“全目录所有文件SHA”。库外ownership不属于删除清单，也不以其正常变化判定预览失效。

会话归属文件schema为xiangxu-session-owners/1，持久保存SHA256(sessionId)→instanceId，无聊天正文。清除时capture在排他锁内重读并合并最新归属；合法外部新增可保留，归属冲突、锁忙或容量失败则在删除前拒绝，不覆盖已持久记录。归属冲突不覆盖；停用/切换/归档/清除前后采集实际接入和检查点中的会话。清除目标文本后此记录仍保留，用来拒绝把属于旧实例的DSH会话自动接入新实例；宿主旧日志本身没有被删除。它是技术隔离记录，不决定同一人格怎样认人或跨对象回忆。

0.12.0补充归属capture异常退出后的技术锁恢复：`.ownership.json.lock`须为1–4096字节、独立普通单链接文件，正文只含有效PID与UUIDv4 token。恢复在独占`.lock.recovery`保护下取得两份稳定快照，逐项核dev／ino／birth身份、size／mtime／ctime版本、完整字节、PID和token，两次PID检查都明确为ESRCH才删除同一旧锁。随后只尝试一次`wx`新锁；若另一写者已先取得锁，保留它，不回头再次回收。活进程、状态未知、格式／链接异常、快照变化或已有recovery guard均拒绝接管；不按时间删锁，不改原owner正文。guard异常残留不自动恢复，释放guard失败会尝试释放本次新主锁。错误仍为`INSTANCE_OWNERSHIP_BUSY`，消息说明具体原因，并在可核实时附owner PID。专项验证与正式重启证据按[本轮阶段记录](../../account-capabilities.md#0120-stage-observations)分列。

技术容量为最多16个未清除实例（归档与partial仍占用）、256个已清除墓碑；登记文件256KiB，归属文件2MiB，容量满明确拒绝而不淘汰归属/墓碑。list返回全部未清除记录与登记顺序尾部最多20条已清除记录，counts报告总量，clearedListComplete说明已清除列表是否完整。清除扫描最多20000个受管文件、累计256MiB；这些是管理操作技术帽，不扩大原有核心库容量或人格上下文预算。

本节是0.9.0生命周期增量的结构与执行契约，其历史验收见[0.9.0最终验收](../../management-ui.md#090-final-acceptance)；0.10.0当时增量见[历史验收记录](../../integrations-and-retrieval.md#本轮验收记录)，0.12.0的归属残锁修复与实际恢复范围见[当前验收](../../account-capabilities.md#0120-current-acceptance)。

## 22. 混合候选检索与可选平台扩展（0.10.0）

本节是新增字段权威，保持persona-memory/3与八工具兼容。资源默认值、可调范围和硬帽唯一可执行数值源为[core/retrieval-config.js](../../../core/retrieval-config.js)；部署schema直接消费该源，不另维护一份数值裁决表。平台固定传输／资产帽分别来自适配器导出的LIMITS，说明索引见[本轮技术容量](../../integrations-and-retrieval.md#技术容量)。它们只约束资源，不决定人格重要度、亲疏或行为频率。

~~~ts
interface RetrievalConfig {
  semanticEnabled?: boolean;
  cacheEntries?: number;
  cacheBytes?: number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  batchRecords?: number;
  documentChars?: number;
  diagnosticEntries?: number;
  diagnosticBytes?: number;
}
interface SemanticPort {
  id: string;
  version: string;
  dimensions?: number;
  embed(input: {texts: string[]; purpose: "document" | "query"; signal: AbortSignal}):
    Promise<{vectors: number[][]}>;
}
~~~

memory_search与RetrievePlan共用mode、timeMode、asOf、seedIds、associationDepth、diversity。默认mode:auto、timeMode:all、associationDepth:1、diversity:none、limit:5；scope沿原person/global/all语义。query最多2000字符，可空；limit技术范围0–1000，0不调用向量。seedIds最多16个真实记录ID，深度0–2；空query且无seed不做语义查询或图扩展。lexical关闭向量接口，仍允许明确的既有关联扩展；hybrid/auto没有服务／索引或服务失败时如实降级。

current/asOf按已有validFrom≤at<validTo筛选，缺失边界保持未指定，不补编时间；asOf必须且只能随timeMode:asOf提供epoch毫秒，聊天原件还按sourceAt排除未来消息。past只选validTo已明确结束的资料，不等于所有历史经历；invalid区间不冒称有效。supersedesIds不会自动让旧观点失效。查询只覆盖尚存资料，不是历史数据库恢复，不复活明确遗忘。

返回仍是items，既有score保留字面相关度含义；item.retrieval另含channels、rankScore、lexicalScore、semanticScore、matchedTerms、associationPaths、temporal、referenceOnly:true、automaticRecall:false。融合排序不是人格重要度；diversity:source只作为可选来源多样性排序，不设人群配额，不删条目。内部候选键含recordType/scope/personId/id，不能把同名裸ID串成他人经历。关联仅沿relatedMemoryIds/expandIds/supersedesIds/replacementIds等已存连接，不冒用来源依赖作语义关系；不完整时标partial。

diagnostics包含真实method、temporal、semantic（enabled/configured/available/queryCacheHit/eligible/indexed/coverageComplete/reason/degraded）、association及返回量。候选、实际snapshot注入和工具返回分别记search_candidates/snapshot/tool_result；记录requestId/ID/来源hash/计算依据与queryHash，不额外留query原文，窗口与缓存都有帽且进程重启清空。重复曝光不改变排序权重、自动回忆或人格取舍。工具预算页可只返回scalar解释和matchedTermCount/associationPathCount、explanationDetailsOmitted:true，原文仍沿cursor读取。

setSemanticPort(port|null)经仓库队列替换并清cache/provider状态；prepareRetrievalIndex只为显式所选页调用document embed。search只在启用且已有可用索引时按需query embed，并复用同provider/version/query指纹缓存。有限真实非零向量需维度／数值校验，不用字符串hash伪装语义。文档超过向量片段帽时标partialTexts/partialDocumentTexts，原件不截短；pageComplete/nextOffset是页进度，coverage才是实际覆盖。TTL、LRU、换服务和重启可移除可重建向量，不删除原始资料；撤销来源清除受影响缓存／诊断引用。DSH配置文件与密钥在库外，endpoint/model/apiKey/enabled/version经expectedVersion保存；不会回退聊天模型或自动全库索引。

persona_platform保持同一工具，新增platform:bilibili及action:read/job/cancel_job/assets，原inspect/execute/accounts继续按分支使用。B站operation为search/recommend/video/subtitles/comments/frames/comment/reply/share/message；keyword、bvid/cid、page/limit、offset/charOffset/next、times/num、commentId/contentHash、评论父ID及接收UID等仅按对应操作校验，不是任意HTTP代理。读取按实际字幕／分P／采样覆盖，写入按真实rpid/msg_key回执；分享是私信链接。当前memoryRoot、账号、能力授权和真实调用requestId来自可信适配上下文，不能由模型伪造。B站默认没有许可；能力快照只读当前服务状态，不在操作队列内重入排队inspect，probe仍单独排队。unknown及等价未确认操作不得自动重发。

0.10.1字幕返回兼容增加coverage.sourceBinding（aid/bvid/cid、实际签名endpoint与platformDeclaredIdsVerified）、subtitleTrack（轨id、sourceHost、sourceUrlHash、assetBinding:aid_cid_prefix|not_encoded）、contentHash及coverage.contentCorrespondenceAssessed:false。签名/x/player/wbi/v2的身份与可辨识资产来源不匹配时技术拒绝，不回退旧未签名/x/player/v2；not_encoded不能解释为已完成资产ID绑定。续读可提供contentHash核对字节版本。平台声明／来源检查不判断文字是否语义对应视频，不删除或改写字幕，仍由人格解释。实现与样本边界见[0.10.1字幕说明](../../ui-retrieval-context-validation.md#字幕轨来源身份回显还不够)。

QQ OneBot11扩展chat.mention、message.read、message.forward.read和安全rich消息。resolveIncomingMedia默认true、transcribeIncomingAudio默认false；真实图片附件需要视觉模型，语音只经已配置STT处理受支持PCM16 WAV。rich原始安全段、SHA、省略标志、媒体／提及／回复／转发及perception保留技术事实；转写和第三方转发是独立程序材料，不改用户原话或speaker身份。unsupported／失败如实报告，不猜媒体内容；微信与官方Bot不继承QQ桥能力。

media.cover和QQ feed.*使用用户自备xiangxu-social-provider/1。配置分别含feed/cover的baseUrl/apiKey/allowRemote/accountId、同源probe/read/publish/react或submit/poll/cancel路径、model/targetVoice和明确downloadOrigins；不存在即不可用。作业保存真实requestId、目标／内容指纹、状态和来源，音频资产存真实bytes/mime/SHA与来源，导入经有界分块和整件校验。未确认不自动重交；取消本机等待不冒充远端取消。人格记什么仍自主选择。受管extensions/qq-social/state.json计入实例文本清除，库外音频、账号凭据、任务原件和备份不属于该删除清单；来源撤销另核永久撤销表并报告远端未删除边界。

owner动作和各服务具体响应以[接口补充](api-surface.md#0100-检索与可选平台接口)和[本轮说明](../../integrations-and-retrieval.md)为消费说明。2970仍是动态snapshot总帽，参考不等于回忆；本节字段校验不代替本轮最终运行／真实账号验收。

## 23. 个人QQ一键准备与受管连接（0.11.0）

本节定义DSH受管连接兼容扩展，persona-memory/3与八工具保持兼容；本轮核心另有第24节通用维护端口增量，平台代码仍不进入核心。默认QQ页面提供个人QQ／NapCat，官方Bot与已有OneBot桥仍可明确选择。Windows x64受管安装检查真实QQ安装，固定官方NapCat Shell版本、字节与SHA，独立保存downloads、versions和runtime；runtime的config/cache/logs不属于人格文本。既有QQ安装包不被替换，不将正常QQ用户数据当成只读；实际平台登录仍由本人手机扫码确认。

owner动作qqBridgeSetup.inspect/start/poll/connect/stop使用当前实例选择，可通过flowId继续同一任务。phase为not_installed|installing|starting|waiting_login|authorized|configuring|connected|failed|stopped；扫码已接受与实际QQ核心在线分别核实，不能只按进度显示connected。owner可得到本次QR内容与实际账号线索，管理前端不取得WebUI密码、临时Credential、OneBot token或事件secret；诊断不回显。具体通俗步骤与真实验收在[操作说明](../../qq-one-click-setup.md)。

connect之前核对当前已加载人格和QQ实际账号，并由本人确认接入。个人QQ受管向导默认自主社交：allowedPrivateIds与allowedGroupIds均为['*']，授权该独立QQ的私聊与群聊；不要求逐个指定社交对象。用户也可切换指定对象作为可选隐私／测试范围；该模式空列表仍表示未接入。此处扩展第14节手动桥初值，不把准备或扫码本身当作渠道已启用。范围只控制平台通路，不规定人格的注意、联系对象、是否尝试加好友、认人、亲密关系、回复、主动、记忆或睡眠。仍沿实际实例、平台、账号、room和actor记录原件与回执，不把外部ID当personId。

channels.rotateIngress({id,authMode})默认bearer；onebot-hmac仅支持OneBot11。记录沿xiangxu-channels/1兼容扩展：ingressHash仍用于轮换核验，HMAC模式额外保存ingressHmacSecret；status返回ingressAuthMode而不返回secret，rotate仅在本次操作返回ingressToken。NapCat HTTP Client发送x-signature:sha1=<HMAC-SHA1 hex>，签名覆盖准确的原始JSON字节，接收端在64KiB帽内保留原始body验签后解析，并在排队执行前核轮换。Host／Origin、真实self_id、实例／账号和范围核验继续有效，不能关闭鉴权、把secret塞URL或将HMAC误当Bearer。

受管恢复只沿已成功connect、同实例／同memoryRoot且channel仍enabled的记录，不自动下载、不扩大范围或切换账号。人工stop清除恢复意愿，并停止DSH通道、禁用本应用的OneBot网络项、结束可证归属的启动句柄；不能证实QQ子进程全树退出时返回需人工关闭或停止未确认事实，不按QQ.exe名称结束所有进程。平台凭据和原生进程状态与人格记忆分离，停止不会清除人格文本。

好友申请分两项能力：NapCat固定版本已有set_friend_add_request处理真实入站申请，但插件尚未接入申请事件与执行；公开OneBot仍无主动申请action。原创原生适配器的friend.query／friend.request契约已核并在源码接线，不能以此宣称所有好友管理已实现。主动申请字段、版本、原始档案与验收见[第24节](#24-独立qq账号工具与维护扩展0110)及[账号操作](../../qq-account-operations.md)。

本节只定义技术契约；实际安装、本人扫码、正式人格接入、私聊与群聊回执及停止恢复分别见[0.11.0最终验收](../../qq-one-click-setup.md#0110-final-acceptance)，未完成不预填成功，不改变第14节中未被本节兼容扩展的其它渠道规则。

## 24. 独立QQ账号工具与维护扩展（0.11.0）

本节保持persona-memory/3与八工具兼容，在persona_platform内增加scope:account、platform:qq分支；普通聊天分支继续沿真实target／binding执行。账号操作不要求先有人发来消息，不伪造target、入站事件或人物归属。一次许可friend.query／friend.request后，查询谁、是否申请、验证文字、人物associate与记什么仍由人格自主选择，不逐次交回人工审批。friend.manage仍表示未接线的入站申请处理。

~~~ts
interface QQAccountTool {
  scope: "account";
  platform: "qq";
  action: "inspect" | "read" | "execute";
  accountOperation?: "friend.query" | "friend.options" | "friend.request" | "friend.status" | "receipts" | "receipt";
  accountId?: string; userId?: string; targetRef?: string; optionsRef?: string;
  text?: string; receiptId?: string; limit?: number; pageCursor?: string;
  offset?: number; maxChars?: number;
}
~~~

inspect核真实账号与原生能力；read分别执行friend.query／friend.options／friend.status／receipts／receipt，execute仅friend.request。operationId取宿主可信工具编号，不允许模型填写；当前memoryRoot、实例和实际账号取宿主可信上下文。账号操作拒绝聊天target，不进入普通聊天delivered投影；sourceSessionId／sourceRefs／sourceRecordIds保留实际工具来源，humanDialogue:false、bindingCreated:false，不自动写人格记忆。

查询回传targetRef与optionsRef，绑定实例／根／账号／bootId及expiresAt；旧引用可回查原件，不能在重启或换号后直接执行。当前支持按已核原生回调保留身份字段，包括合法空UID；不将OneBot UID跨填原生字段，不猜source枚举或验证码。结果状态prepared／unknown／submitted／accepted／failed／unsupported；submitted仅已核提交，accepted需实际friend_list关系确认。未知结果只核同一receiptId，相同宿主操作编号不获得第二次原生提交机会。

原生运行协议xiangxu-qq-native/1，当前ABI qq-win-53644-req-to-friend/1，仅精确Windows QQ wrapper与固定NapCat bundle哈希支持。原创loader捕获官方启动所用同一会话，不修改厂商bundle、QQ文件或allowlist。私有配置／令牌仅在适配层；getNativeRuntime内部核marker／boot／账号／owned进程树及认证inspect后提供描述符，设置页不回显。停止、换号、旧boot／PID失配或离线如实不可用；普通OneBot聊天不因原生能力缺失停止。

人格内extensions/qq-account使用xiangxu-qq-account/1：index.json含instanceId／revision／receipts／queries，queries/qqquery-<32hex>.json保存完整查询，receipts/qqop-<32hex>/000000.json保留准备原文，000001至000064为不可变状态修订；JsonStore的writer.lock与.wal是技术元数据。容量唯一见QQ_ACCOUNT_LIMITS：索引2MiB、记录256KiB、2048收据／2048查询、每收据64修订、总64MiB；列表最多50条／页、正文每次8000 Unicode字符。原始记录保留完整信息，超限拒新操作，不静默淘汰旧收据。

core维护可选extensionValidator({path,value,kind:'content'|'writerLock'})，仅返回true才接纳扩展；validateMemoryRoot／validateBackup／createBackup／restoreBackup／recoverRestore及恢复完成链均传递同端口，缺省严格拒未知扩展。DSH只认精确qq-account与既有qq-social路径／结构，nested WAL核文件名、digest及每条entry，active nested writer拒维护；停止排空并releaseRoot后才允许校验、备份、恢复或明确清除。精确清除仍有20000文件／256MiB扫描帽；库外共享native journal、凭据、作品和备份排除。

本轮验收仅同人格原目录backup／restore；receipt标识含原root与instance，跨人格／换根迁移未实现，不盲改不可变原件。库外native journal另有跨进程prepare锁和严格2048项容量；崩溃残锁不按时间自动回收，确认旧writer已停后才可受控技术修复。CONTROL_GUIDANCE本轮增加API用法与事实回执说明，核心新增通用维护端口，未加人格频率或价值裁决。源码接线、操作者诊断、真人聊天收件与正式工具实测分层见[当前验收](../../qq-one-click-setup.md#0110-final-acceptance)。


<a id="0120-account-and-recovery-contract"></a>

## 25. QQ 账号自身操作与受管恢复（0.12.0）

本节是 0.12.0 新增字段与状态的权威，兼容第23／24节；核心 `persona-memory/3`、八工具和人格判断保持不变。第24节的原生好友 DTO、固定 ABI 与 `friend.query/request/status` 仍有效；下列 OneBot 账号自身动作不冒充原生好友调用，不要求聊天 target，也不伪造人类来信或人物归属。跨平台实际范围与待验收见[账号能力](../../account-capabilities.md#0120-current-acceptance)。

### 25.1 人格工具参数与成功条件

`persona_platform` 使用 `scope:account/platform:qq/action:execute`，新增以下 `accountOperation`；实际账号、实例、资料根和可信工具调用 operationId 取宿主上下文。模型不填写 operationId／路径／令牌，不把 account 操作挂到聊天 binding。

在已授予当前人格、当前QQ账号的工具能力范围内，是否修改自己的头像、昵称、签名、性别资料，具体使用什么内容以及何时修改，均由人格自主决定。程序不设固定更换周期、次数或触发条件。

| accountOperation | 参数 | 既有许可 | 确认完成条件 |
|---|---|---|---|
| `profile.avatar` | `accountId`、当前人格图片 `assetId` | `profile.update` | 已核实 OneBot `retcode:0`、`status:ok` 与头像动作的实际响应结构；本桥当前确认 `data:null` 路径，不泛化 void 为所有操作成功。 |
| `profile.update` | `accountId`、`nickname` 必填1–64字符、`signature?` 最多512字符且可空、`sex?:unknown/male/female` | `profile.update` | `data.result===0`；明确非零 failed，缺少该结果 unknown。sex 向桥映射为0／1／2，不据此推导人格性格。 |
| `feed.publish` | `accountId`、`text` 最多16000字符（有图可空）、`imageAssetIds?` 最多9个唯一资产、必填 `visibility`、`targetUserIds?` | `feed.publish` | 实际返回非空 `tid` 才 completed，缺失／响应未确认 unknown。 |

`visibility` 只接受 `1/4/16/64/128`，分别为公开／好友／部分好友可见／仅自己／部分好友不可见。`targetUserIds` 最多100个唯一真实QQ号；16／128必须非空，其他范围不可给非空列表。参数限制是平台和资源契约，不选择人格应当发布什么、联系谁或采用哪种范围。

图片资产 ID 为当前人格已保存的 `asset-<32hex>`。每件8MiB、总16MiB、最多9件，复核容器／MIME／SHA与实际字节；准备记录 `request.assets=[{assetId,sha256,bytes,mime}]` 不保留图片 Base64、路径或密钥。临时发送字节不进入人格上下文或普通聊天 delivered 账本。

适配器来源 `napcat-onebot-account`；只有实际已认证的当前账号／桥连接、精确 NapCat 4.18.41 或 `get_supported_actions` 明示相应 action 时提供对应能力。`profile.avatar/profile.update` 共享 `profile.update` 许可，`feed.publish` 使用自己的既有许可；换账号、换实例或连接身份改变重新核对。原生已支持能力优先，optional 扩展不能把它覆盖为另一来源。

### 25.2 保持 v1 的账号技术档案扩展

`schemaVersion:xiangxu-qq-account/1`、index／query／receipt路径与原始不可变修订保留兼容。旧好友记录仍有实际 `userId`，旧记录缺 `operation` 时按既有好友申请解释。账号自身操作在准备原件、索引摘要与状态修订中携带 `operation:profile.avatar|profile.update|feed.publish`、`userId:null`，增加 `completed` 状态；不能写成联系人 null 或新增好友关系。

本分支先 durable prepared，再单次 dispatch；收据记录 `transportCalls/transportCallUpperBound`（中断可为null／1），原生好友分支继续 `nativeCalls/nativeCallUpperBound`。同一宿主可信编号、相同参数／来源仅回旧记录，不重放；更换参数／来源为冲突。prepared 冷恢复保留 unknown，未确认回执、写入失败或重启不能生成第二次副作用。完成结果含 `status/operation/accountId/receiptId/confirmedBy:onebot-api-success`，空间成功另有实际 `tid`；没有结果不能把 HTTP200 当完成。

`friend.status` 仅用于原好友记录；账号自身动作没有已实现的远端通用 status API，unknown 不通过重发来核对。`read/receipts` 分页列出真实 operation，`read/receipt` 继续按 offset／maxChars／sha256 完整读取。UI 中 null 目标为“账号自身”，completed为“已完成”，仅好友记录显示好友状态核对按钮。

原有2048收据／2048查询、2MiB索引、256KiB单记录、64MiB档案、每收据64修订、50条列表／页和8000 Unicode字符／次正文读取继续有效；超限拒绝新操作并保留原件。通用维护扩展校验器接受新 operation／null userId／completed 分支，仍拒未知路径／结构；同人格原目录 backup→restore 的不可变准备及修订字节已隔离验证，不代表跨根迁移或正式 QQ 写操作实测。

### 25.3 管理认证和QQ登录的公开状态

~~~ts
interface ManagedQQStatus0120 {
  management: {
    status: "unknown" | "ready" | "unavailable" | "rate_limited";
    lastVerifiedAt: number | null;
    retryAt: number | null;
    retryAfterMs: number;
    errorCode: string | null;
  };
  lastVerifiedQQ: {
    at: number;
    online: boolean;
    coreReady: boolean;
    loginPhase: string | null;
    accountId: string | null;
  } | null;
  recovery: {required: boolean; canRecover: boolean; reason: "offline_without_qr" | null};
}
~~~

原 phase／flowId／instanceId／loginAccount／qrContent（仅owner端转QR）继续保留。management 是本机 WebUI 管理通路状态，lastVerifiedQQ 是最近实际读取的 QQ 登录事实，不能互相替代。HTTP200 内 Unauthorized 与HTTP401均按认证失败处理，管理认证共享 single-flight；只读登录查询最多恢复一次凭据，不重放 SetConfig 或其他 mutation。明确 login rate limit 使用60000ms本机技术冷却及 retryAt，不按失败轮询延长；这不是人格聊天频率规则。合法业务拒绝保留 management.ready，不把“无QRCode”等业务错误误称管理鉴权失败。

UI 出错停止2.5秒自动读取，仅本地倒数，到期由本人点“重新检查连接”；同页各动作共享in-flight状态。离开或hidden取消UI定时器，回可见只对有效活动flow做一次只读核对且不越过冷却；不会自动RefreshQR、QuickLogin或recover。仅本次有效QR才指导扫码；缓存在线／旧二维码不得冒充当前确认。

手动换码入口与当前QR是否可显示分开判断：仅`phase:waiting_login`、`management.status:ready`，且无错误或只有明确`NAPCAT_LOGIN_ERROR`时可提供“重新生成二维码”；即使错误使QR隐藏，仍可由本人点击。认证／限流／未知管理状态、需重连、手机已确认、初始化或在线状态不允许换码。handler核alive／visible／in-flight及捕获的flowId，普通poll／recheck绝不自动传refreshQr。后台仅实际Refresh成功后重新CheckLoginStatus，以新状态报告错误，不复用Refresh前的旧loginError盖住新码。专项通过不代替真实过期码手动刷新验收。

### 25.4 本人一键重新连接与启动恢复

新增owner动作 `qqBridgeSetup.recover({instanceId,flowId})`。required仅在新鲜管理查询确认 `management.ready`、实际QQ `online:false/loginPhase:offline` 且无QR时成立；canRecover还要求本应用native启动代次及可证归属的停止端口。执行前再次只读核实状态与实例／根／账号／flow，核marker、boot、ABI、PID及进程树归属；先确认对应owned树和监听端口已退出，再创建新flow启动。无法证明停止时如实保留错误／manualCloseRequired，不spawn第二套、不按QQ.exe名称结束进程。

本人一次点击“重新连接QQ”不新增逐次审批弹窗；恢复保持已保存账号／接入范围／许可／记忆，不自动拓宽范围、不自动QuickLogin或刷新二维码，新的平台扫码仍由本人完成。stop取消恢复意愿；旧flow、账号变化、人格生命周期和迟到结果继续封闭原作用域。冷启动owner receipt恢复按第25.5节另行保存与核验；生产结果以最终回执补充，不能把热运行成功扩写成所有冷启动已通过。

仅当前service实际spawn的新flow在starting阶段有90秒传输就绪宽限：明确的本机连接未就绪保持starting与management.status:unknown，继续有界poll，不造在线事实或二维码；认证、限流、业务拒绝、HTTP错误和未分类异常不因宽限而隐藏。私有spawnedHereAt仅用于本次启动计时，不进入公开状态或模型。已有可达进程与冷恢复不应用此宽限；90秒后传输仍未就绪则failed／management.unavailable并报`NAPCAT_STARTUP_TIMEOUT`，不执行第二次spawn，最终实际恢复结果另行验收。

第23／24节的0.11.0历史验收保留原范围。本节定义不替代本版[当前验收表](../../account-capabilities.md#0120-current-acceptance)，也不增加人格频率、关系或记忆裁决规则。

### 25.5 私有启动归属收据与冷恢复

本机受管目录的`owned-launch.json`为私有技术记录，schema为`xiangxu-napcat-owned-launch/1`，state为`launching|verified|stopped`。它记录version、instanceId、memoryRoot、qqPath、versionRoot、launcherPath、launcherPid、startedAt、bootId、configPath及configSha256、markerPath、loaderPath、port、abiVersion与processProof。令牌仍只在原私有配置中，不再抄一份到receipt；UI和人格工具不读取processProof或秘密配置。

启动时先记launching；只有OS进程归属证明和使用原令牌／boot／ABI的本机原生握手都通过后才附processProof并记verified。QQ尚未登录时原生`ready:false/accountId:null`也可证明这次进程归属，但不能因此宣布QQ在线或账号工具可用。processProof为`xiangxu-owned-qq-process/1`，含bootId、pid、launcherPid、path、createdAt和startedAt。

冷恢复只接受同一owner实例与记忆根、相同固定版本和精确路径布局的verified记录，重新核配置SHA、loader／资产摘要、端口／ABI、marker／PID及OS出生事实，再以原token作原生握手；不能凭磁盘PID或QQ.exe名称收养外部进程。缺失旧receipt、launching未证、stopped、配置／资产变化或身份不匹配均不能变成已恢复归属；若OS归属已证但握手未确认，明确阻止再启动另一套并保留未确认状态。实际QQ登录、原渠道恢复和模型聊天仍需各自核验。此结构实现与正式冷启动验收分别记录在本版验收表。

前阶段正式宿主加载后曾恢复同一个仍存活的在线受控QQ，无需新扫码；之后一次重启停止了旧受控进程，本次最终运行已启动新的受控QQ并取得verified归属证明，目前等待本人重新扫码，OneBot API尚不可用，主QQ保持运行。不能用前阶段在线事实代替当前登录，也不据此宣布优雅关闭通过。实际ownership残锁自动恢复、1289项完整回归及修后真实模型3次只读调用已有各自证据；登录后平台材料与未执行的写操作仍待验证，详见[阶段观测](../../account-capabilities.md#0120-stage-observations)，不改变上述字段契约。

`launching`记录同时是未核实启动屏障：即使旧WebUI没有监听，也不能据此认定原QQ已经退出并spawn第二套。后台返回`NAPCAT_OWNED_LAUNCH_UNVERIFIED`与`manualCloseRequired`，请本人确认并关闭旧受管QQ后处理；不会按记录年龄自动回收，也不能用launching记录作为收养或授权stop进程的依据。此边界不代表新版真实recover或平台写入已经验收。

<a id="0130-memory-timeline-contract"></a>

## 26. 统一时间线与必要人格上下文（0.13.0）

本节替代第2／3／8节中旧的“容量满自然删除原文”和“100万字符包含全部人格文本”的口径。外层仍为persona-memory/3；平台工具、主观人格成长、关系、深刻参考、睡眠和自主委派不变。格式和转层属于存储契约，不规定人格的观点、情绪、社交对象或成长频率。

### 26.1 一份原件，同一格式

每条真实交流记录继续保留原ChatRecord的id、eventId、sourceSessionId、sourceEventId、personId、speakerId、role、origin、sourceKind、text、sourceAt和observedAt，并增加：

```ts
interface TimelineAnnotation {
  format: "persona-timeline/1";
  title: string;
  occurredAt: EpochMs;       // 等于原始sourceAt，不是整理时刻
  recordedAt: EpochMs;       // 等于原始observedAt
  background: string;
  process: string;
  outcome: string;
  details: string;
  feltThen: string;
  meaningNow: string;
  indexCodes: string[];
  relatedMemoryIds: string[];
  provenance: Record<string, {
    refs: Array<{sourceSessionId: string; sourceEventId: string}>;
    recordIds: string[];
  }>; // 程序记录每个注释字段的来源，模型不能填写
}
type TimelineTier = "recent" | "long_term" | "archive";
```

实际原话text是权威；注释默认空字符串／空数组，不为填模板编造标题、经过或感受。原始事件时间与初次观察时间分开；注释不改原话、角色、来源或时间。相同sourceSessionId／sourceEventId始终是同一根事件，转层不增加一次经历。相同发生时间用原接收eventId与稳定id继续排序。

人格可在既有自主整理中提出global:timeline补丁，expectedVersion取冻结inputVersions["global:timeline"]，recordId必须是实际交流原件id。upsert只修改title／background／process／outcome／details／feltThen／meaningNow／indexCodes／relatedMemoryIds；remove只清这些注释，不删除交流原件。数组每项最多200个Unicode字符、每数组最多128项，整次补丁仍受既有单条与请求帽。想明确遗忘原件时仍走独立撤销接口，不借remove注释伪装删源。索引编码和关联记忆继续服务检索，不自动触发某种回忆或情绪。

timeline.provenance由宿主从实际run.input.chat／hot和冻结context.sourceDependencies记录到每个非空注释字段；不是模型声明的来源，也不改变原话。每字段最多128个refs和256个recordIds，超量或来源收集不完整时技术拒绝，不截掉依赖凑容量。明确遗忘B时，A原件中依赖B的注释字段会清空并移除相应provenance，A无关原话保留；从旧备份恢复也先应用现行撤销，重新计算归档分片SHA和count／chars，不借旧注释复活已忘内容。

### 26.2 时间、容量与转层

短期沿用people/<personId>/stream.jsonl与staging/events.jsonl；长期位于timeline/long/person-<personId>.jsonl或unknown.jsonl；归档为timeline/archive/八位数字.jsonl。timeline/catalog.json保存persona-timeline-catalog/1、版本、各层count／chars与归档分片path／count／chars／bytes／SHA256，来源收据记录实际storagePath。

recentPreferredDays默认3，recentTargetChars默认100000，按同一实例的近期交流合计。超过时间或近期容量的记录进入长期；longTermTargetChars默认1000000，只计活动长期层text与标题／前因／过程／结果／细节／当时感受／当前理解的Unicode码点，超过时从最旧记录开始完整转归档。人格、关系、普通索引、编码与深刻参考另受各自业务条目／文档和实例物理帽约束，不抢活动长期层配额。

转层在打开库、接收、读取近况、修改相关配置及时间线管理时本地维护，不新建固定模型定时整理。原文和注释值完整保留，同一WAL提交来源索引、原层、目标层与目录；中断重开恢复，不把半批转层当完成。归档分片通常不超过1MiB，并受journal预算约束；单条超分片目标可独占，但仍受真实单条／事务／物理硬帽，不能截断原文凑容量。已归档的旧记录不因时钟回退或调大近期范围自动复制回活动层，仍可回查。

旧库迁移只为仍然存在的原件补统一格式并转存，保持原始编号、来源和文字。旧版本已自然裁剪、明确删除或未实际保存的原文不能凭空恢复；现存概括与来源引用不冒充找回了全部细节。

归档不自动删除。全部层仍计入capacityLimits.storeBytes与磁盘安全余量；到真实硬边界保留旧资料并拒绝无法安全提交的新副本，报告MemoryGap和可回补来源，不伪称保存成功。用户可明确备份、增加容量或选择归档原件遗忘；此操作沿原撤销语义同时处理受影响派生，不能声称只删冷文件而完整保留对应依赖。转层保真不等于无限存储、异盘备份或硬件故障零损失。

### 26.3 读取、检索和管理消费者

getContext提供recentMemory={items,total,omitted,preferredDays,asOf,originalsRemainQueryable:true}，items来自同库当前对象的短期原件。普通近况组装不扫描长期／归档正文；详细搜索、sourceRefs原件回读、详情、关联更正、明确遗忘、校验、备份与恢复覆盖各层。检索可使用原文、统一注释和indexCodes，relatedMemoryIds保留真实关联；结果仍说明真实人物与角色。

owner管理新增memory.timeline.status与memory.timeline.list。list接受tier=recent|long_term|archive|all、可选query（最多512字符）、可选personId（null选择未归属）、pageSize（最多100）与同次结果cursor，保持有界分页。详情和明确遗忘复用memory.detail／memory.forget。界面“记忆 → 短期、长期与归档”展示各层数量／字符、筛选与上下翻页，展开详情才读完整记录。数据变化或换人格使旧cursor失效时应重新查询，不能将某页结束称为整个记忆库结束。显式时间线浏览／搜索当前会扫描所选层的本地JSONL后形成有界结果；响应分页限制返回量，不等于磁盘索引按页读取，也不承诺大归档恒定I/O。

### 26.4 每轮必要上下文和故障

必要人格背景在模型请求前由程序加载，不依赖人格先主动调用读取工具。当前身份核心（name／pronouns／gender／ageDescription／birthday／selfDescription）、anchor与axes、当前对象身份与关系概要、有效计划／休息事实及有界近期参考必须成功组装；扩展人格、习惯、关系条目、初始用户想法与详细往事按实际预算提供完整条目，并列出省略信息或可读原件。深刻记忆仍为referenceOnly／automaticRecall:false，不强制激活或规定反应。

contextBudget总动态默认2970计数单位，新增recentMemoryTokens局部默认600，仍包含在总额内。必要核心不按局部帽截成残片，超出原局部预算可在总帽内调整；必要内容连总帽也放不下时返回PERSONA_CONTEXT_BUDGET或ESSENTIAL_CONTEXT_BUDGET，不悄悄删核心。近期段保留真实来源和Unicode范围，超长记录标fragment、未显示数量和originalsRemainQueryable；当前来信尚待原始输入分页时，pendingInputReferences只记录该引用，不在近期段重复正文，也不表示整条或未读尾部已消费；参考不推进源消费游标。

人格资料／必要近期读取失败返回PERSONA_CONTEXT_UNAVAILABLE并暂停本次人格生成，不退回缺少人格的普通模型请求。DSH assemble与middleware保留同一故障，不吞错继续next；控制、回复和唤醒通过同一核心组装。失败不消耗尚未处理消息，恢复后可以继续。tokenizer不可用时仍明确utf8_bytes_estimate，2970不是整个宿主请求帽；工具、历史和输出预留另计。

新库合法的空人格和从未保存的自我档案可以为空；已保存自我档案由meta.requiredDocuments登记，缺文件不能退回空身份。已建立的人格／meta／runtime／config和timeline/catalog实际缺失时明确报错，不把损坏库当新人格初始化。

DSH最终llm/stream还核对真实system消息中的protocol／conversation／live正文投影（字符串或text多part），以实际sessionId和本步AbortSignal固定准备结果；第三方后来覆盖完整提示导致缺人格时，在实际模型调用前抛PERSONA_CONTEXT_UNAVAILABLE，不能只凭快照元数据判定已注入。不同会话／信号和合法重试各核自己的冻结投影，不把本次失败扩展到其他会话；独立任务工作预设继续隔离。

### 26.5 本轮验收边界

本轮按用户自行验证QQ的安排，不运行真实模型或平台验收；QQ头像／资料／空间由用户自行操作，其他社交连接显示未测试；没有为了补覆盖而强迫人格修改资料。隔离持久化、故障和加载测试的实际结果以[0.13.0机器回执](../../verification/0.13.0-memory-timeline.json)为准，不预填通过数，也不以0.12.0的1289项替代。本节不新增人格判断、固定梳理频率、强制情绪或深刻回忆规则。
