import { createHash } from 'node:crypto';

const FILE = 'host-delivery-facts.json', VERSION = 'xiangxu-native-delivery-facts/1';
const LIMITS = { presentations: 256, outputs: 64, bytes: 262144 };
const clone = value => structuredClone(value);
const identity = row => JSON.stringify([row.sourceSessionId, row.sourceEventId]);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const empty = () => ({ schemaVersion: VERSION, version: 0, presentations: [], outputs: [], evictedPresentations: 0, evictedOutputs: 0 });
function mergeRanges(ranges) {
  const merged = [];
  for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
    const prior = merged.at(-1);
    if (prior && from <= prior[1]) prior[1] = Math.max(prior[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Delivery diagnostics only: no personality content, semantic completion or raw messages. */
export function createNativeDeliveryFacts({ store, clock = Date.now, onError = () => {} }) {
  let state = empty(), available = false, failure = null, tail = Promise.resolve();
  const report = error => { available = false; failure = error.code ?? 'NATIVE_DELIVERY_FACTS_UNAVAILABLE'; try { onError(error); } catch {} };
  const queue = work => { const result = tail.then(work); tail = result.catch(report); return result; };
  const trim = () => {
    while (state.presentations.length > LIMITS.presentations) { state.presentations.shift(); state.evictedPresentations++; }
    while (state.outputs.length > LIMITS.outputs) { state.outputs.shift(); state.evictedOutputs++; }
    while (Buffer.byteLength(JSON.stringify(state)) > LIMITS.bytes) {
      if (state.presentations.length) { state.presentations.shift(); state.evictedPresentations++; }
      else if (state.outputs.length) { state.outputs.shift(); state.evictedOutputs++; }
      else throw Object.assign(new Error('Native delivery facts cannot fit their diagnostic capacity'), { code: 'NATIVE_DELIVERY_FACTS_CAPACITY' });
    }
  };
  const save = async () => { state.version++; trim(); await store.transaction({ json: { [FILE]: state } }); available = true; failure = null; };
  async function open() {
    try {
      const value = await store.readJson(FILE, empty());
      if (value.schemaVersion !== VERSION || !Number.isSafeInteger(value.version) || !Array.isArray(value.presentations) || !Array.isArray(value.outputs) ||
        value.presentations.length > LIMITS.presentations || value.outputs.length > LIMITS.outputs || Buffer.byteLength(JSON.stringify(value)) > LIMITS.bytes ||
        !Number.isSafeInteger(value.evictedPresentations) || value.evictedPresentations < 0 || !Number.isSafeInteger(value.evictedOutputs) || value.evictedOutputs < 0 ||
        value.presentations.some(row => !validId(row.eventId) || !validId(row.sourceSessionId) || !validId(row.sourceEventId) || !validTime(row.firstAdmittedAt) || !validTime(row.lastAdmittedAt) ||
          !Number.isSafeInteger(row.total) || row.total < 0 || typeof row.complete !== 'boolean' || !Array.isArray(row.ranges) ||
          row.ranges.some(range => !Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] < range[0] || range[1] > row.total) ||
          row.complete !== (row.ranges.length === 1 && row.ranges[0][0] === 0 && row.ranges[0][1] === row.total) ||
          !(row.streamObservedAt === null || validTime(row.streamObservedAt))) ||
        value.outputs.some(row => !validId(row.sourceSessionId) || !validId(row.sourceEventId) || !validTime(row.observedAt) || !['delivered', 'unknown'].includes(row.status) || !Array.isArray(row.settledPendingEventIds) || row.settledPendingEventIds.some(id => !validId(id)))) {
        throw Object.assign(new Error('Native delivery diagnostic metadata is invalid; no reply state was inferred'), { code: 'NATIVE_DELIVERY_FACTS_INVALID' });
      }
      state = value; available = true;
    } catch (error) { report(error); }
  }
  function admit(records, { sessionId, turn, streamObserved = false } = {}) {
    return queue(async () => {
      if (!available) return;
      const now = clock(); let changed = false;
      for (const record of records) {
        if (!validId(record.eventId) || !validId(record.sourceSessionId) || !validId(record.sourceEventId)) continue;
        const total = record.fragment?.total ?? Array.from(record.text ?? '').length;
        const from = record.fragment?.from ?? 0, to = record.fragment?.to ?? total;
        if (![from, to, total].every(Number.isSafeInteger) || from < 0 || to < from || to > total) continue;
        let row = state.presentations.find(item => item.eventId === record.eventId);
        if (!row) { row = { eventId: record.eventId, sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, firstAdmittedAt: now, lastAdmittedAt: now, streamObservedAt: null, total, ranges: [], complete: false }; state.presentations.push(row); }
        if (row.sourceSessionId !== record.sourceSessionId || row.sourceEventId !== record.sourceEventId || row.total !== total) continue;
        row.ranges = mergeRanges([...row.ranges, [from, to]]);
        row.complete = row.ranges.length === 1 && row.ranges[0][0] === 0 && row.ranges[0][1] === total;
        row.lastAdmittedAt = now; row.lastAdmissionSessionId = sessionId ?? null; row.lastAdmissionTurn = turn ?? null;
        if (streamObserved) row.streamObservedAt = now;
        changed = true;
      }
      if (changed) await save();
    });
  }
  function recordOutput({ sourceSessionId, sourceEventId, channelId, personId, text, status, receiptId = null, deliveredAt = null, settledPendingEventIds = [], evidence } = {}) {
    return queue(async () => {
      if (!available) return;
      if (!validId(sourceSessionId) || !validId(sourceEventId) || typeof text !== 'string' || !text || !['delivered', 'unknown'].includes(status)) return;
      const key = identity({ sourceSessionId, sourceEventId }), previous = state.outputs.find(row => identity(row) === key);
      if (previous?.status === 'delivered' && status !== 'delivered') return;
      const row = { sourceSessionId, sourceEventId, channelId, personId: personId ?? null, status, receiptId,
        deliveredAt: status === 'delivered' && validTime(deliveredAt) ? deliveredAt : null, observedAt: clock(), evidence,
        textChars: Array.from(text).length, textSha256: createHash('sha256').update(text).digest('hex'),
        settledPendingEventIds: status === 'delivered' ? [...new Set([...(previous?.settledPendingEventIds ?? []), ...settledPendingEventIds])] : [] };
      state.outputs = [...state.outputs.filter(value => identity(value) !== key), row]; await save();
    });
  }
  function inspect({ pending = [], sessionId, pendingEventIds = [], limit = 16 } = {}) {
    const bounded = Math.max(1, Math.min(64, Number.isSafeInteger(limit) ? limit : 16));
    const ids = new Set(pendingEventIds), scoped = pending.filter(record => !sessionId || record.sourceSessionId === sessionId || ids.has(record.eventId));
    const sourceSessions = new Set([sessionId, ...scoped.map(record => record.sourceSessionId)]);
    const outputs = state.outputs.filter(row => !sessionId || sourceSessions.has(row.sourceSessionId))
      .sort((a, b) => (a.deliveredAt ?? a.observedAt) - (b.deliveredAt ?? b.observedAt));
    const rows = scoped.slice(0, bounded).map(record => {
      const presentation = state.presentations.find(row => row.eventId === record.eventId);
      const later = outputs.filter(row => row.sourceSessionId === record.sourceSessionId && (row.deliveredAt ?? row.observedAt) >= record.sourceAt);
      return { eventId: record.eventId, sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId,
        admission: presentation ? { firstAdmittedAt: presentation.firstAdmittedAt, lastAdmittedAt: presentation.lastAdmittedAt, streamObservedAt: presentation.streamObservedAt, complete: presentation.complete } : null,
        laterOutputCount: later.length, latestLaterOutput: later.at(-1) ?? null,
        answeredByLaterOutput: 'not_inferred' };
    });
    return clone({ available, ...(failure ? { errorCode: failure } : {}), schemaVersion: VERSION,
      note: 'Admission is not proof of a model reply. streamObservedAt marks a request stream for the admitting turn, not byte-for-byte source verification at the provider boundary or semantic reading. A later output and task completion do not prove that this specific old request was answered.',
      pending: { items: rows, total: scoped.length, truncated: rows.length < scoped.length },
      outputs: { items: outputs.slice(-bounded), retained: outputs.length, totalObserved: state.evictedOutputs ? null : outputs.length,
        truncated: outputs.length > bounded || state.evictedOutputs > 0, historyEvicted: state.evictedOutputs > 0 },
      admissionHistoryTruncated: state.evictedPresentations > 0 });
  }
  async function recoverSettled({ getPending, clearPending }) {
    await tail;
    if (!available) return;
    const pending = await getPending(), ids = new Set();
    for (const row of state.outputs.filter(row => row.status === 'delivered')) for (const record of pending) {
      if (record.sourceSessionId === row.sourceSessionId && record.channelId === row.channelId && (record.personId ?? null) === (row.personId ?? null) && row.settledPendingEventIds.includes(record.eventId)) ids.add(record.eventId);
    }
    if (ids.size) await clearPending([...ids]);
  }
  return { open, admit, recordOutput, inspect, recoverSettled,
    wasAdmitted: id => available && state.presentations.some(row => row.eventId === id && row.complete === true), idle: () => tail };
}
