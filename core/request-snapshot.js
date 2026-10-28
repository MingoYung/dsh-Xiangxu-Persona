import { SCHEMA_VERSION, newId } from './schema.js';
import { extractSourceDependencies } from './source-dependencies.js';
import { fitDeepMemoryReferences } from './deep-memory.js';
import { selfProfileContext } from './onboarding.js';
import { contextBudgetError, sectionText, requiredSelfProfile, fitStructuredSection, recentMemorySection } from './context-continuity.js';

const description = value => typeof value === 'string' ? value : value?.desc ?? value?.text ?? '';
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

/** Loading identity is mandatory; selecting or reacting to remembered content remains autonomous. */
export async function buildContinuitySnapshot({ context = {}, material = {}, state = {}, config, now, counter }) {
  const persona = material.persona ?? {}, relation = material.impression ?? {}, budgets = config.contextBudget;
  const ownId = context.personId ?? null, relevant = entries => (entries ?? []).filter(item => item.scope !== 'person' || item.personId === ownId);
  const facets = relevant(persona.facets), signatures = relevant(persona.signatures), habits = relevant(persona.habits);
  const memories = context.memories ?? [], target = { channelId: context.channelId ?? context.environment?.channelId ?? '',
    sessionId: context.sessionId ?? context.environment?.sessionId ?? '', personId: ownId };
  const capacity = context.capacity;
  const resources = capacity && capacity.available !== false ? { available: true,
    longTermChars: { used: capacity.persistentChars ?? null, limit: capacity.longTermTargetChars ?? null },
    tempChars: { used: capacity.hotChars ?? null, limit: capacity.tempTargetChars ?? null },
    storeBytes: { used: capacity.physicalBytes ?? null, limit: capacity.storeBytes ?? null },
    pressure: capacity.pressure ?? null, unresolvedGaps: capacity.memoryGapCount ?? null }
    : { available: false, errorCode: capacity?.errorCode ?? null };
  const essential = { now, timezone: context.timezone ?? context.environment?.timezone ?? config.timezone,
    target, sleep: state.sleep?.state ?? 'awake', resources,
    memoryAvailability: context.memoryAvailability ?? material.memoryAvailability ?? { storeContent: 'not_assessed', retrieval: 'not_requested' },
    consolidation: { mode: config.consolidationMode, opportunity: state.execution?.consolidationOpportunity ?? null,
      jobs: Object.values(state.execution?.consolidationJobs ?? {}).slice(-3).map(job => ({ jobId: job.jobId, status: job.status })) } };
  const result = [], adjustments = [], extensions = {};
  const prefix = () => result.map(segment => segment.text).join('');
  const canFit = async text => await counter.count(prefix() + text) <= budgets.totalTokens;
  const add = async (name, text, { budget, truncated = false, required = false, ...rest } = {}) => {
    if (!await canFit(text)) throw contextBudgetError('The request budget cannot carry the complete mandatory personality and current background; no incomplete personality was supplied');
    const tokens = await counter.count(text);
    result.push({ name, budget: Math.max(budget ?? tokens, tokens), text, tokens, truncated, required, ...rest });
    if (required && Number.isFinite(budget) && tokens > budget) adjustments.push({ segment: name, configured: budget, applied: tokens,
      reason: name === 'environment' ? 'preserve_complete_route_and_time' : 'preserve_complete_personality_core' });
  };
  const environmentText = sectionText('environment', essential);
  if (await counter.count(environmentText) > budgets.totalTokens) throw Object.assign(new Error('The request budget cannot carry the complete current route/time facts; no incomplete target was injected'), { code: 'ESSENTIAL_CONTEXT_BUDGET' });
  await add('environment', environmentText, { budget: budgets.environmentTokens, required: true });
  let selfProfile = await requiredSelfProfile(material.selfProfile, counter);
  await add('self_profile', selfProfile.text, { budget: budgets.selfProfileTokens ?? 350, required: true });
  await add('anchor', sectionText('anchor', persona.anchor?.text ?? ''), { budget: budgets.anchorTokens, required: true });
  const axes = Object.fromEntries(Object.entries(persona.axes ?? {}).map(([name, value]) => [name, description(value)]));
  await add('persona', Object.keys(axes).length ? sectionText('persona', { axes }) : '', { budget: budgets.personaTokens, required: true });
  const relationship = ownId !== null || material.identity || relation.summary ? { personId: ownId, identity: material.identity ?? null, summary: relation.summary ?? '' } : null;
  await add('relationship', relationship ? sectionText('relationship', relationship) : '', { budget: budgets.relationTokens, required: true });
  const activePlan = state.currentDecision ? { reply: state.currentDecision.replyPlan?.action,
    target: state.currentDecision.replyPlan?.target, replyAt: state.currentDecision.replyPlan?.replyAt,
    nextCheckAt: state.schedule?.nextCheckAt, recheckOn: state.schedule?.recheckOn } : null;
  if (activePlan || state.sleep?.state === 'sleeping') await add('current_state', sectionText('current_state', {
    activePlan, sleep: state.sleep ? { state: state.sleep.state, wakeCondition: state.sleep.wakeCondition, wakeAt: state.sleep.wakeAt } : null }), { required: true });
  const recent = await recentMemorySection(material, context, { counter,
    budget: Math.min(budgets.recentMemoryTokens ?? 600, Math.max(0, budgets.totalTokens - await counter.count(prefix()))), canFit });
  await add('recent_memory', recent.text, { budget: budgets.recentMemoryTokens ?? 600, truncated: recent.truncated, required: true });

  // Biography and initial wishes may expand a complete identity, never displace
  // an anchor or necessary current background. Each visible value stays whole.
  const profileIndex = result.findIndex(segment => segment.name === 'self_profile');
  const coreProfile = result[profileIndex];
  const coreProfileBudget = await counter.count(coreProfile.text);
  let low = coreProfileBudget, high = Math.max(coreProfileBudget, budgets.selfProfileTokens ?? 350), chosen = selfProfile;
  while (low <= high) {
    const budget = Math.floor((low + high) / 2), candidate = await selfProfileContext(material.selfProfile, { counter, budget });
    const requiredShown = selfProfile.shown.every(field => candidate.shown.includes(field));
    const candidateText = result.slice(0, profileIndex).map(segment => segment.text).join('') + candidate.text + result.slice(profileIndex + 1).map(segment => segment.text).join('');
    if (requiredShown && await counter.count(candidateText) <= budgets.totalTokens) { chosen = candidate; low = budget + 1; }
    else high = budget - 1;
  }
  selfProfile = chosen;
  result[profileIndex] = { ...coreProfile, text: chosen.text, tokens: await counter.count(chosen.text), budget: Math.max(coreProfile.budget, await counter.count(chosen.text)), truncated: chosen.omitted.length > 0 };
  // Account for all unshown profile fields even when the total allowed no expansion.
  const completeProfile = material.selfProfile ?? {};
  const profileFields = ['name', 'pronouns', 'gender', 'ageDescription', 'birthday', 'selfDescription', 'background'];
  selfProfile.omitted = ['current', 'initial'].flatMap(group => profileFields.filter(field => completeProfile[group]?.[field] && !selfProfile.shown.includes(group + '.' + field)).map(field => group + '.' + field));
  result[profileIndex].truncated = selfProfile.omitted.length > 0;

  const personaDetails = await fitStructuredSection('persona_details', {
    facets: facets.map(item => ({ id: item.id, desc: description(item), epistemic: item.epistemic })),
    signatures: signatures.map(item => ({ id: item.id, if: item.if, then: item.then, epistemic: item.epistemic })) },
  { counter, budget: Math.max(0, budgets.personaTokens - (result.find(item => item.name === 'persona')?.tokens ?? 0)), canFit });
  await add('persona_details', personaDetails.text, { budget: budgets.personaTokens, truncated: personaDetails.truncated }); extensions.persona = personaDetails;
  const habitDetails = await fitStructuredSection('habits', { items: habits.map(item => ({ id: item.id, text: item.text })) }, { counter, budget: budgets.habitTokens, canFit });
  await add('habits', habitDetails.text, { budget: budgets.habitTokens, truncated: habitDetails.truncated }); extensions.habits = habitDetails;
  let deepReferences = { text: '', shownIds: [], total: (material.deepMemories ?? []).length, shown: 0, truncated: (material.deepMemories ?? []).length > 0 };
  if ((material.deepMemories ?? []).length) {
    let budget = Math.min(budgets.deepMemoryTokens ?? 600, Math.max(0, budgets.totalTokens - await counter.count(prefix())));
    deepReferences = await fitDeepMemoryReferences(material.deepMemories, { budget, counter });
    while (deepReferences.text && !await canFit(deepReferences.text)) deepReferences = await fitDeepMemoryReferences(material.deepMemories, { budget: --budget, counter });
    if (deepReferences.text) await add('deep_memory_reference', deepReferences.text, { budget, truncated: deepReferences.truncated,
      referenceOnly: true, automaticRecall: false, total: deepReferences.total, shown: deepReferences.shown });
  }
  const relationDetails = await fitStructuredSection('relationship_details', { signatures: relation.signatures, coordinates: relation.coordinates,
    events: relation.events, interpretations: material.interpretations, codes: material.codes, boundaries: facets.filter(item => item.kind === 'boundary') },
  { counter, budget: budgets.relationTokens, canFit });
  await add('relationship_details', relationDetails.text, { budget: budgets.relationTokens, truncated: relationDetails.truncated }); extensions.relationship = relationDetails;
  const recall = await fitStructuredSection('recalled_material', { items: memories }, { counter, budget: budgets.retrievalTokens, canFit });
  await add('recalled_material', recall.text, { budget: budgets.retrievalTokens, truncated: recall.truncated }); extensions.recalled = recall;
  const environmentDetails = await fitStructuredSection('environment_details', { environment: context.environment, capacity },
    { counter, budget: budgets.environmentTokens, canFit });
  await add('environment_details', environmentDetails.text, { budget: budgets.environmentTokens, truncated: environmentDetails.truncated });
  const text = prefix(), tokens = await counter.count(text);
  if (tokens > budgets.totalTokens) throw contextBudgetError('Mandatory personality context exceeded the actual counted request budget');
  const shownFacets = facets.filter(item => personaDetails.shown.includes('facets:' + item.id));
  const shownSignatures = signatures.filter(item => personaDetails.shown.includes('signatures:' + item.id));
  const shownHabits = habits.filter(item => habitDetails.shown.includes('items:' + item.id));
  const shownDeep = (material.deepMemories ?? []).filter(item => deepReferences.shownIds.includes(item.id));
  const shownMemories = recall.selected.items ?? [];
  const snapshot = { schemaVersion: SCHEMA_VERSION, requestId: context.requestId ?? newId('req'), sessionId: context.sessionId ?? context.environment?.sessionId ?? '',
    personId: ownId, conversationStyle: config.conversationStyle ?? 'short_chat', personaVersion: persona.version ?? 0, relationVersion: relation.version ?? null,
    environmentVersion: context.environment?.version ?? context.environmentVersion ?? 0,
    now, timezone: context.timezone ?? context.environment?.timezone ?? config.timezone,
    mandatoryContext: { complete: true, segments: result.filter(item => item.required).map(item => item.name),
      optional: Object.fromEntries(Object.entries(extensions).map(([name, value]) => [name, { shown: value.shown, omitted: value.omitted }])) },
    selfProfileReference: { version: material.selfProfile?.version ?? 0, shown: selfProfile.shown, omitted: selfProfile.omitted, fullProfileAvailable: Boolean(material.selfProfile) },
    recentMemoryReference: { ...recent.value, items: undefined, ids: recent.selected.map(item => item.id).filter(Boolean), fragments: recent.fragments, truncated: recent.truncated },
    deepMemoryReference: { referenceOnly: true, automaticRecall: false, total: deepReferences.total, shown: deepReferences.shown, truncated: deepReferences.truncated, ids: deepReferences.shownIds },
    injectedIds: [...new Set([...shownMemories, ...shownFacets, ...shownSignatures, ...shownHabits, ...shownDeep, ...recent.selected].map(item => item.id).filter(Boolean))],
    injectedText: text, tokens, tokenAccounting: counter.method, budgetAdjustments: adjustments, routeFacts: target, segments: result };
  delete snapshot.recentMemoryReference.items;
  const dependencies = extractSourceDependencies({ selfProfile: selfProfile.sourceDependencies, sourceDependencies: material.sourceDependencies,
    persona: { anchor: persona.anchor, axes: persona.axes, facets: shownFacets, signatures: shownSignatures, habits: shownHabits },
    relationship, details: relationDetails.selected, memories: shownMemories, recentMemories: recent.selected,
    recentAnnotationDependencies: recent.annotationProvenance, deepMemories: shownDeep, injectedIds: snapshot.injectedIds });
  snapshot.sourceDependencies = { refs: dependencies.refs, recordIds: dependencies.recordIds };
  return freeze(snapshot);
}
