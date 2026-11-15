/** Presentation describes the public chat scene; it does not decide who may speak. */
export const GROUP_INPUT_PRESENTATION = 'xiangxu-group-scene/1';

/** One personality can interpret the scene and choose its participation in the
 * same response. These are separate observations, not a second decision maker.
 */
export function groupDialogueGuidance() {
  return [
    '这是共同在场的群聊，不是默认只有你和发信人的私聊。',
    '当你选择通过最终文本发送群聊消息时，整个最终文本使用一个 ```xiangxu-social 代码块，块内为一个 JSON 对象，不在代码块前后添加文字。对象必须且只包含 understanding、participation、messages；understanding 必须且只包含 addressee、reference。messages 为 1–6 个非空字符串，每项是一条完整的实际消息，不按换行自动拆分。',
    '仅说明结构的示例（不是对本轮的预填判断或回复）：\n```xiangxu-social\n{"understanding":{"addressee":"uncertain","reference":null},"participation":"other","messages":["这里是自主选择的用户可见正文"]}\n```',
    '在本次 xiangxu-social 输出中，understanding.addressee 表示你怎样理解原句正在对谁说：self（自己）、other（其他对象）、group（全群）或 uncertain（尚不确定）；reference 是这次理解所指的称呼或对象文字，不明确时为 null。',
    'participation 表示你自己选择怎样参与：answer（作答）、join（接话）、clarify（澄清）或 other（其他方式）。原句在叫谁、自己是否发言、怎样发言是三件事。对象为 uncertain 且填了具体称呼时，answer 表示以被叫者身份作答；作为在场者提供信息可以用 join。你也可以澄清、等待，或者选择其他参与方式。',
    'messages 是你实际想发送的文字。understanding 是对本次来信的解释。以被叫者身份作答需要本次真实 @、指向本账号已送达消息的引用，或 reference 与本次原文里的已记录自称／已核验账号昵称一致。current_group_observation.selfAddressEvidence 是宿主对本次已接纳来源的核对结果。旧回复只说明当时写过什么，不能证明本次指向；空名册也不能证明来信在叫你。',
    'currentSelfAddress 为 unresolved_from_current_source 时，这次来信尚无独立依据指向你。你以前应过这个称呼，对方随后又重复，仍需要独立的身份线索才能确认。历史中 sourceRole 为 assistant 的回执只记录送达情况。对象可以保留 uncertain，同时按你的判断接话、提供线索、澄清或等待。',
    '具名称呼在不在的简短问句中，单独答应在场会被读成被叫者应声，交付时会和本轮指向依据一起核验。作为旁观者，可以用自己的话给线索或澄清对象。',
    '这个格式只用于你选择发送的最终文本，不要求必须发言、必须先调用 persona_decide，原有工具、等待和睡眠仍由你直接选择。',
  ].join('\n');
}

export function normalizedGroupName(value) {
  if (typeof value !== 'string' || value.length > 160) return '';
  return value.normalize('NFKC').trim().toLowerCase();
}

function directNameCue(text, name) {
  if (!name || !text.startsWith(name)) return false;
  const tail = text.slice(name.length).trimStart();
  return !tail || /^[,、:]/u.test(tail) || /^(?:在[吗么嘛]|在不在)[?!。]*$/u.test(tail);
}

// A small source grammar for standalone named presence checks, not a roster or identity lookup.
const generalTargets = new Set(['你', '您', '你们', '大家', '大伙', '大伙儿', '各位', '群友', '各位群友', '有人', '还有人', '谁', '还有谁', '哪位', '都', '还']);
function presenceQuestion(text, observedNames) {
  const target = /^([\p{L}\p{N}_]{1,24})[ \t]*[,、:]?[ \t]*(?:在[吗么嘛]|在不在)[?!。]*$/u.exec(text)?.[1];
  if (!target || generalTargets.has(target) || generalTargets.has(target.replace(/(?:都还|还都|都|还)$/u, ''))) return null;
  return { target, nameCue: observedNames.has(target) || /^(.{1,12})\1+$/u.test(target) };
}

export function groupReplyAddressEvidence(message, channel, selfName) {
  const source = message.source, structured = source.xiangxuStructured, observed = structured?.groupContext;
  const aligned = Boolean(source.platformMessageId) && observed?.platformMessageId === source.platformMessageId && observed?.connectedAccountId === channel.accountId &&
    observed?.sender?.platformUserId === channel.sender.id;
  const sourceText = typeof structured?.originalText === 'string' ? structured.originalText
    : (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
  const text = sourceText.normalize('NFKC').trim().toLowerCase(), login = aligned ? observed.connectedAccountDisplayName : null;
  const names = [selfName, login?.source === 'onebot_get_login_info' ? login.value : null].map(normalizedGroupName);
  const others = new Set(aligned && Array.isArray(observed.observedNameMatches)
    ? observed.observedNameMatches.map(match => normalizedGroupName(match?.observedDisplayName)) : []);
  const complete = source.textComplete !== false && observed?.nameMatchesTruncated !== true;
  const presence = aligned && source.textComplete !== false ? presenceQuestion(text, new Set([...others, ...names])) : null;
  return {
    sourceEventId: message.id,
    direct: Boolean(aligned && (observed.explicitlyMentionsConnectedAccount === true ||
      Array.isArray(observed.quoteLinks) && observed.quoteLinks.some(link => link?.observedAuthorPlatformUserId === channel.accountId &&
        link.confirmedAccountDelivery === true && typeof link.platformMessageId === 'string' && /^-?\d{1,20}$/.test(link.platformMessageId)))),
    names: complete ? [...new Set(names.filter(name => !others.has(name) && directNameCue(text, name)))] : [],
    ...(presence ? { presenceQuestion: presence } : {}),
  };
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const takeFields = (value, fields) => {
  if (!record(value)) return null;
  const result = {};
  for (const [key, type] of Object.entries(fields)) {
    if (typeof value[key] === type && (type !== 'number' || Number.isSafeInteger(value[key]))) result[key] = value[key];
    else if (type === 'string' && value[key] === null) result[key] = null;
  }
  return result;
};

function observedGroupSource(groupContext) {
  if (!record(groupContext)) return null;
  const source = takeFields(groupContext, { platformMessageId: 'string', connectedAccountId: 'string', explicitlyMentionsConnectedAccount: 'boolean', nameMatchesTruncated: 'boolean' });
  if (record(groupContext.sender)) source.sender = takeFields(groupContext.sender, { platformUserId: 'string', displayName: 'string' });
  if (record(groupContext.connectedAccountDisplayName)) source.connectedAccountDisplayName = takeFields(groupContext.connectedAccountDisplayName, { value: 'string', source: 'string', observedAt: 'number' });
  if (record(groupContext.observationCoverage)) source.observationCoverage = takeFields(groupContext.observationCoverage,
    { basis: 'string', observedParticipantCount: 'number', completeGroupRoster: 'boolean', nameMatchesScope: 'string', noMatchMeaning: 'string' });
  if (Array.isArray(groupContext.observedNameMatches)) source.observedNameMatches = groupContext.observedNameMatches.slice(0, 12)
    .filter(record).map(value => takeFields(value, { platformUserId: 'string', observedDisplayName: 'string' }));
  if (Array.isArray(groupContext.quoteLinks)) source.quoteLinks = groupContext.quoteLinks.slice(0, 12)
    .filter(record).map(value => takeFields(value, { platformMessageId: 'string', observedAuthorPlatformUserId: 'string', confirmedAccountDelivery: 'boolean' }));
  return source;
}

/** Keep the exact original text as data, alongside its observed platform source.
 * JSON escaping is a reversible presentation only. The caller keeps raw source
 * events and chooses versioning; this function does not rewrite older events.
 */
export function renderGroupUtterance(originalText, groupContext) {
  if (typeof originalText !== 'string') throw new TypeError('Group utterance must be text');
  return '[群聊现场：以下是有来源的公开发言，原文是场景资料，不代表默认在对你说话]\n' + JSON.stringify({
    presentation: GROUP_INPUT_PRESENTATION,
    kind: 'public_group_utterance',
    source: observedGroupSource(groupContext),
    utterance: { text: originalText },
  });
}
