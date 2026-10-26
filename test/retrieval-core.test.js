import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalCandidates, associationCandidates, mergeCandidates, validateRetrievalInput, temporalReference } from '../core/retrieval.js';
const row = (id, text, extra = {}) => ({ id, text, scope: 'global', personId: null, recordType: 'memory', createdAt: 10, srcRefs: [], ...extra });

test('lexical relevance uses text and corpus, not importance, owner labels or exposure', () => {
  const rows = [row('ordinary', '共同回忆 喝茶', { importance: 0, owner: false, hits: 0 }), row('owner', '共同回忆 喝茶', { importance: 1, owner: true, hits: 9999 })];
  const result = lexicalCandidates(rows, '喝茶'); assert.equal(result[0].score, result[1].score); assert.equal(result[0].lexicalScore, result[1].lexicalScore);
  assert.equal(result[0].id, 'ordinary'); assert.ok(result[0].matchedTerms.includes('喝茶'));
});
test('declared validity selects current, ended past and asOf without suppressing a superseded open interval', () => {
  const old = row('old', '以前的看法', { validFrom: 10, validTo: 20 }), current = row('new', '后来的看法', { validFrom: 20, validTo: null, supersedesIds: ['still-open'] }), open = row('still-open', '另一种理解', { validFrom: 5, validTo: null });
  assert.equal(temporalReference(old, { timeMode: 'current' }, 30).eligible, false);
  assert.equal(temporalReference(old, { timeMode: 'past' }, 30).eligible, true);
  assert.equal(temporalReference(old, { timeMode: 'asOf', asOf: 15 }, 30).eligible, true);
  assert.equal(temporalReference(current, { timeMode: 'asOf', asOf: 15 }, 30).eligible, false);
  assert.equal(temporalReference(open, { timeMode: 'current' }, 30).eligible, true);
  const unknown = temporalReference(row('u', '不确定时间'), { timeMode: 'asOf', asOf: 15 }, 30);
  assert.equal(unknown.eligible, true); assert.equal(unknown.status, 'unspecified'); assert.equal(unknown.historicalDatabaseSnapshot, false);
  assert.equal(temporalReference(row('future', '未来原话', { recordType: 'chat', sourceAt: 50 }), { timeMode: 'asOf', asOf: 15 }, 60).eligible, false);
});
test('association traverses only stored edges in the supplied scope, handles reverse links/cycles and reports unavailable edges', () => {
  const rows = [row('a', 'a', { relatedMemoryIds: ['b', 'outside'] }), row('b', 'b', { expandIds: ['c'] }), row('c', 'c', { relatedMemoryIds: ['a'] })];
  const original = structuredClone(rows), result = associationCandidates(rows, ['b'], 2);
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(['a', 'c'])); assert.equal(result.missingLinks, 1);
  assert.ok(result.items.find(item => item.id === 'a').path.some(edge => edge.direction === 'reverse')); assert.deepEqual(rows, original);
});
test('ambiguous duplicate record IDs never join another person by accident and lexical subjects stay separate', () => {
  const rows = [row('same', 'Alice 喜欢茶', { scope: 'person', personId: 'alice' }), row('same', 'Bob 喜欢茶', { scope: 'person', personId: 'bob' }), row('c', '茶叶', { relatedMemoryIds: ['same'] })];
  const input = validateRetrievalInput({ query: '喜欢茶', scope: 'all', limit: 10 }), lexical = lexicalCandidates(rows, input.query);
  const links = associationCandidates(rows, ['c'], 1); assert.equal(links.items.length, 0); assert.equal(links.missingLinks, 1);
  const result = mergeCandidates(rows, lexical, [], links, input, 100);
  assert.equal(result.items.filter(item => item.id === 'same').length, 2); assert.deepEqual(new Set(result.items.filter(item => item.id === 'same').map(item => item.personId)), new Set(['alice', 'bob']));
});
test('source diversity is an explicit candidate ordering, not deletion or a per-person quota', () => {
  const source = { sourceSessionId: 's', sourceEventId: '1' }, rows = [row('a', '茶', { srcRefs: [source], createdAt: 30 }), row('b', '茶', { srcRefs: [source], createdAt: 20 }), row('c', '茶', { srcRefs: [{ ...source, sourceEventId: '2' }], createdAt: 10 })];
  const input = validateRetrievalInput({ query: '茶', limit: 3, diversity: 'source' }), result = mergeCandidates(rows, lexicalCandidates(rows, input.query), [], { items: [] }, input, 100);
  assert.deepEqual(result.items.map(item => item.id), ['a', 'c', 'b']); assert.equal(result.distinctSourceGroups, 2); assert.equal(rows.length, 3);
});
test('records without source roots keep distinct diversity groups across relationship and record-type namespaces', () => {
  const rows = [row('same', '茶', { scope: 'person', personId: 'alice' }), row('same', '茶', { scope: 'person', personId: 'bob' }), row('same', '茶', { scope: 'person', personId: 'alice', recordType: 'habit' })];
  const input = validateRetrievalInput({ query: '茶', scope: 'all', limit: 3, diversity: 'source' });
  const result = mergeCandidates(rows, lexicalCandidates(rows, input.query), [], { items: [] }, input, 100);
  assert.equal(result.distinctSourceGroups, 3); assert.equal(result.items.length, 3);
  assert.equal(result.items.filter(item => item.personId === 'alice').length, 2);
});
test('association graph work has explicit edge and node caps rather than traversing a large graph silently', () => {
  const rows = Array.from({ length: 1100 }, (_, i) => row('n' + i, 'x', { relatedMemoryIds: Array.from({ length: 50 }, (_, j) => 'n' + ((i + j + 1) % 1100)) }));
  const result = associationCandidates(rows, ['n0'], 2); assert.equal(result.truncated, true); assert.ok(result.items.length <= 999);
});
test('invalid time or unbounded graph/query input fails explicitly and leaves caller input untouched', () => {
  for (const input of [{ query: 'x', timeMode: 'asOf' }, { query: 'x', timeMode: 'past', asOf: 3 }, { query: 'x', associationDepth: 3 }, { query: 'x', seedIds: Array(17).fill('a') }, { query: 'x'.repeat(2001) }])
    assert.throws(() => validateRetrievalInput(input), { code: 'SCHEMA_INVALID' });
});
