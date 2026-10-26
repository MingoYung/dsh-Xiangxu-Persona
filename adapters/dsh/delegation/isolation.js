/** Trusted host/task provenance projection. No decisions about personality or memory value. */
const markedMetadata = new WeakSet();
const TASK_ID = /^task-[a-f0-9]{32}$/;
const DOCUMENT_ID = /^doc-[a-f0-9]{32}$/;
const SAFE_KEY = /^[^\u0000-\u001f\u007f]{1,512}$/;
const ACTIONS = new Set(['spawn','create','inspect','list','status','read','materials','artifact','followup','cancel','retain','archive_file','configure']);
const STATUSES = new Set(['queued','prepared','starting','running','completed','failed','cancelled','unknown','revoked','paused','archived','available','unavailable','unsupported','not_found','memory_error','bounded_preview','closed','started','submitted','ready','pending']);
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => typeof value === 'string' && SAFE_KEY.test(value) ? value : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const parse = value => {
  if (object(value)) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2097152) return null;
  try { const parsed = JSON.parse(value); return object(parsed) ? parsed : null; } catch { return null; }
};
const mark = value => { markedMetadata.add(value); return value; };
export const isDelegationMetadata = value => object(value) && markedMetadata.has(value);

function identifiers(value, out) {
  if (TASK_ID.test(value?.taskId ?? '')) out.taskId = value.taskId;
  if (DOCUMENT_ID.test(value?.documentId ?? '')) out.documentId = value.documentId;
}
function selection(argumentsValue) {
  const value = parse(argumentsValue), out = {};
  out.action = ACTIONS.has(value?.action) ? value.action : 'unrecognized';
  identifiers(value, out);
  for (const field of ['offset','limit','maxChars','maxBytes','documentOffset','documentLimit']) if (nonnegative(value?.[field])) out[field] = value[field];
  if (own(value, 'cursor') || own(value, 'pageCursor')) out.cursorSupplied = Boolean(value.cursor ?? value.pageCursor);
  return out;
}
function resultNavigation(value) {
  const result = parse(value), out = { bodyCopiedToMemory: false };
  if (!result) return { ...out, structuredResultAvailable: false };
  identifiers(result, out);
  if (STATUSES.has(result.status)) out.status = result.status;
  if (typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(result.code)) out.code = result.code;
  for (const field of ['offset','nextOffset','totalChars','totalBytes','bytes','chars','createdAt','updatedAt','count','total','documentCount','nextDocumentOffset','usedBytes']) if (nonnegative(result[field])) out[field] = result[field];
  for (const field of ['complete','duplicate','cancelled','truncated','retained','documentsComplete']) if (typeof result[field] === 'boolean') out[field] = result[field];
  if (own(result, 'nextCursor') || own(result, 'pageCursor') || own(result, 'hasMore')) out.hasMore = Boolean(result.nextCursor ?? result.pageCursor ?? result.hasMore);
  if (typeof result.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(result.errorCode)) out.errorCode = result.errorCode;
  if (object(result.capture)) {
    out.capture = {};
    if (Number.isSafeInteger(result.capture.afterSeq) && result.capture.afterSeq >= -1) out.capture.afterSeq = result.capture.afterSeq;
    if (typeof result.capture.complete === 'boolean') out.capture.complete = result.capture.complete;
    if (typeof result.capture.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(result.capture.errorCode)) out.capture.errorCode = result.capture.errorCode;
    if (DOCUMENT_ID.test(result.capture.promptDocumentId ?? '')) out.capture.promptDocumentId = result.capture.promptDocumentId;
  }
  if (Array.isArray(result.items)) {
    out.itemCount = result.items.length;
    out.items = result.items.slice(0, 20).map(value => { const item = {}; identifiers(value, item); if (STATUSES.has(value?.status)) item.status = value.status; return item; });
    if (result.items.length > out.items.length) out.itemsComplete = false;
  }
  if (Array.isArray(result.documents)) {
    if (!nonnegative(out.documentCount)) out.documentCount = result.documents.length;
    out.listedDocuments = Math.min(result.documents.length, 20);
    out.documents = result.documents.slice(0, 20).map(value => { const item = {}; identifiers(value, item); for (const field of ['bytes','chars']) if (nonnegative(value?.[field])) item[field] = value[field]; return item; });
    if (result.documents.length > out.documents.length) out.documentsComplete = false;
  }
  if (object(result.preview?.fragment)) out.previewFragment = Object.fromEntries(Object.entries(result.preview.fragment).filter(([field, value]) => ['from','to','total'].includes(field) && nonnegative(value)));
  return out;
}
function resultBody(event) {
  const texts = event.data?.message?.content?.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) ?? [];
  const size = texts.reduce((total, text) => total + Buffer.byteLength(text), 0);
  return size > 2097152 ? null : texts.join('\n');
}
function rawResultCallId(event) { return event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? event.data?.callId; }
function resultCallId(event) { return key(rawResultCallId(event)); }
function taskResultEvent(event, navigation) {
  const previous = event.data ?? {}, originalMessage = previous.message ?? {};
  const message = { ...(key(originalMessage.id) ? { id: originalMessage.id } : {}), role: 'tool',
    ...(resultCallId(event) ? { toolCallId: resultCallId(event) } : {}),
    content: [mark({ type: 'text', text: JSON.stringify(navigation) })] };
  const data = { ...(Number.isSafeInteger(previous.turn) ? { turn: previous.turn } : {}), ...(Number.isSafeInteger(previous.step) ? { step: previous.step } : {}), message: mark(message) };
  return mark({ ...event, data: mark(data) });
}

/** lookupWorker and lookupCall are trusted host ports, never model/message fields. */
export function createDelegationIsolation({ lookupWorker = () => null, lookupCall, toolName = 'persona_task', maxCalls = 4096 } = {}) {
  if (typeof lookupWorker !== 'function' || lookupCall !== undefined && typeof lookupCall !== 'function' || typeof toolName !== 'string' || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 16384) throw new TypeError('Invalid delegation isolation ports');
  const calls = new Map(); let closed = false;
  const check = () => { if (closed) throw Object.assign(new Error('Delegation provenance projection is closed'), { code: 'DELEGATION_ISOLATION_CLOSED' }); };
  const sessionIdOf = session => typeof session === 'string' ? session : session?.id;
  function isWorkerSession(session) {
    check(); const sessionId = sessionIdOf(session), worker = lookupWorker(sessionId);
    return Boolean(worker && worker.sessionId === sessionId && TASK_ID.test(worker.taskId ?? '') && typeof worker.parentSessionId === 'string' && worker.parentSessionId !== sessionId && worker.origin === 'assistant_delegation');
  }
  function normalizationOptions(session) { return isWorkerSession(session) ? { executionRole: 'worker' } : {}; }
  function registerCall(session, callId, call) {
    check(); const sessionId = sessionIdOf(session), actualId = key(callId ?? call?.id), name = key(call?.name);
    if (typeof sessionId !== 'string' || !actualId || !name) return false;
    const entry = { name, ...(name === toolName ? { selection: selection(call?.arguments ?? call?.args) } : {}) };
    const callKey = JSON.stringify([sessionId, actualId]);
    calls.delete(callKey); while (calls.size >= maxCalls) calls.delete(calls.keys().next().value);
    calls.set(callKey, entry); return true;
  }
  function rememberAssistant(session, message) {
    for (const block of message?.content ?? []) if (block?.type === 'tool-call') registerCall(session, block.id, block);
  }
  async function resolveCall(session, event, callId) {
    const sessionId = sessionIdOf(session), callKey = JSON.stringify([sessionId, callId]);
    if (calls.has(callKey)) return calls.get(callKey);
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const block = messages[i]?.content?.find(item => item?.type === 'tool-call' && item.id === callId);
      if (block) { registerCall(session, callId, block); return calls.get(callKey); }
    }
    const resolved = await lookupCall?.({ sessionId, callId, event });
    if (resolved) registerCall(session, callId, resolved);
    return calls.get(callKey) ?? null;
  }
  async function projectEventForMemory(session, event) {
    check();
    if (isWorkerSession(session)) return { event: null, skip: true, isolated: true, reason: 'delegation_worker_session' };
    if (isDelegationMetadata(event)) return { event, skip: false, isolated: true };
    if (event?.type === 'tool/call') {
      const call = event.data?.call ?? event.data?.toolCall ?? event.data;
      registerCall(session, call?.id ?? call?.callId, call);
      return { event, skip: false, isolated: false };
    }
    if (event?.type === 'assistant/message') {
      const message = event.data?.message; rememberAssistant(session, message);
      let changed = false;
      const content = message?.content?.map(block => {
        if (block?.type !== 'tool-call' || block.name !== toolName) return block;
        changed = true;
        return mark({ ...block, arguments: JSON.stringify({ tool: toolName, ...selection(block.arguments), bodyCopiedToMemory: false }) });
      });
      return changed ? { event: { ...event, data: { ...event.data, message: { ...message, content } } }, skip: false, isolated: true } : { event, skip: false, isolated: false };
    }
    if (event?.type !== 'tool/result') return { event, skip: false, isolated: false };
    const callId = resultCallId(event);
    if (rawResultCallId(event) == null) return { event, skip: false, isolated: false };
    const call = callId ? await resolveCall(session, event, callId) : null;
    if (call && call.name !== toolName) return { event, skip: false, isolated: false };
    const navigation = call ? { tool: toolName, ...call.selection, ...resultNavigation(resultBody(event)) }
      : { sourceResolution: 'unavailable', bodyCopiedToMemory: false, originalRetainedByHost: true };
    return { event: taskResultEvent(event, navigation), skip: false, isolated: true, ...(call ? {} : { unresolved: true, reason: 'tool_call_source_unavailable' }) };
  }
  function forgetSession(session) { const sessionId = sessionIdOf(session); for (const callKey of calls.keys()) if (JSON.parse(callKey)[0] === sessionId) calls.delete(callKey); }
  function close() { closed = true; calls.clear(); }
  return { isWorkerSession, normalizationOptions, registerCall, projectEventForMemory, forgetSession, close };
}
