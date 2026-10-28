import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, SchemaError, sourceKey, countChars, safeId, validateChat, validateSrcRef } from './schema.js';

export const TIMELINE_CATALOG = 'timeline/catalog.json';
export const TIMELINE_FORMAT = 'persona-timeline/1';
export const TIMELINE_FIELDS = Object.freeze(['title', 'background', 'process', 'outcome', 'details', 'feltThen', 'meaningNow', 'indexCodes', 'relatedMemoryIds']);
const strings = ['title', 'background', 'process', 'outcome', 'details', 'feltThen', 'meaningNow'];
export const shortPath = id => id ? 'people/' + safeId(id) + '/stream.jsonl' : 'staging/events.jsonl';
export const longPath = id => 'timeline/long/' + (id ? 'person-' + safeId(id) : 'unknown') + '.jsonl';
export const isTimelinePath = path => /^(people\/[^/]+\/stream|staging\/events|timeline\/long\/(unknown|person-[^/]+)|timeline\/archive\/\d{8})\.jsonl$/.test(path);
export const timelineOrder = (a, b) => a.sourceAt - b.sourceAt || String(a.eventId ?? '').localeCompare(String(b.eventId ?? '')) || a.id.localeCompare(b.id);
const bytes = rows => Buffer.byteLength(rows.map(JSON.stringify).join('\n') + (rows.length ? '\n' : ''));
export const timelineChars = row => countChars(row.text ?? '') + strings.reduce((sum, key) => sum + countChars(row.timeline?.[key] ?? ''), 0);
export function validateTimelineAnnotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError('Timeline annotation must be an object');
  for (const [key, field] of Object.entries(value)) {
    if (!TIMELINE_FIELDS.includes(key)) throw new SchemaError('Timeline source fields cannot be changed: ' + key);
    if (strings.includes(key)) { if (typeof field !== 'string') throw new SchemaError('Timeline ' + key + ' must be text'); }
    else if (!Array.isArray(field) || field.length > 128 || field.some(item => typeof item !== 'string' || !item || countChars(item) > 200)) throw new SchemaError('Timeline links must be bounded nonempty strings');
  }
  return value;
}
export function unifiedRecord(record) {
  validateChat(record);
  const prior = record.timeline ?? {};
  if (record.timeline) {
    if (prior.format !== TIMELINE_FORMAT || prior.occurredAt !== record.sourceAt || prior.recordedAt !== record.observedAt) throw new SchemaError('Timeline source time or format disagrees with the original');
    validateTimelineAnnotation(Object.fromEntries(TIMELINE_FIELDS.filter(key => Object.hasOwn(prior, key)).map(key => [key, prior[key]])));
    if (prior.provenance !== undefined) {
      if (!prior.provenance || typeof prior.provenance !== 'object' || Array.isArray(prior.provenance)) throw new SchemaError('Invalid timeline provenance');
      for (const [field, dependencies] of Object.entries(prior.provenance)) {
        if (!TIMELINE_FIELDS.includes(field) || !dependencies || !Array.isArray(dependencies.refs) || dependencies.refs.length > 128 || !Array.isArray(dependencies.recordIds) || dependencies.recordIds.length > 256 || dependencies.recordIds.some(id => typeof id !== 'string' || !id || countChars(id) > 200)) throw new SchemaError('Invalid bounded timeline field dependencies');
        dependencies.refs.forEach(validateSrcRef);
      }
    }
  }
  return { ...record, timeline: { format: TIMELINE_FORMAT, title: '', occurredAt: record.sourceAt, recordedAt: record.observedAt,
    background: '', process: '', outcome: '', details: '', feltThen: '', meaningNow: '', indexCodes: [], relatedMemoryIds: [], provenance: {}, ...prior } };
}
export function redactTimelineRecord(record, meta) {
  const row = unifiedRecord(record), sources = new Set(meta.revokedSources ?? []), ids = new Set(meta.revokedIds ?? []);
  let changed = false;
  for (const [field, dependencies] of Object.entries(row.timeline.provenance ?? {})) if (dependencies.refs.some(ref => sources.has(sourceKey(ref))) || dependencies.recordIds.some(id => ids.has(id))) {
    row.timeline = { ...row.timeline, [field]: ['indexCodes', 'relatedMemoryIds'].includes(field) ? [] : '', provenance: { ...row.timeline.provenance } };
    delete row.timeline.provenance[field]; changed = true;
  }
  return { record: row, changed };
}
export const emptyTimelineCatalog = () => ({ schemaVersion: SCHEMA_VERSION, format: 'persona-timeline-catalog/1', version: 0, nextShard: 1, archiveFiles: [],
  recent: { count: 0, chars: 0 }, long_term: { count: 0, chars: 0 }, archive: { count: 0, chars: 0 } });
export function validateTimelineCatalog(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.format !== 'persona-timeline-catalog/1' || !Number.isSafeInteger(value.version) || value.version < 0 || !Number.isSafeInteger(value.nextShard) || value.nextShard < 1 || !Array.isArray(value.archiveFiles)) throw new SchemaError('Invalid timeline catalog');
  const paths = new Set();
  for (const item of value.archiveFiles) {
    if (!/^timeline\/archive\/\d{8}\.jsonl$/.test(item.path) || paths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || ['count', 'chars', 'bytes'].some(key => !Number.isSafeInteger(item[key]) || item[key] < 0)) throw new SchemaError('Invalid archive shard descriptor');
    paths.add(item.path);
  }
  for (const tier of ['recent', 'long_term', 'archive']) if (!value[tier] || ['count', 'chars'].some(key => !Number.isSafeInteger(value[tier][key]) || value[tier][key] < 0)) throw new SchemaError('Invalid timeline counters');
  if (value.archiveFiles.some(item => Number(item.path.slice(-14, -6)) >= value.nextShard)) throw new SchemaError('Archive nextShard would reuse an existing shard');
  if (value.archive.count !== value.archiveFiles.reduce((sum, item) => sum + item.count, 0) || value.archive.chars !== value.archiveFiles.reduce((sum, item) => sum + item.chars, 0)) throw new SchemaError('Archive counters disagree with shard descriptors');
  return value;
}
export const archiveDescriptor = (path, rows) => { const text = rows.map(JSON.stringify).join('\n') + (rows.length ? '\n' : ''); return { path, count: rows.length,
  chars: rows.reduce((sum, row) => sum + timelineChars(row), 0), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }; };

/** Moving a record changes only its storage tier. It never invokes a model. */
export class TimelineStorage {
  constructor(store, getConfig, now) { this.store = store; this.getConfig = getConfig; this.now = now; }
  invalidate() { this._cache = null; }
  async catalog() {
    const stored = await this.store.readJson(TIMELINE_CATALOG);
    if (stored) return validateTimelineCatalog(stored);
    const meta = await this.store.readJson('meta/state.json');
    if (Object.values(meta?.sources ?? {}).some(receipt => receipt.storagePath) || (await this.store.listFiles('timeline/')).length) throw Object.assign(new Error('Known timeline storage is missing its catalog; no empty archive was substituted'), { code: 'MEMORY_REQUIRED_DOCUMENT_MISSING' });
    return emptyTimelineCatalog();
  }
  async readPath(path, catalog) {
    if (!isTimelinePath(path)) throw new SchemaError('Source receipt points outside timeline storage');
    if (!path.startsWith('timeline/archive/')) return this.store.readLines(path);
    const expected = (catalog ?? await this.catalog()).archiveFiles.find(item => item.path === path);
    if (!expected) throw new SchemaError('Source archive shard is missing from catalog');
    return this.store.readLinesVerified(path, expected);
  }
  async paths(meta, includeArchived = true) { return [...[null, ...meta.personIds].flatMap(id => [shortPath(id), longPath(id)]), ...(includeArchived ? (await this.catalog()).archiveFiles.map(item => item.path) : [])]; }
  async read(meta, { includeArchived = true, paths } = {}) {
    const rows = [], catalog = await this.catalog();
    for (const path of paths ?? await this.paths(meta, includeArchived)) for (const row of await this.readPath(path, catalog)) {
      if (meta.revokedIds.includes(row.id) || meta.revokedSources.includes(sourceKey(row))) continue;
      rows.push({ ...redactTimelineRecord(row, meta).record, tier: path.startsWith('timeline/archive/') ? 'archive' : path.startsWith('timeline/long/') ? 'long_term' : 'recent' });
    }
    return rows.sort(timelineOrder);
  }
  async plan(meta, writes) {
    const config = this.getConfig(), before = await this.catalog(), catalog = structuredClone(before), originals = new Map(), rows = [];
    writes.json ??= {}; writes.jsonl ??= {};
    const configKey = JSON.stringify([config.recentPreferredDays, config.recentTargetChars, config.longTermTargetChars]);
    const catalogKey = JSON.stringify(before), mutatingSources = Object.keys(writes.jsonl).some(isTimelinePath) || Boolean(writes.archiveSourceIds?.length);
    if (!mutatingSources && this._cache?.configKey === configKey && this._cache.catalogKey === catalogKey && this.now() < this._cache.nextExpiry) {
      await this.store.assertFileStates(this._cache.activeFiles); return { changed: false, catalog: before };
    }
    const removed = row => meta.revokedIds.includes(row.id) || meta.revokedSources.includes(sourceKey(row));
    for (const path of await this.paths(meta, false)) {
      const stored = await this.store.readLines(path); originals.set(path, stored);
      for (const row of writes.jsonl[path] ?? stored) if (!removed(row)) rows.push(redactTimelineRecord(row, meta).record);
    }
    const knownSources = Object.entries(meta.sources).filter(([key, receipt]) => receipt.storagePath && !receipt.storagePath.startsWith('timeline/archive/') && !meta.revokedSources.includes(key) && !meta.revokedIds.includes(receipt.id));
    for (const [key, receipt] of knownSources) {
      if (!isTimelinePath(receipt.storagePath)) throw new SchemaError('Source receipt points outside timeline storage');
      const original = originals.get(receipt.storagePath)?.filter(row => sourceKey(row) === key);
      if (original?.length !== 1 || original[0].id !== receipt.id) throw Object.assign(new Error('A known source original is missing or ambiguous; no timeline was rebuilt'), { code: 'MEMORY_SOURCE_UNAVAILABLE' });
    }
    const unique = new Map();
    for (const row of rows) { const key = sourceKey(row); if (unique.has(key)) throw new SchemaError('Timeline source has multiple physical originals'); unique.set(key, row); }
    const sorted = [...unique.values()].sort(timelineOrder), recent = [], long = [], archive = [];
    const forced = new Set(writes.archiveSourceIds ?? []);
    let recentChars = 0;
    const threshold = this.now() - config.recentPreferredDays * 86400000;
    for (const row of [...sorted].reverse()) {
      const size = timelineChars(row);
      if (forced.has(row.id) || forced.has(row.eventId)) archive.push(row);
      else if (row.sourceAt >= threshold && recentChars + size <= config.recentTargetChars) { recent.unshift(row); recentChars += size; }
      else long.unshift(row);
    }
    let longChars = long.reduce((sum, row) => sum + timelineChars(row), 0);
    while (longChars > config.longTermTargetChars && long.length) { const row = long.shift(); archive.push(row); longChars -= timelineChars(row); }
    const active = new Map([...originals.keys()].map(path => [path, []]));
    for (const [tier, items] of [['recent', recent], ['long_term', long]]) for (const row of items) {
      const path = tier === 'recent' ? shortPath(row.personId) : longPath(row.personId), next = { ...row, tier };
      active.get(path).push(next); const receipt = meta.sources[sourceKey(row)]; if (receipt) receipt.storagePath = path;
    }
    for (const [path, next] of active) { next.sort(timelineOrder); if (JSON.stringify(next) !== JSON.stringify(originals.get(path))) writes.jsonl[path] = next; else delete writes.jsonl[path]; }
    const maxShardBytes = Math.min(1048576, Math.max(1024, Math.floor(config.retention.journalMaxBytes / 4)));
    for (const row of archive.sort(timelineOrder)) {
      let path = catalog.archiveFiles.at(-1)?.path;
      let shard = path ? writes.jsonl[path] ?? await this.readPath(path, before) : [];
      const next = { ...row, tier: 'archive' };
      if (!path || (shard.length && bytes([...shard, next]) > maxShardBytes)) {
        if (catalog.nextShard > 99999999) throw Object.assign(new Error('Archive shard index capacity reached; no record was deleted'), { code: 'CAPACITY_EXCEEDED', resource: 'archiveShardIndex' });
        path = 'timeline/archive/' + String(catalog.nextShard++).padStart(8, '0') + '.jsonl'; shard = [];
        if (catalog.archiveFiles.some(item => item.path === path)) throw new SchemaError('Archive shard path is already cataloged');
        writes.expectedAbsent ??= []; writes.expectedAbsent.push(path);
        catalog.archiveFiles.push(archiveDescriptor(path, []));
      }
      if (!shard.some(item => sourceKey(item) === sourceKey(next))) shard = [...shard, next].sort(timelineOrder);
      writes.jsonl[path] = shard;
      const receipt = meta.sources[sourceKey(row)]; if (receipt) receipt.storagePath = path;
    }
    for (const [path, values] of Object.entries(writes.jsonl)) if (path.startsWith('timeline/archive/')) {
      const next = values.filter(row => !removed(row)).map(row => ({ ...unifiedRecord(row), tier: 'archive' })).sort(timelineOrder);
      writes.jsonl[path] = next; const index = catalog.archiveFiles.findIndex(item => item.path === path);
      if (index < 0) throw new SchemaError('Archive write is not in the timeline catalog');
      catalog.archiveFiles[index] = archiveDescriptor(path, next);
    }
    catalog.recent = { count: recent.length, chars: recentChars }; catalog.long_term = { count: long.length, chars: longChars };
    catalog.archive = { count: catalog.archiveFiles.reduce((sum, item) => sum + item.count, 0), chars: catalog.archiveFiles.reduce((sum, item) => sum + item.chars, 0) };
    const changed = JSON.stringify(catalog) !== JSON.stringify(before) || Object.keys(writes.jsonl).some(isTimelinePath);
    if (changed) { catalog.version++; catalog.updatedAt = this.now(); writes.json[TIMELINE_CATALOG] = validateTimelineCatalog(catalog); }
    this._cache = { configKey, catalogKey: JSON.stringify(catalog), nextExpiry: recent.reduce((deadline, row) => Math.min(deadline, row.sourceAt + config.recentPreferredDays * 86400000 + 1), Infinity),
      activeFiles: [...active].filter(([, items]) => items.length).map(([path, items]) => ({ path, bytes: bytes(items) })) };
    delete writes.archiveSourceIds;
    return { changed, catalog };
  }
}
