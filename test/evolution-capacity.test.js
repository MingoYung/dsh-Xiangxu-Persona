import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { JsonStore } from '../core/store.js';
import { defaultConfig, validateConfig, validateDecision } from '../core/schema.js';
import { countStringValues, assertRecordCapacity } from '../core/capacity.js';

const chat = (id, text) => ({ personId: 'a', sourceSessionId: 'source', sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'channel', role: 'user', text });
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-resource-'));
  const repository = new MemoryRepository({ root, config, clock: () => 1000 }); await repository.open(); await repository.upsertPerson({ personId: 'a' });
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); }); return { root, repository };
}
const entry = (run, documentKey, recordId, value, operation = 'upsert') => ({ documentKey, expectedVersion: run.inputVersions[documentKey], operation, recordId, ...(operation === 'upsert' ? { value } : {}) });

test('resource defaults merge for existing v3 configs, reject non-positive budgets and allow autonomous consolidation choices', () => {
  const config = defaultConfig({ capacityLimits: { artifactTextChars: 99 }, processingLimits: { consolidationCallsPerSegment: 3 } });
  assert.equal(config.capacityLimits.artifactTextChars, 99); assert.equal(config.capacityLimits.storeBytes, 67108864);
  assert.equal(config.processingLimits.consolidationCallsPerSegment, 3); assert.equal(config.processingLimits.maxTargetsPerJob, 8);
  assert.equal(config.processingLimits.consolidationInputChars, 4000);
  const legacy = defaultConfig(); delete legacy.capacityLimits; delete legacy.processingLimits;
  validateConfig(legacy); assert.equal(defaultConfig(legacy).processingLimits.consolidationRequestTokens, 32768);
  assert.throws(() => defaultConfig({ capacityLimits: { documentBytes: 0 } }), { code: 'SCHEMA_INVALID' });
  assert.throws(() => defaultConfig({ processingLimits: { maxQueuedConsolidations: -1 } }), { code: 'SCHEMA_INVALID' });
  validateDecision({ consolidationPlan: { action: 'defer', reason: '还没想整理' } });
  validateDecision({ consolidationPlan: { action: 'run', targetPersonIds: [null, 'a'] } });
});

test('all serialized occurrences of string values count, including arrays/shared extensions; cycles and nonfinite artifacts refuse', () => {
  const shared = { text: 'a'.repeat(8000) }, repeated = { extension: [shared, shared, shared, shared, shared] };
  assert.equal(countStringValues(repeated), 40000);
  assert.throws(() => assertRecordCapacity(repeated, defaultConfig().capacityLimits), { code: 'CAPACITY_EXCEEDED' });
  assert.throws(() => assertRecordCapacity({ extra: Infinity }, defaultConfig().capacityLimits), { code: 'SCHEMA_INVALID' });
  assert.throws(() => assertRecordCapacity({ extra: NaN }, defaultConfig().capacityLimits), { code: 'SCHEMA_INVALID' });
  assert.throws(() => assertRecordCapacity({ extra: undefined }, defaultConfig().capacityLimits), { code: 'SCHEMA_INVALID' });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => countStringValues(cycle), { code: 'SCHEMA_INVALID' });
});

test('evolution text/record limits include keys, cues, questions and unknown extensions without partial writes or source consumption', async t => {
  const { repository } = await fixture(t, { capacityLimits: { artifactTextChars: 512, artifactRecordBytes: 4096 } });
  const original = await repository.ingest(chat('one', '仍须保留完整原件'));
  const run = await repository.prepareConsolidation({ personId: 'a' }), before = await repository.getRuntime();
  const cases = [entry(run, 'person:a:index', 'keys', { text: 'small', keys: ['x'.repeat(600)] }),
    entry(run, 'person:a:codes', 'cues', { label: 'short', meaning: '', cues: ['x'.repeat(600)] }),
    entry(run, 'person:a:pending', 'questions', { text: 'small', questions: ['x'.repeat(600)] }),
    entry(run, 'persona', 'anchor', { text: 'small', extra: 'x'.repeat(600) }),
    entry(run, 'persona', 'anchor', { text: 'small', extension: { ['k'.repeat(5000)]: null } })];
  for (const patch of cases) {
    await assert.rejects(repository.applyConsolidation(run, [patch]), { code: 'CAPACITY_EXCEEDED' });
    assert.equal((await repository.getPersona()).version, 0);
    assert.deepEqual(await repository.getRuntime(), before);
    assert.equal((await repository.getConsolidationRun(run.runId)).status, 'prepared');
    assert.equal((await repository.readSources({ eventIds: [original.eventId] }))[0].text, original.record.text);
  }
});

test('summary, axes, coordinates and valid retired records are bounded while malformed retired entries are rejected', async t => {
  const { repository } = await fixture(t, { capacityLimits: { artifactTextChars: 512, documentBytes: 4096 } });
  const run = await repository.prepareConsolidation({ personId: 'a' });
  const axis = { desc: 'x'.repeat(600), n: 0, sd: null, position: null, srcRefs: [] };
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'persona', 'axes', { x: axis })]), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'person:a:impression', 'summary', 'x'.repeat(600))]), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'person:a:impression', 'coordinates', { ['key'.repeat(3000)]: { desc: '', value: null, srcRefs: [] } })]), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'persona', 'retired:bad', 'invalid')]), { code: 'SCHEMA_INVALID' });
  const retired = { retiredAt: 1000, reason: 'x'.repeat(600), entry: { schemaVersion: 'persona-memory/3', id: 'old', scope: 'global', personId: null,
    epistemic: 'interpretation', srcRefs: [], createdAt: 1, updatedAt: 1, kind: 'tendency', desc: 'old' } };
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'persona', 'retired:old', retired)]), { code: 'CAPACITY_EXCEEDED' });
});

test('100k original chat and large H1 are preserved rather than subjected to the evolution-record length cap', async t => {
  const { repository } = await fixture(t); const text = '中'.repeat(100000);
  const source = await repository.ingest(chat('long-code', text)); assert.ok(source.record); assert.equal(source.record.text, text);
  const hot = await repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'source', sourceEventId: 'process' }, kind: 'reasoning',
    sourceKind: 'reasoning', origin: 'ai_reply', text: '思'.repeat(150000) });
  assert.equal(hot.record.content.mode, 'cached'); assert.equal(hot.record.content.chars, 150000);
  const run = await repository.prepareConsolidation({ personId: 'a', maxInputChars: 16000 });
  assert.equal(run.input.chat[0].text.length, 16000); assert.equal(run.input.chat[0].fragment.total, 100000);
  assert.equal((await repository.readSources({ eventIds: [source.eventId] }))[0].text.length, 100000);
});

test('bounded whole-map omission refuses until context read completes, while explicit removal remains a choice', async t => {
  const { repository } = await fixture(t);
  const axis = desc => ({ desc, n: 0, sd: null, position: null, srcRefs: [] }), coordinate = desc => ({ desc, value: null, srcRefs: [] });
  const seed = await repository.prepareConsolidation({ personId: 'a' });
  await repository.applyConsolidation(seed, [entry(seed, 'persona', 'axes', { a: axis('a'), b: axis('b') }), entry(seed, 'person:a:impression', 'coordinates', { a: coordinate('a'), b: coordinate('b') })]);
  const run = await repository.prepareConsolidation({ personId: 'a' }), before = await repository.getRuntime();
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'persona', 'axes', { a: axis('new') })]), { code: 'CONTEXT_NOT_READ' });
  await assert.rejects(repository.applyConsolidation(run, [entry(run, 'person:a:impression', 'coordinates', { a: coordinate('new') })]), { code: 'CONTEXT_NOT_READ' });
  assert.deepEqual(await repository.getRuntime(), before);
  const saved = await repository.recordConsolidationProgress(run.runId, { reviewState: { modelCalls: 2, pageIndex: 1, contextComplete: true, stage: 'review' }, candidatePatch: [] });
  assert.equal(saved.status, 'prepared'); assert.equal(saved.commitMarker, null);
  await repository.applyConsolidation(saved, [entry(saved, 'persona', 'axes', { a: axis('new') })]);
  assert.deepEqual(Object.keys((await repository.getPersona()).axes), ['a']);
  const remove = await repository.prepareConsolidation({ personId: 'a' });
  await repository.applyConsolidation(remove, [entry(remove, 'person:a:impression', 'coordinates', undefined, 'remove')]);
  assert.deepEqual((await repository.getContext({ personId: 'a' })).impression.coordinates, {});
});

test('progress is finite, bounded and detached; explicit revocation clears it and prevents resuming stale work', async t => {
  const { repository } = await fixture(t); const original = await repository.ingest(chat('one', '原话'));
  const run = await repository.prepareConsolidation({ personId: 'a' }), before = await repository.getRuntime();
  const saved = await repository.recordConsolidationProgress(run.runId, { reviewState: { stage: 'source', pageIndex: 1, modelCalls: 2, contextComplete: false } });
  saved.reviewState.pageIndex = 999;
  assert.equal((await repository.getConsolidationRun(run.runId)).reviewState.pageIndex, 1); assert.deepEqual(await repository.getRuntime(), before);
  await assert.rejects(repository.recordConsolidationProgress(run.runId, { reviewState: { context: 'x'.repeat(17000) } }), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(repository.recordConsolidationProgress(run.runId, { reviewState: { modelCalls: Infinity } }), { code: 'SCHEMA_INVALID' });
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(repository.recordConsolidationProgress(run.runId, { reviewState: cyclic }), { code: 'SCHEMA_INVALID' });
  await repository.forget({ ids: [original.record.id], targetPersonId: 'a', reason: '明确撤销' });
  const failed = await repository.getConsolidationRun(run.runId); assert.equal(failed.reviewState, undefined); assert.equal(failed.input, undefined);
  await assert.rejects(repository.recordConsolidationProgress(run.runId, { reviewState: {} }), { code: 'RUN_INVALIDATED' });
});

test('persona history text participates in the same instance total and cannot hide repeated retained text', async t => {
  const { repository } = await fixture(t); const before = await repository.getCapacity(), prior = await repository.getPersona();
  const run = await repository.prepareConsolidation({ personId: 'a' }); await repository.applyConsolidation(run, [entry(run, 'persona', 'anchor', { text: 'a'.repeat(1000) })]);
  const after = await repository.getCapacity(), current = await repository.getPersona(), history = await repository.store.readJson('self/history.json');
  assert.equal(after.persistentChars - before.persistentChars, countStringValues(current) - countStringValues(prior) + countStringValues(history));
});

test('an unreviewed child refreshes shared context versions without admitting late sources or rebasing reviewed candidates', async t => {
  const { repository } = await fixture(t); await repository.ingest(chat('initial', '最初来信'));
  const first = await repository.prepareConsolidation({ personId: 'a' }), second = await repository.prepareConsolidation({ personId: null });
  const frozen = Object.fromEntries(['chat', 'hot'].map(key => [key, structuredClone(second.input[key])]));
  const cursors = Object.fromEntries(['inputSlices', 'cursorBefore', 'cursorAfter', 'inputEndEventId'].map(key => [key, structuredClone(second[key])]));
  await repository.applyConsolidation(first, [entry(first, 'persona', 'anchor', { text: '前一个child已经提炼的共同人格' })]);
  await repository.ingest({ ...chat('late', '不得混入旧批次的新来信'), personId: null });
  const refreshed = await repository.refreshConsolidationContext(second.runId);
  assert.equal(refreshed.inputVersions.persona, 1); assert.equal(refreshed.input.context.persona.anchor.text, '前一个child已经提炼的共同人格');
  assert.deepEqual({ chat: refreshed.input.chat, hot: refreshed.input.hot }, frozen);
  for (const [key, value] of Object.entries(cursors)) assert.deepEqual(refreshed[key], value);
  assert.ok(!JSON.stringify(refreshed.input.context).includes('不得混入旧批次的新来信'));
  await repository.recordConsolidationProgress(second.runId, { reviewState: { modelCalls: 1, contextComplete: false } });
  await assert.rejects(repository.refreshConsolidationContext(second.runId), { code: 'VERSION_CONFLICT' });
  const untouched = await repository.prepareConsolidation({ personId: null });
  await repository.recordConsolidationProgress(untouched.runId, { reviewState: { modelCalls: 0 }, candidatePatch: [] });
  await assert.rejects(repository.refreshConsolidationContext(untouched.runId), { code: 'VERSION_CONFLICT' });
});

test('store applies operation/workspace and whole-root peak limits before preparing WAL, for all write paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-store-budget-'));
  const store = new JsonStore(root, { capacityLimits: { documentBytes: 1024, storeBytes: 24000 }, journalMaxBytes: 8192 }); await store.open();
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await store.transaction({ json: { 'global/state.json': { text: 'ops'.repeat(500) } } });
  await assert.rejects(store.transaction({ json: { 'self/persona.json': { text: 'x'.repeat(1100) } } }), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(store.transaction({ json: { 'journal/runs/huge.json': { text: 'x'.repeat(9000) } } }), { code: 'CAPACITY_EXCEEDED' });
  const initial = await store.readJson('global/state.json');
  await assert.rejects(store.transaction({ json: { 'global/state.json': { changed: true }, 'global/other.json': { text: 'x'.repeat(7500) } } }), error => error.code === 'CAPACITY_EXCEEDED' && error.resource === 'storePeakBytes');
  assert.deepEqual(await store.readJson('global/state.json'), initial); assert.equal(await store.readJson('global/other.json'), null);
  await assert.rejects(store.transaction({ json: { 'global/state.json': { invalid: Infinity } } }), { code: 'SCHEMA_INVALID' });
});

test('prepared admission reclaims bounded committed diagnostics rather than deadlocking below the workspace ceiling', async t => {
  const { repository } = await fixture(t, { retention: { journalMaxBytes: 8192 } }); let first;
  for (let index = 0; index < 6; index++) {
    const run = await repository.prepareConsolidation({ personId: 'a' }); first ??= run;
    await repository.applyConsolidation(run, [entry(run, 'persona', 'anchor', { text: String(index).repeat(1200) })]);
  }
  const runs = await repository.listConsolidationRuns(); assert.ok(runs.length < 6);
  assert.equal((await repository.applyConsolidation(first, [])).duplicate, true);
  assert.equal((await repository.getPersona()).anchor.text, '5'.repeat(1200));
});

test('failed work metadata is bounded without discarding prepared input or the original conversation', async t => {
  const { repository } = await fixture(t); const original = await repository.ingest(chat('original', '不能被日志清理删掉'));
  const writes = {};
  for (let index = 0; index < 130; index++) writes['journal/runs/failed_' + index + '.json'] = { schemaVersion: 'persona-memory/3', runId: 'failed_' + index,
    status: 'failed', validatedPatch: [], commitMarker: null, invalidation: { reason: 'source_revoked', at: index } };
  await repository.store.transaction({ json: writes });
  const prepared = await repository.prepareConsolidation({ personId: 'a' });
  assert.ok((await repository.listConsolidationRuns({ status: 'failed' })).length <= 128);
  assert.ok(prepared.input.chat.some(record => record.id === original.record.id));
  assert.equal((await repository.readSources({ eventIds: [original.eventId] }))[0].text, original.record.text);
});

test('unknown target refusal consumes nothing; null remains legal and old prepared page size survives a new default', async t => {
  const { repository, root } = await fixture(t); const original = await repository.ingest(chat('one', '中'.repeat(20000)));
  const runtimeBefore = await repository.getRuntime(), metaBefore = await repository.store.readJson('meta/state.json');
  const runsBefore = await repository.listConsolidationRuns();
  await assert.rejects(repository.prepareConsolidation({ personId: 'missing_safe_id' }), { code: 'UNKNOWN_PERSON_TARGET' });
  assert.deepEqual(await repository.getRuntime(), runtimeBefore); assert.deepEqual(await repository.store.readJson('meta/state.json'), metaBefore);
  assert.deepEqual(await repository.listConsolidationRuns(), runsBefore);
  await assert.rejects(fs.access(path.join(root, 'people/missing_safe_id')), { code: 'ENOENT' });
  assert.equal((await repository.readSources({ eventIds: [original.eventId] }))[0].text, original.record.text);
  const old = await repository.prepareConsolidation({ personId: 'a', maxInputChars: 16000 });
  await repository.recordConsolidationProgress(old.runId, { reviewState: { modelCalls: 1, pageChars: 16000, dataPartOffset: 13031, contextComplete: false } });
  await repository.updateConfig({ processingLimits: { consolidationInputChars: 4000 } });
  const retained = await repository.getConsolidationRun(old.runId);
  assert.deepEqual(retained.inputSlices, old.inputSlices); assert.deepEqual(retained.cursorAfter, old.cursorAfter);
  assert.equal(retained.inputEndEventId, old.inputEndEventId); assert.equal(retained.reviewState.pageChars, 16000); assert.equal(retained.reviewState.dataPartOffset, 13031);
  const next = await repository.prepareConsolidation({ personId: 'a' }); assert.equal(next.input.chat[0].text.length, 4000);
  assert.equal((await repository.prepareConsolidation({ personId: null })).personId, null);
});
