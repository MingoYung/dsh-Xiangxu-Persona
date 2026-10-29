import { createHash } from 'node:crypto';

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('base64url');
const withoutCursor = args => Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => key !== 'cursor'));
const copy = value => value === undefined ? undefined : structuredClone(value);

export class ToolCursorError extends Error {
  constructor(message, code = 'INVALID_TOOL_CURSOR') { super(message); this.name = 'ToolCursorError'; this.code = code; }
}

function cursorFor(tool, query, shape, index, offset = 0) {
  return Buffer.from(JSON.stringify({ v: 1, t: tool, q: query, s: shape, i: index, o: offset })).toString('base64url');
}
function readCursor(value, { tool, query, shape, length }) {
  if (value == null) return { index: 0, offset: 0 };
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ToolCursorError('Malformed tool cursor');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new ToolCursorError('Malformed tool cursor'); }
  if (cursor.v !== 1 || cursor.t !== tool || cursor.q !== query) throw new ToolCursorError('Cursor belongs to another tool, query, target, scope or selection');
  if (cursor.s !== shape) throw new ToolCursorError('The underlying result changed; restart this query to obtain a consistent page', 'TOOL_CURSOR_STALE');
  if (!Number.isSafeInteger(cursor.i) || cursor.i < 0 || cursor.i > length || !Number.isSafeInteger(cursor.o) || cursor.o < 0) throw new ToolCursorError('Invalid cursor position');
  return { index: cursor.i, offset: cursor.o };
}

function counterPort(counter) {
  if (typeof counter === 'function') return { method: counter.method ?? 'port', count: counter };
  if (counter?.count) return { method: counter.method ?? 'port', count: counter.count.bind(counter) };
  return { method: 'utf8_bytes_estimate', count: text => Buffer.byteLength(text, 'utf8') };
}
function sourceRefs(item) {
  const all = item.srcRefs?.length ? item.srcRefs : item.sourceRef ? [item.sourceRef]
    : item.sourceSessionId && item.sourceEventId ? [{ sourceSessionId: item.sourceSessionId, sourceEventId: item.sourceEventId, available: true }] : [];
  return { count: all.length, first: all.slice(0, 1).map(ref => ({ sourceSessionId: ref.sourceSessionId, sourceEventId: ref.sourceEventId,
    ...(ref.sourceKind != null ? { sourceKind: ref.sourceKind } : {}),
    ...(ref.sourceRole != null ? { sourceRole: ref.sourceRole } : {}),
    ...(ref.sourceOrigin != null ? { sourceOrigin: ref.sourceOrigin } : {}),
    ...(ref.blockIndex != null ? { blockIndex: ref.blockIndex } : {}),
    available: ref.available !== false })) };
}
function memoryHeader(item) {
  const refs = sourceRefs(item);
  return { schemaVersion: item.schemaVersion ?? 'persona-memory/3', id: item.id ?? null, ...(item.recordKey ? { recordKey: item.recordKey } : {}), personId: item.personId ?? null,
    ...(item.recordType ? { recordType: item.recordType } : {}), ...(item.kind ? { kind: item.kind } : {}),
    ...(item.scope != null ? { scope: item.scope } : {}), ...(item.role != null ? { role: item.role } : {}),
    ...(item.origin != null ? { origin: item.origin } : {}), ...(item.sourceAt != null ? { sourceAt: item.sourceAt } : {}),
    ...(item.proactiveId != null ? { proactiveId: item.proactiveId } : {}),
    ...(item.epistemic ? { epistemic: item.epistemic } : {}),
    ...(item.retrieval ? { retrieval: { channels: item.retrieval.channels, temporal: item.retrieval.temporal, lexicalScore: item.retrieval.lexicalScore, semanticScore: item.retrieval.semanticScore, rankScore: item.retrieval.rankScore, matchedTermCount: item.retrieval.matchedTerms?.length??0, associationPathCount: item.retrieval.associationPaths?.length??0, explanationDetailsOmitted: true } } : {}), ...(item.label ? { label: item.label } : {}),
    ...(item.policy ? { policy: item.policy, topic: item.topic } : {}),
    srcRefs: refs.first, sourceRefCount: refs.count,
    ...(refs.count > refs.first.length ? { additionalSourceRefsOmitted: refs.count - refs.first.length } : {}) };
}
function memoryBody(item) {
  if (typeof item.text === 'string') return { text: item.text };
  if (typeof item.meaning === 'string') return { text: item.meaning };
  if (typeof item.desc === 'string') return { text: item.desc };
  if (typeof item.if === 'string' || typeof item.then === 'string') return { text: JSON.stringify({ if: item.if, then: item.then }), bodyFormat: 'signature_json' };
  return { text: JSON.stringify(item), bodyFormat: 'record_json' };
}

function summarizeDecision(result) {
  const decision = result?.decision ?? result?.state?.currentDecision ?? result?.currentDecision;
  const reply = decision?.replyPlan;
  const identity = result?.effects?.identity;
  const consolidation = result?.effects?.consolidation;
  return {
    status: result?.status ?? (result?.duplicate ? 'already_applied' : 'applied'),
    ...(consolidation ? { consolidation: { status: consolidation.status, jobId: consolidation.jobId,
      targetPersonIds: consolidation.targetPersonIds } } : {}),
    ...(result?.identityAssociation ? { identityAssociation: copy(result.identityAssociation) } : {}),
    ...(decision ? { decisionId: decision.decisionId, decidedAt: decision.decidedAt,
      effective: { identityPlan: decision.identityPlan ? { action: decision.identityPlan.action, personId: decision.identityPlan.personId,
        displayName: decision.identityPlan.displayName } : undefined,
      attention: decision.attention, replyPlan: reply ? { action: reply.action, target: reply.target, replyAt: reply.replyAt,
        recheckOn: reply.recheckOn, pendingEventIds: (reply.pendingEventIds ?? []).slice(0, 8), pendingEventCount: reply.pendingEventIds?.length ?? 0 } : undefined,
      nextCheckAt: decision.nextCheckAt, sleepPlan: decision.sleepPlan, retrievePlan: decision.retrievePlan,
      consolidationPlan: decision.consolidationPlan } } : {}),
    ...(identity ? { identity: { personId: identity.personId, displayName: identity.displayName } } : {}),
    ...(result?.state ? { runtime: { sleep: result.state.sleep, globalMuted: result.state.globalMuted, version: result.state.version } } : {}),
    ...(result?.code ? { code: result.code } : {}), ...(result?.message ? { message: result.message } : {}),
    detailRef: { tool: 'persona_introspect', section: 'state' },
  };
}

/**
 * Bound the complete JSON tool return, including metadata/cursor, using the
 * caller's local counter. This is output sizing, never a personality policy.
 * Cursors bind tool+full arguments (apart from cursor)+result snapshot. A changed
 * result returns TOOL_CURSOR_STALE rather than joining mismatched fragments.
 */
export async function boundToolOutput(toolName, result, args = {}, { counter, budget = 1500 } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError('Tool output budget must be a positive integer');
  const port = counterPort(counter), query = hash(withoutCursor(args));
  const count = async value => {
    const raw = await port.count(JSON.stringify(value));
    const n = typeof raw === 'number' ? raw : raw?.tokens;
    if (!Number.isFinite(n) || n < 0) throw new TypeError('Tool token counter returned an invalid count');
    return Math.ceil(n);
  };
  const fits = async value => (await count(value)) <= budget;
  const accounting = { tokenAccounting: port.method };
  const budgetError = () => Object.assign(new Error('The selected tool output budget cannot carry one complete metadata/reference item; increase the resource budget'), { code: 'TOOL_OUTPUT_BUDGET' });

  if (toolName === 'memory_search' && Array.isArray(result?.items)) {
    const items = result.items;
    const material = items.map(item => { const { text, bodyFormat } = memoryBody(item); return { header: { ...memoryHeader(item), ...(bodyFormat ? { bodyFormat } : {}) }, text }; });
    const shape = hash(material), at = readCursor(args.cursor, { tool: toolName, query, shape, length: items.length });
    if (at.index === items.length && at.offset) throw new ToolCursorError('Cursor offset is past the result');
    const out = [], base = { totalMatched: items.length, ...accounting,
      ...(result.diagnostics ? { retrieval: { method: result.diagnostics.method, referenceOnly: true, automaticRecall: false, semantic: { enabled: result.diagnostics.semantic?.enabled, configured: result.diagnostics.semantic?.configured, indexed: result.diagnostics.semantic?.indexed, eligible: result.diagnostics.semantic?.eligible, coverageComplete: result.diagnostics.semantic?.coverageComplete, reason: result.diagnostics.semantic?.reason, degraded: result.diagnostics.semantic?.degraded } } } : {}),
      ...(result.needsTarget ? { needsTarget: true } : {}) };
    const page = (rows, i, o = 0) => ({ ...base, items: rows,
      nextCursor: i < material.length ? cursorFor(toolName, query, shape, i, o) : null });
    let index = at.index, offset = at.offset;
    while (index < material.length) {
      const entry = material[index], points = Array.from(entry.text);
      if (offset > points.length) throw new ToolCursorError('Cursor offset is past the source text');
      const row = { ...entry.header, text: points.slice(offset).join(''), fragment: { from: offset, to: points.length, total: points.length, complete: true } };
      if (await fits(page([...out, row], index + 1))) { out.push(row); index++; offset = 0; continue; }
      if (out.length) break;
      let low = offset + 1, high = points.length, best = null;
      while (low <= high) {
        const to = Math.floor((low + high) / 2);
        const candidate = { ...entry.header, text: points.slice(offset, to).join(''), fragment: { from: offset, to, total: points.length, complete: to === points.length } };
        const response = page([candidate], to === points.length ? index + 1 : index, to === points.length ? 0 : to);
        if (await fits(response)) { best = { row: candidate, to }; low = to + 1; } else high = to - 1;
      }
      if (!best) throw budgetError();
      out.push(best.row); offset = best.to;
      if (offset === points.length) { index++; offset = 0; }
      break;
    }
    const response = page(out, index, offset);
    if (!(await fits(response))) throw budgetError();
    return response;
  }

  if (toolName === 'memory_forget' && Array.isArray(result?.affectedIds)) {
    const ids = result.affectedIds, shape = hash({ ids, revocation: result.revocation?.id ?? null });
    const at = readCursor(args.cursor, { tool: toolName, query, shape, length: ids.length });
    if (at.offset) throw new ToolCursorError('Identifier cursors do not accept text offsets');
    const base = { affectedCount: ids.length, revocationId: result.revocation?.id ?? null, action: result.revocation?.action ?? 'forget', ...accounting };
    const page = (selected, next) => ({ ...base, affectedIds: selected, nextCursor: next < ids.length ? cursorFor(toolName, query, shape, next) : null });
    const selected = []; let i = at.index;
    for (; i < ids.length; i++) { if (!(await fits(page([...selected, ids[i]], i + 1)))) break; selected.push(ids[i]); }
    if (i === at.index && i < ids.length) throw budgetError();
    const response = page(selected, i); if (!(await fits(response))) throw budgetError(); return response;
  }

  const compact = toolName === 'persona_decide' ? summarizeDecision(result) : copy(result);
  const direct = compact && typeof compact === 'object' && !Array.isArray(compact) ? { ...compact, ...accounting } : { value: compact ?? null, ...accounting };
  if (!args.cursor && await fits(direct)) return direct;
  const serialized = JSON.stringify(compact ?? null), shape = hash(serialized), points = Array.from(serialized);
  const at = readCursor(args.cursor, { tool: toolName, query, shape, length: 1 });
  if (at.index > 0 || at.offset > points.length) throw new ToolCursorError('Cursor offset is past this JSON result');
  const reference = { tool: toolName === 'persona_decide' ? 'persona_introspect' : toolName,
    ...(args.targetPersonId ? { targetPersonId: args.targetPersonId } : {}), section: args.section ?? (toolName === 'persona_decide' ? 'state' : 'all') };
  const page = to => ({ status: 'bounded_preview', detailRef: reference, ...accounting,
    preview: { format: 'json_text_fragment', text: points.slice(at.offset, to).join(''),
      fragment: { from: at.offset, to, total: points.length, complete: to === points.length } },
    nextCursor: to < points.length ? cursorFor(toolName, query, shape, 0, to) : null });
  let low = at.offset + 1, high = points.length, best = null;
  while (low <= high) {
    const to = Math.floor((low + high) / 2), candidate = page(to);
    if (await fits(candidate)) { best = candidate; low = to + 1; } else high = to - 1;
  }
  if (!best) throw budgetError(); return best;
}
