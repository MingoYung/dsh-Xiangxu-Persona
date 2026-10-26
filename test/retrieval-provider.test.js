import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalProvider } from '../adapters/dsh/retrieval-provider.js';

function setup(fetchImpl, saved = null) {
  let state = saved, active = null, writes = 0;
  const repository = { async setSemanticPort(port) { active = port; }, async prepareRetrievalIndex(args) { return { prepared: args.limit }; } };
  const service = createRetrievalProvider({ repository, fetchImpl, storage: { async read() { return state; }, async write(value) { writes++; state = structuredClone(value); } } });
  return { service, get active() { return active; }, get state() { return state; }, get writes() { return writes; } };
}
const config = { endpoint: 'http://127.0.0.1:9000/v1/embeddings', model: 'real-embedding-model', apiKey: 'private-fixture-key', enabled: true, expectedVersion: 0 };
test('embeddings are opt-in; exact index order, no secret in inspection, changing provider invalidates port', async () => {
  const calls = [], fixture = setup(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })); });
  await fixture.service.ready; assert.equal(fixture.active, null); assert.equal(calls.length, 0);
  await assert.rejects(fixture.service.prepare({ limit: 2 }), { code: 'RETRIEVAL_PROVIDER_DISABLED' });
  const inspection = await fixture.service.configure(config);
  assert.equal(JSON.stringify(inspection).includes(config.apiKey), false); assert.equal(inspection.hasApiKey, true); assert.equal(calls.length, 0);
  const first = fixture.active; const result = await first.embed({ texts: ['原话一', '原话二'] });
  assert.deepEqual(result.vectors, [[1, 0], [0, 1]]); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.authorization, 'Bearer ' + config.apiKey);
  assert.deepEqual(JSON.parse(calls[0].options.body).input, ['原话一', '原话二']);
  await assert.rejects(fixture.service.configure({ ...config, model: 'changed' }), { code: 'VERSION_CONFLICT' }); assert.equal(fixture.writes, 1);
  await fixture.service.configure({ enabled: false, expectedVersion: 1 }); assert.equal(fixture.active, null);
  await fixture.service.close();
});
test('malformed, redirected and missing embeddings fail explicitly without chat fallback', async () => {
  for (const value of [{ data: [{ index: 0, embedding: [0, 0] }] }, { data: [{ index: 1, embedding: [1, 0] }] }, { data: [] }, { choices: [{ message: { content: 'fake embeddings' } }] }]) {
    let calls = 0; const f = setup(async () => { calls++; return new Response(JSON.stringify(value)); });
    await f.service.configure(config); await assert.rejects(f.active.embed({ texts: ['输入'] }), { code: 'RETRIEVAL_PROVIDER_RESPONSE' }); assert.equal(calls, 1); await f.service.close();
  }
  const f = setup(async () => { throw new Error('sensitive server echo private-fixture-key'); }); await f.service.configure(config);
  await assert.rejects(f.active.embed({ texts: ['输入'] }), error => error.code === 'RETRIEVAL_PROVIDER_UNAVAILABLE' && !error.message.includes(config.apiKey)); await f.service.close();
});
test('unsafe endpoint and failed persistence do not activate a provider', async () => {
  const f = setup(() => { throw Error('not called'); });
  for (const endpoint of ['http://remote.example/embeddings', 'https://user:secret@example.com/v1/embeddings', 'https://example.com/embeddings?key=secret']) await assert.rejects(f.service.configure({ ...config, endpoint }), { code: 'RETRIEVAL_PROVIDER_CONFIG' });
  assert.equal(f.writes, 0); assert.equal(f.active, null); await f.service.close();
  let active = null; const service = createRetrievalProvider({ repository: { async setSemanticPort(port) { active = port; } }, storage: { async read() { return null; }, async write() { throw Error('disk fixture'); } } });
  await assert.rejects(service.configure(config), /disk fixture/); assert.equal(active, null); assert.equal((await service.inspect()).version, 0); await service.close();
});
