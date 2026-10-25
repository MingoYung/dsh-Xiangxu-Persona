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
  memory_search: { query: string, targetPersonId: string, scope: { type: 'string', enum: ['person', 'global', 'all'] }, limit: { type: 'integer' }, cursor },
  memory_forget: { ids: strings, targetPersonId: string, before: { type: 'number' }, reason: string,
    action: { type: 'string', enum: ['forget', 'correction'] }, replacementIds: strings, cursor },
  persona_introspect: { targetPersonId: string, section: { type: 'string', enum: ['anchor', 'axes', 'facets', 'signatures', 'habits', 'relation', 'state', 'all'] }, cursor },
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
      scope: { type: 'string', enum: ['person', 'global', 'all'] }, limit: { type: 'integer' }, reason: string,
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
