import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRepository } from '../core/repository.js';

const chat = (id, role, personId = null, extra = {}) => ({ personId, sourceSessionId: 'actual-session', sourceEventId: id,
  sourceKind: role, contentClass: 'participant_dialogue', channelId: 'desktop', role, text: '实际说出的原话😀', sourceAt: 1000, observedAt: 1000, ...extra });
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sourceHash = record => { const { personId, speakerId, ...source } = record; return hash(source); };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-speaker-'));
  const repository = new MemoryRepository({ root, clock: () => 5000 }); await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  return { root, repository };
}

test('ingestion separates the assistant actor from its relationship partition and preserves explicit null', async t => {
  const { repository } = await fixture(t);
  assert.equal((await repository.ingest(chat('assistant-default', 'assistant', 'a'))).record.speakerId, null);
  assert.equal((await repository.ingest(chat('assistant-null', 'assistant', 'a', { speakerId: null }))).record.speakerId, null);
  assert.equal((await repository.ingest(chat('assistant-independent', 'assistant', 'a', { speakerId: 'shared_ai' }))).record.speakerId, 'shared_ai');
  assert.equal((await repository.ingest(chat('assistant-placeholder', 'assistant', 'a', { speakerId: 'a' }))).record.speakerId, null);
  assert.equal((await repository.ingest(chat('user-default', 'user', 'a'))).record.speakerId, 'a');
  assert.equal((await repository.ingest(chat('user-explicit-null', 'user', 'a', { speakerId: null }))).record.speakerId, null);
});

test('assigning unknown assistant memories changes only relationship ownership, while user recognition still updates its speaker', async t => {
  const { repository } = await fixture(t);
  for (const [id, extra] of [['ai-null', { speakerId: null }], ['ai-independent', { speakerId: 'shared_ai' }]]) {
    const original = (await repository.ingest(chat(id, 'assistant', null, extra))).record;
    const assigned = await repository.assign({ sourceSessionId: original.sourceSessionId, sourceEventId: id, personId: 'b', reason: '人格明确选择关系归属' });
    assert.equal(assigned.record.personId, 'b'); assert.equal(assigned.record.speakerId, original.speakerId);
    assert.equal(assigned.record.role, 'assistant'); assert.equal(sourceHash(assigned.record), sourceHash(original));
    const found = (await repository.search({ query: original.text, targetPersonId: 'b', limit: 100 })).items.find(item => item.id === original.id);
    assert.equal(found.srcRefs[0].sourceRole, 'assistant'); assert.equal(found.speakerId, original.speakerId);
    const reassigned = await repository.assign({ sourceSessionId: original.sourceSessionId, sourceEventId: id, personId: 'a' });
    assert.equal(reassigned.record.speakerId, original.speakerId); assert.equal(sourceHash(reassigned.record), sourceHash(original));
  }
  const user = (await repository.ingest(chat('user-unknown', 'user', null, { speakerId: null }))).record;
  assert.equal((await repository.assign({ sourceSessionId: user.sourceSessionId, sourceEventId: user.sourceEventId, personId: 'a' })).record.speakerId, 'a');
  const changed = await repository.assign({ sourceSessionId: user.sourceSessionId, sourceEventId: user.sourceEventId, personId: 'b' });
  assert.equal(changed.record.speakerId, 'b'); assert.equal(changed.record.role, 'user'); assert.equal(sourceHash(changed.record), sourceHash(user));
  assert.deepEqual((await repository.getPending()).map(record => record.id), [user.id]);
});

test('opening old v3 corrects only exact assistant speaker placeholders, idempotently without rewriting personality or source facts', async t => {
  const { root, repository } = await fixture(t);
  const polluted = (await repository.ingest(chat('old-placeholder', 'assistant', 'b'))).record;
  const independent = (await repository.ingest(chat('old-independent', 'assistant', 'b', { speakerId: 'shared_ai' }))).record;
  const human = (await repository.ingest(chat('human', 'user', 'b'))).record;
  const unknown = (await repository.ingest(chat('unknown-ai', 'assistant'))).record;
  const rows = await repository.store.readLines('people/b/stream.jsonl'); rows.find(record => record.id === polluted.id).speakerId = 'b';
  await repository.store.transaction({ jsonl: { 'people/b/stream.jsonl': rows } });
  const before = structuredClone(rows), c3Before = hash(await fs.readFile(path.join(root, 'self/persona.json'), 'utf8'));
  const runtimeBefore = await repository.getRuntime(); await repository.close(); await repository.open();
  const after = await repository.store.readLines('people/b/stream.jsonl');
  assert.deepEqual(after, before.map(record => record.id === polluted.id ? { ...record, speakerId: null } : record));
  assert.equal(sourceHash(after.find(record => record.id === polluted.id)), sourceHash(polluted));
  assert.equal(after.find(record => record.id === independent.id).speakerId, 'shared_ai'); assert.equal(after.find(record => record.id === human.id).speakerId, 'b');
  assert.equal((await repository.readSources({ sourceRefs: [{ sourceSessionId: unknown.sourceSessionId, sourceEventId: unknown.sourceEventId }] }))[0].personId, null);
  assert.equal(hash(await fs.readFile(path.join(root, 'self/persona.json'), 'utf8')), c3Before); assert.deepEqual(await repository.getRuntime(), runtimeBefore);
  const firstMeta = await repository.store.readJson('meta/state.json'), firstBytes = await fs.readFile(path.join(root, 'people/b/stream.jsonl'), 'utf8');
  await repository.close(); await repository.open();
  assert.deepEqual(await repository.store.readJson('meta/state.json'), firstMeta); assert.equal(await fs.readFile(path.join(root, 'people/b/stream.jsonl'), 'utf8'), firstBytes);
  assert.equal(hash(await fs.readFile(path.join(root, 'self/persona.json'), 'utf8')), c3Before);
});

test('hot capture and reassignment preserve actual actors across assistant process and human dialogue material', async t => {
  const { repository } = await fixture(t);
  const ai = (await repository.ingest(chat('ai-hot', 'assistant', 'a'))).record;
  const ref = { sourceSessionId: ai.sourceSessionId, sourceEventId: ai.sourceEventId, sourceKind: 'model', sourceRole: 'assistant', sourceOrigin: 'ai_reply', available: true };
  const originals = [];
  for (const [kind, speakerId] of [['reasoning', 'a'], ['tool_call', 'shared_ai'], ['dialogue', null]]) {
    const record = (await repository.captureHot({ personId: 'a', speakerId, sourceRef: ref, sourceKind: 'model', kind,
      origin: 'ai_reply', content: { mode: 'cached', text: 'AI process', chars: 10 }, sourceAt: 1000, observedAt: 1000 })).record;
    originals.push(record);
    assert.equal(record.speakerId, kind === 'tool_call' ? 'shared_ai' : null);
  }
  const legacyHot = await repository.store.readLines('people/a/hot.jsonl'); legacyHot[0].speakerId = 'a';
  await repository.store.transaction({ jsonl: { 'people/a/hot.jsonl': legacyHot } });
  await repository.assign({ sourceSessionId: ai.sourceSessionId, sourceEventId: ai.sourceEventId, personId: 'b' });
  let moved = await repository.store.readLines('people/b/hot.jsonl');
  assert.deepEqual(moved, originals.map(record => ({ ...record, personId: 'b' })));
  assert.deepEqual(await repository.store.readLines('people/a/hot.jsonl'), []);
  await repository.assign({ sourceSessionId: ai.sourceSessionId, sourceEventId: ai.sourceEventId, personId: 'a' });
  assert.deepEqual(await repository.store.readLines('people/a/hot.jsonl'), originals);

  const user = (await repository.ingest(chat('human-hot', 'user'))).record;
  const humanHot = (await repository.captureHot({ personId: null, speakerId: null,
    sourceRef: { sourceSessionId: user.sourceSessionId, sourceEventId: user.sourceEventId, available: true, sourceKind: 'user', sourceOrigin: 'user' },
    sourceKind: 'user', kind: 'dialogue', origin: 'user', content: { mode: 'cached', text: user.text, chars: [...user.text].length }, sourceAt: 1000, observedAt: 1000 })).record;
  await repository.assign({ sourceSessionId: user.sourceSessionId, sourceEventId: user.sourceEventId, personId: 'a' });
  await repository.assign({ sourceSessionId: user.sourceSessionId, sourceEventId: user.sourceEventId, personId: 'b' });
  moved = (await repository.store.readLines('people/b/hot.jsonl')).find(record => record.id === humanHot.id);
  assert.deepEqual(moved, { ...humanHot, personId: 'b', speakerId: 'b' });
  const run = await repository.prepareConsolidation({ personId: 'a' });
  assert.deepEqual(run.input.hot.map(record => record.speakerId), [null, 'shared_ai', null]);
});

test('opening old hot actor placeholders repairs current H1 atomically while preserving frozen consolidation input', async t => {
  const { root, repository } = await fixture(t);
  const ai = (await repository.ingest(chat('legacy-hot', 'assistant', 'b'))).record;
  const ref = { sourceSessionId: ai.sourceSessionId, sourceEventId: ai.sourceEventId, sourceKind: 'model', sourceRole: 'assistant', sourceOrigin: 'ai_reply', available: true };
  for (const [kind, speakerId] of [['reasoning', null], ['tool_call', 'shared_ai']]) await repository.captureHot({ personId: 'b', speakerId,
    sourceRef: ref, sourceKind: 'model', kind, origin: 'ai_reply', content: { mode: 'cached', text: 'old AI process', chars: 14 }, sourceAt: 1000, observedAt: 1000 });
  await repository.captureHot({ personId: 'b', speakerId: 'b', sourceRef: { ...ref, sourceEventId: 'automatic', sourceRole: 'user', sourceOrigin: 'system' },
    sourceKind: 'runtime-context', kind: 'runtime_context', origin: 'system', content: { mode: 'cached', text: 'automatic', chars: 9 }, sourceAt: 1000, observedAt: 1000 });
  const hot = await repository.store.readLines('people/b/hot.jsonl');
  hot[0].speakerId = 'b'; hot[2].speakerId = 'b';
  await repository.store.transaction({ jsonl: { 'people/b/hot.jsonl': hot } });
  const run = await repository.prepareConsolidation({ personId: 'b' });
  const runPath = path.join(root, 'journal/runs', run.runId + '.json'), frozenBytes = await fs.readFile(runPath, 'utf8');
  const personaBefore = await fs.readFile(path.join(root, 'self/persona.json'), 'utf8');
  const runtimeBefore = await repository.getRuntime();
  await repository.close(); await repository.open();
  const after = await repository.store.readLines('people/b/hot.jsonl');
  assert.deepEqual(after, hot.map((record, index) => index === 1 ? record : { ...record, speakerId: null }));
  assert.equal(await fs.readFile(runPath, 'utf8'), frozenBytes);
  assert.equal(await fs.readFile(path.join(root, 'self/persona.json'), 'utf8'), personaBefore);
  assert.deepEqual(await repository.getRuntime(), runtimeBefore);
  const metaBefore = await repository.store.readJson('meta/state.json');
  await repository.close(); await repository.open();
  assert.deepEqual(await repository.store.readLines('people/b/hot.jsonl'), after);
  assert.deepEqual(await repository.store.readJson('meta/state.json'), metaBefore);
  assert.equal(await fs.readFile(runPath, 'utf8'), frozenBytes);
});
