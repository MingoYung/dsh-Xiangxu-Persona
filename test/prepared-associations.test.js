import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreparedAssociations, readPreparedAssociations } from '../core/prepared-associations.js';
import { SCHEMA_VERSION, sourceKey } from '../core/schema.js';

const original = (id, sessionId = 'session') => ({
  sourceSessionId: sessionId, sourceEventId: id, available: true,
});
const memory = (id, ...srcRefs) => ({
  schemaVersion: SCHEMA_VERSION, id, scope: 'global', personId: null,
  aboutPersonIds: ['subject'], srcRefs,
});
const input = { seedIds: ['seed'], limit: 4 };
const seedRef = original('seed-source'), targetRef = original('target-source');
const documentsWith = (...items) => [{ recordType: 'memory', document: { version: 1, updatedAt: 10, items } }];
const chatReceipt = (id) => ({ id, eventId: 'event-' + id });
const metaWith = (sources = {}, hotSources = {}, revokedIds = []) => ({
  personIds: ['subject'], revokedSources: [], revokedIds, sources, hotSources,
});

test('prepared lookup requires still-accepted source receipts for both ends even when memory documents have not changed', () => {
  const documents = documentsWith(memory('seed', seedRef), memory('target', targetRef));
  const sources = { [sourceKey(seedRef)]: chatReceipt('origin-seed'), [sourceKey(targetRef)]: chatReceipt('origin-target') };
  const meta = metaWith(sources);
  const cache = buildPreparedAssociations(documents, meta, null, 'run', 10);
  const lookup = (state) => readPreparedAssociations(cache, documents, state, null, input, 11).items.map(item => item.id);
  assert.deepEqual(lookup(meta), ['target']);
  for (const ref of [seedRef, targetRef]) {
    const other = ref === seedRef ? targetRef : seedRef;
    assert.deepEqual(lookup(metaWith({ [sourceKey(other)]: sources[sourceKey(other)] })), []);
    assert.deepEqual(lookup(metaWith(sources, {}, [sources[sourceKey(ref)].id])), []);
  }
  const unknown = original('never-accepted');
  const unsupported = documentsWith(memory('seed', seedRef), memory('target', targetRef, unknown));
  const cleanCache = buildPreparedAssociations(unsupported, meta, null, 'run', 10);
  assert.deepEqual(cleanCache.links, []);
});

test('prepared lookup recognizes accepted hot receipts without confusing colons or escaped quotes with their key suffix', () => {
  const hotRef = original('hot-source:"\u005d:next', 'room:42');
  const documents = documentsWith(memory('seed', seedRef), memory('target', hotRef));
  const sources = { [sourceKey(seedRef)]: chatReceipt('origin-seed') };
  const actualReceiptKey = sourceKey(hotRef) + ':tool_result:1';
  const meta = metaWith(sources, { [actualReceiptKey]: 'event-hot' });
  const cache = buildPreparedAssociations(documents, meta, null, 'run', 10);
  const lookup = (state) => readPreparedAssociations(cache, documents, state, null, input, 11).items.map(item => item.id);
  assert.deepEqual(lookup(meta), ['target']);
  assert.deepEqual(lookup(metaWith(sources, { [sourceKey({ ...hotRef, sourceEventId: hotRef.sourceEventId + ':different' }) + ':tool_result:1']: 'event-other' })), []);
  assert.deepEqual(lookup({ ...meta, revokedSources: [sourceKey(hotRef)] }), []);
});
