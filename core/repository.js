import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JsonStore } from './store.js';
import { extractSourceDependencies, hotSourceDependencies, dependenciesRevoked, temporaryCleanupPlan, runReferencesRevocation } from './source-dependencies.js';
import { countStringValues, serializedBytes, assertRecordCapacity, assertDocumentCapacity, assertFiniteReviewState, assertFiniteJson, capacityError } from './capacity.js';
import {
  SCHEMA_VERSION, SchemaError, defaultConfig, mergeConfig, emptyPersona, emptyRuntime,
  newId, sourceKey, countChars, safeId, validateChat, validateHot, validateMemoryItem,
  validatePersona, validateMeta, validateCode, validateSignature, validateFacet, validatePatch,
  validateRelationEvent, validateImpression, validateInterpretation, validateConfig, validateRuntime, validateSrcRef
} from './schema.js';

const copy = (v) => structuredClone(v);
const last = (rows, count) => count > 0 ? rows.slice(-count) : [];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const doc = (now) => ({ schemaVersion: SCHEMA_VERSION, version: 0, updatedAt: now, items: [] });
const conflict = (message) => Object.assign(new Error(message), { code: 'VERSION_CONFLICT' });
const personPath = (id, file) => 'people/' + safeId(id) + '/' + file;
const streamPath = (id) => id ? personPath(id, 'stream.jsonl') : 'staging/events.jsonl';
const hotPath = (id) => id ? personPath(id, 'hot.jsonl') : 'staging/hot.jsonl';
const sourceRef = (record, available = true) => ({
  sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, available,
  sourceKind: record.sourceKind, sourceRole: record.role, sourceOrigin: record.origin
});
const isHotParticipant = (record) => record.kind === 'dialogue' && record.origin === 'user' &&
  (record.sourceRef?.sourceRole == null || record.sourceRef.sourceRole === 'user');
const correctHotSpeakerPlaceholder = (record) => record.personId != null && record.speakerId === record.personId && !isHotParticipant(record)
  ? { ...record, speakerId: null } : record;
const initialMeta = () => ({ version: 0, sequence: 0, sources: {}, hotSources: {}, personIds: [], pending: [], assignments: [], revokedIds: [], revokedSources: [], completedRuns: [], lineage: {}, consolidationOffsets: {} });
const strings = countStringValues;
function keywords(query) {
  const value = String(query ?? '').toLocaleLowerCase();
  const terms = new Set(value.match(/[\p{L}\p{N}_]+/gu) ?? []);
  const han = value.match(/\p{Script=Han}+/gu) ?? [];
  for (const text of han) { for (let i = 0; i < text.length - 1; i++) terms.add(text.slice(i, i + 2)); }
  return [...terms];
}

export class MemoryRepository {
  constructor({ root, config = {}, clock = Date.now, fault = null }) {
    this.root = root; this.configOverrides = config; this.config = defaultConfig(config); this.clock = typeof clock === 'function' ? clock : () => clock.now();
    this.store = new JsonStore(root, { fault, journalMaxBytes: this.config.retention.journalMaxBytes, capacityLimits: this.config.capacityLimits, diskReserveBytes: this.config.diskReserveBytes });
    this._tail = Promise.resolve();
  }
  _queue(work) { const result = this._tail.then(work); this._tail = result.catch(() => {}); return result; }
  now() { return this.clock(); }
  async open() {
    try {
      await this.store.open({ preflight: async (reader) => {
        const stored = await reader.readJson('config.json'); if (stored) {
          validateConfig(stored); const deployment = defaultConfig(mergeConfig(stored, this.configOverrides ?? {}));
          this.store.capacityLimits = deployment.capacityLimits; this.store.diskReserveBytes = deployment.diskReserveBytes;
        }
        const persona = await reader.readJson('self/persona.json'); if (persona && persona.schemaVersion !== SCHEMA_VERSION) throw new SchemaError('Unsupported stored persona schemaVersion; source is preserved');
        const runtime = await reader.readJson('global/state.json'); if (runtime && runtime.schemaVersion !== SCHEMA_VERSION) throw new SchemaError('Unsupported stored runtime schemaVersion; source is preserved');
      } });
      const stored = await this.store.readJson('config.json');
      if (stored) this.config = defaultConfig(mergeConfig(stored, this.configOverrides ?? {}));
      else await this.store.transaction({ runId: newId('init'), json: { 'config.json': this.config, 'meta/state.json': initialMeta(), 'self/persona.json': emptyPersona(this.now()), 'global/state.json': emptyRuntime(this.now()) } });
      const meta = await this._meta(); const writes = { json: {}, jsonl: {} };
      const correctedSpeakers = await this._correctAssistantSpeakerPlaceholders(meta, writes);
      const cleanedDependencies = await this._cleanDependencyCaches(meta, writes, 'open_revocation_cleanup');
      if (correctedSpeakers || cleanedDependencies) await this._commit(meta, writes);
      return this;
    } catch (error) { await this.store.close(); throw error; }
  }
  close() { return this._queue(() => this.store.close()); }
  async _meta() { return this.store.readJson('meta/state.json', initialMeta()); }
  validateSourceRefs(refs, { requireOriginal = false } = {}) {
    return this._queue(async () => {
      if (!Array.isArray(refs)) throw new SchemaError('sourceRefs must be an array');
      refs.forEach(validateSrcRef);
      const meta = await this._meta();
      const originals = requireOriginal ? new Set((await this._records(meta)).map(sourceKey)) : null;
      for (const ref of refs) {
        const key = sourceKey(ref), receipt = meta.sources[key];
        if (meta.revokedSources.includes(key) || (receipt && meta.revokedIds.includes(receipt.id))) throw Object.assign(new Error('Source reference was explicitly revoked'), { code: 'SOURCE_REVOKED', sourceRef: copy(ref) });
        if (!receipt) throw Object.assign(new Error('Source reference does not identify an accepted stable event'), { code: 'SOURCE_UNKNOWN', sourceRef: copy(ref) });
        if (originals && !originals.has(key)) throw Object.assign(new Error('Source original is unavailable for reassignment'), { code: 'SOURCE_UNAVAILABLE', sourceRef: copy(ref) });
      }
      return copy(refs);
    });
  }
  async _runtime() { return this.store.readJson('global/state.json', emptyRuntime(this.now())); }
  async _persona() { return this.store.readJson('self/persona.json', emptyPersona(this.now())); }
  async _document(path) { return this.store.readJson(path, doc(this.now())); }
  _bump(value) { return { ...value, version: (value.version ?? 0) + 1, updatedAt: this.now() }; }
  _event(meta) { meta.sequence += 1; return 'ev_' + String(meta.sequence).padStart(20, '0'); }
  async _commit(meta, { json = {}, jsonl = {}, expectedVersions = {}, runId = newId('write') } = {}) {
    const priorVersion = meta.version; meta.version += 1;
    return this.store.transaction({ runId, json: { ...json, 'meta/state.json': meta }, jsonl, expectedVersions: { ...expectedVersions, 'meta/state.json': priorVersion } });
  }
  async _records(meta = null) {
    meta ??= await this._meta(); const rows = [];
    for (const id of [null, ...meta.personIds]) rows.push(...await this.store.readLines(streamPath(id)));
    return rows.filter((row) => !meta.revokedIds.includes(row.id) && !meta.revokedSources.includes(sourceKey(row)));
  }
  async _correctAssistantSpeakerPlaceholders(meta, writes) {
    let changed = false;
    for (const personId of [null, ...meta.personIds]) {
      const path = streamPath(personId), rows = writes.jsonl[path] ?? await this.store.readLines(path);
      let changedPath = false;
      const corrected = rows.map(record => {
        if (record.role !== 'assistant' || record.personId == null || record.speakerId !== record.personId) return record;
        changedPath = true; return { ...record, speakerId: null };
      });
      if (changedPath) { writes.jsonl[path] = corrected; changed = true; }
      const hp = hotPath(personId), hot = writes.jsonl[hp] ?? await this.store.readLines(hp);
      const correctedHot = hot.map(correctHotSpeakerPlaceholder);
      if (correctedHot.some((record, index) => record !== hot[index])) { writes.jsonl[hp] = correctedHot; changed = true; }
    }
    return changed;
  }
  async _hot(meta = null) {
    meta ??= await this._meta(); const rows = [];
    for (const id of [null, ...meta.personIds]) rows.push(...await this.store.readLines(hotPath(id)));
    const removed = new Set(temporaryCleanupPlan(rows, meta).removedIds);
    return rows.filter((row) => !removed.has(row.id));
  }
  async _cleanDependencyCaches(meta, writes, reason) {
    const paths = [null, ...meta.personIds].map(hotPath), current = new Map(), runs = [];
    for (const path of paths) current.set(path, writes.jsonl[path] ?? await this.store.readLines(path));
    for (const file of await this.store.listFiles('journal/runs/')) {
      const run = writes.json[file.path] ?? await this.store.readJson(file.path);
      if (run.status === 'prepared') runs.push({ path: file.path, run });
    }
    const records = [...current.values()].flat();
    const plan = temporaryCleanupPlan([...records, ...runs.flatMap(({ run }) => run.input?.hot ?? [])], meta);
    const removed = new Set(plan.removedIds), invalidated = [];
    for (const [path, rows] of current) {
      const keep = rows.filter((row) => !removed.has(row.id));
      if (keep.length !== rows.length) writes.jsonl[path] = keep;
    }
    for (const { path, run } of runs) if (runReferencesRevocation(run, meta, plan.removedIds)) {
      run.status = 'failed'; run.invalidation = { reason: 'source_revoked', at: this.now() };
      delete run.input; delete run.candidatePatch; delete run.validationError; delete run.attemptRecordedAt; delete run.reviewState; delete run.progressUpdatedAt;
      run.validatedPatch = []; writes.json[path] = run; invalidated.push(run.runId);
    }
    const removedCurrent = records.filter((record) => removed.has(record.id)).map((record) => record.id);
    if (!removedCurrent.length && !invalidated.length) return false;
    meta.invalidatedHotContextGroups = last(plan.contextGroups, 256);
    meta.dependencyCleanups = last([...(meta.dependencyCleanups ?? []), { at: this.now(), reason,
      sourceSessionIds: plan.affectedSessions.slice(0, 64), removedHotIds: removedCurrent.slice(0, 128),
      removedHotCount: removedCurrent.length, invalidatedRunIds: invalidated.slice(0, 128) }], 20);
    if (invalidated.length) {
      const runtime = writes.json['global/state.json'] ?? await this._runtime();
      if (invalidated.includes(runtime.activeRunId)) runtime.activeRunId = null;
      if (invalidated.includes(runtime.sleep?.wakeRunId)) runtime.sleep.wakeRunId = null;
      writes.json['global/state.json'] = this._bump(runtime);
    }
    return true;
  }
  async _capacity() {
    const files = await this.store.listFiles(); let persistentChars = 0; let hotChars = 0;
    for (const file of files) {
      if (/^(people\/[^/]+\/hot|staging\/hot)\.jsonl$/.test(file.path)) {
        for (const entry of await this.store.readLines(file.path)) if (entry.content?.mode === 'cached') hotChars += countChars(entry.content.text);
      } else if (/^(self\/(persona|history)\.json|global\/(index|codes)\.json|people\/[^/]+\/(stream\.jsonl|identity\.json|index\.json|codes\.json|impression\.json|pending\.json))$/.test(file.path) || file.path === 'staging/events.jsonl') {
        persistentChars += strings(file.path.endsWith('.jsonl') ? await this.store.readLines(file.path) : await this.store.readJson(file.path));
      }
    }
    const freeBytes = await this.store.availableBytes();
    return { persistentChars, hotChars, physicalBytes: files.reduce((sum, f) => sum + f.bytes, 0), freeBytes,
      longTermTargetChars: this.config.longTermTargetChars, tempTargetChars: this.config.tempTargetChars,
      pressure: { longTerm: persistentChars >= this.config.longTermTargetChars, hot: hotChars >= this.config.tempTargetChars, disk: freeBytes <= this.config.diskReserveBytes } };
  }
  getCapacity() { return this._queue(() => this._capacity()); }
  async _gap(meta, input, reason) {
    const runtime = await this._runtime();
    this._sourceCursor(runtime, input, false);
    const gap = { id: newId('gap'), sourceSessionId: input.sourceSessionId ?? input.sourceRef?.sourceSessionId,
      sourceEventId: input.sourceEventId ?? input.sourceRef?.sourceEventId ?? null,
      fromCursor: input.sourceCursor ?? input.sourceEventId ?? input.sourceRef?.sourceEventId ?? null,
      toCursor: input.sourceCursor ?? input.sourceEventId ?? input.sourceRef?.sourceEventId ?? null,
      reason, recoverable: Boolean(input.hostAvailable ?? input.content?.available), createdAt: this.now() };
    runtime.memoryGaps = [...(runtime.memoryGaps ?? []), gap].slice(-100);
    await this._commit(meta, { json: { 'global/state.json': this._bump(runtime) } });
    return { duplicate: false, record: null, eventId: null, gap };
  }
  _sourceCursor(runtime, input, recorded) {
    const sessionId = input.sourceSessionId ?? input.sourceRef?.sourceSessionId;
    if (!sessionId) return;
    const cursor = String(input.sourceCursor ?? input.sourceEventId ?? input.sourceRef?.sourceEventId ?? '');
    if (!cursor) return;
    runtime.ingestCursors ??= [];
    let row = runtime.ingestCursors.find((entry) => entry.sourceSessionId === sessionId);
    if (!row) { row = { sourceSessionId: sessionId, receivedThroughCursor: null, recordedThroughCursor: null }; runtime.ingestCursors.push(row); }
    row.receivedThroughCursor = cursor;
    if (recorded) row.recordedThroughCursor = cursor;
  }
  resolveMemoryGaps({ sourceSessionId, sourceCursor, sourceEventId, updateReceivedCursor = false } = {}) {
    return this._queue(async () => {
      if (typeof sourceSessionId !== 'string' || !sourceSessionId) throw new SchemaError('sourceSessionId is required');
      if (sourceCursor == null && !sourceEventId) throw new SchemaError('A successful source cursor or event ID is required');
      const runtime = await this._runtime(); const cursor = sourceCursor == null ? null : String(sourceCursor); const resolvedIds = [];
      runtime.memoryGaps = (runtime.memoryGaps ?? []).map((gap) => {
        if (gap.sourceSessionId !== sourceSessionId || gap.resolvedAt != null) return gap;
        const sameEvent = sourceEventId != null && gap.sourceEventId === String(sourceEventId);
        const sameCursor = cursor != null && (String(gap.fromCursor) === cursor || String(gap.toCursor) === cursor);
        if (!sameEvent && !sameCursor) return gap;
        resolvedIds.push(gap.id); return { ...gap, resolvedAt: this.now(), resolvedSourceCursor: cursor };
      });
      if (updateReceivedCursor && cursor != null) this._sourceCursor(runtime, { sourceSessionId, sourceCursor: cursor }, false);
      if (!resolvedIds.length && !updateReceivedCursor) return { resolvedIds, version: runtime.version };
      const next = this._bump(runtime);
      await this.store.transaction({ runId: newId('resolve-gap'), json: { 'global/state.json': next }, expectedVersions: { 'global/state.json': runtime.version } });
      return { resolvedIds, version: next.version };
    });
  }
  ingest(input) {
    return this._queue(async () => {
      const now = this.now();
      const personId = input.personId ?? null;
      const speakerId = Object.hasOwn(input, 'speakerId') ? input.speakerId : input.role === 'user' ? personId : null;
      const record = validateChat({ ...input, schemaVersion: SCHEMA_VERSION, id: input.id ?? newId('m'), eventId: '',
        personId, speakerId: input.role === 'assistant' && personId !== null && speakerId === personId ? null : speakerId,
        sourceAt: input.sourceAt ?? now, observedAt: input.observedAt ?? now, timezone: input.timezone ?? this.config.timezone,
        origin: input.origin ?? (input.role === 'user' ? 'user' : 'ai_reply'), text: input.text ?? '', chars: countChars(input.text ?? ''),
        proactiveId: input.proactiveId ?? null, reactionTo: input.reactionTo ?? null });
      const meta = await this._meta(); const key = sourceKey(record);
      if (meta.revokedSources.includes(key) || meta.revokedIds.includes(record.id)) return { duplicate: true, revoked: true, record: null, eventId: meta.sources[key]?.eventId ?? null };
      if (meta.sources[key]) return { duplicate: true, record: (await this._records(meta)).find((r) => sourceKey(r) === key) ?? null, eventId: meta.sources[key].eventId };
      const cap = await this._capacity();
      if (cap.pressure.disk || cap.persistentChars + strings(record) > this.config.longTermTargetChars || Buffer.byteLength(JSON.stringify(meta)) > this.config.retention.journalMaxBytes) return this._gap(meta, input, 'memory_copy_paused_at_capacity');
      if (record.personId && !meta.personIds.includes(record.personId)) throw new SchemaError('Unknown personId; upsertPerson before ingestion');
      record.eventId = this._event(meta);
      meta.sources[key] = { id: record.id, eventId: record.eventId, lastEventId: record.eventId, personId: record.personId, sourceAt: record.sourceAt };
      if (record.role === 'user') meta.pending.push(record.eventId);
      const path = streamPath(record.personId); const records = await this.store.readLines(path); records.push(record);
      const json = {};
      const runtime = await this._runtime(); this._sourceCursor(runtime, input, true);
      json['global/state.json'] = this._bump(runtime);
      if (record.personId) {
        const state = await this._personState(record.personId);
        if (record.role === 'user') state.pendingEventIds.push(record.eventId);
        if (record.role === 'user') state.lastSeenAt = record.sourceAt;
        else state.lastDeliveredAt = record.sourceAt;
        json[personPath(record.personId, 'state.json')] = this._bump(state);
      }
      try { await this._commit(meta, { json, jsonl: { [path]: records } }); }
      catch (error) { if (error.code !== 'CAPACITY_EXCEEDED') throw error; return this._gap(await this._meta(), input, 'memory_copy_paused_at_' + error.resource); }
      return { duplicate: false, record: copy(record), eventId: record.eventId };
    });
  }
  captureHot(input) {
    return this._queue(async () => {
      const now = this.now(); const meta = await this._meta();
      const ref = input.sourceRef ?? { sourceSessionId: input.sourceSessionId, sourceEventId: input.sourceEventId, available: true };
      if (meta.revokedSources.includes(sourceKey(ref))) return { duplicate: true, revoked: true, record: null, eventId: null };
      const key = sourceKey(ref) + ':' + input.kind + ':' + String(input.blockIndex ?? input.id ?? 0);
      if (meta.hotSources[key]) return { duplicate: true, record: null, eventId: meta.hotSources[key] };
      let content = input.content ?? { mode: 'cached', text: input.text ?? '', chars: countChars(input.text ?? '') };
      if (content.mode === 'cached') content = { ...content, chars: countChars(content.text) };
      if (input.dependencyRefs !== undefined) { if (!Array.isArray(input.dependencyRefs)) throw new SchemaError('dependencyRefs must be an array'); input.dependencyRefs.forEach(validateSrcRef); }
      if (input.dependencyRecordIds !== undefined && (!Array.isArray(input.dependencyRecordIds) || input.dependencyRecordIds.some((id) => typeof id !== 'string' || !id))) throw new SchemaError('dependencyRecordIds must contain nonempty strings');
      const dependencies = hotSourceDependencies({ ...input, content });
      if (!dependencies.complete) return this._gap(meta, input, 'hot_dependency_scan_incomplete');
      if (dependenciesRevoked(dependencies, meta)) return { duplicate: true, revoked: true, record: null, eventId: null };
      const annotatedInput = { ...input, sourceRef: ref, dependencyRefs: dependencies.refs, dependencyRecordIds: dependencies.recordIds, content };
      const legacyTrace = content.mode === 'host_trace' && !Array.isArray(input.dependencyRefs) && !Array.isArray(input.dependencyRecordIds);
      if (temporaryCleanupPlan([{ ...annotatedInput, id: '_pending_hot' }], meta).removedIds.length ||
        (legacyTrace && temporaryCleanupPlan([{ ...input, id: '_pending_hot', sourceRef: ref, content }], meta).removedIds.length)) return { duplicate: true, revoked: true, record: null, eventId: null };
      const cap = await this._capacity();
      if (cap.pressure.disk) return this._gap(meta, input, 'hot_copy_paused_at_disk_reserve');
      if (content.mode === 'cached' && cap.hotChars + content.chars > this.config.tempTargetChars) content = { mode: 'host_trace', locator: input.traceLocator ?? 'source:' + encodeURIComponent(sourceKey(ref)), available: Boolean(input.hostAvailable), chars: content.chars };
      const record = validateHot(correctHotSpeakerPlaceholder({ ...input, schemaVersion: SCHEMA_VERSION, id: input.id ?? newId('h'), eventId: this._event(meta),
        personId: input.personId ?? null, sourceRef: { available: true, ...ref }, sourceKind: input.sourceKind ?? input.kind,
        dependencyRefs: dependencies.refs, dependencyRecordIds: dependencies.recordIds, dependencyScanComplete: true,
        origin: input.origin ?? 'system', content, navigationSummary: input.navigationSummary ?? null,
        sourceAt: input.sourceAt ?? now, observedAt: input.observedAt ?? now }));
      if (serializedBytes(record) > this.config.retention.journalMaxBytes) return this._gap(meta, input, 'hot_pointer_metadata_capacity');
      if (record.personId && !meta.personIds.includes(record.personId)) throw new SchemaError('Unknown hot personId');
      const hotBytes = (await this.store.listFiles()).filter((f) => /(^|\/)hot\.jsonl$/.test(f.path)).reduce((sum, f) => sum + f.bytes, 0);
      if (hotBytes + Buffer.byteLength(JSON.stringify(record)) > this.config.retention.journalMaxBytes || Buffer.byteLength(JSON.stringify(meta)) > this.config.retention.journalMaxBytes) return this._gap(meta, input, 'hot_pointer_metadata_capacity');
      const path = hotPath(record.personId); const rows = await this.store.readLines(path); rows.push(record); meta.hotSources[key] = record.eventId;
      try { await this._commit(meta, { jsonl: { [path]: rows } }); }
      catch (error) { if (error.code !== 'CAPACITY_EXCEEDED') throw error; return this._gap(await this._meta(), input, 'hot_copy_paused_at_' + error.resource); }
      return { duplicate: false, record: copy(record), eventId: record.eventId,
        ...(content.mode === 'host_trace' && !content.available ? { gap: { reason: 'hot_context_source_unavailable', recoverable: false } } : {}) };
    });
  }
  async _personState(personId) {
    return this.store.readJson(personPath(personId, 'state.json'), { schemaVersion: SCHEMA_VERSION, version: 0, personId,
      lastSeenAt: null, lastDeliveredAt: null, relationDescription: '', pendingEventIds: [], updatedAt: this.now() });
  }
  upsertPerson(input = {}) {
    return this._queue(async () => {
      const personId = safeId(input.personId ?? newId('p')); const meta = await this._meta(); const now = this.now();
      const prior = await this.store.readJson(personPath(personId, 'identity.json'));
      const identity = this._bump({ schemaVersion: SCHEMA_VERSION, version: 0, personId, displayName: null, aliases: [],
        firstMetAt: now, locale: null, timezone: null, clues: [], ...prior, ...input, personId });
      if (!Array.isArray(identity.aliases) || !Array.isArray(identity.clues)) throw new SchemaError('aliases and clues must be arrays');
      assertRecordCapacity(identity, this.config.capacityLimits, 'identity');
      const json = { [personPath(personId, 'identity.json')]: identity };
      if (!meta.personIds.includes(personId)) {
        meta.personIds.push(personId); json[personPath(personId, 'state.json')] = await this._personState(personId);
        json[personPath(personId, 'impression.json')] = { schemaVersion: SCHEMA_VERSION, version: 0, personId, summary: '', signatures: [], coordinates: {}, events: [], updatedAt: now };
      }
      await this._enforceLimits({ json }); await this._commit(meta, { json }); return copy(identity);
    });
  }
  assign({ sourceSessionId, sourceEventId, personId, reason = '', environmentVersion = 0 }) {
    return this._queue(async () => {
      safeId(personId); const meta = await this._meta(); if (!meta.personIds.includes(personId)) throw new SchemaError('Assignment target is unknown');
      const key = sourceKey({ sourceSessionId, sourceEventId }); const source = meta.sources[key]; if (!source) throw new SchemaError('Assignment source is unknown');
      const oldPath = streamPath(source.personId); const oldRows = await this.store.readLines(oldPath); const record = oldRows.find((r) => sourceKey(r) === key);
      if (!record) throw Object.assign(new Error('Source original is no longer available'), { code: 'SOURCE_UNAVAILABLE' });
      if (source.personId === personId) return { assignment: null, record, duplicate: true };
      const eventId = this._event(meta);
      const assignment = { schemaVersion: SCHEMA_VERSION, id: newId('as'), eventId, sourceRef: sourceRef(record), previousPersonId: source.personId,
        personId, decidedAt: this.now(), environmentVersion, reason, supersedesAssignmentId: source.assignmentId ?? null };
      const oldPersonId = record.personId; record.personId = personId;
      if (record.role === 'user' && (record.speakerId == null || record.speakerId === oldPersonId)) record.speakerId = personId;
      else if (record.role === 'assistant' && oldPersonId !== null && record.speakerId === oldPersonId) record.speakerId = null;
      const nextPath = streamPath(personId); const nextRows = await this.store.readLines(nextPath); nextRows.push(record);
      const jsonl = { [oldPath]: oldRows.filter((r) => sourceKey(r) !== key), [nextPath]: nextRows };
      for (const id of new Set([oldPersonId, personId])) {
        const hp = hotPath(id); const rows = await this.store.readLines(hp);
        const relevant = rows.filter((r) => sourceKey(r.sourceRef) === key);
        if (id === oldPersonId && relevant.length) {
          jsonl[hp] = rows.filter((r) => sourceKey(r.sourceRef) !== key);
          jsonl[hotPath(personId)] = [...await this.store.readLines(hotPath(personId)), ...relevant.map((r) => {
            const next = correctHotSpeakerPlaceholder(r);
            return { ...next, personId, ...(isHotParticipant(r) && (r.speakerId == null || r.speakerId === oldPersonId) ? { speakerId: personId } : {}) };
          })];
        }
      }
      const json = {};
      if (oldPersonId) { const state = await this._personState(oldPersonId); state.pendingEventIds = state.pendingEventIds.filter((id) => id !== record.eventId); json[personPath(oldPersonId, 'state.json')] = this._bump(state); }
      const state = await this._personState(personId);
      if (meta.pending.includes(record.eventId) && !state.pendingEventIds.includes(record.eventId)) state.pendingEventIds.push(record.eventId);
      json[personPath(personId, 'state.json')] = this._bump(state);
      Object.assign(source, { personId, lastEventId: eventId, assignmentId: assignment.id });
      meta.assignments = [...meta.assignments, assignment].slice(-256);
      await this._commit(meta, { json, jsonl }); return { assignment, record: copy(record) };
    });
  }
  listPeople() {
    return this._queue(async () => { const meta = await this._meta(); return Promise.all(meta.personIds.map((id) => this.store.readJson(personPath(id, 'identity.json')))); });
  }
  async _allMemory(meta) {
    const rows = [];
    for (const id of [null, ...meta.personIds]) {
      const prefix = id ? 'people/' + id : 'global';
      for (const [file, type] of [['index.json', 'memory'], ['codes.json', 'code'], ['pending.json', 'interpretation']]) {
        if (!id && file === 'pending.json') continue;
        for (const item of (await this._document(prefix + '/' + file)).items) rows.push({ ...item, recordType: type });
      }
    }
    for (const record of await this._records(meta)) rows.push({ ...record, scope: record.personId ? 'person' : 'staging', epistemic: record.role === 'user' ? 'user_statement' : 'observed',
      srcRefs: [sourceRef(record)], aboutPersonIds: record.personId ? [record.personId] : [], recordType: 'chat' });
    const persona = await this._persona();
    for (const [field, type] of [['facets', 'facet'], ['signatures', 'signature'], ['habits', 'habit']]) for (const entry of persona[field]) rows.push({ ...entry, scope: entry.scope ?? 'global', personId: entry.personId ?? null, recordType: type });
    for (const personId of meta.personIds) {
      const impression = await this.store.readJson(personPath(personId, 'impression.json'));
      if (impression) {
        for (const entry of impression.signatures) rows.push({ ...entry, recordType: 'relation_signature' });
        for (const entry of impression.events) rows.push({ ...entry, recordType: 'relation_event' });
      }
    }
    return rows.filter((item) => !item.retractedBy && !meta.revokedIds.includes(item.id) && !(item.srcRefs?.length && item.srcRefs.every((ref) => meta.revokedSources.includes(sourceKey(ref)))));
  }
  async _search(input, context = {}) {
    const target = input.targetPersonId ?? context.personId ?? null; const scope = input.scope ?? 'person';
    if (!['person', 'global', 'all'].includes(scope)) throw new SchemaError('Unknown search scope');
    if (scope === 'person' && !target) return { items: [], needsTarget: true };
    if (target) safeId(target);
    const meta = await this._meta(); const terms = keywords(input.query); const normalizedQuery = String(input.query ?? '').toLocaleLowerCase();
    const limit = input.limit ?? 5; if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new SchemaError('limit must be integer 0..1000');
    const rows = (await this._allMemory(meta)).filter((item) => scope === 'all' || (scope === 'global' ? item.scope === 'global' : item.personId === target));
    const results = rows.map((item) => {
      const text = [item.text, item.meaning, item.label, item.desc, item.if, item.then, ...(item.keys ?? []), ...(item.cues ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
      const exact = normalizedQuery && text.includes(normalizedQuery) ? 2 : 0;
      const matches = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      const score = exact + (terms.length ? matches / terms.length : 0);
      return { ...item, score };
    }).filter((item) => !normalizedQuery || item.score > 0).sort((a, b) => b.score - a.score || (b.createdAt ?? b.sourceAt ?? 0) - (a.createdAt ?? a.sourceAt ?? 0));
    return { items: results.slice(0, limit) };
  }
  search(input, context = {}) { return this._queue(() => this._search(input, context)); }
  browseMemory({ query = '', scope = 'all', targetPersonId = null, recordType = null, offset = 0, limit = 50 } = {}) {
    return this._queue(async () => {
      if (!['all', 'person', 'global', 'unknown'].includes(scope)) throw new SchemaError('Unknown browse scope');
      if (typeof query !== 'string' || countChars(query) > 2000) throw new SchemaError('Browse query must contain at most 2000 characters');
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SchemaError('Browse offset/limit must be safe integers and limit 1..100');
      if (recordType !== null && (typeof recordType !== 'string' || recordType.length > 40)) throw new SchemaError('Invalid browse recordType');
      const meta = await this._meta();
      if (scope === 'person') {
        safeId(targetPersonId);
        if (!meta.personIds.includes(targetPersonId)) throw Object.assign(new Error('The selected person does not exist'), { code: 'UNKNOWN_PERSON_TARGET' });
      }
      const normalized = query.toLocaleLowerCase(), terms = keywords(query);
      let rows = (await this._allMemory(meta)).filter(item => scope === 'all' || (scope === 'global' ? item.scope === 'global' : scope === 'unknown' ? item.scope === 'staging' : item.personId === targetPersonId));
      if (recordType) rows = rows.filter(item => item.recordType === recordType);
      if (query) rows = rows.filter(item => {
        const body = [item.text, item.meaning, item.label, item.desc, item.if, item.then, ...(item.keys ?? []), ...(item.cues ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
        return body.includes(normalized) || terms.some(term => body.includes(term));
      });
      rows.sort((a, b) => (b.createdAt ?? b.sourceAt ?? 0) - (a.createdAt ?? a.sourceAt ?? 0) || String(a.id).localeCompare(String(b.id)));
      const revision = digest(JSON.stringify(rows));
      return { items: copy(rows.slice(offset, offset + limit)), total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, revision };
    });
  }
  getMemoryRecord(id) {
    return this._queue(async () => {
      if (typeof id !== 'string' || !id || countChars(id) > 200) throw new SchemaError('A bounded memory record ID is required');
      return copy((await this._allMemory(await this._meta())).find(item => item.id === id) ?? null);
    });
  }
  getPersona() { return this._queue(() => this._persona()); }
  getRuntime() { return this._queue(() => this._runtime()); }
  saveRuntime(state, { expectedVersion = state.version } = {}) {
    return this._queue(async () => {
      if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.memoryGaps) || !state.sleep || !state.schedule) throw new SchemaError('Invalid RuntimeState');
      const current = await this._runtime(); if (expectedVersion !== undefined && current.version !== expectedVersion) throw conflict('Runtime changed');
      const next = this._bump({ ...copy(state), version: current.version });
      await this.store.transaction({ runId: newId('runtime'), json: { 'global/state.json': next }, expectedVersions: { 'global/state.json': current.version } }); return next;
    });
  }
  patchRuntime(base, next) {
    return this._queue(async () => {
      validateRuntime(base); validateRuntime(next);
      const current = await this._runtime(); validateRuntime(current);
      const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
      const changed = [...keys].filter((key) => !['version', 'updatedAt'].includes(key) &&
        (Object.hasOwn(base, key) !== Object.hasOwn(next, key) || !isDeepStrictEqual(base[key], next[key])));
      for (const key of changed) {
        if (Object.hasOwn(current, key) !== Object.hasOwn(base, key) || !isDeepStrictEqual(current[key], base[key])) throw conflict('Runtime key changed concurrently: ' + key);
      }
      if (!changed.length) return copy(current);
      const merged = copy(current);
      for (const key of changed) {
        if (Object.hasOwn(next, key)) merged[key] = copy(next[key]);
        else delete merged[key];
      }
      const stored = this._bump(merged); validateRuntime(stored);
      await this.store.transaction({ runId: newId('runtime-patch'), json: { 'global/state.json': stored }, expectedVersions: { 'global/state.json': current.version } });
      return stored;
    });
  }
  getPersonState(id) { return this._queue(() => this._personState(id)); }
  savePersonState(id, state, { expectedVersion = state.version } = {}) {
    return this._queue(async () => {
      const current = await this._personState(id); if (expectedVersion !== undefined && expectedVersion !== current.version) throw conflict('Person state changed');
      const next = this._bump({ ...copy(state), personId: safeId(id), version: current.version });
      await this.store.transaction({ runId: newId('personstate'), json: { [personPath(id, 'state.json')]: next }, expectedVersions: { [personPath(id, 'state.json')]: current.version } }); return next;
    });
  }
  async _context({ personId = null, query } = {}) {
    const meta = await this._meta(); const all = await this._records(meta); const records = all.filter((r) => r.personId === personId);
    const recent = []; let chars = 0;
    for (const row of [...records].sort((a, b) => b.sourceAt - a.sourceAt)) {
      if (chars + row.chars > this.config.recentTargetChars) continue;
      recent.push(row); chars += row.chars;
    }
    recent.reverse();
    const emptyImpression = { schemaVersion: SCHEMA_VERSION, version: 0, personId, summary: '', signatures: [], coordinates: {}, events: [], updatedAt: this.now() };
    const result = { persona: await this._persona(),
      identity: personId ? await this.store.readJson(personPath(personId, 'identity.json')) : null,
      impression: personId ? await this.store.readJson(personPath(personId, 'impression.json'), emptyImpression) : emptyImpression,
      interpretations: personId ? (await this._document(personPath(personId, 'pending.json'))).items : [],
      codes: [...(await this._document('global/codes.json')).items, ...(personId ? (await this._document(personPath(personId, 'codes.json'))).items : [])],
      state: personId ? await this._personState(personId) : null, records, recent, pending: records.filter((r) => meta.pending.includes(r.eventId)),
      memories: query ? (await this._search({ query }, { personId })).items : [] };
    const eligible = entries => entries.filter(entry => entry.scope !== 'person' || entry.personId === personId);
    const persona = { ...result.persona, facets: eligible(result.persona.facets), signatures: eligible(result.persona.signatures), habits: eligible(result.persona.habits) };
    const lineageRefs = [];
    const paths = ['self/persona.json', 'global/codes.json', ...(personId ? ['impression', 'pending', 'codes'].map(file => personPath(personId, file + '.json')) : [])];
    const personaKeys = new Set(['anchor', 'axes', ...['facets', 'signatures', 'habits'].flatMap(field => persona[field].map(entry => field + ':' + entry.id))]);
    for (const path of paths) for (const [field, roots] of Object.entries(meta.lineage?.[path] ?? {})) {
      if (path === 'self/persona.json' && !personaKeys.has(field)) continue;
      for (const root of roots) { try { const [sourceSessionId, sourceEventId] = JSON.parse(root); lineageRefs.push({ sourceSessionId, sourceEventId }); } catch {} }
    }
    const dependencies = extractSourceDependencies({ persona, impression: result.impression, interpretations: result.interpretations, codes: result.codes, memories: result.memories, lineageRefs });
    result.sourceDependencies = { refs: dependencies.refs, recordIds: dependencies.recordIds };
    return result;
  }
  getContext(input = {}) { return this._queue(() => this._context(input)); }
  getPending({ personId } = {}) {
    return this._queue(async () => { const meta = await this._meta(); return (await this._records(meta)).filter((r) => meta.pending.includes(r.eventId) && (personId === undefined || r.personId === personId)); });
  }
  readSources({ eventIds, sourceRefs } = {}) {
    return this._queue(async () => {
      if (eventIds !== undefined && (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== 'string' || !id))) throw new SchemaError('eventIds must be an array of nonempty strings');
      if (sourceRefs !== undefined && !Array.isArray(sourceRefs)) throw new SchemaError('sourceRefs must be an array');
      sourceRefs?.forEach(validateSrcRef);
      const events = new Set(eventIds ?? []), sources = new Set((sourceRefs ?? []).map(sourceKey));
      if (!events.size && !sources.size) return [];
      const meta = await this._meta();
      return copy((await this._records(meta)).filter((record) => events.has(record.eventId) || sources.has(sourceKey(record))));
    });
  }
  clearPending(ids) {
    return this._queue(async () => {
      if (!Array.isArray(ids)) throw new SchemaError('pending ids must be an array');
      const meta = await this._meta(); const set = new Set(ids); meta.pending = meta.pending.filter((id) => !set.has(id)); const json = {};
      for (const id of meta.personIds) { const state = await this._personState(id); const pending = state.pendingEventIds.filter((eventId) => !set.has(eventId)); if (pending.length !== state.pendingEventIds.length) json[personPath(id, 'state.json')] = this._bump({ ...state, pendingEventIds: pending }); }
      await this._commit(meta, { json }); return { cleared: ids };
    });
  }
  introspect(input = {}, context = {}) {
    return this._queue(async () => {
      const target = input.targetPersonId ?? context.personId ?? null; const section = input.section ?? 'all';
      if (section === 'state') return { ...await this._runtime(), personState: target ? await this._personState(target) : null, capacity: await this._capacity() };
      const data = await this._context({ personId: target });
      if (section === 'all') return data;
      if (section === 'relation') return data.impression;
      if (!['anchor', 'axes', 'facets', 'signatures', 'habits'].includes(section)) throw new SchemaError('Unknown introspection section');
      return data.persona[section];
    });
  }
  async _evict(meta, ids, writes) {
    const selected = new Set(ids); const removedRefs = [];
    for (const personId of [null, ...meta.personIds]) {
      const path = streamPath(personId); const rows = writes.jsonl[path] ?? await this.store.readLines(path);
      const removed = rows.filter((r) => (selected.has(r.id) || selected.has(r.eventId)) && !meta.pending.includes(r.eventId));
      if (!removed.length) continue;
      removed.forEach((r) => removedRefs.push(sourceKey(r)));
      writes.jsonl[path] = rows.filter((r) => !removed.includes(r));
    }
    const set = new Set(removedRefs);
    const mark = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(mark);
      const result = {};
      for (const [key, item] of Object.entries(value)) result[key] = mark(item);
      if (typeof value.sourceSessionId === 'string' && typeof value.sourceEventId === 'string' && set.has(sourceKey(value)) && Object.hasOwn(value, 'available')) result.available = false;
      return result;
    };
    for (const file of await this.store.listFiles()) if (/^(self\/persona\.json|global\/(index|codes)\.json|people\/[^/]+\/(index|codes|impression|pending)\.json)$/.test(file.path)) {
      const before = writes.json[file.path] ?? await this.store.readJson(file.path); const after = mark(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) writes.json[file.path] = this._bump(after);
    }
    return removedRefs;
  }
  evictSources(ids) {
    return this._queue(async () => { const meta = await this._meta(); const writes = { json: {}, jsonl: {} }; const removed = await this._evict(meta, ids, writes); await this._commit(meta, writes); return { removed }; });
  }
  forget(input, context = {}) {
    return this._queue(async () => {
      if (!(Array.isArray(input.ids) && input.ids.length) && input.before === undefined) return { needsSelection: true };
      const personId = input.targetPersonId ?? context.personId ?? null;
      if (input.scope !== undefined && !['person', 'unknown', 'global'].includes(input.scope)) throw new SchemaError('Unknown explicit forgetting scope');
      const nullScope = ['unknown', 'global'].includes(input.scope) ? input.scope : null;
      if (nullScope && (!(Array.isArray(input.ids) && input.ids.length) || input.before !== undefined)) throw new SchemaError('Unknown/global forgetting requires explicit record IDs without a before selector');
      if (!nullScope && !personId) return { needsTarget: true };
      if (!nullScope) safeId(personId);
      if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) throw new SchemaError('before must be epoch ms');
      const meta = await this._meta(); const all = await this._allMemory(meta); const ids = new Set(input.ids ?? []);
      const chosen = all.filter((r) => (nullScope ? r.scope === (nullScope === 'unknown' ? 'staging' : 'global') : r.personId === personId) && (ids.has(r.id) || ids.has(r.eventId) || (input.before !== undefined && (r.createdAt ?? r.sourceAt) < input.before)));
      const refs = chosen.flatMap((r) => r.srcRefs ?? []); const refKeys = new Set(refs.map(sourceKey)); const affected = new Set(chosen.map((r) => r.id));
      const revocation = { schemaVersion: SCHEMA_VERSION, id: newId('rv'), eventId: this._event(meta), action: input.action ?? 'forget', personId: nullScope ? null : personId,
        ...(nullScope ? { scope: nullScope } : {}),
        targetIds: [...affected], targetSrcRefs: [...new Map(refs.map((r) => [sourceKey(r), { ...r, summary: undefined }])).values()],
        replacementIds: input.replacementIds ?? [], reason: input.reason ?? '', createdAt: this.now() };
      if (!['forget', 'correction'].includes(revocation.action)) throw new SchemaError('Unknown revocation action');
      const writes = { json: {}, jsonl: {} };
      const dependent = (entry) => affected.has(entry.id) || (entry.srcRefs?.length && entry.srcRefs.some((r) => refKeys.has(sourceKey(r))));
      for (const file of await this.store.listFiles()) {
        if (/^(self\/persona\.json|global\/(index|codes)\.json|people\/[^/]+\/(index|codes|impression|pending)\.json)$/.test(file.path)) {
          const data = await this.store.readJson(file.path);
          const walk = (value) => {
            if (Array.isArray(value)) return value.filter((v) => { if (v && typeof v === 'object' && dependent(v)) { if (v.id) affected.add(v.id); return false; } return true; }).map(walk);
            if (!value || typeof value !== 'object') return value;
            const out = {}; for (const [key, v] of Object.entries(value)) out[key] = walk(v); return out;
          };
          let next = walk(data);
          const lineage = meta.lineage?.[file.path] ?? {};
          for (const [field, refs] of Object.entries(lineage)) if (refs.some((key) => refKeys.has(key))) {
            if (field === 'anchor' && next.anchor) next.anchor = { text: '', changedAt: this.now(), srcRefs: [] };
            else if (field === 'axes') next.axes = {};
            else if (field === 'summary') next.summary = '';
            else if (field === 'coordinates') next.coordinates = {};
            delete lineage[field];
          }
          if (JSON.stringify(next) !== JSON.stringify(data)) writes.json[file.path] = this._bump(next);
        }
      }
      // Remove original selected sources and matching temporary process material.
      for (const id of [null, ...meta.personIds]) {
        const sp = streamPath(id); const rows = await this.store.readLines(sp); const remain = rows.filter((r) => !refKeys.has(sourceKey(r)));
        if (remain.length !== rows.length) writes.jsonl[sp] = remain;
      }
      meta.revokedIds = [...new Set([...meta.revokedIds, ...affected])]; meta.revokedSources = [...new Set([...meta.revokedSources, ...refKeys])];
      const revokedEvents = new Set(Object.entries(meta.sources).filter(([key]) => refKeys.has(key)).map(([, info]) => info.eventId));
      meta.pending = meta.pending.filter((eventId) => !revokedEvents.has(eventId));
      for (const id of meta.personIds) { const state = await this._personState(id); const pending = state.pendingEventIds.filter((eventId) => !revokedEvents.has(eventId)); if (pending.length !== state.pendingEventIds.length) writes.json[personPath(id, 'state.json')] = this._bump({ ...state, pendingEventIds: pending }); }
      const snapshots = await this.store.readLines('global/snapshots.jsonl');
      writes.jsonl['global/snapshots.jsonl'] = snapshots.filter((snapshot) => !(snapshot.injectedIds ?? []).some((id) => affected.has(id)));
      writes.jsonl['global/revocations.jsonl'] = [...await this.store.readLines('global/revocations.jsonl'), revocation];
      // Clear bounded rollback versions so explicitly forgotten text cannot be revived by rollback.
      writes.json['self/history.json'] = { schemaVersion: SCHEMA_VERSION, versions: [] };
      await this._cleanDependencyCaches(meta, writes, 'explicit_revocation');
      await this._commit(meta, writes); return { revocation, affectedIds: [...affected] };
    });
  }
  _docPath(key) {
    if (key === 'persona') return 'self/persona.json';
    if (/^global:(index|codes)$/.test(key)) return 'global/' + key.split(':')[1] + '.json';
    const parts = key.split(':'); if (parts.length === 3 && parts[0] === 'person' && ['index', 'codes', 'impression', 'pending'].includes(parts[2])) return personPath(parts[1], parts[2] + '.json');
    throw new SchemaError('Uncontrolled documentKey');
  }
  async prepareConsolidation({ personId = null, maxInputChars = this.config.processingLimits.consolidationInputChars, boundedContext = true } = {}) {
    return this._queue(async () => {
      if (personId !== null) safeId(personId); if (!Number.isFinite(maxInputChars) || maxInputChars <= 0) throw new SchemaError('maxInputChars must be positive');
      const meta = await this._meta();
      if (personId !== null && !meta.personIds.includes(personId)) throw Object.assign(new Error('The selected consolidation person does not exist; use null for unknown material'), { code: 'UNKNOWN_PERSON_TARGET', personId });
      const runtime = await this._runtime(); const cursorKey = personId ? 'person:' + personId : 'global';
      const cursor = runtime.consolidationCursors?.[cursorKey]?.lastCommittedEventId ?? '';
      const chat = (await this._records(meta)).filter((r) => r.personId === personId && meta.sources[sourceKey(r)].lastEventId > cursor);
      const hot = (await this._hot(meta)).filter((r) => r.personId === personId && r.eventId > cursor);
      const candidates = [...chat.map((r) => ({ type: 'chat', record: r, eventId: meta.sources[sourceKey(r)].lastEventId })), ...hot.map((r) => ({ type: 'hot', record: r, eventId: r.eventId }))].sort((a, b) => a.eventId.localeCompare(b.eventId));
      const selected = []; const inputSlices = []; let chars = 0; let inputEndEventId = cursor || 'ev_00000000000000000000';
      for (const candidate of candidates) {
        const text = candidate.type === 'chat' ? candidate.record.text : (candidate.record.content.mode === 'cached' ? candidate.record.content.text : '');
        const points = Array.from(text); const key = candidate.type + ':' + candidate.record.id;
        const from = meta.consolidationOffsets?.[key] ?? 0; const available = Math.max(0, maxInputChars - chars);
        if (points.length > from && available === 0) break;
        const to = Math.min(points.length, from + available); const complete = to >= points.length;
        const record = copy(candidate.record);
        if (from > 0 || !complete) {
          record.fragment = { from, to, total: points.length };
          if (candidate.type === 'chat') { record.text = points.slice(from, to).join(''); record.chars = to - from; }
          else record.content = { ...record.content, text: points.slice(from, to).join(''), chars: to - from };
        }
        selected.push({ ...candidate, record, complete }); inputSlices.push({ key, from, to, total: points.length, complete });
        chars += to - from;
        if (complete) inputEndEventId = candidate.eventId;
        else break;
      }
      const keys = ['persona', 'global:index', 'global:codes', ...(personId ? ['index', 'codes', 'impression', 'pending'].map((type) => 'person:' + personId + ':' + type) : [])];
      const inputVersions = {}; for (const key of keys) inputVersions[key] = (await this.store.readJson(this._docPath(key)))?.version ?? 0;
      const runId = newId('run');
      const context = await this._context({ personId });
      const consolidationContext = Object.fromEntries(['persona', 'identity', 'impression', 'interpretations', 'codes', 'state', 'sourceDependencies'].map((key) => [key, context[key]]));
      const run = { schemaVersion: SCHEMA_VERSION, runId, personId, inputEndEventId, inputVersions, validatedPatch: [], commitMarker: null, status: 'prepared',
        ...(boundedContext ? { boundedContext: true, reviewState: { contextComplete: false, modelCalls: 0 } } : {}),
        inputSlices,
        consumedHotRefs: selected.filter((r) => r.type === 'hot' && r.complete).map((r) => ({ hotRecordId: r.record.id, eventId: r.record.eventId })),
        cursorBefore: copy(runtime.consolidationCursors ?? {}), cursorAfter: { [cursorKey]: { lastCommittedEventId: inputEndEventId || null, lastRunId: runId } },
        input: { chat: selected.filter((r) => r.type === 'chat').map((r) => r.record), hot: selected.filter((r) => r.type === 'hot').map((r) => r.record), context: consolidationContext } };
      await this._cleanupRuns(meta.completedRuns, serializedBytes(run));
      const runBytes = (await this.store.listFiles('journal/runs/')).reduce((sum, file) => sum + file.bytes, 0);
      if (runBytes + Buffer.byteLength(JSON.stringify(run)) > this.config.retention.journalMaxBytes) throw Object.assign(new Error('Consolidation workspace capacity reached; recover/finish an existing run or choose a smaller input'), { code: 'CAPACITY_EXCEEDED' });
      await this.store.transaction({ runId: 'prepare-' + runId, json: { ['journal/runs/' + runId + '.json']: run } }); return copy(run);
    });
  }
  _normalizeMeta(value, { personId, run, id }) {
    return { schemaVersion: SCHEMA_VERSION, id, scope: personId ? 'person' : 'global', personId: personId ?? null, epistemic: 'interpretation',
      srcRefs: run.input.chat.map((r) => sourceRef(r)), createdAt: this.now(), updatedAt: this.now(), retractedBy: null, ...copy(value), id };
  }
  _assertNotRevoked(record, meta) {
    if (meta.revokedIds.includes(record.id) || record.srcRefs?.some((ref) => meta.revokedSources.includes(sourceKey(ref)))) throw Object.assign(new Error('Patch references explicitly revoked memory'), { code: 'REVOKED_SOURCE' });
  }
  async applyConsolidation(run, patch) {
    return this._queue(async () => {
      validatePatch(patch); const entries = Array.isArray(patch) ? patch : patch.entries; const meta = await this._meta();
      const savedRun = await this.store.readJson('journal/runs/' + safeId(run.runId, 'runId') + '.json');
      if (!savedRun && meta.completedRuns.includes(run.runId)) return { committed: true, duplicate: true, run: { schemaVersion: SCHEMA_VERSION, runId: run.runId, status: 'committed' } };
      if (!savedRun) throw new SchemaError('Unknown consolidation run');
      if (savedRun.status === 'committed' || meta.completedRuns.includes(run.runId)) return { committed: true, duplicate: true, run: savedRun };
      if (savedRun.status === 'failed') throw Object.assign(new Error('Consolidation input was invalidated; prepare a new run'), { code: 'RUN_INVALIDATED' });
      run = savedRun; const writes = { json: {}, jsonl: {}, expectedVersions: {} }; const changed = new Map();
      const runtimeBefore = await this._runtime();
      for (const key of Object.keys(run.cursorAfter)) if ((runtimeBefore.consolidationCursors?.[key]?.lastCommittedEventId ?? null) !== (run.cursorBefore?.[key]?.lastCommittedEventId ?? null)) throw conflict('Consolidation source cursor advanced; prepare a new run');
      for (const slice of run.inputSlices ?? []) if ((meta.consolidationOffsets?.[slice.key] ?? 0) !== slice.from) throw conflict('Consolidation fragment was already consumed by another run');
      for (const entry of entries) {
        if (!Object.hasOwn(run.inputVersions, entry.documentKey)) throw new SchemaError('Patch targets a document outside this run');
        if (entry.operation === 'upsert') {
          assertFiniteJson(entry.value);
          if (!((entry.documentKey === 'persona' && entry.recordId === 'axes') || (entry.documentKey.endsWith(':impression') && entry.recordId === 'coordinates'))) {
            assertRecordCapacity(entry.value, this.config.capacityLimits, entry.documentKey + '/' + entry.recordId);
          }
        }
        const path = this._docPath(entry.documentKey); let document = changed.get(path);
        if (!document) {
          document = await this.store.readJson(path, entry.documentKey === 'persona' ? emptyPersona(this.now()) : doc(this.now()));
          if (document.version !== run.inputVersions[entry.documentKey] || entry.expectedVersion !== document.version) throw conflict('Stale consolidation input: ' + entry.documentKey);
          writes.expectedVersions[path] = document.version; changed.set(path, document);
        } else if (entry.expectedVersion !== run.inputVersions[entry.documentKey]) throw conflict('Inconsistent patch version');
        const parts = entry.documentKey.split(':'); const target = parts[0] === 'person' ? parts[1] : null;
        meta.lineage ??= {}; meta.lineage[path] ??= {};
        if (entry.operation === 'remove') delete meta.lineage[path][entry.recordId];
        else {
          const refs = entry.value?.srcRefs ?? run.input.chat.map((r) => sourceRef(r));
          for (const ref of refs) if (meta.revokedSources.includes(sourceKey(ref))) throw Object.assign(new Error('Patch depends on explicitly revoked source'), { code: 'REVOKED_SOURCE' });
          meta.lineage[path][entry.recordId] = [...new Set(refs.map(sourceKey))];
        }
        if (entry.documentKey === 'persona') {
          if (entry.recordId === 'anchor') {
            if (entry.operation === 'remove') throw new SchemaError('Remove anchor by upserting empty text, not deleting structural field');
            document.anchor = { text: entry.value.text, changedAt: this.now(), srcRefs: entry.value.srcRefs ?? [] };
            if (document.anchor.srcRefs.some((r) => meta.revokedSources.includes(sourceKey(r)))) throw Object.assign(new Error('Anchor source was revoked'), { code: 'REVOKED_SOURCE' });
          } else if (entry.recordId === 'axes') {
            if (entry.operation === 'upsert' && run.boundedContext === true && run.reviewState?.contextComplete !== true &&
              Object.keys(document.axes).some(key => !Object.hasOwn(entry.value ?? {}, key))) throw Object.assign(new Error('Read the complete frozen axes context before replacing a map with omitted keys'), { code: 'CONTEXT_NOT_READ', documentKey: entry.documentKey, recordId: entry.recordId });
            document.axes = entry.operation === 'remove' ? {} : copy(entry.value);
          }
          else {
            const split = entry.recordId.indexOf(':'); const field = entry.recordId.slice(0, split); const id = entry.recordId.slice(split + 1);
            if (!['facets', 'signatures', 'habits', 'retired'].includes(field) || split < 0 || !id) throw new SchemaError('Unknown persona patch field');
            document[field] = document[field].filter((v) => (v.id ?? v.entry?.id) !== id);
            if (entry.operation === 'upsert') { const item = field === 'retired' ? copy(entry.value) : this._normalizeMeta(entry.value, { personId: entry.value.personId ?? null, run, id }); this._assertNotRevoked(item, meta); document[field].push(item); }
          }
          validatePersona(document);
        } else if (parts.at(-1) === 'impression') {
          if (!target) throw new SchemaError('Impression needs person target');
          if (!document.personId) document = { schemaVersion: SCHEMA_VERSION, version: document.version, personId: target, summary: '', signatures: [], coordinates: {}, events: [], updatedAt: this.now() };
          changed.set(path, document);
          if (entry.recordId === 'summary') {
            if (entry.operation === 'upsert' && typeof entry.value !== 'string') throw new SchemaError('Impression summary must be a string');
            document.summary = entry.operation === 'remove' ? '' : entry.value;
          }
          else if (entry.recordId === 'coordinates') {
            if (entry.operation === 'upsert' && run.boundedContext === true && run.reviewState?.contextComplete !== true &&
              Object.keys(document.coordinates).some(key => !Object.hasOwn(entry.value ?? {}, key))) throw Object.assign(new Error('Read the complete frozen coordinates context before replacing a map with omitted keys'), { code: 'CONTEXT_NOT_READ', documentKey: entry.documentKey, recordId: entry.recordId });
            document.coordinates = entry.operation === 'remove' ? {} : copy(entry.value);
          }
          else {
            const [field, id] = entry.recordId.split(':'); if (!['signatures', 'events'].includes(field) || !id) throw new SchemaError('Unknown impression patch field');
            document[field] = document[field].filter((v) => v.id !== id);
            if (entry.operation === 'upsert') {
              const item = this._normalizeMeta(entry.value, { personId: target, run, id }); this._assertNotRevoked(item, meta);
              if (item.personId !== target) throw new SchemaError('Impression subject mismatch');
              if (field === 'signatures') validateSignature(item); else validateRelationEvent(item);
              document[field].push(item);
            }
          }
          validateImpression(document);
        } else {
          const field = parts.at(-1); document.items = document.items.filter((v) => v.id !== entry.recordId);
          if (entry.operation === 'upsert') {
            let value = this._normalizeMeta(entry.value, { personId: target, run, id: entry.recordId });
            if (value.personId !== target || value.scope !== (target ? 'person' : 'global')) throw new SchemaError('Patch record subject disagrees with its document');
            if (field === 'index') value = validateMemoryItem({ kind: 'fact', keys: [], importance: null, aboutPersonIds: target ? [target] : [], validFrom: null, validTo: null, supersedesIds: [], ...value });
            else if (field === 'codes') value = validateCode({ cues: [], expandIds: [], occurrences: 0, lastUsedAt: null, ...value });
            else { value.questions ??= []; validateInterpretation(value); }
            this._assertNotRevoked(value, meta); document.items.push(value);
          }
        }
      }
      for (const [path, data] of changed) writes.json[path] = this._bump(data);
      if (changed.has('self/persona.json')) {
        const history = await this.store.readJson('self/history.json', { schemaVersion: SCHEMA_VERSION, versions: [] });
        history.versions.push(await this._persona());
        history.versions = last(history.versions, this.config.retention.personaHistoryMaxVersions);
        while (history.versions.length && Buffer.byteLength(JSON.stringify(history)) > Math.min(this.config.retention.backupMaxBytes, this.config.capacityLimits.documentBytes)) history.versions.shift();
        writes.json['self/history.json'] = history;
      }
      const evictions = Array.isArray(patch) ? [] : patch.evictSourceIds ?? [];
      if (evictions.length) await this._evict(meta, evictions, writes);
      const selectedHot = new Set(run.consumedHotRefs.map((r) => r.hotRecordId));
      for (const id of [null, ...meta.personIds]) {
        const path = hotPath(id); const rows = await this.store.readLines(path);
        if (rows.some((r) => selectedHot.has(r.id))) writes.jsonl[path] = rows.filter((r) => !selectedHot.has(r.id));
      }
      const runtime = await this._runtime();
      meta.consolidationOffsets ??= {};
      for (const slice of run.inputSlices ?? []) {
        if (slice.complete) delete meta.consolidationOffsets[slice.key];
        else meta.consolidationOffsets[slice.key] = slice.to;
      }
      runtime.consolidationCursors = { ...runtime.consolidationCursors, ...run.cursorAfter };
      if (runtime.activeRunId === run.runId) runtime.activeRunId = null;
      writes.json['global/state.json'] = this._bump(runtime); writes.expectedVersions['global/state.json'] = runtime.version;
      const committed = { ...run, validatedPatch: copy(entries), status: 'committed', commitMarker: { committedAt: this.now(), manifestHash: digest(JSON.stringify(entries)) } };
      delete committed.input; delete committed.candidatePatch; delete committed.validationError; delete committed.attemptRecordedAt; delete committed.reviewState; delete committed.progressUpdatedAt;
      if (run.reviewState) committed.reviewState = { modelCalls: run.reviewState.modelCalls ?? 0, stage: 'committed', contextComplete: run.reviewState.contextComplete === true };
      writes.json['journal/runs/' + run.runId + '.json'] = committed;
      meta.completedRuns = [...meta.completedRuns, run.runId].slice(-128);
      await this._enforceLimits(writes);
      await this._commit(meta, { ...writes, runId: 'commit-' + run.runId });
      await this._cleanupRuns(meta.completedRuns);
      return { committed: true, duplicate: false, run: committed };
    });
  }
  async _cleanupRuns(retain, reserveBytes = 0) {
    const files = await this.store.listFiles('journal/runs/'); let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const remove = [], runs = [];
    for (const file of files) {
      const run = await this.store.readJson(file.path); runs.push({ file, run });
    }
    runs.sort((a, b) => (a.run.commitMarker?.committedAt ?? a.run.invalidation?.at ?? 0) - (b.run.commitMarker?.committedAt ?? b.run.invalidation?.at ?? 0));
    let failed = runs.filter(({ run }) => run.status === 'failed').length;
    for (const { file, run } of runs) {
      const pressure = bytes + reserveBytes > this.config.retention.journalMaxBytes;
      if ((run.status === 'committed' && (!retain.includes(run.runId) || pressure)) || (run.status === 'failed' && (failed > 128 || pressure))) {
        remove.push(file.path); bytes -= file.bytes; if (run.status === 'failed') failed--;
      }
    }
    if (remove.length) await this.store.transaction({ runId: newId('prune-runs'), remove });
  }
  recordConsolidationAttempt(runId, { candidatePatch, validationError } = {}) {
    return this._queue(async () => {
      const path = 'journal/runs/' + safeId(runId, 'runId') + '.json';
      const run = await this.store.readJson(path);
      if (!run) throw new SchemaError('Unknown consolidation run');
      if (run.status === 'failed') throw Object.assign(new Error('Consolidation input was invalidated'), { code: 'RUN_INVALIDATED' });
      if (run.status !== 'prepared') throw Object.assign(new Error('Only a prepared consolidation run can retain an uncommitted candidate'), { code: 'RUN_NOT_PREPARED' });
      if (!validationError || typeof validationError.message !== 'string' || !validationError.message) throw new SchemaError('validationError.message is required');
      if (validationError.code != null && typeof validationError.code !== 'string') throw new SchemaError('validationError.code must be a string');
      const diagnostic = { code: validationError.code ?? null, message: validationError.message };
      if (validationError.responseText !== undefined) {
        const response = validationError.responseText;
        assertFiniteJson(response);
        const fragment = response?.fragment;
        if (!response || Array.isArray(response) || response.format !== 'text_fragment' || typeof response.text !== 'string' ||
          !fragment || Array.isArray(fragment) || fragment.from !== 0 || !Number.isSafeInteger(fragment.to) || !Number.isSafeInteger(fragment.total) ||
          fragment.to < 0 || fragment.total < fragment.to || fragment.to !== countChars(response.text) ||
          typeof fragment.complete !== 'boolean' || fragment.complete !== (fragment.to === fragment.total) ||
          typeof response.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(response.sha256) ||
          (response.pointer !== undefined && typeof response.pointer !== 'string')) throw new SchemaError('validationError.responseText must be a source-faithful text fragment with its full response SHA256');
        if (fragment.to > this.config.processingLimits.consolidationContextChars) throw capacityError('consolidationContextChars', fragment.to, this.config.processingLimits.consolidationContextChars, 'validationError.responseText');
        diagnostic.responseText = copy(response);
      }
      let candidate;
      assertFiniteJson(candidatePatch);
      try { candidate = JSON.parse(JSON.stringify(candidatePatch)); } catch { throw new SchemaError('candidatePatch must be JSON serializable'); }
      const meta = await this._meta();
      if (runReferencesRevocation({ input: run.input, candidatePatch: candidate, validationError: diagnostic }, meta)) throw Object.assign(new Error('Candidate or consolidation input references an explicitly revoked source'), { code: 'SOURCE_REVOKED' });
      const next = { ...run, candidatePatch: candidate, validationError: diagnostic, attemptRecordedAt: this.now() };
      const files = await this.store.listFiles('journal/runs/');
      const totalBytes = files.reduce((sum, file) => sum + (file.path === path ? 0 : file.bytes), 0) + Buffer.byteLength(JSON.stringify(next) + '\n');
      if (totalBytes > this.config.retention.journalMaxBytes) throw Object.assign(new Error('Consolidation candidate exceeds workspace capacity'), { code: 'CAPACITY_EXCEEDED' });
      await this.store.transaction({ runId: newId('consolidation-attempt'), json: { [path]: next } });
      return copy(next);
    });
  }
  getConsolidationRun(runId) { return this._queue(() => this.store.readJson('journal/runs/' + safeId(runId, 'runId') + '.json')); }
  refreshConsolidationContext(runId) {
    return this._queue(async () => {
      const path = 'journal/runs/' + safeId(runId, 'runId') + '.json', run = await this.store.readJson(path);
      if (!run) throw new SchemaError('Unknown consolidation run');
      if (run.status === 'failed') throw Object.assign(new Error('Consolidation input was invalidated'), { code: 'RUN_INVALIDATED' });
      if (run.status !== 'prepared') throw Object.assign(new Error('Only prepared work can refresh its unreviewed context'), { code: 'RUN_NOT_PREPARED' });
      if (run.reviewState?.modelCalls !== 0 || Object.hasOwn(run, 'candidatePatch')) throw conflict('Reviewed work or a retained candidate cannot be rebased automatically');
      if (runReferencesRevocation(run, await this._meta())) throw Object.assign(new Error('Consolidation source was revoked'), { code: 'SOURCE_REVOKED' });
      const context = await this._context({ personId: run.personId });
      const next = copy(run); next.input.context = Object.fromEntries(['persona', 'identity', 'impression', 'interpretations', 'codes', 'state', 'sourceDependencies'].map(key => [key, context[key]]));
      for (const key of Object.keys(next.inputVersions)) next.inputVersions[key] = (await this.store.readJson(this._docPath(key)))?.version ?? 0;
      const files = await this.store.listFiles('journal/runs/'), bytes = files.reduce((sum, file) => sum + (file.path === path ? 0 : file.bytes), 0) + serializedBytes(next);
      if (bytes > this.config.retention.journalMaxBytes) throw capacityError('consolidationWorkspaceBytes', bytes, this.config.retention.journalMaxBytes, path);
      await this.store.transaction({ runId: newId('consolidation-context'), json: { [path]: next } }); return copy(next);
    });
  }
  recordConsolidationProgress(runId, { reviewState, candidatePatch } = {}) {
    return this._queue(async () => {
      const path = 'journal/runs/' + safeId(runId, 'runId') + '.json', run = await this.store.readJson(path);
      if (!run) throw new SchemaError('Unknown consolidation run');
      if (run.status === 'failed') throw Object.assign(new Error('Consolidation input was invalidated'), { code: 'RUN_INVALIDATED' });
      if (run.status !== 'prepared') throw Object.assign(new Error('Only prepared work can save review progress'), { code: 'RUN_NOT_PREPARED' });
      assertFiniteReviewState(reviewState, this.config.capacityLimits);
      if (candidatePatch !== undefined) assertFiniteJson(candidatePatch);
      const next = { ...run, reviewState: copy(reviewState), progressUpdatedAt: this.now(), ...(candidatePatch === undefined ? {} : { candidatePatch: copy(candidatePatch) }) };
      if (runReferencesRevocation(next, await this._meta())) throw Object.assign(new Error('Progress references an explicitly revoked source'), { code: 'SOURCE_REVOKED' });
      const files = await this.store.listFiles('journal/runs/');
      const bytes = files.reduce((sum, file) => sum + (file.path === path ? 0 : file.bytes), 0) + serializedBytes(next);
      if (bytes > this.config.retention.journalMaxBytes) throw capacityError('consolidationWorkspaceBytes', bytes, this.config.retention.journalMaxBytes, path);
      await this.store.transaction({ runId: newId('consolidation-progress'), json: { [path]: next } }); return copy(next);
    });
  }
  listConsolidationRuns({ status } = {}) {
    return this._queue(async () => {
      const files = await this.store.listFiles('journal/runs/'); const runs = [];
      for (const file of files) { const run = await this.store.readJson(file.path); if (!status || run.status === status) runs.push(run); }
      return runs;
    });
  }
  getPersonaHistory() {
    return this._queue(async () => (await this.store.readJson('self/history.json', { versions: [] })).versions);
  }
  rollbackPersona(version) {
    return this._queue(async () => {
      const history = await this.store.readJson('self/history.json', { schemaVersion: SCHEMA_VERSION, versions: [] });
      const selected = history.versions.find((v) => v.version === version);
      if (!selected) throw Object.assign(new Error('Requested persona version is not in bounded history'), { code: 'VERSION_UNAVAILABLE' });
      const meta = await this._meta(); const prior = await this._persona();
      const next = this._bump({ ...copy(selected), version: prior.version });
      const check = (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.id && meta.revokedIds.includes(v.id)) throw Object.assign(new Error('History contains revoked record'), { code: 'REVOKED_SOURCE' });
        if (v.sourceSessionId && v.sourceEventId && meta.revokedSources.includes(sourceKey(v))) throw Object.assign(new Error('History contains revoked source'), { code: 'REVOKED_SOURCE' });
        Object.values(v).forEach(check);
      };
      check(next); validatePersona(next);
      history.versions = last([...history.versions.filter((v) => v.version !== version), prior], this.config.retention.personaHistoryMaxVersions);
      const writes = { json: { 'self/persona.json': next, 'self/history.json': history }, expectedVersions: { 'self/persona.json': prior.version } };
      await this._enforceLimits(writes); await this._commit(meta, writes);
      return next;
    });
  }
  async _enforceLimits(writes) {
    for (const [path, document] of Object.entries(writes.json ?? {})) {
      const limits = this.config.artifactLimits;
      if (/^(self\/(persona|history)\.json|global\/(index|codes)\.json|people\/[^/]+\/(identity|index|codes|impression|pending)\.json)$/.test(path)) assertDocumentCapacity(document, this.config.capacityLimits, path);
      if (path === 'self/persona.json') {
        if (Object.keys(document.axes).length > limits.axes || document.facets.filter((r) => r.kind === 'tendency').length > limits.tendencyFacets || document.facets.filter((r) => r.kind === 'boundary').length > limits.boundaryFacets || document.signatures.length > limits.signatures || document.habits.length > limits.habits) throw Object.assign(new Error('Persona patch exceeds configured storage capacity; choose a smaller patch or adjust resource limits'), { code: 'CAPACITY_EXCEEDED' });
        assertRecordCapacity(document.anchor, this.config.capacityLimits, path + '/anchor');
        for (const [key, axis] of Object.entries(document.axes)) assertRecordCapacity(axis, this.config.capacityLimits, path + '/axes/' + key);
        for (const field of ['facets', 'signatures', 'habits', 'retired']) for (const item of document[field]) assertRecordCapacity(item, this.config.capacityLimits, path + '/' + field);
      } else if (document.items) {
        const limit = path.endsWith('/index.json') ? limits.indexItemsPerPerson : path.endsWith('/codes.json') ? limits.codesPerScope : limits.interpretationsPerPerson;
        if (document.items.length > limit) throw Object.assign(new Error('Patch exceeds configured item capacity'), { code: 'CAPACITY_EXCEEDED' });
        for (const item of document.items) assertRecordCapacity(item, this.config.capacityLimits, path + '/' + item.id);
      } else if (path.endsWith('/impression.json') && (document.signatures.length > limits.impressionSignaturesPerPerson || document.events.length > limits.relationEventsPerPerson)) throw Object.assign(new Error('Impression exceeds configured capacity'), { code: 'CAPACITY_EXCEEDED' });
      if (path.endsWith('/impression.json')) {
        assertRecordCapacity(document.summary, this.config.capacityLimits, path + '/summary');
        for (const [key, coordinate] of Object.entries(document.coordinates)) assertRecordCapacity(coordinate, this.config.capacityLimits, path + '/coordinates/' + key);
        for (const item of [...document.signatures, ...document.events]) assertRecordCapacity(item, this.config.capacityLimits, path + '/' + item.id);
      }
    }
    const current = await this._capacity(); let delta = 0;
    for (const [path, value] of Object.entries(writes.json ?? {})) if (/^(self\/(persona|history)\.json|global\/(index|codes)\.json|people\/[^/]+\/(identity|index|codes|impression|pending)\.json)$/.test(path)) delta += strings(value) - strings(await this.store.readJson(path));
    for (const [path, value] of Object.entries(writes.jsonl ?? {})) if (/stream\.jsonl$|staging\/events\.jsonl$/.test(path)) delta += strings(value) - strings(await this.store.readLines(path));
    if (current.persistentChars + delta > this.config.longTermTargetChars) throw Object.assign(new Error('Patch exceeds total persistent memory target'), { code: 'CAPACITY_EXCEEDED' });
  }
  getOutbox() { return this._queue(() => this.store.readLines('global/outbox.jsonl')); }
  saveOutbox(records) {
    return this._queue(async () => {
      if (!Array.isArray(records)) throw new SchemaError('Outbox records must be an array');
      for (const row of records) if (!row.deliveryId || !['pending', 'submitted', 'delivered', 'cancelled', 'unknown'].includes(row.status)) throw new SchemaError('Invalid outbox status/ID');
      const unresolved = records.filter((r) => !['delivered', 'cancelled'].includes(r.status));
      const completed = last(records.filter((r) => ['delivered', 'cancelled'].includes(r.status)), this.config.retention.snapshotMaxRequests);
      const next = [...unresolved, ...completed];
      if (Buffer.byteLength(JSON.stringify(next)) > this.config.retention.journalMaxBytes) throw Object.assign(new Error('Outbox metadata capacity reached'), { code: 'CAPACITY_EXCEEDED' });
      await this.store.transaction({ runId: newId('outbox'), jsonl: { 'global/outbox.jsonl': next } }); return copy(next);
    });
  }
  saveSnapshot(snapshot) {
    return this._queue(async () => {
      const rows = await this.store.readLines('global/snapshots.jsonl');
      const next = last([...rows.filter((r) => r.requestId !== snapshot.requestId), copy(snapshot)], this.config.retention.snapshotMaxRequests);
      await this.store.transaction({ runId: newId('snapshot'), jsonl: { 'global/snapshots.jsonl': next } }); return copy(snapshot);
    });
  }
  getSnapshots() { return this._queue(() => this.store.readLines('global/snapshots.jsonl')); }
  recordUsage(entry) {
    return this._queue(async () => {
      const rows = await this.store.readLines('global/usage.jsonl');
      if (entry.requestId && rows.some((record) => record.requestId === entry.requestId)) return { ...rows.find((record) => record.requestId === entry.requestId), duplicate: true };
      const checkpoints = await this.store.readJson('global/usage-checkpoints.json', { schemaVersion: SCHEMA_VERSION, sessions: {} });
      const native = /^dsh:(.*):([0-9]+)$/.exec(entry.requestId ?? '');
      if (native && Number(native[2]) <= (checkpoints.sessions[native[1]] ?? -1)) return { requestId: entry.requestId, duplicate: true, checkpointed: true };
      if (native) checkpoints.sessions[native[1]] = Number(native[2]);
      const next = [...rows, { at: this.now(), ...copy(entry) }].slice(-Math.max(100, this.config.retention.snapshotMaxRequests));
      await this.store.transaction({ runId: newId('usage'), json: { 'global/usage-checkpoints.json': checkpoints }, jsonl: { 'global/usage.jsonl': next } }); return next.at(-1);
    });
  }
  getUsage() { return this._queue(() => this.store.readLines('global/usage.jsonl')); }
  updateConfig(partial) {
    return this._queue(async () => {
      const next = defaultConfig(mergeConfig(this.config, partial));
      const previous = { capacityLimits: this.store.capacityLimits, journalMaxBytes: this.store.journalMaxBytes, diskReserveBytes: this.store.diskReserveBytes };
      Object.assign(this.store, { capacityLimits: next.capacityLimits, journalMaxBytes: next.retention.journalMaxBytes, diskReserveBytes: next.diskReserveBytes });
      try { await this.store.transaction({ runId: newId('config'), json: { 'config.json': next } }); }
      catch (error) { Object.assign(this.store, previous); throw error; }
      this.config = next; return copy(next);
    });
  }
}
