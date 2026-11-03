// Pure adapter document validation shared by runtime reads and offline
// maintenance. No I/O, host imports, credentials or personality decisions.
export const HOST_CHANNEL_LIMITS = Object.freeze({ sessions: 128, bytes: 262144 });
export const NATIVE_DELIVERY_LIMITS = Object.freeze({ presentations: 256, outputs: 64, bytes: 262144 });
export const NATIVE_DELIVERY_VERSION = 'xiangxu-native-delivery-facts/1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const failure = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sizeWithin = (value, maximum) => Buffer.byteLength(JSON.stringify(value)) <= maximum;
const optional = (value, key, accepts) => !Object.hasOwn(value, key) || accepts(value[key]);
const nullableId = value => value === null || id(value);

export function validateHostChannelContext(value) {
  const invalid = () => failure('CHANNEL_CONTEXT_INVALID', '平台通道上下文超量或格式无效');
  if (!object(value) || value.schemaVersion !== 'xiangxu-channel-context/1' || !object(value.sessions)
    || Object.keys(value.sessions).length > HOST_CHANNEL_LIMITS.sessions || !sizeWithin(value, HOST_CHANNEL_LIMITS.bytes)) invalid();
  const stable = item => typeof item === 'string' && item.length > 0 && Array.from(item).length <= 256 && !/[\u0000-\u001f]/.test(item);
  for (const [sessionId, facts] of Object.entries(value.sessions)) {
    if (!/^xiangxu-social-[a-f0-9]{16,64}$/.test(sessionId) || !object(facts) || !stable(facts.platform) || !stable(facts.accountId)
      || !object(facts.conversation) || !stable(facts.conversation.id) || !['private', 'group'].includes(facts.conversation.type)
      || !object(facts.sender) || !stable(facts.sender.id)
      || !optional(facts.sender, 'name', name => typeof name === 'string' && Array.from(name).length <= 120)) invalid();
  }
  return value;
}

export function validateNativeDeliveryFacts(value) {
  const invalid = () => failure('NATIVE_DELIVERY_FACTS_INVALID', 'Native delivery diagnostic metadata is invalid; no reply state was inferred');
  if (!object(value) || value.schemaVersion !== NATIVE_DELIVERY_VERSION || !integer(value.version)
    || !Array.isArray(value.presentations) || value.presentations.length > NATIVE_DELIVERY_LIMITS.presentations
    || !Array.isArray(value.outputs) || value.outputs.length > NATIVE_DELIVERY_LIMITS.outputs
    || !integer(value.evictedPresentations) || !integer(value.evictedOutputs) || !sizeWithin(value, NATIVE_DELIVERY_LIMITS.bytes)) invalid();
  const seenPresentations = new Set(), seenOutputs = new Set();
  for (const row of value.presentations) {
    if (!object(row) || !id(row.eventId) || seenPresentations.has(row.eventId) || !id(row.sourceSessionId) || !id(row.sourceEventId)
      || !integer(row.firstAdmittedAt) || !integer(row.lastAdmittedAt) || !integer(row.total) || typeof row.complete !== 'boolean'
      || !Array.isArray(row.ranges) || row.ranges.some(range => !Array.isArray(range) || range.length !== 2
        || !range.every(integer) || range[1] < range[0] || range[1] > row.total)
      || row.complete !== (row.ranges.length === 1 && row.ranges[0][0] === 0 && row.ranges[0][1] === row.total)
      || !(row.streamObservedAt === null || integer(row.streamObservedAt))
      || !optional(row, 'lastAdmissionSessionId', nullableId)
      || !optional(row, 'lastAdmissionTurn', number => number === null || integer(number))) invalid();
    seenPresentations.add(row.eventId);
  }
  for (const row of value.outputs) {
    if (!object(row)) invalid();
    const identity = JSON.stringify([row.sourceSessionId, row.sourceEventId]);
    if (!id(row.sourceSessionId) || !id(row.sourceEventId) || seenOutputs.has(identity) || !integer(row.observedAt)
      || !['delivered', 'unknown'].includes(row.status) || !Array.isArray(row.settledPendingEventIds)
      || row.settledPendingEventIds.some(item => !id(item)) || new Set(row.settledPendingEventIds).size !== row.settledPendingEventIds.length
      || row.status === 'unknown' && row.settledPendingEventIds.length !== 0
      || !optional(row, 'channelId', id) || !optional(row, 'personId', nullableId) || !optional(row, 'receiptId', nullableId)
      || !optional(row, 'deliveredAt', time => time === null || integer(time))
      || !optional(row, 'textChars', integer) || !optional(row, 'textSha256', hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || !optional(row, 'evidence', text => typeof text === 'string' && text.length > 0 && text.length <= 256)) invalid();
    seenOutputs.add(identity);
  }
  return value;
}
