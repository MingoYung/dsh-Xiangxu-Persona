import { createHash } from 'node:crypto';
import { sourceKey } from './schema.js';
import { retrievalRecordKey, temporalReference } from './retrieval.js';

const format = 'xiangxu-prepared-associations/1';
const recordsPerDocument = 128;
const leadsPerRecord = 4;
const handle = value => createHash('sha256').update(value).digest('base64url').slice(0, 22);
export const preparedAssociationBytes = 64 * 1024;
export const isPreparedAssociationPath = path => /^(?:global|people\/[A-Za-z0-9_-]{1,160})\/prepared-associations\.json$/.test(path);

function versions(documents) {
  return documents.map(({ recordType, document }) => [recordType, document?.version ?? null, document?.updatedAt ?? null]);
}

function evidence(meta, personId) {
  const knownPeople = new Set(meta.personIds), revokedIds = new Set(meta.revokedIds), revokedSources = new Set(meta.revokedSources);
  let hotSourceKeys;
  const acceptedSource = ref => {
    if (typeof ref?.sourceSessionId !== 'string' || !ref.sourceSessionId ||
      typeof ref.sourceEventId !== 'string' || !ref.sourceEventId) return false;
    const key = sourceKey(ref);
    if (revokedSources.has(key)) return false;
    if (Object.hasOwn(meta.sources, key)) {
      const receipt = meta.sources[key];
      return typeof receipt?.id === 'string' && receipt.id.length > 0 && !revokedIds.has(receipt.id);
    }
    // A hot receipt has a JSON source pair followed by :kind:block. Read the
    // pair intact so punctuation inside a source ID cannot become a separator.
    hotSourceKeys ??= new Set(Object.entries(meta.hotSources).flatMap(([receiptKey, eventId]) => {
      const match = /^(\["(?:[^"\\]|\\.)*","(?:[^"\\]|\\.)*"\]):/u.exec(receiptKey);
      return match && typeof eventId === 'string' && eventId ? [match[1]] : [];
    }));
    return hotSourceKeys.has(key);
  };
  return {
    accepts: item => item && item.scope === (personId ? 'person' : 'global') && (item.personId ?? null) === personId &&
      !item.retractedBy && !revokedIds.has(item.id) && Array.isArray(item.srcRefs) &&
      item.srcRefs.every(acceptedSource) && item.srcRefs.some(ref => ref.available !== false),
    // A person index can inherit its owner as a default tag. Only other
    // saved subjects in that scope can support a co-tag retrieval lead.
    subjects: item => (item.aboutPersonIds ?? []).filter(id => id !== personId && knownPeople.has(id)),
  };
}

export function buildPreparedAssociations(documents, meta, personId, runId, builtAt) {
  const live = evidence(meta, personId), rows = [], counts = new Map();
  let partial = false;
  documents.forEach(({ document }, documentIndex) => {
    const items = document?.items ?? [];
    partial ||= items.length > recordsPerDocument;
    for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    for (let index = Math.max(0, items.length - recordsPerDocument); index < items.length; index++) {
      const item = items[index];
      if (!live.accepts(item)) continue;
      const subjects = [...new Set(live.subjects(item).map(handle))];
      if (subjects.length) rows.push({ item, position: [documentIndex, index], subjects });
    }
  });
  rows.sort((a, b) => (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0) || a.item.id.localeCompare(b.item.id));
  const postings = new Map(), links = [];
  for (const entry of rows) for (const subject of entry.subjects) {
    const posting = postings.get(subject) ?? [];
    if (posting.length <= leadsPerRecord) posting.push(entry);
    else partial = true;
    postings.set(subject, posting);
  }
  for (const entry of rows) {
    if (counts.get(entry.item.id) !== 1) continue;
    const candidates = new Map();
    for (const subject of entry.subjects) for (const target of postings.get(subject)) {
      if (target !== entry && !candidates.has(target)) candidates.set(target, subject);
    }
    partial ||= candidates.size > leadsPerRecord;
    if (candidates.size) links.push([handle(entry.item.id), entry.position,
      [...candidates].slice(0, leadsPerRecord).map(([target, subject]) => [target.position, subject])]);
  }
  return { format, builtAt, runId, versions: versions(documents), partial, links };
}

export function readPreparedAssociations(cache, documents, meta, personId, input, now) {
  const finish = (status, items = [], extra = {}) => ({ items, diagnostics: { method: 'prepared_association',
    referenceOnly: true, automaticRecall: false, preparedAssociations: { status, ...extra } } });
  if (!cache) return finish('missing');
  if (cache.format !== format || !Number.isSafeInteger(cache.builtAt) || !Array.isArray(cache.links) ||
    cache.links.length > documents.length * recordsPerDocument) return finish('unavailable');
  if (JSON.stringify(cache.versions) !== JSON.stringify(versions(documents))) return finish('stale');
  const live = evidence(meta, personId), links = new Map(), seeds = new Set(input.seedIds), result = new Map();
  for (const row of cache.links) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[2]) || row[2].length > leadsPerRecord) return finish('unavailable');
    links.set(row[0], row);
  }
  function resolve(position) {
    if (!Array.isArray(position) || position.length !== 2 || !position.every(index => Number.isSafeInteger(index) && index >= 0)) return null;
    const selected = documents[position[0]], item = selected?.document?.items[position[1]];
    if (!live.accepts(item) || !temporalReference(item, input, now).eligible) return null;
    return { ...item, recordType: selected.recordType };
  }
  for (const seedId of seeds) {
    const match = links.get(handle(seedId));
    if (!match) continue;
    const seed = resolve(match[1]);
    if (seed?.id !== seedId) continue;
    const subjects = new Map(live.subjects(seed).map(id => [handle(id), id]));
    for (const lead of match[2]) {
      if (!Array.isArray(lead)) return finish('unavailable');
      const [position, subject] = lead, target = resolve(position), subjectPersonId = subjects.get(subject);
      if (!subjectPersonId || !target || seeds.has(target.id) || !live.subjects(target).includes(subjectPersonId)) continue;
      const recordKey = retrievalRecordKey(target);
      if (result.has(recordKey)) continue;
      result.set(recordKey, { ...target, recordKey, score: 0,
        retrieval: { channels: ['prepared_association'], referenceOnly: true, automaticRecall: false, preparedAssociation: {
          subjectPersonId, seed: { schemaVersion: seed.schemaVersion, id: seed.id, scope: seed.scope,
            personId: seed.personId ?? null, recordType: seed.recordType, srcRefs: seed.srcRefs },
        } } });
    }
  }
  return finish('ready', [...result.values()].slice(0, input.limit), { builtAt: cache.builtAt, partial: cache.partial === true || result.size > input.limit });
}
