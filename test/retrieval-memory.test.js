import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';

async function fixture(t, retrieval = {}, port = null) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.realpath(await fs.mkdtemp(path.join(parent, 'xiangxu-retrieval-'))), root = path.join(base, 'memory'); let now = 100000;
  const repo = new MemoryRepository({ root, clock: () => now, semanticPort: port, config: { retrieval } }); await repo.open();
  t.after(async () => { await repo.close(); assert.ok(path.resolve(base).startsWith(parent + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  return { repo, root, tick: amount => { now += amount; } };
}
async function put(repo, records, personId = null) {
  if (personId) await repo.upsertPerson({ personId });
  const run = await repo.prepareConsolidation({ personId }), key = personId ? 'person:' + personId + ':index' : 'global:index';
  await repo.applyConsolidation(run, records.map(item => ({ documentKey: key, expectedVersion: run.inputVersions[key], operation: 'upsert', recordId: item.id,
    value: { kind: 'fact', ...item } })));
}
function semanticFixture() {
  const calls = [];
  return { calls, port: { id: 'isolated-semantic-fixture', version: '1', dimensions: 3,
    async embed({ texts, purpose, signal }) { calls.push({ texts: [...texts], purpose, signal }); return { vectors: texts.map(text => /猫|kitten|feline/i.test(text) ? [1, 0, 0] : /茶|tea/i.test(text) ? [0, 1, 0] : [0, 0, 1]) }; } } };
}
test('an unconfigured store honestly supplies lexical and stored-association candidates without inventing semantic vectors', async t => {
  const { repo } = await fixture(t); await put(repo, [{ id: 'tea', text: '一起喝茶', relatedMemoryIds: ['walk'] }, { id: 'walk', text: '后来沿河散步' }]);
  const result = await repo.search({ query: '喝茶', scope: 'global' });
  assert.ok(result.items.some(row => row.id === 'walk' && row.retrieval.channels.includes('association')));
  assert.equal(result.diagnostics.method, 'lexical+association'); assert.equal(result.diagnostics.semantic.configured, false);
  assert.equal(result.diagnostics.automaticRecall, false); assert.equal(result.items[0].retrieval.referenceOnly, true);
});
test('semantic indexing is explicit, query embeddings are cached, and the port can find a different wording', async t => {
  const fake = semanticFixture(), { repo, root } = await fixture(t, { semanticEnabled: true }, fake.port);
  await put(repo, [{ id: 'cat', text: '我家的猫喜欢窗台' }, { id: 'tea', text: '我偏爱清茶' }]);
  const before = await fs.readFile(path.join(root, 'global/index.json'));
  let result = await repo.search({ query: 'kitten', scope: 'global' }); assert.equal(result.items.length, 0); assert.equal(fake.calls.length, 0); assert.equal(result.diagnostics.semantic.reason, 'index_empty');
  assert.equal((await repo.prepareRetrievalIndex({ scope: 'global' })).prepared, 2); assert.deepEqual(fake.calls.map(row => row.purpose), ['document']);
  result = await repo.search({ query: 'kitten', scope: 'global' }); assert.equal(result.items[0].id, 'cat'); assert.equal(result.items[0].score, 0);
  assert.deepEqual(result.items[0].retrieval.channels, ['semantic']); assert.equal(result.diagnostics.semantic.queryCacheHit, false);
  result = await repo.search({ query: 'kitten', scope: 'global' }); assert.equal(result.diagnostics.semantic.queryCacheHit, true); assert.equal(fake.calls.length, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'global/index.json')), before);
});
test('provider replacement clears both vector domains and serializes after an in-flight preparation', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const old = { id: 'first', version: '1', embed: async ({ texts }) => { entered(); await barrier; return { vectors: texts.map(() => [1, 0]) }; } };
  const { repo } = await fixture(t, { semanticEnabled: true }, old); await put(repo, [{ id: 'a', text: 'old document' }]);
  const preparing = repo.prepareRetrievalIndex(); await started; let replaced = false;
  const replacement = repo.setSemanticPort({ id: 'second', version: '2', dimensions: 3, embed: async ({ texts }) => ({ vectors: texts.map(() => [0, 1, 0]) }) }).then(value => { replaced = true; return value; });
  await Promise.resolve(); assert.equal(replaced, false); release(); await preparing; await replacement;
  const status = await repo.getRetrievalDiagnostics(); assert.equal(status.semantic.provider.id, 'second'); assert.equal(status.semantic.cache.entries, 0);
  await repo.prepareRetrievalIndex(); await repo.setSemanticPort(null); assert.equal((await repo.getRetrievalDiagnostics()).semantic.cache.entries, 0);
});
test('failed or malformed semantic providers degrade to real lexical results without consuming or changing memory', async t => {
  const fake = semanticFixture(), { repo, root } = await fixture(t, { semanticEnabled: true }, fake.port); await put(repo, [{ id: 'cat', text: '猫在窗台' }]); await repo.prepareRetrievalIndex();
  const before = await fs.readFile(path.join(root, 'global/index.json')); fake.port.embed = async () => { throw new Error('private provider response must not escape'); };
  let result = await repo.search({ query: '猫', scope: 'global' }); assert.equal(result.items[0].id, 'cat'); assert.equal(result.diagnostics.semantic.reason, 'SEMANTIC_PROVIDER_FAILED');
  assert.ok(!JSON.stringify(await repo.getRetrievalDiagnostics()).includes('private provider'));
  fake.port.embed = async () => ({ vectors: [[0, 0, 0]] }); result = await repo.search({ query: '猫', scope: 'global' }); assert.equal(result.diagnostics.semantic.reason, 'SEMANTIC_VECTOR_INVALID');
  assert.deepEqual(await fs.readFile(path.join(root, 'global/index.json')), before);
});
test('expiry and entry/byte limits affect the reproducible cache, never the retained records', async t => {
  const fake = semanticFixture(), f = await fixture(t, { semanticEnabled: true, cacheEntries: 2, cacheBytes: 4096, cacheTtlMs: 1000 }, fake.port);
  await put(f.repo, [{ id: 'a', text: '猫' }, { id: 'b', text: '茶' }, { id: 'c', text: '散步' }]); await f.repo.prepareRetrievalIndex();
  let status = await f.repo.getRetrievalDiagnostics(); assert.ok(status.semantic.cache.entries <= 2); assert.ok(status.semantic.cache.bytes <= 4096);
  const result = await f.repo.search({ query: 'kitten', scope: 'global' }); assert.equal(result.diagnostics.semantic.coverageComplete, false);
  f.tick(1001); status = await f.repo.getRetrievalDiagnostics(); assert.equal(status.semantic.cache.entries, 0);
  assert.equal((await f.repo.search({ query: '', scope: 'global', limit: 100 })).items.length, 3);
});
test('manual index pages disclose prefix-only embedding and do not truncate original text', async t => {
  const fake = semanticFixture(), { repo, root } = await fixture(t, { semanticEnabled: true, documentChars: 128, batchRecords: 1 }, fake.port);
  const text = '猫'.repeat(200); await put(repo, [{ id: 'a', text }, { id: 'b', text: '茶' }]);
  const first = await repo.prepareRetrievalIndex({ offset: 0, limit: 1 }); assert.equal(first.partialTexts, 1); assert.equal(first.nextOffset, 1); assert.equal(first.complete, false);
  assert.equal(Array.from(fake.calls[0].texts[0]).length, 128); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'global/index.json'), 'utf8')).items[0].text, text);
  const second = await repo.prepareRetrievalIndex({ offset: 1, limit: 1 }); assert.equal(second.complete, true); assert.equal(second.nextOffset, null);
  assert.equal((await repo.search({ query: 'kitten', scope: 'global' })).diagnostics.semantic.partialDocumentTexts, 1);
});
test('source withdrawal removes document/query vectors, diagnostic identities and all search channels before restart', async t => {
  const fake = semanticFixture(), { repo, root } = await fixture(t, { semanticEnabled: true }, fake.port); await put(repo, [{ id: 'cat', text: '秘密猫', srcRefs: [] }]);
  await repo.prepareRetrievalIndex(); await repo.search({ query: 'kitten', scope: 'global' }); await repo.recordRetrievalExposure({ requestId: 'shown', recordIds: ['cat'], kind: 'tool_result' });
  assert.equal((await repo.getRetrievalDiagnostics()).semantic.cache.queryEntries, 1);
  await repo.forget({ ids: ['cat'], scope: 'global', reason: 'explicit fixture withdrawal' });
  const status = await repo.getRetrievalDiagnostics(); assert.equal(status.semantic.cache.entries, 0); assert.equal(status.exposure.length, 0);
  assert.ok(!JSON.stringify(status.recent).includes('"id":"cat"')); assert.equal((await repo.search({ query: 'kitten', scope: 'global' })).items.length, 0);
  await repo.close(); const cold = new MemoryRepository({ root }); await cold.open(); assert.equal((await cold.search({ query: '秘密猫', scope: 'global' })).items.length, 0); await cold.close();
});
test('past/current/asOf searches preserve old interpretations and never infer invalidity from a supersedes link', async t => {
  const { repo } = await fixture(t); await put(repo, [{ id: 'old', text: '爱喝茶', validFrom: 10, validTo: 20 }, { id: 'new', text: '爱喝茶和水', validFrom: 20, validTo: null, supersedesIds: ['open'] }, { id: 'open', text: '另一种喝茶习惯', validFrom: 10, validTo: null }]);
  const query = mode => repo.search({ query: '茶', scope: 'global', timeMode: mode });
  assert.deepEqual((await query('past')).items.map(row => row.id), ['old']); assert.ok(!(await query('current')).items.some(row => row.id === 'old')); assert.ok((await query('current')).items.some(row => row.id === 'open'));
  const at = await repo.search({ query: '茶', scope: 'global', timeMode: 'asOf', asOf: 15 }); assert.ok(at.items.some(row => row.id === 'old')); assert.ok(!at.items.some(row => row.id === 'new'));
  assert.equal((await query('all')).items.length, 3);
});
test('reference diagnostics distinguish candidate search, admitted snapshots and tool exposure without altering ranking', async t => {
  const { repo } = await fixture(t, { diagnosticEntries: 6, diagnosticBytes: 4096 }); await put(repo, [{ id: 'a', text: '茶' }, { id: 'b', text: '茶' }]);
  const before = (await repo.search({ query: '茶', scope: 'global' })).items.map(row => row.id);
  assert.equal((await repo.getRetrievalDiagnostics()).exposure.length, 0);
  await repo.saveSnapshot({ requestId: 'snapshot-one', injectedIds: ['b'], injectedText: '[reference] b' });
  await repo.recordRetrievalExposure({ requestId: 'tool-one', recordIds: ['b'], kind: 'tool_result' });
  assert.equal((await repo.recordRetrievalExposure({ requestId: 'tool-one', recordIds: ['b'], kind: 'tool_result' })).duplicate, true);
  const status = await repo.getRetrievalDiagnostics(), exposed = status.exposure.find(row => row.recordId === 'b');
  assert.equal(exposed.snapshotReferences, 1); assert.equal(exposed.toolReferences, 1); assert.equal(exposed.windowReferences, 2); assert.equal(status.automaticRecall, false);
  assert.deepEqual((await repo.search({ query: '茶', scope: 'global' })).items.map(row => row.id), before);
  assert.ok(!JSON.stringify(status).includes('"query":"茶"')); await repo.clearRetrievalDiagnostics(); assert.equal((await repo.getRetrievalDiagnostics()).window.entries, 0);
});
test('semantic and association candidates retain selected relationship scope and do not conflate duplicate IDs', async t => {
  const fake = semanticFixture(), { repo } = await fixture(t, { semanticEnabled: true }, fake.port);
  await put(repo, [{ id: 'same', text: 'Alice 猫', relatedMemoryIds: ['b-only'] }], 'alice'); await put(repo, [{ id: 'same', text: 'Bob 猫' }, { id: 'b-only', text: 'Bob 特有资料' }], 'bob');
  await repo.prepareRetrievalIndex({ scope: 'all' });
  const person = await repo.search({ query: 'kitten', scope: 'person', targetPersonId: 'alice' }); assert.ok(person.items.every(row => row.personId === 'alice')); assert.equal(person.items[0].text, 'Alice 猫');
  const all = await repo.search({ query: 'kitten', scope: 'all', associationDepth: 0 }); assert.deepEqual(new Set(all.items.filter(row => row.id === 'same').map(row => row.personId)), new Set(['alice', 'bob']));
});
test('a provider timeout is bounded, aborts its signal and leaves a usable lexical store', async t => {
  let signal; const { repo } = await fixture(t, { semanticEnabled: true, requestTimeoutMs: 100 }, { id: 'slow-fixture', version: '1', embed: async request => { signal = request.signal; return new Promise(() => {}); } });
  await put(repo, [{ id: 'a', text: '茶' }]); const result = await repo.prepareRetrievalIndex(); assert.equal(result.reason, 'SEMANTIC_TIMEOUT'); assert.equal(signal.aborted, true);
  assert.equal((await repo.search({ query: '茶', scope: 'global' })).items[0].id, 'a');
});

test('changed documents cannot reuse old semantic vectors, and unchanged cached queries do not refresh index text', async t => {
  const fake = semanticFixture(), { repo } = await fixture(t, { semanticEnabled: true }, fake.port);
  await put(repo, [{ id: 'a', text: '猫' }]); await repo.prepareRetrievalIndex(); assert.equal((await repo.search({ query: 'kitten', scope: 'global' })).items[0].id, 'a');
  await put(repo, [{ id: 'a', text: '茶' }]); const result = await repo.search({ query: 'kitten', scope: 'global' });
  assert.equal(result.items.length, 0); assert.equal(result.diagnostics.semantic.reason, 'index_empty'); assert.equal(fake.calls.filter(row => row.purpose === 'document').length, 1);
  await repo.prepareRetrievalIndex(); assert.equal((await repo.search({ query: 'kitten', scope: 'global' })).items.length, 0);
});

test('an empty query never invokes semantic embedding or seeds arbitrary graph expansion', async t => {
  const fake = semanticFixture(), { repo } = await fixture(t, { semanticEnabled: true }, fake.port);
  await put(repo, [{ id: 'a', text: '猫', relatedMemoryIds: ['b'] }, { id: 'b', text: '茶' }]); await repo.prepareRetrievalIndex();
  const before = fake.calls.length, result = await repo.search({ query: '', scope: 'global' });
  assert.equal(fake.calls.length, before); assert.equal(result.diagnostics.method, 'lexical'); assert.equal(result.diagnostics.association.depth, 0);
});

test('cache capacity cannot be reported as a completed full semantic index and vector dimensions are validated', async t => {
  const port = { id: 'oversized-vector-fixture', version: '1', embed: async ({ texts }) => ({ vectors: texts.map(() => Array.from({ length: 4096 }, (_, i) => i % 3 + 1)) }) };
  const { repo } = await fixture(t, { semanticEnabled: true, cacheBytes: 4096 }, port); await put(repo, [{ id: 'a', text: '猫' }]);
  const result = await repo.prepareRetrievalIndex(); assert.equal(result.available, false); assert.equal(result.reason, 'SEMANTIC_CACHE_CAPACITY'); assert.equal(result.coverage.complete, false);
  port.embed = async ({ texts }) => ({ vectors: texts.map(() => [NaN]) });
  assert.equal((await repo.prepareRetrievalIndex()).reason, 'SEMANTIC_VECTOR_INVALID');
});

test('seed-only queries follow selected stored links instead of quietly adding unrelated recent memories', async t => {
  const { repo } = await fixture(t); await put(repo, [{ id: 'a', text: '一件事', relatedMemoryIds: ['b'] }, { id: 'b', text: '关联的事' }, { id: 'unrelated', text: '无关' }]);
  const result = await repo.search({ query: '', seedIds: ['a'], scope: 'global' }); assert.deepEqual(new Set(result.items.map(row => row.id)), new Set(['a', 'b']));
});

test('empty document text is excluded explicitly rather than poisoning a valid embedding batch', async t => {
  const fake = semanticFixture(), { repo } = await fixture(t, { semanticEnabled: true }, fake.port); await put(repo, [{ id: 'a', text: '' }, { id: 'b', text: '茶' }]);
  const result = await repo.prepareRetrievalIndex(); assert.equal(result.excludedEmpty, 1); assert.equal(result.prepared, 1); assert.ok(fake.calls[0].texts.every(text => text.trim()));
});

test('a dimension change without a provider version change degrades rather than mixing incompatible vectors', async t => {
  const port = { id: 'dimension-fixture', version: 'same', embed: async ({ texts, purpose }) => ({ vectors: texts.map(() => purpose === 'document' ? [1, 0] : [1, 0, 0]) }) };
  const { repo } = await fixture(t, { semanticEnabled: true }, port); await put(repo, [{ id: 'a', text: '茶' }]); await repo.prepareRetrievalIndex();
  const result = await repo.search({ query: '茶', scope: 'global' }); assert.equal(result.diagnostics.semantic.reason, 'SEMANTIC_DIMENSIONS_CHANGED'); assert.equal(result.items[0].id, 'a');
});
