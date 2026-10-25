import { randomUUID } from 'node:crypto';
import { DEFAULT_CAPACITY_LIMITS, DEFAULT_PROCESSING_LIMITS } from './capacity.js';

export const SCHEMA_VERSION = 'persona-memory/3';
export class SchemaError extends Error {
  constructor(message) { super(message); this.name = 'SchemaError'; this.code = 'SCHEMA_INVALID'; }
}
export const countChars = (value) => Array.from(String(value ?? '')).length;
export const newId = (prefix = 'id') => prefix + '_' + randomUUID();
export const sourceKey = (ref) => JSON.stringify([ref.sourceSessionId, ref.sourceEventId]);
/** Selected observation dimensions intersect; this is attention, not identity proof or search authorization. */
export function observationAllows(attention, { channelId, personId } = {}) {
  if (Array.isArray(attention?.observeChannelIds) && !attention.observeChannelIds.includes(channelId)) return false;
  if (Array.isArray(attention?.targetPersonIds) &&
    (typeof personId !== 'string' || !personId || !attention.targetPersonIds.includes(personId))) return false;
  return true;
}
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);
const fail = (message) => { throw new SchemaError(message); };
const object = (v, field) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(field + ' must be an object'); };
const str = (v, field, empty = false) => { if (typeof v !== 'string' || (!empty && !v.length)) fail(field + ' must be a string'); };
const num = (v, field, min = 0) => { if (!Number.isFinite(v) || v < min) fail(field + ' must be a finite number >= ' + min); };
const integer = (v, field) => { num(v, field); if (!Number.isSafeInteger(v)) fail(field + ' must be a safe integer'); };
const array = (v, field) => { if (!Array.isArray(v)) fail(field + ' must be an array'); };
const enumeration = (v, values, field) => { if (!values.includes(v)) fail(field + ' has an unknown value'); };
const nullableTime = (v, field) => { if (v !== null && v !== undefined) integer(v, field); };
const safeId = (v, field = 'personId') => { str(v, field); if (!/^[A-Za-z0-9_-]{1,160}$/.test(v)) fail(field + ' is not a safe identifier'); return v; };
export { safeId };
export function validateSrcRef(ref) {
  object(ref, 'sourceRef'); str(ref.sourceSessionId, 'sourceSessionId'); str(ref.sourceEventId, 'sourceEventId');
  if (own(ref, 'available') && typeof ref.available !== 'boolean') fail('available must be boolean');
  return ref;
}
export function validateMeta(item) {
  object(item, 'record'); str(item.id, 'id');
  if (item.schemaVersion !== SCHEMA_VERSION) fail('unsupported schemaVersion');
  enumeration(item.scope, ['global', 'person'], 'scope');
  if (item.scope === 'person') safeId(item.personId);
  else if (item.personId !== null) fail('global record requires personId:null');
  enumeration(item.epistemic, ['user_statement', 'observed', 'interpretation'], 'epistemic');
  array(item.srcRefs, 'srcRefs'); item.srcRefs.forEach(validateSrcRef);
  integer(item.createdAt, 'createdAt'); integer(item.updatedAt, 'updatedAt');
  return item;
}
export function validateChat(record) {
  object(record, 'chat'); validateSrcRef(record);
  if (record.schemaVersion !== SCHEMA_VERSION) fail('unsupported chat schemaVersion');
  if (record.personId !== null) safeId(record.personId);
  if (record.speakerId !== null) safeId(record.speakerId, 'speakerId');
  str(record.sourceKind, 'sourceKind'); str(record.channelId, 'channelId');
  if (record.contentClass !== 'participant_dialogue') fail('C1 requires participant_dialogue classification');
  if (['runtime-context', 'agent-instructions', 'plugin-state', 'agent-message', 'tool', 'reasoning'].some((kind) => record.sourceKind === kind)) fail('automatic source cannot enter C1');
  enumeration(record.role, ['user', 'assistant'], 'role');
  enumeration(record.origin, ['user', 'ai_reply', 'ai_initiated'], 'origin');
  if ((record.role === 'user') !== (record.origin === 'user')) fail('chat role/origin disagree');
  str(record.text, 'text', true); integer(record.sourceAt, 'sourceAt'); integer(record.observedAt, 'observedAt');
  if (record.chars !== countChars(record.text)) fail('chat chars do not match Unicode text');
  return record;
}
export function validateHot(record) {
  object(record, 'hot'); validateSrcRef(record.sourceRef);
  if (record.schemaVersion !== SCHEMA_VERSION) fail('unsupported hot schemaVersion');
  str(record.sourceKind, 'hot.sourceKind');
  if (record.dependencyRefs !== undefined) { array(record.dependencyRefs, 'hot.dependencyRefs'); record.dependencyRefs.forEach(validateSrcRef); }
  if (record.dependencyRecordIds !== undefined) { array(record.dependencyRecordIds, 'hot.dependencyRecordIds'); record.dependencyRecordIds.forEach(id => str(id, 'dependency record id')); }
  if (record.contextGroupId != null) str(record.contextGroupId, 'contextGroupId');
  if (record.dependencyScanComplete !== undefined && typeof record.dependencyScanComplete !== 'boolean') fail('dependencyScanComplete must be boolean');
  if (record.personId !== null) safeId(record.personId);
  enumeration(record.kind, ['dialogue', 'reasoning', 'tool_call', 'tool_result', 'runtime_context', 'agent_instructions', 'plugin_state', 'agent_message'], 'hot.kind');
  enumeration(record.origin, ['user', 'ai_reply', 'ai_initiated', 'system'], 'hot.origin');
  object(record.content, 'hot.content');
  if (record.content.mode === 'cached') { str(record.content.text, 'content.text', true); if (record.content.chars !== countChars(record.content.text)) fail('hot chars do not match text'); }
  else if (record.content.mode === 'host_trace') { str(record.content.locator, 'content.locator'); if (typeof record.content.available !== 'boolean') fail('trace availability required'); }
  else fail('unknown hot content mode');
  integer(record.sourceAt, 'sourceAt'); integer(record.observedAt, 'observedAt'); return record;
}
export function validateMemoryItem(item) {
  validateMeta(item); enumeration(item.kind, ['fact', 'preference', 'decision', 'pattern'], 'memory.kind');
  str(item.text, 'text', true); array(item.keys, 'keys'); item.keys.forEach((v) => str(v, 'key'));
  array(item.aboutPersonIds, 'aboutPersonIds'); item.aboutPersonIds.forEach((v) => safeId(v));
  if (item.importance !== null) { num(item.importance, 'importance'); if (item.importance > 1) fail('importance exceeds 1'); }
  nullableTime(item.validFrom, 'validFrom'); nullableTime(item.validTo, 'validTo');
  return item;
}
export function validateCode(item) {
  validateMeta(item); str(item.label, 'label'); str(item.meaning, 'meaning', true);
  array(item.cues, 'cues'); array(item.expandIds, 'expandIds'); integer(item.occurrences, 'occurrences'); return item;
}
export function validateSignature(item) {
  validateMeta(item); str(item.if, 'if'); str(item.then, 'then'); array(item.cues, 'cues'); integer(item.observations, 'observations'); return item;
}
export function validateFacet(item) {
  validateMeta(item); enumeration(item.kind, ['tendency', 'boundary'], 'facet.kind'); str(item.desc, 'desc');
  if (item.kind === 'boundary') { enumeration(item.policy, ['preference', 'ask_first', 'avoid'], 'boundary.policy'); str(item.topic, 'topic'); }
  return item;
}
export function validateRelationEvent(item) {
  validateMeta(item); enumeration(item.type, ['interaction', 'commitment'], 'relation.type');
  str(item.text, 'relation.text', true); enumeration(item.who, ['ai', 'person', 'both'], 'relation.who');
  enumeration(item.state, ['remembered', 'open', 'done', 'cancelled'], 'relation.state');
  enumeration(item.reaction, ['replied', 'not_observed', 'explicitly_rejected', 'other'], 'relation.reaction');
  nullableTime(item.mentionedTime, 'mentionedTime');
  if (item.reactionTo !== null && item.reactionTo !== undefined) str(item.reactionTo, 'reactionTo');
  return item;
}
export function validateInterpretation(item) {
  validateMeta(item); str(item.text, 'interpretation.text', true); array(item.questions, 'interpretation.questions');
  item.questions.forEach((question) => str(question, 'question', true)); return item;
}
export function validateImpression(document) {
  object(document, 'impression'); if (document.schemaVersion !== SCHEMA_VERSION) fail('unsupported impression schemaVersion');
  integer(document.version, 'version'); safeId(document.personId); str(document.summary, 'impression.summary', true);
  object(document.coordinates, 'coordinates');
  for (const coordinate of Object.values(document.coordinates)) {
    object(coordinate, 'coordinate'); str(coordinate.desc, 'coordinate.desc', true);
    if (coordinate.value !== null) num(coordinate.value, 'coordinate.value', -Infinity);
    array(coordinate.srcRefs, 'coordinate.srcRefs'); coordinate.srcRefs.forEach(validateSrcRef);
  }
  array(document.signatures, 'impression.signatures'); document.signatures.forEach((signature) => {
    validateSignature(signature); if (signature.personId !== document.personId || signature.scope !== 'person') fail('relation signature subject mismatch');
  });
  array(document.events, 'impression.events'); document.events.forEach((event) => {
    validateRelationEvent(event); if (event.personId !== document.personId || event.scope !== 'person') fail('relation event subject mismatch');
  });
  integer(document.updatedAt, 'updatedAt'); return document;
}
export function validatePersona(persona) {
  object(persona, 'persona'); if (persona.schemaVersion !== SCHEMA_VERSION) fail('unsupported persona version');
  integer(persona.version, 'version'); integer(persona.updatedAt, 'updatedAt');
  object(persona.anchor, 'anchor'); str(persona.anchor.text, 'anchor.text', true); array(persona.anchor.srcRefs, 'anchor.srcRefs'); persona.anchor.srcRefs.forEach(validateSrcRef);
  object(persona.axes, 'axes');
  for (const axis of Object.values(persona.axes)) {
    object(axis, 'axis'); str(axis.desc, 'axis.desc', true); integer(axis.n, 'axis.n');
    if (axis.position !== null) { num(axis.position, 'axis.position'); if (axis.position > 1) fail('axis.position exceeds 1'); }
    if (axis.sd !== null) { num(axis.sd, 'axis.sd'); if (axis.n < 2 || !axis.metric || !axis.window) fail('sd requires >=2 real observations, metric and window'); }
    array(axis.srcRefs, 'axis.srcRefs'); axis.srcRefs.forEach(validateSrcRef);
  }
  array(persona.facets, 'facets'); persona.facets.forEach(validateFacet);
  array(persona.signatures, 'signatures'); persona.signatures.forEach(validateSignature);
  array(persona.habits, 'habits'); persona.habits.forEach((v) => { validateMeta(v); str(v.text, 'habit.text'); });
  array(persona.retired, 'retired'); persona.retired.forEach(retired => {
    object(retired, 'retired entry'); object(retired.entry, 'retired.entry'); integer(retired.retiredAt, 'retiredAt'); str(retired.reason, 'retired.reason', true);
    if (retired.entry.kind === 'tendency' || retired.entry.kind === 'boundary') validateFacet(retired.entry);
    else if (Object.hasOwn(retired.entry, 'if') || Object.hasOwn(retired.entry, 'then')) validateSignature(retired.entry);
    else { validateMeta(retired.entry); str(retired.entry.text, 'retired habit.text'); }
  }); return persona;
}
export function validateDecision(input) {
  object(input, 'decision');
  if (input.nextCheckAt !== undefined) nullableTime(input.nextCheckAt, 'nextCheckAt');
  if (input.attention !== undefined && input.attention !== null) {
    object(input.attention, 'attention');
    for (const key of ['observeChannelIds', 'targetPersonIds']) if (input.attention[key] !== undefined) { array(input.attention[key], key); input.attention[key].forEach((v) => str(v, key)); }
  }
  if (input.replyPlan !== undefined && input.replyPlan !== null) {
    const p = input.replyPlan; object(p, 'replyPlan'); enumeration(p.action, ['reply', 'wait', 'listen'], 'reply.action');
    nullableTime(p.replyAt, 'replyAt');
    if (p.target !== undefined && p.target !== null) { str(p.target.channelId, 'target.channelId'); str(p.target.sessionId, 'target.sessionId'); if (p.target.personId !== null && p.target.personId !== undefined) safeId(p.target.personId); }
    if (p.recheckOn !== undefined) { array(p.recheckOn, 'recheckOn'); p.recheckOn.forEach((v) => enumeration(v, ['new_message', 'environment_change', 'explicit_wake'], 'recheckOn')); }
  }
  if (input.sleepPlan !== undefined && input.sleepPlan !== null) {
    const p = input.sleepPlan; enumeration(p.action, ['sleep', 'wake', 'continue'], 'sleep.action'); nullableTime(p.wakeAt, 'wakeAt');
    if (p.wakeCondition !== null && p.wakeCondition !== undefined) enumeration(p.wakeCondition, ['at_time', 'consolidation_complete', 'explicit_wake'], 'wakeCondition');
    if (p.action === 'sleep' && !p.wakeCondition) fail('sleep requires a chosen wake condition');
    if (p.wakeCondition === 'at_time' && p.wakeAt == null) fail('at_time requires wakeAt');
  }
  if (input.retrievePlan !== undefined && input.retrievePlan !== null) {
    enumeration(input.retrievePlan.action, ['search', 'skip'], 'retrieve.action');
    if (input.retrievePlan.scope !== undefined) enumeration(input.retrievePlan.scope, ['person', 'global', 'all'], 'retrieve.scope');
    if (input.retrievePlan.targetPersonId !== undefined) safeId(input.retrievePlan.targetPersonId);
  }
  if (input.identityPlan !== undefined && input.identityPlan !== null) {
    enumeration(input.identityPlan.action, ['new', 'associate', 'unknown'], 'identity.action');
    if (input.identityPlan.personId !== undefined) safeId(input.identityPlan.personId);
    if (input.identityPlan.action === 'associate') safeId(input.identityPlan.personId);
    if (input.identityPlan.sourceRefs !== undefined) { array(input.identityPlan.sourceRefs, 'identity.sourceRefs'); input.identityPlan.sourceRefs.forEach(validateSrcRef); }
  }
  if (input.consolidationPlan !== undefined && input.consolidationPlan !== null) {
    object(input.consolidationPlan, 'consolidationPlan'); enumeration(input.consolidationPlan.action, ['run', 'defer'], 'consolidation.action');
    if (input.consolidationPlan.targetPersonIds !== undefined) { array(input.consolidationPlan.targetPersonIds, 'consolidation.targetPersonIds'); input.consolidationPlan.targetPersonIds.forEach(id => { if (id !== null) safeId(id); }); }
    if (input.consolidationPlan.reason !== undefined) str(input.consolidationPlan.reason, 'consolidation.reason', true);
  }
  return input;
}
export function validateRuntime(state) {
  object(state, 'runtime'); if (state.schemaVersion !== SCHEMA_VERSION) fail('unsupported runtime schemaVersion');
  integer(state.version, 'runtime.version');
  if (typeof state.globalMuted !== 'boolean') fail('runtime.globalMuted must be boolean');
  if (state.currentDecision != null) validateDecision(state.currentDecision);
  object(state.sleep, 'runtime.sleep'); enumeration(state.sleep.state, ['awake', 'sleeping'], 'sleep.state');
  nullableTime(state.sleep.wakeAt, 'wakeAt');
  if (state.sleep.wakeCondition != null) enumeration(state.sleep.wakeCondition, ['at_time', 'consolidation_complete', 'explicit_wake'], 'wakeCondition');
  object(state.schedule, 'runtime.schedule'); nullableTime(state.schedule.nextCheckAt, 'nextCheckAt'); array(state.schedule.recheckOn, 'recheckOn');
  state.schedule.recheckOn.forEach((value) => enumeration(value, ['new_message', 'environment_change', 'explicit_wake'], 'recheckOn'));
  array(state.ingestCursors, 'ingestCursors'); object(state.consolidationCursors, 'consolidationCursors'); array(state.memoryGaps, 'memoryGaps');
  integer(state.updatedAt, 'runtime.updatedAt');
  return state;
}
export function validatePatch(patch) {
  const entries = Array.isArray(patch) ? patch : patch?.entries;
  array(entries, 'patch.entries');
  for (const entry of entries) {
    object(entry, 'patch entry'); str(entry.documentKey, 'documentKey'); str(entry.recordId, 'recordId');
    if (['__proto__', 'constructor', 'prototype'].includes(entry.recordId)) fail('reserved recordId');
    if (!/^(persona|global:(index|codes)|person:[A-Za-z0-9_-]+:(index|codes|impression|pending))$/.test(entry.documentKey)) fail('uncontrolled documentKey');
    enumeration(entry.operation, ['upsert', 'remove'], 'operation'); integer(entry.expectedVersion, 'expectedVersion');
    if (entry.operation === 'upsert' && !own(entry, 'value')) fail('upsert requires value');
  }
  return patch;
}
export function mergeConfig(base, overrides = {}) {
  object(overrides, 'config overrides');
  return { ...base, ...overrides, contextBudget: { ...base.contextBudget, ...overrides.contextBudget }, artifactLimits: { ...base.artifactLimits, ...overrides.artifactLimits }, retention: { ...base.retention, ...overrides.retention },
    capacityLimits: { ...DEFAULT_CAPACITY_LIMITS, ...base.capacityLimits, ...overrides.capacityLimits }, processingLimits: { ...DEFAULT_PROCESSING_LIMITS, ...base.processingLimits, ...overrides.processingLimits } };
}
export function defaultConfig(overrides = {}) {
  return validateConfig(mergeConfig({
    schemaVersion: SCHEMA_VERSION, consolidationMode: 'sleep', timezone: 'UTC',
    longTermTargetChars: 1000000, recentTargetChars: 100000, recentPreferredDays: 3, tempTargetChars: 200000, diskReserveBytes: 0,
    contextBudget: { totalTokens: 2970, environmentTokens: 120, anchorTokens: 200, personaTokens: 700, habitTokens: 150, relationTokens: 300, retrievalTokens: 1500 },
    artifactLimits: { axes: 5, tendencyFacets: 12, boundaryFacets: 20, signatures: 24, habits: 8, impressionSignaturesPerPerson: 8, indexItemsPerPerson: 80, codesPerScope: 12, interpretationsPerPerson: 30, relationEventsPerPerson: 80 },
    capacityLimits: { ...DEFAULT_CAPACITY_LIMITS }, processingLimits: { ...DEFAULT_PROCESSING_LIMITS },
    retention: { snapshotMaxRequests: 50, personaHistoryMaxVersions: 5, journalMaxBytes: 8388608, backupMaxBytes: 8388608 }
  }, overrides));
}
export function validateConfig(config) {
  object(config, 'config'); if (config.schemaVersion !== SCHEMA_VERSION) fail('unsupported config schemaVersion');
  enumeration(config.consolidationMode, ['sleep', 'on_write'], 'consolidationMode');
  str(config.timezone, 'timezone'); try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { fail('invalid IANA timezone'); }
  for (const key of ['longTermTargetChars', 'recentTargetChars', 'recentPreferredDays', 'tempTargetChars', 'diskReserveBytes']) num(config[key], key);
  for (const name of ['contextBudget', 'artifactLimits', 'retention']) { object(config[name], name); for (const [key, v] of Object.entries(config[name])) integer(v, name + '.' + key); }
  for (const name of ['capacityLimits', 'processingLimits']) if (config[name] !== undefined) {
    object(config[name], name); for (const [key, value] of Object.entries(config[name])) { integer(value, name + '.' + key); if (value === 0) fail(name + '.' + key + ' must be positive'); }
  }
  return config;
}
export function emptyPersona(now = 0) {
  return { schemaVersion: SCHEMA_VERSION, version: 0, updatedAt: now, anchor: { text: '', changedAt: now, srcRefs: [] }, axes: {}, facets: [], signatures: [], habits: [], retired: [] };
}
export function emptyRuntime(now = 0) {
  return { schemaVersion: SCHEMA_VERSION, version: 0, currentDecision: null, globalMuted: false,
    sleep: { state: 'awake', sleepDecisionId: null, wakeAt: null, wakeCondition: null, wakeRunId: null },
    schedule: { nextCheckAt: null, decisionId: null, recheckOn: [] }, activeRunId: null, ingestCursors: [], consolidationCursors: {}, memoryGaps: [], updatedAt: now };
}
