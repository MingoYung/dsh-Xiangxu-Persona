import { createHash } from 'node:crypto';
import { extractSourceDependencies } from './source-dependencies.js';
import { validateRetrievalConfig, RETRIEVAL_LIMITS, retrievalError } from './retrieval-config.js';
import { retrievalText, retrievalRecordKey } from './retrieval.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sourceKey = ref => JSON.stringify([ref.sourceSessionId, ref.sourceEventId]);
export function retrievalFingerprint(item) {
  return sha(JSON.stringify({ text: retrievalText(item), personId: item.personId ?? null, recordType: item.recordType,
    sources: item.srcRefs ?? [] }));
}
export function validateSemanticPort(port) {
  if (port === null || port === undefined) return null;
  if (typeof port !== 'object' || typeof port.embed !== 'function' || ['id', 'version'].some(field => typeof port[field] !== 'string' || !port[field] || port[field].length > 128) ||
    port.dimensions !== undefined && (!Number.isSafeInteger(port.dimensions) || port.dimensions < 1 || port.dimensions > RETRIEVAL_LIMITS.dimensions))
    throw retrievalError('SEMANTIC_PORT_INVALID', 'Semantic port requires bounded id/version, embed and optional dimensions');
  return port;
}
function vector(value, dimensions) {
  if (!Array.isArray(value) || !value.length || value.length > RETRIEVAL_LIMITS.dimensions || dimensions && value.length !== dimensions || value.some(number => typeof number !== 'number' || !Number.isFinite(number)))
    throw retrievalError('SEMANTIC_VECTOR_INVALID', 'Semantic provider returned an invalid vector');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm <= 0) throw retrievalError('SEMANTIC_VECTOR_INVALID', 'Semantic provider returned a zero or unbounded vector');
  return value.map(number => number / norm);
}

/** Reproducible indexes and diagnostics; no personality values are written here. */
export class RetrievalState {
  constructor({ clock, getConfig, semanticPort = null }) {
    this.clock = clock; this.getConfig = getConfig; this.port = validateSemanticPort(semanticPort);
    this.cache = new Map(); this.cacheBytes = 0; this.events = []; this.lastProviderError = null; this.providerSignature = null;
  }
  config() { return validateRetrievalConfig(this.getConfig() ?? {}); }
  clearCache() { this.cache.clear(); this.cacheBytes = 0; this.lastProviderError = null; }
  setPort(port) { this.port = validateSemanticPort(port); this.clearCache(); this.providerSignature = null; return this.status(); }
  provider() {
    if (!this.port) return null;
    const port = validateSemanticPort(this.port), signature = JSON.stringify([port.id, port.version, port.dimensions ?? null]);
    if (signature !== this.providerSignature) { this.clearCache(); this.providerSignature = signature; }
    return { id: port.id, version: port.version, ...(port.dimensions ? { dimensions: port.dimensions } : {}), signature };
  }
  remove(key) { const entry = this.cache.get(key); if (entry) { this.cacheBytes -= entry.bytes; this.cache.delete(key); } }
  prune() {
    const config = this.config(), now = this.clock();
    for (const [key, item] of this.cache) if (now - item.at >= config.cacheTtlMs || item.at > now) this.remove(key);
    while (this.cache.size > config.cacheEntries || this.cacheBytes > config.cacheBytes) this.remove(this.cache.keys().next().value);
  }
  get(key) { this.prune(); const item = this.cache.get(key); if (item) { this.cache.delete(key); this.cache.set(key, item); } return item; }
  put(key, item) {
    const entry = { ...item, at: this.clock() }; entry.bytes = bytes(entry) + Buffer.byteLength(key);
    if (entry.bytes > this.config().cacheBytes) return false;
    this.remove(key); this.cache.set(key, entry); this.cacheBytes += entry.bytes; this.prune(); return this.cache.has(key);
  }
  invalidate(meta, { clearQueries = false } = {}) {
    const ids = new Set(meta.revokedIds ?? []), roots = new Set((meta.revokedSources ?? []).map(sha));
    for (const [key, entry] of this.cache) if (entry.kind === 'query' ? clearQueries : ids.has(entry.id) || entry.dependencyIds.some(id => ids.has(id)) || entry.sourceHashes.some(hash => roots.has(hash))) this.remove(key);
    // Diagnostics never keep a withdrawn record identity or source receipt.
    this.events = this.events.map(event => ({ ...event,
      records: (event.records ?? []).filter(record => !ids.has(record.id) && !(record.sourceHashes ?? []).some(hash => roots.has(hash))) }));
  }
  reconcile(rows, meta) {
    this.provider(); this.prune(); this.invalidate(meta);
    const available = new Map(rows.map(item => [retrievalRecordKey(item), retrievalFingerprint(item)]));
    for (const [key, entry] of this.cache) if (entry.kind === 'document' && available.get(entry.recordKey) !== entry.fingerprint) this.remove(key);
  }
  async embed(texts, purpose) {
    const port = this.port, provider = this.provider(), config = this.config(), controller = new AbortController(); let timer;
    try {
      const request = Promise.resolve().then(() => port.embed({ texts, purpose, signal: controller.signal }));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(retrievalError('SEMANTIC_TIMEOUT', 'Semantic provider exceeded the request time limit')); }, config.requestTimeoutMs); });
      const result = await Promise.race([request, timeout]);
      if (!result || !Array.isArray(result.vectors) || result.vectors.length !== texts.length) throw retrievalError('SEMANTIC_VECTOR_INVALID', 'Semantic vector count must match input count');
      let dimensions = provider.dimensions;
      const vectors = result.vectors.map(item => { const normalized = vector(item, dimensions); dimensions ??= normalized.length; return normalized; });
      const existing = this.cache.values().next().value;
      if (existing && existing.vector.length !== dimensions) throw retrievalError('SEMANTIC_DIMENSIONS_CHANGED', 'Semantic dimensions changed without a provider version change');
      this.lastProviderError = null; return { vectors, provider };
    } catch (error) {
      const code = ['SEMANTIC_TIMEOUT', 'SEMANTIC_VECTOR_INVALID', 'SEMANTIC_DIMENSIONS_CHANGED', 'SEMANTIC_PORT_INVALID'].includes(error?.code) ? error.code : 'SEMANTIC_PROVIDER_FAILED';
      this.lastProviderError = code; throw retrievalError(code, 'Semantic retrieval is unavailable; original records are unchanged');
    } finally { clearTimeout(timer); }
  }
  async prepare(rows, { offset = 0, limit = this.config().batchRecords } = {}) {
    const config = this.config(), provider = this.provider();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > config.batchRecords) throw retrievalError('SCHEMA_INVALID', 'Semantic preparation offset/limit exceeds one configured page');
    const excludedEmpty = rows.filter(item => !retrievalText(item).trim()).length; rows = rows.filter(item => retrievalText(item).trim());
    const page = rows.slice(offset, offset + limit), base = { offset, total: rows.length, selected: page.length, excludedEmpty,
      nextOffset: offset + page.length < rows.length ? offset + page.length : null, complete: offset + page.length >= rows.length };
    if (!config.semanticEnabled || !provider) return { ...base, prepared: 0, skipped: page.length, available: false, reason: provider ? 'disabled' : 'not_configured', originalRecordsChanged: false };
    const pending = page.map(item => ({ item, fingerprint: retrievalFingerprint(item) })).filter(row => !this.get(provider.signature + ':document:' + row.item.id + ':' + row.fingerprint));
    if (!pending.length) return { ...base, prepared: 0, cached: page.length, available: true, originalRecordsChanged: false };
    const texts = pending.map(({ item }) => Array.from(retrievalText(item)).slice(0, config.documentChars).join(''));
    let result; try { result = await this.embed(texts, 'document'); }
    catch (error) { return { ...base, prepared: 0, available: false, reason: error.code, originalRecordsChanged: false }; }
    let prepared = 0, partialTexts = 0;
    pending.forEach(({ item, fingerprint }, index) => {
      const dependencies = extractSourceDependencies(item), completeText = Array.from(retrievalText(item)).length <= config.documentChars;
      if (!completeText) partialTexts++;
      const entry = { kind: 'document', id: item.id, recordKey: retrievalRecordKey(item), fingerprint, vector: result.vectors[index], completeText,
        dependencyIds: dependencies.recordIds, sourceHashes: dependencies.refs.map(sourceKey).map(sha) };
      if (this.put(provider.signature + ':document:' + item.id + ':' + fingerprint, entry)) prepared++;
    });
    const indexed = rows.filter(item => this.cache.has(provider.signature + ':document:' + item.id + ':' + retrievalFingerprint(item))).length;
    return { ...base, prepared, available: prepared > 0 || indexed > 0, ...(prepared || indexed ? {} : { reason: 'SEMANTIC_CACHE_CAPACITY' }),
      partialTexts, cached: page.length - pending.length, pageComplete: base.complete,
      coverage: { eligible: rows.length, indexed, complete: indexed === rows.length },
      cacheRetained: [...this.cache.values()].filter(entry => entry.kind === 'document').length, originalRecordsChanged: false };
  }
  async search(rows, query, mode) {
    const config = this.config(), provider = this.provider(); this.prune();
    const docs = rows.map(item => ({ item, entry: provider ? this.get(provider.signature + ':document:' + item.id + ':' + retrievalFingerprint(item)) : null })).filter(row => row.entry);
    const base = { configured: Boolean(provider), enabled: config.semanticEnabled, available: false, queryCacheHit: false,
      eligible: rows.length, indexed: docs.length, coverageComplete: docs.length === rows.length, partialDocumentTexts: docs.filter(row => !row.entry.completeText).length,
      ...(provider ? { provider: { id: provider.id, version: provider.version } } : {}) };
    if (mode === 'lexical' || !query || !config.semanticEnabled || !provider || !docs.length) return { items: [], diagnostics: { ...base,
      reason: mode === 'lexical' ? 'lexical_requested' : !query ? 'empty_query' : !config.semanticEnabled ? 'disabled' : !provider ? 'not_configured' : 'index_empty' } };
    const key = provider.signature + ':query:' + sha(query); let cached = this.get(key), hit = Boolean(cached);
    if (!cached) try { const result = await this.embed([query], 'query'); cached = { kind: 'query', vector: result.vectors[0] }; this.put(key, cached); }
    catch (error) { return { items: [], diagnostics: { ...base, reason: error.code, degraded: true } }; }
    const items = [];
    for (const { item, entry } of docs) {
      if (cached.vector.length !== entry.vector.length) return { items: [], diagnostics: { ...base, reason: 'SEMANTIC_DIMENSIONS_CHANGED', degraded: true } };
      const score = entry.vector.reduce((sum, value, i) => sum + value * cached.vector[i], 0);
      if (score > 0) items.push({ id: item.id, key: retrievalRecordKey(item), score: Math.min(1, score) });
    }
    items.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return { items, diagnostics: { ...base, available: true, queryCacheHit: hit, reason: null } };
  }
  record(event) {
    const config = this.config(), value = structuredClone(event); value.at = this.clock();
    const records = value.records ?? []; value.recordCount = records.length; value.records = records.slice(0, RETRIEVAL_LIMITS.diagnosticIds);
    if (records.length > value.records.length) value.recordsPartial = true;
    while (value.records.length && bytes(value) > config.diagnosticBytes) { value.records.pop(); value.recordsPartial = true; }
    if (bytes(value) > config.diagnosticBytes) return;
    this.events.push(value);
    while (this.events.length > config.diagnosticEntries || bytes(this.events) > config.diagnosticBytes) this.events.shift();
  }
  recordSearch({ requestId, query, options, items, diagnostics }) {
    this.record({ kind: 'search_candidates', requestId, queryHash: sha(query), timeMode: options.timeMode, mode: options.mode,
      queryCacheHit: diagnostics.semantic.queryCacheHit, method: diagnostics.method,
      records: items.map(item => ({ id: item.id, score: item.score, channels: item.retrieval.channels,
        sourceHashes: (item.srcRefs ?? []).map(sourceKey).map(sha) })) });
  }
  recordExposure({ requestId, recordIds, kind = 'snapshot' }) {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256 || !['snapshot', 'tool_result'].includes(kind) || !Array.isArray(recordIds) || recordIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw retrievalError('SCHEMA_INVALID', 'Invalid bounded retrieval exposure');
    const existing = this.events.find(event => event.kind === kind && event.requestId === requestId);
    if (existing) return { duplicate: true, referenceOnly: true, automaticRecall: false };
    this.record({ kind, requestId, records: [...new Set(recordIds)].map(id => ({ id })) });
    return { duplicate: false, referenceOnly: true, automaticRecall: false };
  }
  clearDiagnostics() { this.events = []; return this.status(); }
  status() {
    const provider = this.provider(); this.prune(); const exposure = new Map();
    for (const event of this.events) if (['snapshot', 'tool_result'].includes(event.kind)) for (const { id } of event.records ?? []) {
      const row = exposure.get(id) ?? { recordId: id, snapshotReferences: 0, toolReferences: 0, windowReferences: 0, lastAt: null };
      row[event.kind === 'snapshot' ? 'snapshotReferences' : 'toolReferences']++; row.windowReferences++; row.lastAt = event.at; exposure.set(id, row);
    }
    return { referenceOnly: true, automaticRecall: false, semantic: { enabled: this.config().semanticEnabled, configured: Boolean(provider),
      provider: provider ? { id: provider.id, version: provider.version } : null, lastError: this.lastProviderError,
      cache: { entries: this.cache.size, documentEntries: [...this.cache.values()].filter(row => row.kind === 'document').length,
        queryEntries: [...this.cache.values()].filter(row => row.kind === 'query').length, bytes: this.cacheBytes,
        entryLimit: this.config().cacheEntries, byteLimit: this.config().cacheBytes, ttlMs: this.config().cacheTtlMs } },
      window: { entries: this.events.length, entryLimit: this.config().diagnosticEntries, byteLimit: this.config().diagnosticBytes, bytes: bytes(this.events), allTimeHistory: false },
      recent: structuredClone([...this.events].reverse()), exposure: [...exposure.values()].sort((a, b) => b.windowReferences - a.windowReferences || a.recordId.localeCompare(b.recordId)) };
  }
}
