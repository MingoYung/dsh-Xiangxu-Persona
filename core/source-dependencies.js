// Structural provenance only. Ordinary prose is never searched for topics or words.
const key = ref => JSON.stringify([ref.sourceSessionId, ref.sourceEventId]);
const processKinds = new Set(['reasoning', 'tool_call', 'tool_result', 'runtime_context', 'agent_instructions', 'plugin_state', 'agent_message']);
const idFields = new Set(['id', 'recordId']);
const idArrays = new Set(['ids', 'recordIds', 'targetIds', 'affectedIds', 'injectedIds', 'dependencyRecordIds', 'expandIds', 'supersedesIds', 'replacementIds']);

export function extractSourceDependencies(value) {
  const refs = new Map(), recordIds = new Set(), seen = new WeakSet();
  let complete = true, nodes = 0;
  const visit = (v, depth = 0, field = '') => {
    if (++nodes > 100000 || depth > 32) { complete = false; return; }
    if (typeof v === 'string') {
      if (idFields.has(field) && v) recordIds.add(v);
      const text = v.trim();
      if (/^[{[\"]/.test(text)) {
        if (text.length > 2000000) { complete = false; return; }
        try { const parsed = JSON.parse(text); if (parsed !== v) visit(parsed, depth + 1); }
        catch { /* Free text or incomplete legacy JSON has no fabricated references. */ }
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) return; seen.add(v);
    if (v.format === 'json_text_fragment' && (v.fragment?.complete === false || (v.fragment?.from ?? 0) > 0 ||
      (Number.isFinite(v.fragment?.to) && Number.isFinite(v.fragment?.total) && v.fragment.to < v.fragment.total))) complete = false;
    if (typeof v.sourceSessionId === 'string' && v.sourceSessionId && typeof v.sourceEventId === 'string' && v.sourceEventId) {
      const ref = { sourceSessionId: v.sourceSessionId, sourceEventId: v.sourceEventId }; refs.set(key(ref), ref);
    }
    if (Array.isArray(v)) {
      if (idArrays.has(field)) for (const id of v) if (typeof id === 'string' && id) recordIds.add(id);
      for (const child of v) visit(child, depth + 1);
    } else for (const [name, child] of Object.entries(v)) visit(child, depth + 1, name);
    if (refs.size > 8192 || recordIds.size > 16384) complete = false;
  };
  visit(value);
  return { refs: [...refs.values()], recordIds: [...recordIds], complete };
}

export function hotSourceDependencies(record) {
  const dependencies = extractSourceDependencies({ content: record.content?.mode === 'cached' ? record.content.text : null,
    navigationSummary: record.navigationSummary, refs: record.dependencyRefs, dependencyRecordIds: record.dependencyRecordIds });
  return { ...dependencies, complete: dependencies.complete && record.dependencyScanComplete !== false,
    annotated: Array.isArray(record.dependencyRefs) && Array.isArray(record.dependencyRecordIds) && record.dependencyScanComplete !== false };
}

export function dependenciesRevoked(dependencies, { revokedSources = [], revokedIds = [] } = {}) {
  const sources = new Set(revokedSources), ids = new Set(revokedIds);
  return dependencies.refs.some(ref => sources.has(key(ref))) || dependencies.recordIds.some(id => ids.has(id));
}

export function temporaryCleanupPlan(records, { revokedSources = [], revokedIds = [], invalidatedHotContextGroups = [] } = {}) {
  const sources = new Set(revokedSources), ids = new Set(revokedIds), affectedSessions = new Set(), groups = new Map();
  for (const root of sources) { try { const [session] = JSON.parse(root); if (typeof session === 'string') affectedSessions.add(session); } catch {} }
  const groupKey = (session, group) => JSON.stringify([session, group]);
  for (const group of invalidatedHotContextGroups) groups.set(groupKey(group.sourceSessionId, group.contextGroupId), group);
  const direct = new Set();
  for (const record of records) {
    const session = record.sourceRef?.sourceSessionId;
    if (ids.has(record.id) || (record.sourceRef && sources.has(key(record.sourceRef))) || dependenciesRevoked(hotSourceDependencies(record), { revokedSources, revokedIds })) {
      direct.add(record.id); if (session) affectedSessions.add(session);
      if (session && record.contextGroupId != null) groups.set(groupKey(session, record.contextGroupId), { sourceSessionId: session, contextGroupId: record.contextGroupId });
    }
  }
  const removedIds = new Set(direct);
  for (const record of records) {
    const session = record.sourceRef?.sourceSessionId, info = hotSourceDependencies(record);
    const grouped = processKinds.has(record.kind) && record.contextGroupId != null && groups.has(groupKey(session, record.contextGroupId));
    const legacy = !info.annotated && affectedSessions.has(session) && (processKinds.has(record.kind) || record.content?.mode === 'host_trace');
    if (grouped || legacy || (!info.complete && affectedSessions.has(session))) removedIds.add(record.id);
  }
  return { removedIds: [...removedIds], affectedSessions: [...affectedSessions], contextGroups: [...groups.values()] };
}

export function runReferencesRevocation(run, revocations, removedHotIds = []) {
  const removed = new Set(removedHotIds);
  if ((run.input?.hot ?? []).some(record => removed.has(record.id))) return true;
  return dependenciesRevoked(extractSourceDependencies({ input: run.input, candidatePatch: run.candidatePatch, reviewState: run.reviewState, validationError: run.validationError }), revocations);
}
