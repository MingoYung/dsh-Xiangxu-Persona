import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { MemoryRepository } from '../core/repository.js';
import { retrievalRecordKey } from '../core/retrieval.js';

async function fixture(t, config = {}) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.realpath(await fs.mkdtemp(path.join(parent, 'xiangxu-record-identity-')));
  const repo = new MemoryRepository({ root: path.join(base, 'memory'), config, clock: () => 100000 }); await repo.open();
  for (const personId of ['alice', 'bob']) await repo.upsertPerson({ personId });
  t.after(async () => { await repo.close(); assert.ok(base.startsWith(parent + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  return repo;
}
const chat = (event, personId, extra = {}) => ({ personId, role: 'user', sourceSessionId: 'fixture', sourceEventId: event,
  sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'isolated', text: event, ...extra });
async function put(repo, personId, id, extra = {}, kind = 'index') {
  const run = await repo.prepareConsolidation({ personId }), documentKey = personId ? 'person:' + personId + ':' + kind : 'global:' + kind;
  const value = kind === 'codes' ? { label: personId + ' independent code', meaning: '', cues: [], expandIds: [], occurrences: 0, srcRefs: [], ...extra }
    : { kind: 'fact', text: personId + ' independent memory', srcRefs: [], ...extra };
  await repo.applyConsolidation(run, [{ documentKey, expectedVersion: run.inputVersions[documentKey], operation: 'upsert', recordId: id, value }]);
}
async function hashes(repo) {
  const result = {};
  for (const file of await repo.store.listFiles()) result[file.path] = createHash('sha256').update(await fs.readFile(path.join(repo.root, file.path))).digest('hex');
  return result;
}

test('duplicate IDs stay distinct in browse/search and qualified details return the selected person', async t => {
  const repo = await fixture(t); await put(repo, 'alice', 'shared'); await put(repo, 'bob', 'shared');
  const rows = (await repo.search({ query: 'independent', scope: 'all', associationDepth: 0 })).items;
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.recordKey)).size, 2);
  for (const personId of ['alice', 'bob']) {
    const selected = (await repo.browseMemory({ scope: 'person', targetPersonId: personId })).items[0];
    assert.equal(selected.recordKey, retrievalRecordKey(selected));
    assert.equal((await repo.getMemoryRecord(selected.id, { recordKey: selected.recordKey })).personId, personId);
    assert.equal((await repo.getMemoryRecord(selected.id, { personId, scope: 'person', recordType: 'memory' })).text, selected.text);
  }
  await assert.rejects(repo.getMemoryRecord('shared'), { code: 'MEMORY_RECORD_AMBIGUOUS' });
});

test('a person alone does not guess between different record types with the same ID', async t => {
  const repo = await fixture(t); await put(repo, 'alice', 'shared'); await put(repo, 'alice', 'shared', {}, 'codes');
  await assert.rejects(repo.getMemoryRecord('shared', { personId: 'alice' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.equal((await repo.getMemoryRecord('shared', { personId: 'alice', recordType: 'code' })).recordType, 'code');
  assert.equal((await repo.getMemoryRecord('shared', { personId: 'alice', recordType: 'memory' })).recordType, 'memory');
});

test('invalid keys and missing or contradictory selections never fall back to another record', async t => {
  const repo = await fixture(t); await put(repo, 'alice', 'only'); const selected = await repo.getMemoryRecord('only');
  for (const selector of [{ recordKey: 'not-json' }, { recordKey: JSON.stringify(['memory','person','alice','other']) }, { scope: 'invalid' }, { personId: '../other' }, { unexpected: true }, null])
    await assert.rejects(repo.getMemoryRecord('only', selector), { code: 'SCHEMA_INVALID' });
  assert.equal(await repo.getMemoryRecord('missing'), null);
  assert.equal((await repo.getMemoryRecord('only', { personId: undefined, scope: undefined, recordType: undefined, recordKey: undefined })).personId, 'alice');
  assert.equal(await repo.getMemoryRecord('only', { personId: 'bob' }), null);
  assert.equal(await repo.getMemoryRecord('only', { recordKey: selected.recordKey, personId: 'bob' }), null);
});

test('forgetting a duplicate ID in one relationship refuses atomically and preserves both records after reopen', async t => {
  const repo = await fixture(t); await put(repo, 'alice', 'shared'); await put(repo, 'bob', 'shared'); const before = await hashes(repo);
  await assert.rejects(repo.forget({ ids: ['shared'], reason: 'Alice only' }, { personId: 'alice' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.deepEqual(await hashes(repo), before);
  await repo.close(); await repo.open();
  assert.equal((await repo.browseMemory({ scope: 'person', targetPersonId: 'alice' })).total, 1);
  assert.equal((await repo.browseMemory({ scope: 'person', targetPersonId: 'bob' })).total, 1);
});

test('time-based forgetting also refuses ambiguous legacy IDs before changing files', async t => {
  const repo = await fixture(t); await put(repo, 'alice', 'shared'); await put(repo, 'bob', 'shared'); const before = await hashes(repo);
  await assert.rejects(repo.forget({ before: 100001, reason: 'Alice history only' }, { personId: 'alice' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.deepEqual(await hashes(repo), before);
});

test('a colliding dependent ID cannot turn source revocation into deletion of an independent other-person memory', async t => {
  const repo = await fixture(t), source = await repo.ingest(chat('original', 'alice'));
  await put(repo, 'alice', 'shared', { srcRefs: [{ sourceSessionId: 'fixture', sourceEventId: 'original', available: true }] });
  await put(repo, 'bob', 'shared'); const before = await hashes(repo);
  await assert.rejects(repo.forget({ ids: [source.record.id], reason: 'Original only' }, { personId: 'alice' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.deepEqual(await hashes(repo), before);
  assert.equal((await repo.getMemoryRecord(source.record.id)).text, 'original');
});

test('global and person records with a repeated ID remain independently readable and are not broadly forgotten', async t => {
  const repo = await fixture(t); await put(repo, null, 'shared'); await put(repo, 'bob', 'shared');
  assert.equal((await repo.getMemoryRecord('shared', { personId: null, scope: 'global' })).scope, 'global');
  const before = await hashes(repo);
  await assert.rejects(repo.forget({ ids: ['shared'], scope: 'global', reason: 'Global only' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.deepEqual(await hashes(repo), before);
});

test('unique source revocation still removes its actual dependents and blocks replay without changing unrelated memory', async t => {
  const repo = await fixture(t), source = await repo.ingest(chat('original', 'alice'));
  await put(repo, 'alice', 'alice-memory', { srcRefs: [{ sourceSessionId: 'fixture', sourceEventId: 'original', available: true }] });
  await put(repo, 'bob', 'bob-memory'); const bob = await fs.readFile(path.join(repo.root, 'people/bob/index.json'));
  const result = await repo.forget({ ids: [source.record.id], reason: 'Forget this actual source' }, { personId: 'alice' });
  assert.ok(result.affectedIds.includes('alice-memory')); assert.equal(await repo.getMemoryRecord(source.record.id), null);
  assert.deepEqual(await fs.readFile(path.join(repo.root, 'people/bob/index.json')), bob);
  await repo.close(); await repo.open(); assert.equal((await repo.ingest(chat('original', 'alice'))).revoked, true);
  assert.equal((await repo.getMemoryRecord('bob-memory')).personId, 'bob');
});

test('qualified source reads keep selecting only matching archive shards and timeline keys remain usable', async t => {
  const repo = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 0, retention: { journalMaxBytes: 16384 } });
  const first = await repo.ingest(chat('first', 'alice', { text: 'a'.repeat(3600) }));
  await repo.ingest(chat('second', 'bob', { text: 'b'.repeat(3600) }));
  const catalog = await repo.getTimelineStatus(); assert.equal(catalog.archiveFiles.length, 2);
  const selected = (await repo.browseTimeline({ tier: 'archive', personId: 'alice' })).items[0];
  assert.equal(selected.recordKey, retrievalRecordKey(selected));
  const read = repo.timeline.readPath.bind(repo.timeline), other = catalog.archiveFiles[1].path;
  repo.timeline.readPath = (name, ...args) => { if (name === other) throw new Error('Unrelated archive must not be read'); return read(name, ...args); };
  assert.equal((await repo.getMemoryRecord(first.record.id, { recordKey: selected.recordKey })).personId, 'alice');
});

test('two physical originals sharing the full composite key remain explicitly ambiguous', async t => {
  const repo = await fixture(t); await repo.ingest(chat('one', 'alice', { id: 'manual-shared' })); await repo.ingest(chat('two', 'alice', { id: 'manual-shared' }));
  const rows = (await repo.browseTimeline()).items; assert.equal(rows.length, 2); assert.equal(rows[0].recordKey, rows[1].recordKey);
  await assert.rejects(repo.getMemoryRecord('manual-shared', { recordKey: rows[0].recordKey }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  const before = await hashes(repo);
  await assert.rejects(repo.forget({ ids: ['manual-shared'], reason: 'Ambiguous originals' }, { personId: 'alice' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.deepEqual(await hashes(repo), before);
});
