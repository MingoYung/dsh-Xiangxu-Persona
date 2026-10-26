import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { defaultConfig, validateDeepMemory } from '../core/schema.js';
import { buildSnapshot, consolidationContextPage, consolidationMessages } from '../core/prompts.js';
import { fitDeepMemoryReferences } from '../core/deep-memory.js';

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-deep-'));
  const clock = { value: 1000 };
  let repository = new MemoryRepository({ root, config, clock: () => clock.value });
  await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, clock, get repository() { return repository; }, async reopen() { await repository.close(); repository = new MemoryRepository({ root, clock: () => clock.value }); await repository.open(); return repository; } };
}
const chat = (id, text, role = 'user', personId = null) => ({ sourceSessionId: 'source', sourceEventId: id, personId,
  channelId: 'dsh:source', sourceKind: 'message', contentClass: 'participant_dialogue', role, text });
const deep = overrides => ({ title: '那次相处', reference: '那天的经历对我有意义', experience: '真实经历的记忆',
  feltThen: '当时既难过也感动', meaningNow: '我现在还在理解它', cues: ['相似情境，是否联想由我自己决定'],
  aboutPersonIds: [], relatedMemoryIds: [], supersedesIds: [], ...overrides });
const entry = (run, id, value, operation = 'upsert', documentKey = 'global:deep') => ({ documentKey, recordId: id,
  expectedVersion: run.inputVersions[documentKey], operation, ...(operation === 'upsert' ? { value } : {}) });
async function remember(repository, id, value) {
  const run = await repository.prepareConsolidation();
  await repository.applyConsolidation(run, [entry(run, id, value)]);
  return run;
}

test('empty old-format stores remain readable and do not acquire invented deep memories', async t => {
  const f = await fixture(t); const { repository, root } = f;
  assert.deepEqual((await repository.introspect({ section: 'deep' })).items, []);
  await repository.close();
  const old = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  delete old.artifactLimits.deepMemories; delete old.artifactLimits.deepMemoryChars; delete old.contextBudget.deepMemoryTokens; delete old.reviewAssistant;
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(old));
  const reopened = await f.reopen();
  assert.equal(reopened.config.artifactLimits.deepMemories, 128);
  assert.equal(reopened.config.artifactLimits.deepMemoryChars, 100000);
  assert.equal(reopened.config.contextBudget.totalTokens, 2970);
  assert.deepEqual((await reopened.getContext()).deepMemories, []);
  await assert.rejects(fs.access(path.join(root, 'global', 'deep.json')), { code: 'ENOENT' });
});

test('deep experiences persist in one shared module with actual source roles, search and owner browsing', async t => {
  const f = await fixture(t); const original = await f.repository.ingest(chat('assistant-original', '我那时感到被理解', 'assistant'));
  await remember(f.repository, 'turning_point', deep({ experience: original.record.text }));
  const section = await f.repository.introspect({ section: 'deep' });
  assert.equal(section.version, 1); assert.equal(section.referenceOnly, true); assert.equal(section.automaticRecall, false);
  assert.equal(section.items[0].srcRefs[0].sourceRole, 'assistant');
  assert.equal(section.items[0].scope, 'global'); assert.equal(section.items[0].personId, null);
  assert.equal((await f.repository.search({ query: '被理解', scope: 'global' })).items[0].id, 'turning_point');
  assert.equal((await f.repository.browseMemory({ recordType: 'deep' })).total, 1);
  assert.equal((await f.repository.getMemoryRecord('turning_point')).feltThen, '当时既难过也感动');
  const bytes = await fs.readFile(path.join(f.root, 'global', 'deep.json'));
  await f.reopen();
  assert.equal((await f.repository.introspect({ section: 'deep' })).items[0].meaningNow, '我现在还在理解它');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'global', 'deep.json')), bytes);
});

test('time and cue words never automatically recall, heal, decay or mutate a deep record', async t => {
  const f = await fixture(t); await f.repository.ingest(chat('snake', '曾被蛇咬'));
  await remember(f.repository, 'snake', deep({ reference: '蛇与井绳的经历', cues: ['井绳'], feltThen: '疼痛和害怕' }));
  const before = await fs.readFile(path.join(f.root, 'global', 'deep.json'));
  const state = await f.repository.getRuntime(); f.clock.value += 10 * 365 * 86400000;
  await f.repository.ingest(chat('rope-now', '今天看到了井绳'));
  const afterIngest = await fs.readFile(path.join(f.root, 'global', 'deep.json'));
  assert.deepEqual(afterIngest, before);
  const material = await f.repository.getContext();
  const snapshot = await buildSnapshot({ material, state: await f.repository.getRuntime(), context: { environment: { now: f.clock.value }, personId: null },
    config: f.repository.config, now: f.clock.value, counter: { method: 'test_unicode', count: async s => Array.from(s).length } });
  assert.ok(snapshot.segments.some(s => s.name === 'deep_memory_reference'));
  assert.ok(!snapshot.injectedText.includes('疼痛和害怕'));
  assert.ok(!snapshot.injectedText.includes('真实经历的记忆'));
  assert.equal((await f.repository.getRuntime()).sleep.state, state.sleep.state);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'global', 'deep.json')), before);
});

test('the personality may reinterpret, replace and prune without deleting original events', async t => {
  const f = await fixture(t); const source = await f.repository.ingest(chat('event', '一次重要相处'));
  await remember(f.repository, 'older', deep({ feltThen: '当时很难过', meaningNow: '当时的理解' }));
  const reread = (await f.repository.introspect({ section: 'deep' })).items[0];
  await f.repository.ingest(chat('later', '后来我理解到另一面'));
  let run = await f.repository.prepareConsolidation();
  await f.repository.applyConsolidation(run, [entry(run, 'older', { ...reread, meaningNow: '我已逐渐释怀，是否还怕由我判断' })]);
  const evolved = (await f.repository.introspect({ section: 'deep' })).items[0];
  assert.equal(evolved.feltThen, '当时很难过'); assert.match(evolved.meaningNow, /释怀/);
  run = await f.repository.prepareConsolidation();
  await f.repository.applyConsolidation(run, [entry(run, 'older', null, 'remove'), entry(run, 'newer', deep({ title: '更深刻的新经历', supersedesIds: ['older'] }))]);
  assert.deepEqual((await f.repository.introspect({ section: 'deep' })).items.map(x => x.id), ['newer']);
  run = await f.repository.prepareConsolidation(); await f.repository.applyConsolidation(run, [entry(run, 'newer', null, 'remove')]);
  assert.deepEqual((await f.repository.introspect({ section: 'deep' })).items, []);
  assert.equal((await f.repository.readSources({ eventIds: [source.eventId] })).length, 1);
});

test('capacity failures are atomic and do not silently evict deeper or older experiences', async t => {
  const f = await fixture(t, { artifactLimits: { deepMemories: 1, deepMemoryChars: 1500 } });
  await f.repository.ingest(chat('event', '经历'));
  await remember(f.repository, 'retained', deep());
  const run = await f.repository.prepareConsolidation();
  await assert.rejects(f.repository.applyConsolidation(run, [entry(run, 'second', deep({ title: '更强烈' }))]), { code: 'CAPACITY_EXCEEDED' });
  assert.deepEqual((await f.repository.introspect({ section: 'deep' })).items.map(x => x.id), ['retained']);
  assert.equal((await f.repository.getConsolidationRun(run.runId)).status, 'prepared');
  await assert.rejects(f.repository.applyConsolidation(run, [entry(run, 'retained', deep({ experience: '超'.repeat(1600) }))]), { code: 'CAPACITY_EXCEEDED' });
  assert.equal((await f.repository.getMemoryRecord('retained')).experience, '真实经历的记忆');
});

test('natural original eviction preserves the reference while explicit source forgetting removes it and frozen copies', async t => {
  const f = await fixture(t); const source = await f.repository.ingest(chat('event', '需要区分自然淘汰和明确遗忘'));
  await remember(f.repository, 'deep_event', deep());
  await f.repository.clearPending([source.eventId]); await f.repository.evictSources([source.record.id]);
  const item = await f.repository.getMemoryRecord('deep_event'); assert.equal(item.srcRefs[0].available, false);
  const run = await f.repository.prepareConsolidation();
  await f.repository.forget({ scope: 'global', ids: ['deep_event'], reason: '明确遗忘' });
  assert.equal(await f.repository.getMemoryRecord('deep_event'), null);
  assert.deepEqual((await f.repository.introspect({ section: 'deep' })).items, []);
  const frozen = await f.repository.getConsolidationRun(run.runId);
  assert.equal(frozen.status, 'failed'); assert.equal(frozen.input, undefined);
  await f.reopen(); assert.equal(await f.repository.getMemoryRecord('deep_event'), null);
  assert.equal((await f.repository.ingest(chat('event', '旧原文重放'))).revoked, true);
});

test('reference cards are whole bounded JSON and contain no full episode or automatic trigger decision', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: 'deep_' + i, title: '回忆' + i, reference: '我保留的一段参考😀', cues: ['井绳'], aboutPersonIds: [], updatedAt: 1,
    experience: 'FULL_EPISODE_SECRET', feltThen: 'FULL_FEELING_SECRET', meaningNow: 'FULL_MEANING_SECRET' }));
  const counter = { count: async text => Buffer.byteLength(text) };
  const result = await fitDeepMemoryReferences(items, { budget: 600, counter });
  assert.ok(result.text); assert.ok(Buffer.byteLength(result.text) <= 600);
  const data = JSON.parse(result.text.split('\n')[1]);
  assert.equal(data.referenceOnly, true); assert.equal(data.automaticRecall, false); assert.equal(data.total, 20); assert.equal(data.truncated, true);
  assert.equal(data.items.length, data.shown); assert.ok(data.shown > 0);
  assert.ok(!result.text.includes('FULL_')); assert.ok(!Object.hasOwn(data, 'triggered'));
});

test('a long valid first reference yields a labelled bounded preview instead of hiding all references', async () => {
  const source = { id: 'deep_long', title: '长'.repeat(256), reference: '参考😀'.repeat(170), cues: Array.from({ length: 32 }, () => '情境'.repeat(100)), aboutPersonIds: ['a'], updatedAt: 1 };
  const result = await fitDeepMemoryReferences([source], { budget: 600, counter: { count: async text => Buffer.byteLength(text) } });
  assert.ok(Buffer.byteLength(result.text) <= 600);
  const payload = JSON.parse(result.text.split('\n')[1]);
  assert.equal(payload.items[0].id, 'deep_long'); assert.equal(payload.items[0].partial, true);
  assert.equal(payload.items[0].referenceTotalChars, Array.from(source.reference).length);
  assert.ok(source.reference.startsWith(payload.items[0].reference));
});

test('the total snapshot budget never cuts a deep reference JSON card in the middle', async () => {
  const item = { id: 'deep_budget', ...deep(), updatedAt: 1 };
  const snapshot = await buildSnapshot({ material: { persona: { anchor: { text: 'anchor'.repeat(100) }, facets: [], signatures: [], habits: [] }, deepMemories: [item] },
    state: { sleep: { state: 'awake' } }, context: { channelId: 'dsh:s', sessionId: 's' }, config: defaultConfig(), now: 1,
    counter: { method: 'utf8_bytes_estimate', count: async text => Buffer.byteLength(text) } });
  assert.ok(snapshot.tokens <= 2970);
  const line = snapshot.injectedText.split('[deep_memory_reference]\n')[1]?.split('\n')[0];
  assert.ok(line); assert.equal(JSON.parse(line).items[0].id, 'deep_budget');
});

test('source references are actual stable events, preserve speakers, and never impose an evidence quorum', async t => {
  const f = await fixture(t); await f.repository.ingest(chat('ai-origin', '我自己的感受', 'assistant'));
  let run = await f.repository.prepareConsolidation();
  const fake = { sourceSessionId: 'invented', sourceEventId: 'invented', sourceRole: 'user' };
  await assert.rejects(f.repository.applyConsolidation(run, [entry(run, 'fake', deep({ srcRefs: [fake] }))]), { code: 'SCHEMA_INVALID' });
  await assert.rejects(f.repository.applyConsolidation(run, [entry(run, 'fake-fact', { text: '引用假的事实', srcRefs: [fake] }, 'upsert', 'global:index')]), { code: 'SCHEMA_INVALID' });
  await assert.rejects(f.repository.applyConsolidation(run, [entry(run, 'wrong-role', deep({ srcRefs: [{ sourceSessionId: 'source', sourceEventId: 'ai-origin', sourceRole: 'user' }] }))]), { code: 'SCHEMA_INVALID' });
  assert.deepEqual((await f.repository.introspect({ section: 'deep' })).items, []);
  await f.repository.applyConsolidation(run, [entry(run, 'subjective', deep({ meaningNow: '没有引用也可以保留我的主观理解', srcRefs: [] }))]);
  assert.equal((await f.repository.getMemoryRecord('subjective')).srcRefs.length, 0);
  run = await f.repository.prepareConsolidation();
  await f.repository.applyConsolidation(run, [entry(run, 'actual', deep({ srcRefs: [{ sourceSessionId: 'source', sourceEventId: 'ai-origin' }, { sourceSessionId: 'source', sourceEventId: 'ai-origin' }] }))]);
  const actual = await f.repository.getMemoryRecord('actual'); assert.equal(actual.srcRefs.length, 1); assert.equal(actual.srcRefs[0].sourceRole, 'assistant');
});

test('known naturally evicted sources remain usable without inventing their availability or speaker', async t => {
  const f = await fixture(t); const original = await f.repository.ingest(chat('remembered_ai', '确实由AI说过', 'assistant'));
  await f.repository.evictSources([original.record.id]);
  const run = await f.repository.prepareConsolidation();
  await f.repository.applyConsolidation(run, [entry(run, 'natural', deep({ srcRefs: [{ sourceSessionId: 'source', sourceEventId: 'remembered_ai', available: true }] }))]);
  const stored = await f.repository.getMemoryRecord('natural');
  assert.equal(stored.srcRefs[0].available, false); assert.equal(stored.srcRefs[0].sourceRole, 'assistant');
});

test('optional review assistant configuration is bounded and explicitly disabled by default', () => {
  const config = defaultConfig(); assert.deepEqual(config.reviewAssistant, { enabled: false, maxOutputTokens: 1024, maxReportChars: 4000 });
  assert.equal(defaultConfig({ reviewAssistant: { enabled: true } }).reviewAssistant.maxOutputTokens, 1024);
  for (const value of [{ enabled: 'yes' }, { maxOutputTokens: 0 }, { maxOutputTokens: 8193 }, { maxReportChars: 16001 }]) assert.throws(() => defaultConfig({ reviewAssistant: value }), { code: 'SCHEMA_INVALID' });
});

test('deep records have bounded structure without emotion quotas or required healing states', () => {
  const base = { schemaVersion: 'persona-memory/3', id: 'deep', scope: 'global', personId: null, epistemic: 'interpretation', srcRefs: [], createdAt: 1, updatedAt: 1, ...deep() };
  assert.equal(validateDeepMemory({ ...base, feltThen: '痛苦、快乐、感动、愤怒同时存在', meaningNow: '我仍然这样认为' }).id, 'deep');
  assert.throws(() => validateDeepMemory({ ...base, reference: 'x'.repeat(513) }), { code: 'SCHEMA_INVALID' });
});

test('Unicode memory identities can be referenced, superseded and read within the same 200-character reader bound', async t => {
  const f = await fixture(t); await f.repository.ingest(chat('unicode', '这段记忆使用中文稳定编号'));
  await remember(f.repository, '初次相识😀', deep());
  const run = await f.repository.prepareConsolidation();
  await f.repository.applyConsolidation(run, [entry(run, '初次相识😀', null, 'remove'), entry(run, '后来释怀😀', deep({ relatedMemoryIds: ['初次相识😀'], supersedesIds: ['初次相识😀'] }))]);
  assert.equal((await f.repository.getMemoryRecord('后来释怀😀')).supersedesIds[0], '初次相识😀');
  const base = { schemaVersion: 'persona-memory/3', id: '回'.repeat(200), scope: 'global', personId: null, epistemic: 'interpretation', srcRefs: [], createdAt: 1, updatedAt: 1, ...deep({ relatedMemoryIds: ['忆'.repeat(200)] }) };
  assert.equal(validateDeepMemory(base).id.length, 200);
  assert.throws(() => validateDeepMemory({ ...base, id: '回'.repeat(201) }), { code: 'SCHEMA_INVALID' });
  assert.throws(() => validateDeepMemory({ ...base, supersedesIds: ['忆'.repeat(201)] }), { code: 'SCHEMA_INVALID' });
});
