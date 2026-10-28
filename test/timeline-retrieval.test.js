import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalCandidates, associationCandidates } from '../core/retrieval.js';

const entry = (id, timeline = {}, extra = {}) => ({ id, recordType: 'chat', scope: 'person', personId: 'person-one',
  text: '原话保持不变', sourceAt: 10, timeline, ...extra });

test('event narrative, original feelings, current interpretation and index codes remain searchable in every tier', () => {
  const fields = ['title', 'background', 'process', 'outcome', 'details', 'feltThen', 'meaningNow'];
  for (const tier of ['recent', 'long_term', 'archive']) for (const field of fields) {
    const row = entry('one', { [field]: '只有注释里出现的蓝色风铃', indexCodes: ['IDX-风铃-一'] }, { tier });
    assert.equal(lexicalCandidates([row], '蓝色风铃')[0].id, 'one');
    assert.equal(lexicalCandidates([row], 'IDX-风铃-一')[0].id, 'one');
    assert.equal(row.text, '原话保持不变');
  }
});

test('timeline links participate in the existing bounded graph without joining ambiguous people', () => {
  const rows = [entry('a', { relatedMemoryIds: ['b', 'outside'] }), entry('b')];
  const linked = associationCandidates(rows, ['a'], 1);
  assert.equal(linked.items[0].id, 'b'); assert.equal(linked.items[0].path[0].field, 'timeline.relatedMemoryIds');
  assert.equal(linked.missingLinks, 1);
  const ambiguous = [...rows, entry('b', {}, { personId: 'other-person' })];
  assert.equal(associationCandidates(ambiguous, ['a'], 1).items.length, 0);
  assert.doesNotThrow(() => associationCandidates([entry('bad', { relatedMemoryIds: {} })], ['bad'], 1));
});
