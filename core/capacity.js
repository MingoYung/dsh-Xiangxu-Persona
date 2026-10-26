export const DEFAULT_DEEP_MEMORY_LIMITS = Object.freeze({ deepMemories: 128, deepMemoryChars: 100000 });

export const DEFAULT_CAPACITY_LIMITS = Object.freeze({ artifactTextChars: 16000, artifactRecordBytes: 65536, documentBytes: 1048576, storeBytes: 67108864 });
export const DEFAULT_PROCESSING_LIMITS = Object.freeze({ consolidationInputChars: 4000, consolidationRequestTokens: 32768,
  consolidationContextChars: 4000, consolidationOutputTokens: 16384, controlOutputTokens: 4096, replyOutputTokens: 4096,
  consolidationCallsPerSegment: 8, maxQueuedConsolidations: 8, maxTargetsPerJob: 8 });

export function capacityError(resource, actual, limit, path) {
  return Object.assign(new Error(`${resource} exceeds configured capacity${path ? ': ' + path : ''} (${actual} > ${limit})`),
    { code: 'CAPACITY_EXCEEDED', resource, actual, limit, ...(path ? { path } : {}) });
}

/** Every string value counts, including arrays and extension fields; field names are covered by serialized bytes. */
export function countStringValues(value) {
  const stack = [{ value }], ancestors = new WeakSet(); let count = 0;
  while (stack.length) {
    const frame = stack.pop(), item = frame.value;
    if (frame.exit) { ancestors.delete(item); continue; }
    if (typeof item === 'string') { for (const unused of item) count++; }
    else if (item && typeof item === 'object') {
      if (ancestors.has(item)) throw Object.assign(new Error('Capacity measurement cannot serialize a cycle'), { code: 'SCHEMA_INVALID' });
      ancestors.add(item); stack.push({ value: item, exit: true });
      for (const child of Object.values(item)) stack.push({ value: child });
    }
  }
  return count;
}

export function serializedBytes(value) { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); }
export function assertFiniteJson(value, { allowUndefined = false, maxDepth = 64 } = {}) {
  const ancestors = new WeakSet();
  const visit = (item, depth) => {
    if (depth > maxDepth || (!allowUndefined && item === undefined) || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))) throw Object.assign(new Error('Value must be plain finite JSON with bounded depth'), { code: 'SCHEMA_INVALID' });
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw Object.assign(new Error('Only plain JSON objects are supported'), { code: 'SCHEMA_INVALID' });
    if (ancestors.has(item)) throw Object.assign(new Error('JSON value cannot contain cycles'), { code: 'SCHEMA_INVALID' });
    ancestors.add(item); for (const child of Object.values(item)) visit(child, depth + 1); ancestors.delete(item);
  };
  visit(value, 0);
}
export function assertRecordCapacity(value, limits, path) {
  assertFiniteJson(value);
  const chars = countStringValues(value); if (chars > limits.artifactTextChars) throw capacityError('artifactTextChars', chars, limits.artifactTextChars, path);
  const bytes = serializedBytes(value); if (bytes > limits.artifactRecordBytes) throw capacityError('artifactRecordBytes', bytes, limits.artifactRecordBytes, path);
}
export function assertDocumentCapacity(value, limits, path) {
  assertFiniteJson(value);
  const bytes = serializedBytes(value); if (bytes > limits.documentBytes) throw capacityError('documentBytes', bytes, limits.documentBytes, path);
}

export function assertFiniteReviewState(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('reviewState must be a JSON object'), { code: 'SCHEMA_INVALID' });
  assertFiniteJson(value, { maxDepth: 32 });
  assertRecordCapacity(value, limits, 'reviewState');
}
