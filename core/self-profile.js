import { isDeepStrictEqual } from 'node:util';
import { assertFiniteJson, capacityError, serializedBytes } from './capacity.js';
import { SchemaError, countChars, sourceKey, validateSrcRef } from './schema.js';
import { dependenciesRevoked } from './source-dependencies.js';

export const SELF_PROFILE_PATH = 'self/profile.json';
export const SELF_PROFILE_SCHEMA_VERSION = 'xiangxu-self/1';
export const SELF_PROFILE_FIELDS = Object.freeze(['name', 'pronouns', 'gender', 'ageDescription', 'birthday', 'background', 'selfDescription']);
// Provenance follows the same absolute scan ceilings as process dependencies.
// These are input safety bounds; the complete 64 KiB profile bound still
// applies to complete current sources; only bounded old versions may rotate.
export const SELF_PROFILE_LIMITS = Object.freeze({ profileBytes: 65536, sectionChars: 2400, history: 8, sourceRefs: 8192, sourceRecordIds: 16384 });
const modes = ['together', 'autonomous', 'unset'];
const actors = ['user', 'persona'];
const clone = value => structuredClone(value);
const fields = () => Object.fromEntries(SELF_PROFILE_FIELDS.map(field => [field, '']));
const fail = message => { throw new SchemaError(message); };
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + ' must be an object');
};
const keys = (value, allowed, name) => { object(value, name); for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(name + ' has unknown field: ' + key); };
const time = (value, name, nullable = false) => { if (nullable && value === null) return; if (!Number.isSafeInteger(value) || value < 0) fail(name + ' must be epoch milliseconds'); };
function textFields(value, name, partial = false) {
  keys(value, SELF_PROFILE_FIELDS, name);
  if (!partial && SELF_PROFILE_FIELDS.some(field => !Object.hasOwn(value, field))) fail(name + ' is missing a field');
  let chars = 0;
  for (const text of Object.values(value)) { if (typeof text !== 'string') fail(name + ' values must be strings'); chars += countChars(text); }
  if (chars > SELF_PROFILE_LIMITS.sectionChars) throw capacityError('selfProfileSectionChars', chars, SELF_PROFILE_LIMITS.sectionChars, name);
}
export function selfProfileLinks({ sourceRefs = [], sourceRecordIds = [] } = {}) {
  if (!Array.isArray(sourceRefs) || !Array.isArray(sourceRecordIds)) fail('Self profile sources must be arrays');
  for (const ref of sourceRefs) {
    validateSrcRef(ref); assertFiniteJson(ref);
    if (countChars(ref.sourceSessionId) > 1024 || countChars(ref.sourceEventId) > 1024) fail('Self profile source identity is too long');
  }
  for (const id of sourceRecordIds) if (typeof id !== 'string' || !id || countChars(id) > 256) fail('Self profile record identity is invalid');
  const refs = [...new Map(sourceRefs.map(ref => [sourceKey(ref), clone(ref)])).values()], ids = [...new Set(sourceRecordIds)];
  if (refs.length > SELF_PROFILE_LIMITS.sourceRefs) throw capacityError('selfProfileSourceRefs', refs.length, SELF_PROFILE_LIMITS.sourceRefs);
  if (ids.length > SELF_PROFILE_LIMITS.sourceRecordIds) throw capacityError('selfProfileSourceRecordIds', ids.length, SELF_PROFILE_LIMITS.sourceRecordIds);
  return { sourceRefs: refs, sourceRecordIds: ids };
}
function provenance(value, name) {
  keys(value, ['initial', 'current'], name);
  for (const section of ['initial', 'current']) {
    keys(value[section], SELF_PROFILE_FIELDS, name + '.' + section);
    for (const item of Object.values(value[section])) {
      keys(item, ['actor', 'at', 'sourceRefs', 'sourceRecordIds'], name + ' source');
      if (!actors.includes(item.actor)) fail('Self profile source actor is invalid');
      time(item.at, 'source.at'); selfProfileLinks(item);
    }
  }
}
/** No date is invented when an older instance has never created this optional file. */
export function emptySelfProfile() {
  return { schemaVersion: SELF_PROFILE_SCHEMA_VERSION, version: 0, createdAt: null, updatedAt: null,
    mode: 'unset', onboardingAcknowledged: false, initial: fields(), current: fields(), provenance: { initial: {}, current: {} }, history: [] };
}
export function validateSelfProfile(input) {
  assertFiniteJson(input);
  keys(input, ['schemaVersion', 'version', 'createdAt', 'updatedAt', 'mode', 'onboardingAcknowledged', 'initial', 'current', 'provenance', 'history'], 'selfProfile');
  const value = clone(input);
  if (value.onboardingAcknowledged === undefined) value.onboardingAcknowledged = false;
  if (value.schemaVersion !== SELF_PROFILE_SCHEMA_VERSION) fail('Unsupported self profile schema');
  if (!Number.isSafeInteger(value.version) || value.version < 0) fail('Self profile version must be a nonnegative integer');
  time(value.createdAt, 'createdAt', true); time(value.updatedAt, 'updatedAt', true);
  if (!modes.includes(value.mode) || typeof value.onboardingAcknowledged !== 'boolean') fail('Self profile setup state is invalid');
  textFields(value.initial, 'initial'); textFields(value.current, 'current'); provenance(value.provenance, 'provenance');
  if (!Array.isArray(value.history) || value.history.length > SELF_PROFILE_LIMITS.history) fail('Self profile history exceeds its bound');
  for (const item of value.history) {
    keys(item, ['version', 'at', 'actor', 'mode', 'onboardingAcknowledged', 'initial', 'current', 'provenance'], 'history');
    if (item.onboardingAcknowledged === undefined) item.onboardingAcknowledged = false;
    if (!Number.isSafeInteger(item.version) || item.version < 0 || item.version >= value.version || !actors.includes(item.actor) || !modes.includes(item.mode) || typeof item.onboardingAcknowledged !== 'boolean') fail('Self profile history metadata is invalid');
    time(item.at, 'history.at'); textFields(item.initial, 'history.initial'); textFields(item.current, 'history.current'); provenance(item.provenance, 'history.provenance');
  }
  if (serializedBytes(value) > SELF_PROFILE_LIMITS.profileBytes) throw capacityError('selfProfileBytes', serializedBytes(value), SELF_PROFILE_LIMITS.profileBytes, SELF_PROFILE_PATH);
  return value;
}
export function validateSelfProfilePatch(patch, actor) {
  assertFiniteJson(patch);
  keys(patch, ['mode', 'onboardingAcknowledged', 'initial', 'current'], 'selfProfilePatch');
  if (!actors.includes(actor)) fail('Self profile update actor is invalid');
  if (actor === 'persona' && Object.keys(patch).some(key => key !== 'current')) throw Object.assign(new Error('User initialization preferences and onboarding state are separate from the current self description'), { code: 'SELF_PROFILE_SCOPE' });
  if (Object.hasOwn(patch, 'mode') && !modes.includes(patch.mode)) fail('Unknown self profile setup mode');
  if (Object.hasOwn(patch, 'onboardingAcknowledged') && typeof patch.onboardingAcknowledged !== 'boolean') fail('onboardingAcknowledged must be boolean');
  for (const section of ['initial', 'current']) if (Object.hasOwn(patch, section)) textFields(patch[section], section, true);
  return patch;
}
export function applySelfProfilePatch(prior, patch, { actor, now, sourceRefs, sourceRecordIds } = {}) {
  const previous = validateSelfProfile(prior); validateSelfProfilePatch(patch, actor); time(now, 'now');
  const next = clone(previous), links = selfProfileLinks({ sourceRefs, sourceRecordIds });
  const sourcesSpecified = sourceRefs !== undefined || sourceRecordIds !== undefined;
  if (Object.hasOwn(patch, 'mode')) next.mode = patch.mode;
  if (Object.hasOwn(patch, 'onboardingAcknowledged')) next.onboardingAcknowledged = patch.onboardingAcknowledged;
  for (const section of ['initial', 'current']) for (const [field, text] of Object.entries(patch[section] ?? {})) {
    const priorSource = next.provenance[section][field];
    const sameLinks = priorSource && isDeepStrictEqual({ sourceRefs: priorSource.sourceRefs, sourceRecordIds: priorSource.sourceRecordIds }, links);
    if (next[section][field] === text && (!priorSource && text === '' || priorSource?.actor === actor && (!sourcesSpecified || sameLinks))) continue;
    next[section][field] = text;
    next.provenance[section][field] = { actor, at: now, ...clone(links) };
  }
  if (isDeepStrictEqual(next, previous)) return { profile: previous, changed: false };
  next.createdAt ??= now; next.updatedAt = now; next.version = previous.version + 1;
  if (previous.updatedAt !== null) next.history.push({ version: previous.version, at: previous.updatedAt, actor,
    mode: previous.mode, onboardingAcknowledged: previous.onboardingAcknowledged, initial: previous.initial, current: previous.current, provenance: previous.provenance });
  next.history = next.history.slice(-SELF_PROFILE_LIMITS.history);
  // Current values are never shortened to fit; only the explicitly bounded old versions rotate.
  while (next.history.length && serializedBytes(next) > SELF_PROFILE_LIMITS.profileBytes) next.history.shift();
  return { profile: validateSelfProfile(next), changed: true };
}
export function selfProfileDependencies(profile, { includeHistory = false } = {}) {
  const refs = new Map(), ids = new Set();
  for (const state of [profile, ...(includeHistory ? profile.history : [])]) for (const section of ['initial', 'current']) for (const item of Object.values(state.provenance[section])) {
    item.sourceRefs.forEach(ref => refs.set(sourceKey(ref), clone(ref))); item.sourceRecordIds.forEach(id => ids.add(id));
  }
  return { refs: [...refs.values()], recordIds: [...ids] };
}
/** Structural source withdrawal, never an opinion about the self description itself. */
export function redactSelfProfile(profile, revocations) {
  const next = validateSelfProfile(profile);
  let changed = false;
  for (const state of [next, ...next.history]) for (const section of ['initial', 'current']) for (const [field, item] of Object.entries(state.provenance[section])) {
    if (!dependenciesRevoked({ refs: item.sourceRefs, recordIds: item.sourceRecordIds }, revocations)) continue;
    state[section][field] = ''; delete state.provenance[section][field]; changed = true;
  }
  return { profile: next, changed };
}
