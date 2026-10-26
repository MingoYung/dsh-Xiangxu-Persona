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

/** Host transport/platform IDs are not memory IDs. Only the scan copy changes. */
export function extractProcessDependencies(record) {
  const content = record.content?.mode === 'cached' ? record.content.text : null;
  if (record.kind !== 'tool_result' || record.sourceKind !== 'tool/result' || typeof content !== 'string') return extractSourceDependencies(content);
  if (content.length > 2000000) return { refs: [], recordIds: [], complete: false };
  let envelope; try { envelope = JSON.parse(content); } catch { return extractSourceDependencies(content); }
  if (envelope?.message?.role !== 'tool' || envelope.message.source?.kind !== 'tool') return extractSourceDependencies(content);
  let complete = true, nodes = 0;
  const explicit = new Set(), active = new WeakSet();
  const explicitArrays = new Set([...idArrays, 'sourceRecordIds']);
  const scanCopy = (value, depth = 0, field = '') => {
    if (++nodes > 100000 || depth > 32) { complete = false; return null; }
    if (typeof value === 'string') {
      if (field === 'recordId' && value) explicit.add(value);
      if (explicit.size > 16384) { complete = false; return null; }
      const text = value.trim();
      if (/^[{[\"]/.test(text)) {
        if (text.length > 2000000) { complete = false; return null; }
        let parsed; try { parsed = JSON.parse(text); } catch { return value; }
        if (parsed !== value) return JSON.stringify(scanCopy(parsed, depth + 1));
      }
      return value;
    }
    if (!value || typeof value !== 'object') return value;
    if (active.has(value)) { complete = false; return null; }
    active.add(value);
    let next;
    if (Array.isArray(value)) {
      if (explicitArrays.has(field)) for (const id of value) {
        if (typeof id === 'string' && id) explicit.add(id);
        if (explicit.size > 16384) { complete = false; break; }
      }
      next = [];
      for (const item of value) { if (nodes >= 100000) { complete = false; break; } next.push(scanCopy(item, depth + 1)); }
    } else {
      next = Object.create(null);
      for (const [name, item] of Object.entries(value)) {
        if (nodes >= 100000) { complete = false; break; }
        if (name === 'id' && value.schemaVersion !== 'persona-memory/3') continue;
        next[name] = scanCopy(item, depth + 1, name);
      }
    }
    active.delete(value); return next;
  };
  const dependencies = extractSourceDependencies(scanCopy(envelope));
  const recordIds = [...new Set([...dependencies.recordIds, ...explicit])];
  return { refs: dependencies.refs, recordIds, complete: complete && dependencies.complete && recordIds.length <= 16384 };
}

export function hotSourceDependencies(record) {
  const scanned = extractProcessDependencies(record);
  const annotated = extractSourceDependencies({ navigationSummary: record.navigationSummary, refs: record.dependencyRefs, dependencyRecordIds: record.dependencyRecordIds });
  const refs = new Map([...scanned.refs, ...annotated.refs].map(ref => [key(ref), ref]));
  const recordIds = [...new Set([...scanned.recordIds, ...annotated.recordIds])];
  return { refs: [...refs.values()], recordIds, complete: scanned.complete && annotated.complete && record.dependencyScanComplete !== false && refs.size <= 8192 && recordIds.length <= 16384,
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
