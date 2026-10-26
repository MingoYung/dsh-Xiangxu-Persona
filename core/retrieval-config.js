// Technical resource limits only. They do not grade a person or a memory.
export const DEFAULT_RETRIEVAL_CONFIG = Object.freeze({ semanticEnabled: false, cacheEntries: 256, cacheBytes: 4194304,
  cacheTtlMs: 3600000, requestTimeoutMs: 15000, batchRecords: 16, documentChars: 4000,
  diagnosticEntries: 30, diagnosticBytes: 262144 });
export const RETRIEVAL_CONFIG_RANGES = Object.freeze({ cacheEntries: [1, 4096], cacheBytes: [4096, 67108864],
  cacheTtlMs: [1000, 604800000], requestTimeoutMs: [100, 120000], batchRecords: [1, 64],
  documentChars: [128, 16000], diagnosticEntries: [1, 200], diagnosticBytes: [4096, 2097152] });
export const RETRIEVAL_LIMITS = Object.freeze({ dimensions: 4096, queryChars: 2000, seedIds: 16,
  associationNodes: 1000, associationEdges: 16384, linksPerRecord: 256, diagnosticIds: 1000 });
export function retrievalError(code, message) { return Object.assign(new Error(message), { code }); }
export function validateRetrievalConfig(value = {}, { partial = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw retrievalError('SCHEMA_INVALID', 'retrieval must be an object');
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_RETRIEVAL_CONFIG, key)) throw retrievalError('SCHEMA_INVALID', 'Unknown retrieval setting: ' + key);
  if (value.semanticEnabled !== undefined && typeof value.semanticEnabled !== 'boolean') throw retrievalError('SCHEMA_INVALID', 'retrieval.semanticEnabled must be boolean');
  for (const [key, [min, max]] of Object.entries(RETRIEVAL_CONFIG_RANGES)) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max))
    throw retrievalError('SCHEMA_INVALID', `retrieval.${key} must be an integer ${min}..${max}`);
  return partial ? structuredClone(value) : { ...DEFAULT_RETRIEVAL_CONFIG, ...value };
}
