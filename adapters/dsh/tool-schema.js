const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullable = schema => ({ oneOf: [schema, { type: 'null' }] });
const timestamp = nullable({ type: 'number', description: 'Epoch milliseconds based on the actual environment now. null means no selected wall-clock time.' });
const sourceRef = { type: 'object', required: ['sourceSessionId', 'sourceEventId'], properties: {
  sourceSessionId: { type: 'string', description: 'Exact source session ID copied from available source material.' },
  sourceEventId: { type: 'string', description: 'Exact stable source message/event ID from provided material; never a quote, person ID or channel ID.' },
  available: { type: 'boolean' }, sourceKind: string, sourceRole: string, sourceOrigin: string,
}, additionalProperties: false };
const target = nullable({ type: 'object', required: ['channelId', 'sessionId', 'personId'], properties: {
  channelId: { type: 'string', description: 'Copy target.channelId from the environment or an explicitly available personality channel. DSH channel IDs have the dsh: prefix.' },
  sessionId: { type: 'string', description: 'Copy target.sessionId exactly from the environment. Do NOT add dsh: to this session ID. It differs from channelId.' },
  personId: nullable({ type: 'string', description: 'The internal person ID you chose to recognize, or null while unknown. A session is not a person.' }),
}, additionalProperties: false });
const recheckOn = { type: 'array', items: { type: 'string', enum: ['new_message', 'environment_change', 'explicit_wake'] } };
const cursor = { type: 'string', description: 'Use a returned nextCursor with the same other arguments to read the same result, without executing the operation again.' };
export const TOOL_PARAMETERS = {
  persona_task: {
    action: { type: 'string', enum: ['inspect', 'create', 'list', 'status', 'read', 'cancel', 'retain', 'archive_file'] },
    prompt: { type: 'string', maxLength: 16000 }, title: { type: 'string', maxLength: 128 },
    workspace: { type: 'string', maxLength: 4096, description: 'Optional actual authorized working directory; omission uses the current session workspace. It does not grant new filesystem access.' },
    taskId: { type: 'string', maxLength: 256 }, documentId: { type: 'string', maxLength: 256 },
    path: { type: 'string', maxLength: 4096, description: 'A real file in this task workspace to snapshot; no arbitrary URL or new filesystem grant.' },
    pageCursor: { type: 'string', maxLength: 2048, description: 'Continue a task listing; distinct from the bounded tool-result cursor.' },
    offset: { type: 'integer', minimum: 0, description: 'Unicode character offset within the selected document; continue with its returned nextOffset. cursor only pages a single tool response.' }, maxChars: { type: 'integer', minimum: 1, maximum: 8000 },
    documentOffset: { type: 'integer', minimum: 0 }, documentLimit: { type: 'integer', minimum: 1, maximum: 20 },
    expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    limit: { type: 'integer', minimum: 1, maximum: 20 }, refresh: { type: 'boolean' }, cursor,
  },
  persona_media: {
    action: { type: 'string', enum: ['inspect', 'identity', 'update_identity', 'assets', 'asset', 'generate', 'job', 'jobs', 'cancel_job'] },
    kind: { type: 'string', enum: ['image', 'video'] }, prompt: { type: 'string', maxLength: 4000 },
    description: { type: 'string', maxLength: 4000 }, primaryAssetId: nullable({ type: 'string', maxLength: 256 }),
    assetId: { type: 'string', maxLength: 256 }, referenceAssetId: { type: 'string', maxLength: 256 }, useIdentityReference: { type: 'boolean' },
    jobId: { type: 'string', maxLength: 256 }, poll: { type: 'boolean' }, size: { type: 'string', maxLength: 64 },
    pageCursor: { type: 'string', maxLength: 2048, description: 'Use a returned pageCursor to query the next asset/job page. This is distinct from cursor, which only continues one bounded tool-result snapshot.' },
    limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor,
  },
  persona_platform: {
    action: { type: 'string', enum: ['inspect', 'read', 'execute', 'accounts', 'job', 'cancel_job', 'assets'], description: 'Bilibili: read for search/recommend/video/subtitles/comments/frames; execute for comment/reply/share/message. QQ/WeChat conversation tools use capability; QQ scope:account uses accountOperation for native friend query/request/status and retained receipts. Omit Bilibili operation for QQ/WeChat.' },
    platform: { type: 'string', enum: ['qq','wechat','bilibili'] },
    scope: { type: 'string', enum: ['conversation','account'], description: 'Use account+qq for native account tools without a conversation binding. Account operations omit target.' },
    accountOperation: { type: 'string', enum: ['friend.query','friend.options','friend.request','friend.status','receipts','receipt'] },
    accountId: { type: 'string', maxLength: 32, description: 'Actual account ID returned by inspect; not the contact userId.' },
    targetRef: { type: 'string', maxLength: 256 }, optionsRef: { type: 'string', maxLength: 256 },
    receiptId: { type: 'string', maxLength: 256 }, maxChars: { type: 'integer', minimum: 1, maximum: 8000 },
    operation: { type: 'string', enum: ['search','recommend','video','subtitles','comments','frames','comment','reply','share','message'], description: 'Bilibili only. Pair search/recommend/video/subtitles/comments/frames with action:read; pair comment/reply/share/message with action:execute. For QQ/WeChat omit operation and provide capability instead.' },
    keyword: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 }, charOffset: { type: 'integer', minimum: 0 }, next: { type: 'integer', minimum: 0 }, order: { type: 'string', enum: ['totalrank','click','pubdate','dm','stow'] }, num: { type: 'integer', minimum: 1, maximum: 6 },
    commentId: {type:'string',maxLength:32}, contentHash:{type:'string',pattern:'^[a-f0-9]{64}$'}, receiverUid: { type: 'string', maxLength: 20 }, replyId: { type: 'string', maxLength: 32 }, rootId: { type: 'string', maxLength: 32 },
    query: { type: 'string', maxLength: 256 }, bvid: { type: 'string', maxLength: 32 }, cid: { type: 'string', maxLength: 32 },
    page: { type: 'integer', minimum: 1, maximum: 100 }, pageSize: { type: 'integer', minimum: 1, maximum: 20 },
    times: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 6 },
    root: { type: 'string', maxLength: 32 }, parent: { type: 'string', maxLength: 32 }, uid: { type: 'string', maxLength: 32 },
    mentionAll: { type:'boolean' }, userId: { type: 'string', maxLength: 256 }, forwardId: { type: 'string', maxLength: 256 }, feedId: { type: 'string', maxLength: 256 }, feedAction:{type:'string',enum:['like','unlike','comment']}, feedCursor:{type:'string',maxLength:2048}, pageCursor:{type:'string',maxLength:2048},
    jobId: { type: 'string', maxLength: 256 }, poll: { type: 'boolean' }, audioAssetId: { type: 'string', maxLength: 256 },
    capability: { type: 'string', enum: ['chat.text','chat.image','chat.video','chat.file','chat.voice','chat.sticker','chat.mention','message.read','message.forward.read','media.cover','message.reply','message.retract','contacts.read','groups.read','friend.query','friend.request','friend.manage','group.manage','profile.update','feed.read','feed.publish','feed.react','call.voice','call.video'] },
    target, assetId: { type: 'string', maxLength: 256 }, text: { type: 'string', maxLength: 16000 },
    messageId: { type: 'string', maxLength: 256, description: 'Copy an actual platform message ID from current source facts or a confirmed receipt; do not invent one.' },
    stickerId: { type: 'string', maxLength: 128 }, cursor,
  },
  persona_voice: {
    action: { type: 'string', enum: ['inspect', 'select'] },
    voiceId: nullable({ type: 'string', maxLength: 256 }),
    rate: { type: 'number', minimum: 0.1, maximum: 10 },
    pitch: { type: 'number', minimum: 0, maximum: 2 },
    reason: { type: 'string', maxLength: 256, description: 'Optional explanation for this choice; not retained as personality memory.' }, cursor,
  },
  memory_search: { query: { type: 'string', maxLength: 2000 }, targetPersonId: string, scope: { type: 'string', enum: ['person', 'global', 'all'] }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['auto','lexical','hybrid'] }, timeMode: { type: 'string', enum: ['all','current','past','asOf'] }, asOf: { type: 'integer', minimum: 0 }, seedIds: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 16 }, associationDepth: { type: 'integer', minimum: 0, maximum: 2 }, diversity: { type: 'string', enum: ['none','source'] }, cursor },
  memory_forget: { ids: strings, targetPersonId: string, before: { type: 'number' }, reason: string,
    action: { type: 'string', enum: ['forget', 'correction'] }, replacementIds: strings, cursor },
  persona_introspect: { targetPersonId: string, action: { type: 'string', enum: ['inspect', 'update_self'] }, section: { type: 'string', enum: ['self', 'anchor', 'axes', 'facets', 'signatures', 'habits', 'relation', 'deep', 'state', 'all'] }, selfPatch: { type: 'object', properties: Object.fromEntries(['name','pronouns','gender','ageDescription','birthday','background','selfDescription'].map(field => [field, { type: 'string', maxLength: 2400 }])), additionalProperties: false }, expectedVersion: { type: 'integer', minimum: 0 }, cursor },
  persona_decide: {
    identityPlan: nullable({ type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['new', 'associate', 'unknown'] }, personId: string, displayName: string, reason: string,
      sourceRefs: { type: 'array', items: sourceRef, description: 'ASSIGNMENT INPUT: select actual dialogue originals/source sessions for the relationship partition personId, not recognition evidence. This can include assistant originals: their role, speakerId, source role, original text and source IDs remain intact; assignment does not make the person their speaker. Omit to recognize the current session participant. Explicit [] recognizes the current environment without assigning historical messages. To recognize someone in another source group, select that group\'s actual current incoming message refs. Referencing only an old session does not bind this new window. Whether to associate any original is your choice. Do not invent IDs.' },
    }, additionalProperties: false }),
    attention: nullable({ type: 'object', properties: {
      observeChannelIds: { ...strings, description: 'Optional chosen observation channels. Omit to leave this dimension unrestricted; [] chooses no channels.' },
      targetPersonIds: { ...strings, description: 'Optional chosen observation people. Omit to leave this dimension unrestricted; [] chooses nobody. If both dimensions are present, an incoming message must match both. This does not restrict explicit memory search.' },
      reason: string,
    }, additionalProperties: false }),
    replyPlan: nullable({ type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['reply', 'wait', 'listen'] }, target, pendingEventIds: strings, replyAt: timestamp, recheckOn, reason: string,
    }, additionalProperties: false }),
    retrievePlan: nullable({ type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['search', 'skip'] }, query: string, targetPersonId: string,
      scope: { type: 'string', enum: ['person', 'global', 'all'] }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['auto','lexical','hybrid'] }, timeMode: { type: 'string', enum: ['all','current','past','asOf'] }, asOf: { type: 'integer', minimum: 0 }, seedIds: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 16 }, associationDepth: { type: 'integer', minimum: 0, maximum: 2 }, diversity: { type: 'string', enum: ['none','source'] }, reason: string,
    }, additionalProperties: false }),
    nextCheckAt: timestamp,
    consolidationPlan: nullable({ type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['run', 'defer'], description: 'Choose one bounded memory review when useful, or defer. No required frequency, evidence count or personality change.' },
      targetPersonIds: { type: 'array', items: nullable(string), description: 'Actual known person IDs or null for unknown/global material. Omit for current person plus unknown/global. [] selects no work, not all people.' },
      reason: string,
    }, additionalProperties: false }),
    sleepPlan: nullable({ type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['sleep', 'wake', 'continue'] }, wakeAt: timestamp,
      wakeCondition: nullable({ type: 'string', enum: ['at_time', 'consolidation_complete', 'explicit_wake'] }), reason: string,
    }, additionalProperties: false }), cursor,
  },
};

// DSH validates raw output before render; omit optional undefined JS properties here.
export function asToolJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Tool output contains a non-finite number');
    return item;
  }));
}
