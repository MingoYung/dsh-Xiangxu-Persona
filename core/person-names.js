import { isDeepStrictEqual } from 'node:util';
import { capacityError } from './capacity.js';
import { PERSON_NAME_LIMITS, sourceKey, validatePersonNameObservation, validatePersonNameUpdates, validatePersonNames } from './schema.js';

const revokedNameSource = (ref, meta) => {
  const key = sourceKey(ref);
  return meta.revokedSources.includes(key) || meta.revokedIds.includes(meta.sources[key]?.id);
};

function normalizeNameSource(ref, meta, personId, observedOn) {
  const key = sourceKey(ref), receipt = meta.sources[key];
  if (revokedNameSource(ref, meta)) throw Object.assign(new Error('Person name source was explicitly revoked'), { code: 'SOURCE_REVOKED' });
  if (!receipt || (observedOn && (receipt.personId !== personId || receipt.sourceRole !== 'user'))) {
    throw Object.assign(new Error('Person name source does not identify an accepted event for this observation'), { code: 'SOURCE_UNKNOWN' });
  }
  const { sourceSessionId, sourceEventId } = ref;
  return { sourceSessionId, sourceEventId, available: true, ...Object.fromEntries(
    ['sourceKind', 'sourceRole', 'sourceOrigin'].filter(field => receipt[field] !== undefined).map(field => [field, receipt[field]]),
  ) };
}

const nameKey = ({ kind, name, observedOn }) => JSON.stringify([kind, name.trim(),
  observedOn?.platform ?? null, observedOn?.accountId ?? null, observedOn?.senderId ?? null]);

export function applyPersonNameUpdates(current = [], updates, { meta, personId, now, observedOn }) {
  validatePersonNames(current);
  if (observedOn !== undefined) {
    validatePersonNameObservation(observedOn);
    const { platform, accountId, senderId } = observedOn;
    observedOn = { platform, accountId, senderId };
  }
  validatePersonNameUpdates(updates, { platform: observedOn !== undefined });
  const names = new Map(current.map(entry => [nameKey(entry), entry]));
  for (const update of updates) {
    const next = { kind: update.kind, name: update.name.trim(), ...(observedOn ? { observedOn } : {}) };
    const key = nameKey(next), previous = names.get(key);
    if (update.action === 'remove') { names.delete(key); continue; }
    const srcRefs = [...new Map((update.sourceRefs ?? []).map(ref =>
      [sourceKey(ref), normalizeNameSource(ref, meta, personId, observedOn)])).values()];
    // Routine messages repeating a known platform label do not rewrite its
    // observation time or accumulate a new citation on every incoming event.
    if (previous && (observedOn || isDeepStrictEqual(previous.srcRefs, srcRefs))) continue;
    names.set(key, { ...next, srcRefs, updatedAt: now });
  }
  if (names.size > PERSON_NAME_LIMITS.entries) throw capacityError('personNameEntries', names.size, PERSON_NAME_LIMITS.entries);
  return [...names.values()];
}

export function redactPersonNames(identity, meta) {
  if (identity?.names === undefined) return identity;
  validatePersonNames(identity.names);
  const names = identity.names.filter(entry => {
    if (entry.srcRefs.some(ref => revokedNameSource(ref, meta))) return false;
    return entry.kind !== 'platform_nickname' || entry.srcRefs.some(ref => {
      const receipt = meta.sources[sourceKey(ref)];
      return receipt?.personId === identity.personId && receipt.sourceRole === 'user';
    });
  });
  return names.length === identity.names.length ? identity : { ...identity, names };
}

export function redactPendingPersonNames(state, meta) {
  const pendingEffects = state.execution?.pendingEffects;
  if (!pendingEffects) return state;
  let next, currentDecision = state.currentDecision;
  for (const [id, effect] of Object.entries(pendingEffects)) {
    const plan = effect.input?.identityPlan;
    if (!plan?.nameUpdates?.some(update => update.sourceRefs?.some(ref => revokedNameSource(ref, meta)))) continue;
    // The identity write is one unit. Losing a selected name source must not
    // leave a replayable rename or association with the name updates stripped.
    const input = { ...effect.input }, decision = { ...effect.decision };
    delete input.identityPlan;
    if (plan.action !== 'names' && !effect.completed?.includes('identity')) {
      delete decision.identityPlan;
      if (currentDecision?.decisionId === id) {
        currentDecision = { ...currentDecision };
        delete currentDecision.identityPlan;
      }
    }
    next ??= { ...pendingEffects };
    next[id] = { ...effect, input, decision };
  }
  return next ? { ...state, currentDecision, execution: { ...state.execution, pendingEffects: next } } : state;
}
