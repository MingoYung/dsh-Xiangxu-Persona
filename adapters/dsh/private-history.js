import { sourceKey } from '../../core/schema.js';
import { normalizeDshEvent } from './normalize.js';

const MAX_HISTORY_EVENTS = 32;
const PROCESS_KINDS = new Set(['reasoning', 'tool_call', 'tool_result']);

function historyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sourceForEvent(sessionId, event) {
  const id = event.type === 'user/message' ? event.data?.id
    : event.type === 'assistant/message' ? event.data?.message?.id
      : event.type === 'tool/result' ? String(event.seq) : null;
  return typeof id === 'string' && id ? { sourceSessionId: sessionId, sourceEventId: id, available: true } : null;
}

/** A model-selected, read-only window of this QQ private conversation's original log. */
export async function readPrivateHistory({ query, sessionId, latestSeq, args = {}, isRevoked, readVisibleMessage,
  readDialogueSources, readProcess, projectProcessEvent, signal }) {
  const { beforeSeq = latestSeq + 1, historyLimit = 16, includeProcess = false } = args;
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(latestSeq) || latestSeq < -1 ||
    typeof query?.readEvent !== 'function' || typeof isRevoked !== 'function' || typeof readVisibleMessage !== 'function' ||
    includeProcess === true && (typeof readProcess !== 'function' || typeof projectProcessEvent !== 'function')) {
    throw historyError('QQ_PRIVATE_HISTORY_UNAVAILABLE', '宿主未提供可核对的私聊历史。');
  }
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > latestSeq + 1 ||
    !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > MAX_HISTORY_EVENTS || typeof includeProcess !== 'boolean') {
    throw historyError('QQ_PRIVATE_HISTORY_CURSOR', '私聊历史的序号或页长无效。');
  }
  const startSeq = Math.max(0, beforeSeq - historyLimit), endSeq = beforeSeq - 1;
  const result = { sessionId, fromSeq: startSeq, beforeSeq, nextBeforeSeq: startSeq > 0 ? startSeq : null, includeProcess, items: [] };
  if (endSeq < 0) return result;

  signal?.throwIfAborted();
  const page = await query.readEvent({ sessionId, seq: endSeq, before: endSeq - startSeq, after: 0 }, signal);
  const inheritedCount = page?.inheritedEventCount ?? 0;
  if ((page?.session?.id ?? page?.header?.id) !== sessionId || !Array.isArray(page.events) ||
    !Number.isSafeInteger(inheritedCount) || inheritedCount < 0 || page.events.length !== beforeSeq - startSeq ||
    page.events.some((event, i) => event?.seq !== startSeq + i)) {
    throw historyError('QQ_PRIVATE_HISTORY_UNAVAILABLE', '宿主返回的私聊历史范围与请求不一致。');
  }
  if (startSeq <= inheritedCount) result.nextBeforeSeq = null;

  const sources = [];
  for (const event of page.events) {
    if (event.seq < inheritedCount) continue;
    const sourceRef = sourceForEvent(sessionId, event);
    if (sourceRef && !await isRevoked(sourceRef)) sources.push({ event, sourceRef });
  }

  const missingAssistantSources = [];
  for (const source of sources) {
    const { event, sourceRef } = source;
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data?.message : null;
    if (message?.role === 'user' && message.source?.kind === 'user' ||
      message?.role === 'assistant' && !event.data?.interrupted &&
        Array.isArray(message.content) && !message.content.some(block => block.type === 'tool-call')) {
      source.role = message.role;
      source.text = await readVisibleMessage(message);
      if (message.role === 'assistant' && typeof source.text !== 'string') missingAssistantSources.push(sourceRef);
    }
  }
  const archived = new Map();
  if (typeof readDialogueSources === 'function' && missingAssistantSources.length) {
    const selected = new Set(missingAssistantSources.map(sourceKey));
    for (const row of await readDialogueSources({ sourceRefs: missingAssistantSources })) {
      // The timeline admits QQ assistant text only after a delivery receipt
      // has proved the visible text. This covers an old, rotated receipt.
      if (row.role === 'assistant' && row.sourceSessionId === sessionId && row.channelId === `dsh:${sessionId}` &&
        row.contentClass === 'participant_dialogue' && ['ai_reply', 'ai_initiated'].includes(row.origin) &&
        typeof row.text === 'string' && selected.has(sourceKey(row))) archived.set(sourceKey(row), row.text);
    }
  }

  const processSources = sources.filter(({ event }) => event.type !== 'user/message').map(({ sourceRef }) => sourceRef);
  const retained = new Map();
  if (includeProcess && processSources.length) {
    for (const record of await readProcess({ sessionId, sourceRefs: processSources })) {
      const key = sourceKey(record.sourceRef);
      if (!retained.has(key)) retained.set(key, []);
      retained.get(key).push(record);
    }
  }

  for (const { event, sourceRef, role, text: visibleText } of sources) {
    signal?.throwIfAborted();
    const info = { seq: event.seq, time: Number.isSafeInteger(event.time) ? event.time : null, sourceRef };
    const text = typeof visibleText === 'string' ? visibleText : archived.get(sourceKey(sourceRef));
    if (typeof text === 'string') result.items.push({ ...info, kind: 'dialogue', role, text });
    const authorized = retained.get(sourceKey(sourceRef));
    if (!authorized?.length) continue;
    const projected = await projectProcessEvent(event);
    if (!projected?.event || projected.skip || projected.isolated) continue;
    const normalized = normalizeDshEvent({ id: sessionId }, projected.event);
    for (const item of normalized.hot) {
      if (!PROCESS_KINDS.has(item.kind)) continue;
      const blockIndex = item.blockIndex ?? 0;
      const record = authorized.find(row => row.kind === item.kind && (row.blockIndex ?? 0) === blockIndex);
      if (!record || record.sourceKind === 'persona-task:metadata') continue;
      const content = record.content;
      const text = content?.mode === 'cached' ? content.text
        : content?.mode === 'host_trace' && content.available === true ? item.content.text : null;
      if (typeof text !== 'string') continue;
      result.items.push({ ...info, kind: item.kind, blockIndex, text, sourceRecordIds: [record.id, ...(record.dependencyRecordIds ?? [])],
        sourceRefs: record.dependencyRefs ?? [] });
    }
  }
  signal?.throwIfAborted();
  return result;
}
