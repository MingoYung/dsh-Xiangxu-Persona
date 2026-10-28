import { RETRIEVAL_LIMITS, retrievalError } from './retrieval-config.js';
export const retrievalRecordKey = item => JSON.stringify([item.recordType ?? null, item.scope ?? null, item.personId ?? null, item.id]);

export function retrievalText(item) {
  return [item.text, item.meaning, item.label, item.desc, item.if, item.then, item.title, item.reference,
    item.experience, item.feltThen, item.meaningNow, ...(item.keys ?? []), ...(item.cues ?? []),
    ...['title', 'background', 'process', 'outcome', 'details', 'feltThen', 'meaningNow'].map(key => item.timeline?.[key]),
    ...(item.timeline?.indexCodes ?? [])].filter(value => typeof value === 'string').join(' ');
}
export function retrievalTerms(input) {
  const value = String(input ?? '').toLocaleLowerCase(), terms = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const text of value.match(/\p{Script=Han}+/gu) ?? []) { const points = Array.from(text); for (let i = 0; i < points.length - 1; i++) terms.push(points[i] + points[i + 1]); }
  return terms;
}
export function validateRetrievalInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw retrievalError('SCHEMA_INVALID', 'Search must be an object');
  const query = input.query ?? '';
  if (typeof query !== 'string' || Array.from(query).length > RETRIEVAL_LIMITS.queryChars) throw retrievalError('SCHEMA_INVALID', 'Search query must contain at most 2000 characters');
  const mode = input.mode ?? 'auto', timeMode = input.timeMode ?? 'all', depth = input.associationDepth ?? 1, diversity = input.diversity ?? 'none', limit = input.limit ?? 5;
  if (!['auto', 'lexical', 'hybrid'].includes(mode) || !['all', 'current', 'past', 'asOf'].includes(timeMode) || !['none', 'source'].includes(diversity)) throw retrievalError('SCHEMA_INVALID', 'Unknown retrieval mode');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000 || !Number.isSafeInteger(depth) || depth < 0 || depth > 2) throw retrievalError('SCHEMA_INVALID', 'Search limit/depth exceeds its technical range');
  if (input.asOf !== undefined && (!Number.isSafeInteger(input.asOf) || input.asOf < 0)) throw retrievalError('SCHEMA_INVALID', 'asOf must be epoch milliseconds');
  if (timeMode === 'asOf' && input.asOf === undefined || timeMode !== 'asOf' && input.asOf !== undefined) throw retrievalError('SCHEMA_INVALID', 'asOf is required only with timeMode:asOf');
  const seedIds = input.seedIds ?? [];
  if (!Array.isArray(seedIds) || seedIds.length > RETRIEVAL_LIMITS.seedIds || seedIds.some(id => typeof id !== 'string' || !id || Array.from(id).length > 200)) throw retrievalError('SCHEMA_INVALID', 'Search seedIds must contain at most 16 bounded record IDs');
  return { ...input, query, mode, timeMode, associationDepth: depth, diversity, limit, seedIds: [...new Set(seedIds)] };
}
export function temporalReference(item, { timeMode = 'all', asOf } = {}, now) {
  const from = Number.isSafeInteger(item.validFrom) ? item.validFrom : null, to = Number.isSafeInteger(item.validTo) ? item.validTo : null;
  const invalid = from !== null && to !== null && from > to;
  const at = timeMode === 'asOf' ? asOf : now, unknown = from === null && to === null;
  let eligible = true;
  if (timeMode === 'current' || timeMode === 'asOf') eligible = !invalid && (from === null || from <= at) && (to === null || at < to);
  if (timeMode === 'asOf' && item.recordType === 'chat' && Number.isSafeInteger(item.sourceAt) && item.sourceAt > at) eligible = false;
  if (timeMode === 'past') eligible = !invalid && to !== null && to <= now;
  return { eligible, mode: timeMode, at, validFrom: from, validTo: to,
    status: invalid ? 'invalid_interval' : unknown ? 'unspecified' : to !== null && to <= at ? 'ended' : from !== null && from > at ? 'not_started' : 'within_declared_interval',
    historicalDatabaseSnapshot: false };
}
export function lexicalCandidates(rows, query) {
  const normalized = query.toLocaleLowerCase(), unique = [...new Set(retrievalTerms(query))], documents = rows.map(item => {
    const text = retrievalText(item).toLocaleLowerCase(), terms = retrievalTerms(text), tf = new Map(); for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    return { item, text, tf, length: terms.length };
  });
  const df = new Map(); for (const { tf } of documents) for (const term of unique) if (tf.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const average = Math.max(1, documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length));
  return documents.map(doc => {
    let bm25 = 0; const matchedTerms = [];
    for (const term of unique) { const frequency = doc.tf.get(term) ?? 0; if (!frequency) continue; matchedTerms.push(term);
      const idf = Math.log(1 + (rows.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      bm25 += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / average)); }
    // Keep the old public score as text-match relevance for existing consumers.
    const exact = normalized && doc.text.includes(normalized) ? 2 : 0;
    const oldMatches = unique.filter(term => doc.text.includes(term));
    return { id: doc.item.id, key: retrievalRecordKey(doc.item), at: doc.item.createdAt ?? doc.item.sourceAt ?? 0,
      score: exact + (unique.length ? oldMatches.length / unique.length : 0), lexicalScore: bm25 + exact, matchedTerms };
  }).filter(row => !normalized || row.score > 0).sort((a, b) => b.lexicalScore - a.lexicalScore || b.score - a.score || b.at - a.at || a.key.localeCompare(b.key));
}
const fields = ['relatedMemoryIds', 'expandIds', 'supersedesIds', 'replacementIds', 'timeline.relatedMemoryIds'];
export function associationCandidates(rows, seeds, depth) {
  const counts = new Map(); for (const item of rows) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const allowed = new Map(rows.filter(item => counts.get(item.id) === 1).map(item => [item.id, item])), edges = new Map(); let truncated = false, missingLinks = 0, edgeCount = 0;
  const put = (from, to, field, direction) => { const list = edges.get(from) ?? []; list.push({ to, field, direction }); edges.set(from, list); edgeCount++; };
  outer: for (const item of rows) {
    if (!allowed.has(item.id)) continue;
    let links = 0;
    for (const field of fields) {
      const references = field === 'timeline.relatedMemoryIds' ? item.timeline?.relatedMemoryIds : item[field];
      for (const id of Array.isArray(references) ? references : []) {
      if (++links > RETRIEVAL_LIMITS.linksPerRecord) { truncated = true; break; }
      if (typeof id !== 'string' || !allowed.has(id)) { missingLinks++; continue; }
      if (edgeCount + 2 > RETRIEVAL_LIMITS.associationEdges) { truncated = true; break outer; }
      put(item.id, id, field, 'forward'); put(id, item.id, field, 'reverse');
      }
    }
  }
  const visited = new Set(seeds.filter(id => allowed.has(id))), queue = [...visited].map(id => ({ id, hops: 0, path: [] })), candidates = [];
  if (!depth) return { items: [], truncated, missingLinks };
  for (let cursor = 0; cursor < queue.length; cursor++) { const current = queue[cursor]; if (current.hops >= depth) continue;
    for (const edge of edges.get(current.id) ?? []) {
      if (visited.has(edge.to)) continue;
      if (visited.size >= RETRIEVAL_LIMITS.associationNodes) { truncated = true; break; }
      visited.add(edge.to); const next = { id: edge.to, key: retrievalRecordKey(allowed.get(edge.to)), hops: current.hops + 1, path: [...current.path, { from: current.id, to: edge.to, field: edge.field, direction: edge.direction }] };
      candidates.push(next); queue.push(next);
    }
  }
  return { items: candidates, truncated, missingLinks };
}
export function sourceGroup(item) {
  const refs = (item.srcRefs ?? []).filter(ref => typeof ref?.sourceSessionId === 'string' && typeof ref?.sourceEventId === 'string')
    .map(ref => JSON.stringify([ref.sourceSessionId, ref.sourceEventId])).sort();
  return refs.length ? JSON.stringify(refs) : 'record:' + retrievalRecordKey(item);
}
export function mergeCandidates(rows, lexical, semantic, association, options, now) {
  const byKey = new Map(rows.map(item => [retrievalRecordKey(item), item])), merged = new Map(), lexicalByKey = new Map(lexical.map(row => [row.key, row]));
  const add = (channel, values) => values.forEach((value, index) => {
    const item = byKey.get(value.key); if (!item) return;
    const row = merged.get(value.key) ?? { item, channels: [], rankScore: 0 };
    row.channels.push(channel); row.rankScore += 1 / (60 + index + 1);
    if (channel === 'semantic') row.semanticScore = value.score;
    if (channel === 'association') row.associationPaths = [value.path];
    merged.set(value.key, row);
  });
  add('lexical', lexical); add('semantic', semantic); add('association', association.items);
  // Explicit selected seeds remain discoverable even without matching prose.
  for (const item of rows) if (options.seedIds.includes(item.id) && !merged.has(retrievalRecordKey(item))) merged.set(retrievalRecordKey(item), { item, channels: ['seed'], rankScore: 1 / 61 });
  let ranked = [...merged.values()].sort((a, b) => b.rankScore - a.rankScore || (b.item.createdAt ?? b.item.sourceAt ?? 0) - (a.item.createdAt ?? a.item.sourceAt ?? 0) || String(a.item.id).localeCompare(String(b.item.id)));
  if (options.diversity === 'source') { const seen = new Set(), first = [], rest = []; for (const row of ranked) { const group = sourceGroup(row.item); if (seen.has(group)) rest.push(row); else { seen.add(group); first.push(row); } } ranked = [...first, ...rest]; }
  const selected = ranked.slice(0, options.limit);
  return { items: selected.map(row => { const lex = lexicalByKey.get(retrievalRecordKey(row.item)); return { ...row.item, score: lex?.score ?? 0,
    retrieval: { channels: row.channels, rankScore: row.rankScore, lexicalScore: lex?.lexicalScore ?? 0, semanticScore: row.semanticScore ?? null,
      matchedTerms: lex?.matchedTerms ?? [], associationPaths: row.associationPaths ?? [], temporal: temporalReference(row.item, options, now), referenceOnly: true, automaticRecall: false } }; }),
    candidateCount: ranked.length, distinctSourceGroups: new Set(selected.map(row => sourceGroup(row.item))).size };
}
