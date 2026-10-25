import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { SCHEMA_VERSION, emptyPersona, validatePersona, validateDecision } from '../core/schema.js';
import { consolidationMessages } from '../core/prompts.js';

const chat = (id, text, personId = null) => ({ personId, sourceSessionId: 's1', sourceEventId: id, sourceKind: 'user',
  contentClass: 'participant_dialogue', channelId: 'desktop', role: 'user', text, sourceAt: 1000, observedAt: 1000 });
const hot = (id, text, personId = null, blockIndex = 0) => ({ personId, sourceRef: { sourceSessionId: 's1', sourceEventId: id, available: true },
  kind: 'reasoning', sourceKind: 'reasoning', origin: 'ai_reply', blockIndex, content: { mode: 'cached', text, chars: text.length }, sourceAt: 1000, observedAt: 1000 });
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-memory-'));
  const repository = new MemoryRepository({ root, config, clock: () => 5000 }); await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repository };
}
async function memoryPatch(repository, personId, text, id = 'fact1') {
  const run = await repository.prepareConsolidation({ personId });
  const key = 'person:' + personId + ':index';
  await repository.applyConsolidation(run, [{ documentKey: key, expectedVersion: run.inputVersions[key], operation: 'upsert', recordId: id, value: { kind: 'fact', text } }]);
  return run;
}
test('source keys deduplicate across restart; source time and Unicode character counts survive', async (t) => {
  const { root, repository } = await fixture(t); await repository.upsertPerson({ personId: 'alice', displayName: 'Alice' });
  const first = await repository.ingest(chat('1', '猫😀', 'alice'));
  assert.equal(first.record.chars, 2);
  assert.equal((await repository.ingest(chat('1', 'changed', 'alice'))).duplicate, true);
  await repository.close();
  const again = new MemoryRepository({ root, clock: () => 9000 }); await again.open();
  assert.equal((await again.ingest(chat('1', 'changed', 'alice'))).duplicate, true);
  assert.equal((await again.getContext({ personId: 'alice' })).records[0].sourceAt, 1000);
  await again.close();
});
test('unknown staged messages can be assigned and reassigned without becoming duplicate experiences', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  const source = await repository.ingest(chat('u', '我喜欢豆豆'));
  await repository.captureHot(hot('u', '同根过程'));
  assert.equal((await repository.getPending()).length, 1);
  const assigned = await repository.assign({ sourceSessionId: 's1', sourceEventId: 'u', personId: 'a', reason: '看见名字' });
  assert.equal(assigned.record.id, source.record.id);
  assert.equal((await repository.getContext({ personId: null })).records.length, 0);
  const first = await repository.prepareConsolidation({ personId: 'a' });
  await repository.applyConsolidation(first, []);
  await repository.assign({ sourceSessionId: 's1', sourceEventId: 'u', personId: 'b', reason: '后来认出' });
  assert.equal((await repository.getContext({ personId: 'a' })).records.length, 0);
  const second = await repository.prepareConsolidation({ personId: 'b' });
  assert.equal(second.input.chat.length, 1);
  assert.equal((await repository.getPending()).length, 1);
});
test('same root event retains multiple same-kind hot blocks; committing a run does not erase new input', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('1', '原话', 'a'));
  await repository.captureHot(hot('1', '第一块', 'a', 0));
  await repository.captureHot(hot('1', '第二块', 'a', 1));
  assert.equal((await repository.captureHot(hot('1', '重复第一块', 'a', 0))).duplicate, true);
  const run = await repository.prepareConsolidation({ personId: 'a' }); assert.equal(run.input.hot.length, 2);
  await repository.captureHot(hot('2', '准备后新到的', 'a'));
  const firstCommit = await repository.applyConsolidation(run, []);
  assert.equal(firstCommit.duplicate, false);
  assert.equal((await repository.applyConsolidation(run, [])).duplicate, true);
  const next = await repository.prepareConsolidation({ personId: 'a' });
  assert.equal(next.input.hot.length, 1); assert.equal(next.input.hot[0].sourceRef.sourceEventId, '2');
});
test('correct cross-subject recall is supported without reassigning an A fact to B', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  await repository.ingest(chat('a', 'A的猫名豆豆', 'a')); await repository.ingest(chat('b', 'B的狗名旺财', 'b'));
  await memoryPatch(repository, 'a', 'A的猫名豆豆');
  assert.equal((await repository.search({ query: '豆豆' }, { personId: 'b' })).items.length, 0);
  const explicit = await repository.search({ query: '豆豆', targetPersonId: 'a' }, { personId: 'b' });
  assert.ok(explicit.items.length); assert.ok(explicit.items.every((r) => r.personId === 'a'));
  assert.ok((await repository.search({ query: '豆豆', scope: 'all' }, { personId: 'b' })).items.some((r) => r.personId === 'a'));
});
test('natural eviction keeps important summaries while explicit forgetting persists through replay/rebuild', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const original = await repository.ingest(chat('source', '豆豆是一只猫', 'a'));
  await memoryPatch(repository, 'a', '豆豆是一只很重要的猫');
  await repository.clearPending([original.record.eventId]);
  await repository.evictSources([original.record.id]);
  const summaries = (await repository.search({ query: '豆豆' }, { personId: 'a' })).items;
  assert.equal(summaries.length, 1); assert.equal(summaries[0].srcRefs[0].available, false);
  const before = await repository.prepareConsolidation({ personId: 'a' });
  await repository.forget({ ids: ['fact1'], reason: '明确忘掉豆豆' }, { personId: 'a' });
  assert.equal((await repository.search({ query: '豆豆' }, { personId: 'a' })).items.length, 0);
  const key = 'person:a:index';
  await assert.rejects(repository.applyConsolidation(before, [{ documentKey: key, expectedVersion: before.inputVersions[key], operation: 'upsert', recordId: 'rebuilt', value: { text: '豆豆', srcRefs: original.record ? [{ sourceSessionId: 's1', sourceEventId: 'source', available: false }] : [] } }]), (e) => ['VERSION_CONFLICT', 'REVOKED_SOURCE', 'RUN_INVALIDATED'].includes(e.code));
  assert.equal((await repository.ingest(chat('source', '重新回放同一原话', 'a'))).duplicate, true);
});
test('no selector does not delete a person; persona/relationship scalars obey explicit source revocation', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const original = await repository.ingest(chat('1', '只聊了第一次', 'a'));
  assert.deepEqual(await repository.forget({ reason: '含糊' }, { personId: 'a' }), { needsSelection: true });
  const run = await repository.prepareConsolidation({ personId: 'a' });
  await repository.applyConsolidation(run, [
    { documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '我开始喜欢这种相处' } },
    { documentKey: 'person:a:impression', expectedVersion: 0, operation: 'upsert', recordId: 'summary', value: '初次印象有点紧张' }
  ]);
  assert.equal((await repository.getPersona()).anchor.text, '我开始喜欢这种相处');
  await repository.forget({ ids: [original.record.id], reason: '撤销这次经历' }, { personId: 'a' });
  assert.equal((await repository.getPersona()).anchor.text, '');
  assert.equal((await repository.getContext({ personId: 'a' })).impression.summary, '');
});
test('capacity degrades redundant copies, preserves conversation autonomy, and hot overflow uses truthful pointers', async (t) => {
  const { repository } = await fixture(t, { tempTargetChars: 3 });
  await repository.upsertPerson({ personId: 'a' }); await repository.ingest(chat('1', '12345', 'a'));
  await repository.updateConfig({ longTermTargetChars: (await repository.getCapacity()).persistentChars });
  const exceeded = await repository.ingest({ ...chat('2', '6', 'a'), hostAvailable: true });
  assert.ok(exceeded.gap); assert.equal(exceeded.record, null);
  const captured = await repository.captureHot(hot('r', 'full reasoning too long', 'a'));
  assert.equal(captured.record.content.mode, 'host_trace');
  assert.equal(captured.record.content.available, false); assert.ok(captured.gap);
  assert.equal((await repository.getRuntime()).sleep.state, 'awake');
});
test('model patch versions conflict rather than overwriting another committed evolution', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const one = await repository.prepareConsolidation({ personId: 'a' }); const two = await repository.prepareConsolidation({ personId: 'a' });
  const patch = (text) => [{ documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text } }];
  await repository.applyConsolidation(one, patch('first'));
  await assert.rejects(repository.applyConsolidation(two, patch('stale')), { code: 'VERSION_CONFLICT' });
  assert.equal((await repository.getPersona()).anchor.text, 'first');
});
test('mode switches preserve pending and committed cursors; runtime/outbox diagnostics survive reopen', async (t) => {
  const { root, repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('1', '还没有回的话', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' }); await repository.applyConsolidation(run, []);
  const cursors = (await repository.getRuntime()).consolidationCursors;
  await repository.updateConfig({ consolidationMode: 'on_write' });
  assert.deepEqual((await repository.getRuntime()).consolidationCursors, cursors);
  assert.equal((await repository.getPending()).length, 1);
  await repository.saveOutbox([{ deliveryId: 'd', status: 'unknown', target: { personId: 'a' } }]);
  await repository.recordUsage({ purpose: 'decision', inputTokens: 12 });
  await repository.close(); const reopened = new MemoryRepository({ root }); await reopened.open();
  assert.equal(reopened.config.consolidationMode, 'on_write');
  assert.equal((await reopened.getOutbox())[0].status, 'unknown');
  assert.equal((await reopened.getUsage())[0].inputTokens, 12);
  await reopened.close();
});
test('structural checks accept first impressions, scene words, event-only waiting and autonomous sleep', () => {
  validateDecision({ replyPlan: { action: 'listen', recheckOn: ['new_message'] }, sleepPlan: { action: 'sleep', wakeCondition: 'consolidation_complete', wakeAt: null } });
  const persona = emptyPersona(0); persona.axes.warmth = { desc: '深夜相处有时更放松', position: null, n: 0, sd: null, metric: null, window: null, srcRefs: [] };
  validatePersona(persona);
  persona.axes.warmth.sd = 0.3;
  assert.throws(() => validatePersona(persona), { code: 'SCHEMA_INVALID' });
  assert.throws(() => validateDecision({ sleepPlan: { action: 'sleep', wakeCondition: 'at_time', wakeAt: null } }), { code: 'SCHEMA_INVALID' });
});
test('automatic user-role material never becomes participant dialogue in C1', async (t) => {
  const { repository } = await fixture(t);
  await assert.rejects(repository.ingest({ ...chat('bad', 'runtime instructions'), sourceKind: 'agent-instructions' }), { code: 'SCHEMA_INVALID' });
  await assert.rejects(repository.ingest({ ...chat('bad2', 'tool result'), contentClass: 'tool_result' }), { code: 'SCHEMA_INVALID' });
  assert.equal((await repository.getPending()).length, 0);
});
test('a fault after hot cleanup recovers persona patch, cursor, run marker and only consumed hot', async (t) => {
  const { root, repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('1', '这次有新的经历', 'a')); await repository.captureHot(hot('1', '这次过程', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  await repository.captureHot(hot('2', '之后的新过程', 'a'));
  repository.store.fault = (phase, details) => {
    if (phase === 'after_apply' && details.path === 'people/a/hot.jsonl') throw new Error('fault after selective cleanup');
  };
  await assert.rejects(repository.applyConsolidation(run, [{ documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '经历后慢慢变化' } }]), /selective cleanup/);
  await repository.close();
  const recovered = new MemoryRepository({ root, clock: () => 8000 }); await recovered.open();
  assert.equal((await recovered.getPersona()).anchor.text, '经历后慢慢变化');
  assert.equal((await recovered.getConsolidationRun(run.runId)).status, 'committed');
  assert.equal((await recovered.applyConsolidation(run, [])).duplicate, true);
  const next = await recovered.prepareConsolidation({ personId: 'a' });
  assert.equal(next.input.hot.length, 1); assert.equal(next.input.hot[0].sourceRef.sourceEventId, '2');
  await recovered.close();
});
test('persona evolution keeps bounded rollback versions and explicit forgetting clears them', async (t) => {
  const { repository } = await fixture(t, { retention: { personaHistoryMaxVersions: 2 } }); await repository.upsertPerson({ personId: 'a' });
  const original = await repository.ingest(chat('1', '一次真实经历', 'a'));
  for (const text of ['first', 'second', 'third']) {
    const run = await repository.prepareConsolidation({ personId: 'a' });
    await repository.applyConsolidation(run, [{ documentKey: 'persona', expectedVersion: run.inputVersions.persona, operation: 'upsert', recordId: 'anchor', value: { text } }]);
  }
  const history = await repository.getPersonaHistory(); assert.equal(history.length, 2);
  const reverted = await repository.rollbackPersona(history[0].version);
  assert.equal(reverted.version, 4); assert.equal(reverted.anchor.text, history[0].anchor.text);
  await repository.forget({ ids: [original.record.id], reason: '明确撤销' }, { personId: 'a' });
  assert.deepEqual(await repository.getPersonaHistory(), []);
  await assert.rejects(repository.rollbackPersona(1), { code: 'VERSION_UNAVAILABLE' });
});
test('oversized original and process text are paged without advancing past unread fragments', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('1', '一二三四五六七八九十', 'a'));
  await repository.captureHot(hot('1', '甲乙丙丁戊己庚辛壬癸', 'a'));
  const seenChat = []; const seenHot = [];
  for (let index = 0; index < 8; index++) {
    const run = await repository.prepareConsolidation({ personId: 'a', maxInputChars: 3 });
    const chars = run.input.chat.reduce((n, r) => n + r.chars, 0) + run.input.hot.reduce((n, r) => n + (r.content.mode === 'cached' ? r.content.chars : 0), 0);
    assert.ok(chars <= 3);
    seenChat.push(...run.input.chat.map((r) => r.text)); seenHot.push(...run.input.hot.map((r) => r.content.text));
    assert.equal(Object.hasOwn(run.input.context, 'records'), false);
    await repository.applyConsolidation(run, []);
  }
  assert.equal(seenChat.join(''), '一二三四五六七八九十'); assert.equal(seenHot.join(''), '甲乙丙丁戊己庚辛壬癸');
  assert.equal((await repository.prepareConsolidation({ personId: 'a' })).input.chat.length, 0);
});
test('natural eviction never loses a message still queued for wake/receive', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const received = await repository.ingest(chat('1', '醒来还要接收这句', 'a'));
  await repository.evictSources([received.record.id]);
  assert.equal((await repository.getPending())[0].text, '醒来还要接收这句');
});
test('delivered assistant messages remain memories but never become pending user mail', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const user = await repository.ingest(chat('u', '等你的话', 'a'));
  for (const [id, origin] of [['reply', 'ai_reply'], ['proactive', 'ai_initiated']]) await repository.ingest({ ...chat(id, '我已经实际说出口', 'a'), role: 'assistant', origin });
  assert.deepEqual((await repository.getPending()).map((r) => r.eventId), [user.eventId]);
  const state = await repository.getPersonState('a');
  assert.deepEqual(state.pendingEventIds, [user.eventId]); assert.equal(state.lastDeliveredAt, 1000);
  assert.equal((await repository.getContext({ personId: 'a' })).records.length, 3);
});
test('one nonempty evolution patch creates shared personality, personal relation, soft boundaries, code and interpretation', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  const original = await repository.ingest(chat('1', '深夜我愿意慢一点说，明天也许再聊', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  const entry = (documentKey, recordId, value) => ({ documentKey, recordId, value, expectedVersion: run.inputVersions[documentKey], operation: 'upsert' });
  await repository.applyConsolidation(run, [
    entry('persona', 'anchor', { text: '经历会让我改变，但我愿意记住熟悉的人' }),
    entry('persona', 'axes', { warmth: { desc: '深夜更愿意慢一点相处', position: null, n: 0, sd: null, metric: null, window: null, srcRefs: [] } }),
    entry('persona', 'facets:shared', { kind: 'tendency', desc: '遇到别人犹豫时也愿意等一等' }),
    entry('persona', 'facets:personal-boundary', { kind: 'boundary', personId: 'a', scope: 'person', topic: '夜里追问', policy: 'avoid', desc: '和A夜里相处时我倾向少追问' }),
    entry('persona', 'signatures:night', { if: '深夜相处时', then: '有时说慢一点，有时也会开个玩笑', cues: [], observations: 1 }),
    entry('persona', 'habits:gentle', { text: '不急着填满每一次沉默' }),
    entry('global:codes', 'shared-code', { label: '缓一缓', meaning: '记得有人愿意慢一点相处', occurrences: 1 }),
    entry('person:a:codes', 'our-code', { label: '夜话', meaning: '我和A之间慢一点说的默契', occurrences: 1 }),
    entry('person:a:pending', 'impression-candidate', { text: '他也许只是今晚累了', questions: ['下次见面时再体会'] }),
    entry('person:a:impression', 'summary', '第一次相处让我有一点亲近，也有一些不确定'),
    entry('person:a:impression', 'signatures:with-a', { if: '和A在夜里闲聊', then: '我愿意跟着他的节奏', cues: [], observations: 1 }),
    entry('person:a:impression', 'events:commitment', { type: 'commitment', text: '说过明天也许再聊', who: 'both', mentionedTime: 9000, state: 'open', reaction: 'not_observed', reactionTo: null })
  ]);
  const a = await repository.getContext({ personId: 'a' }), b = await repository.getContext({ personId: 'b' });
  assert.equal(a.persona.anchor.text, b.persona.anchor.text);
  assert.equal(b.persona.signatures[0].observations, 1); assert.equal(b.persona.axes.warmth.sd, null);
  assert.equal(a.impression.signatures.length, 1); assert.equal(b.impression.signatures.length, 0);
  assert.equal(a.interpretations.length, 1);
  assert.ok(b.codes.some((code) => code.id === 'shared-code'));
  assert.ok(!b.codes.some((code) => code.id === 'our-code'));
  assert.equal((await repository.search({ query: '默契', targetPersonId: 'a' }, { personId: 'b' })).items[0].personId, 'a');
  const runtime = await repository.getRuntime(); assert.equal(runtime.sleep.state, 'awake'); assert.equal(runtime.schedule.nextCheckAt, null);
  await repository.clearPending([original.eventId]); await repository.evictSources([original.record.id]);
  assert.equal((await repository.getPersona()).signatures.length, 1);
});
test('invalid relationship structure is rejected without consuming sources or writing partial personality', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('1', '一次经历', 'a')); const run = await repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(repository.applyConsolidation(run, [
    { documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '不可半批写入' } },
    { documentKey: 'person:a:impression', expectedVersion: 0, operation: 'upsert', recordId: 'events:invalid', value: { type: 'commitment', text: '缺少结构字段' } }
  ]), { code: 'SCHEMA_INVALID' });
  assert.equal((await repository.getPersona()).anchor.text, '');
  assert.equal((await repository.getConsolidationRun(run.runId)).status, 'prepared');
});
test('an unknown future config schema is preserved byte-for-byte when open refuses it', async (t) => {
  const { root, repository } = await fixture(t); await repository.close();
  const configPath = path.join(root, 'config.json'); const future = JSON.stringify({ schemaVersion: 'persona-memory/99', version: 9, important: 'preserve me' });
  await fs.writeFile(configPath, future, 'utf8'); const before = await fs.readFile(configPath);
  const unknown = new MemoryRepository({ root });
  await assert.rejects(unknown.open(), { code: 'SCHEMA_INVALID' }); await unknown.close();
  assert.deepEqual(await fs.readFile(configPath), before);
});
test('native usage receipts deduplicate after their detailed rows leave bounded history', async (t) => {
  const { repository } = await fixture(t);
  for (let seq = 1; seq <= 102; seq++) await repository.recordUsage({ requestId: 'dsh:session:with:colons:' + seq, purpose: 'native_turn', usage: { inputTokens: seq } });
  assert.equal((await repository.getUsage()).length, 100);
  const duplicate = await repository.recordUsage({ requestId: 'dsh:session:with:colons:1', purpose: 'native_turn', usage: { inputTokens: 1 } });
  assert.equal(duplicate.checkpointed, true);
  assert.equal((await repository.getUsage()).length, 100);
  const recentDuplicate = await repository.recordUsage({ requestId: 'dsh:session:with:colons:102', purpose: 'native_turn', usage: { inputTokens: 102 } });
  assert.equal(recentDuplicate.duplicate, true);
});
test('zero diagnostic retention means no snapshots or completed receipts are retained', async (t) => {
  const { repository } = await fixture(t, { retention: { snapshotMaxRequests: 0, personaHistoryMaxVersions: 0 } });
  await repository.saveSnapshot({ requestId: 'not-retained', injectedText: 'text' }); assert.deepEqual(await repository.getSnapshots(), []);
  await repository.saveOutbox([{ deliveryId: 'complete', status: 'delivered' }]); assert.deepEqual(await repository.getOutbox(), []);
});
test('source recovery resolves only matching gaps and reconciles pre-admission message IDs with final seq', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.updateConfig({ longTermTargetChars: (await repository.getCapacity()).persistentChars });
  await repository.ingest({ ...chat('message-id', 'too large', 'a'), sourceCursor: 'message:message-id', hostAvailable: true });
  await repository.ingest({ ...chat('another-id', 'also large', 'a'), sourceCursor: 'message:another-id', hostAvailable: true });
  assert.equal((await repository.getRuntime()).memoryGaps.length, 2);
  await repository.updateConfig({ longTermTargetChars: 1000 });
  await repository.ingest({ ...chat('message-id', 'too large', 'a'), sourceCursor: '42', hostAvailable: true });
  const result = await repository.resolveMemoryGaps({ sourceSessionId: 's1', sourceCursor: 42, sourceEventId: 'message-id', updateReceivedCursor: true });
  assert.equal(result.resolvedIds.length, 1);
  const runtime = await repository.getRuntime();
  assert.equal(runtime.memoryGaps.find((gap) => gap.sourceEventId === 'message-id').resolvedAt, 5000);
  assert.equal(runtime.memoryGaps.find((gap) => gap.sourceEventId === 'another-id').resolvedAt, undefined);
  assert.equal((await repository.resolveMemoryGaps({ sourceSessionId: 's1', sourceCursor: 42, sourceEventId: 'message-id' })).resolvedIds.length, 0);
});
test('forget invalidates frozen uncommitted work and rejects hot or chat replay of the same root', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const original = await repository.ingest(chat('1', '明确撤销这句', 'a')); await repository.captureHot(hot('1', '包含原话的过程', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  await repository.forget({ ids: [original.record.id], reason: '忘掉这次经历' }, { personId: 'a' });
  const frozen = await repository.getConsolidationRun(run.runId); assert.equal(frozen.status, 'failed'); assert.equal(frozen.input, undefined);
  await assert.rejects(repository.applyConsolidation(run, [{ documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '试图从旧run恢复', srcRefs: [] } }]), { code: 'RUN_INVALIDATED' });
  assert.equal((await repository.captureHot(hot('1', '旧过程重放', 'a'))).revoked, true);
  assert.equal((await repository.ingest(chat('1', '旧聊天重放', 'a'))).revoked, true);
});
test('runtime key CAS preserves an intervening ingest cursor while applying a chosen sleep/wake update', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const base = await repository.getRuntime(); const next = structuredClone(base);
  next.sleep = { state: 'sleeping', sleepDecisionId: 'chosen', wakeAt: null, wakeCondition: 'explicit_wake', wakeRunId: null };
  await repository.ingest({ ...chat('interleaved', '真实交错的来信', 'a'), sourceCursor: '71' });
  const stored = await repository.patchRuntime(base, next);
  assert.equal(stored.sleep.state, 'sleeping'); assert.equal(stored.ingestCursors[0].recordedThroughCursor, '71');
  assert.ok(stored.version > base.version);
  const wakeBase = await repository.getRuntime(), wakeNext = structuredClone(wakeBase);
  wakeNext.sleep = { state: 'awake', sleepDecisionId: null, wakeAt: null, wakeCondition: null, wakeRunId: null };
  const run = await repository.prepareConsolidation({ personId: 'a' }); await repository.applyConsolidation(run, []);
  const awake = await repository.patchRuntime(wakeBase, wakeNext);
  assert.equal(awake.sleep.state, 'awake');
  assert.equal(awake.consolidationCursors['person:a'].lastRunId, run.runId);
});
test('runtime key CAS rejects same-key lost updates and does not modify any other key', async (t) => {
  const { repository } = await fixture(t);
  const base = await repository.getRuntime(), proposed = structuredClone(base);
  proposed.execution = { lastContext: { personId: 'a' } };
  const other = structuredClone(base); other.execution = { lastContext: { personId: 'b' } };
  await repository.patchRuntime(base, other);
  await assert.rejects(repository.patchRuntime(base, proposed), { code: 'VERSION_CONFLICT' });
  assert.equal((await repository.getRuntime()).execution.lastContext.personId, 'b');
  const unchanged = await repository.patchRuntime(base, base);
  assert.equal(unchanged.execution.lastContext.personId, 'b');
});
test('source-reference preflight rejects guesses without creating a person or changing runtime state', async (t) => {
  const { repository } = await fixture(t);
  const before = await repository.getRuntime();
  await assert.rejects(repository.validateSourceRefs([{ sourceSessionId: 'guessed-session', sourceEventId: 'guessed-message', available: true }]), { code: 'SOURCE_UNKNOWN' });
  assert.deepEqual(await repository.listPeople(), []);
  assert.deepEqual(await repository.getRuntime(), before);
  assert.deepEqual(await repository.validateSourceRefs([]), []);
});
test('first accepted source is immediately usable without evidence or role thresholds and preflight stays read-only', async (t) => {
  const { repository } = await fixture(t);
  const first = await repository.ingest(chat('first', '第一句话就能认识'));
  const ref = { sourceSessionId: first.record.sourceSessionId, sourceEventId: first.record.sourceEventId, available: true };
  const before = await repository.getRuntime();
  assert.deepEqual(await repository.validateSourceRefs([ref], { requireOriginal: true }), [ref]);
  assert.deepEqual(await repository.getRuntime(), before); assert.deepEqual(await repository.listPeople(), []);
});
test('source preflight distinguishes natural original unavailability from explicit revocation', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const original = await repository.ingest(chat('natural', '原话可以自然忘掉', 'a'));
  const ref = { sourceSessionId: 's1', sourceEventId: 'natural', available: false };
  await repository.clearPending([original.eventId]); await repository.evictSources([original.record.id]);
  assert.deepEqual(await repository.validateSourceRefs([ref]), [ref]);
  await assert.rejects(repository.validateSourceRefs([ref], { requireOriginal: true }), { code: 'SOURCE_UNAVAILABLE' });
  const revoked = await repository.ingest(chat('revoked', '明确撤回', 'a'));
  await repository.forget({ ids: [revoked.record.id], reason: '明确撤回' }, { personId: 'a' });
  await assert.rejects(repository.validateSourceRefs([{ sourceSessionId: 's1', sourceEventId: 'revoked', available: true }]), { code: 'SOURCE_REVOKED' });
});
test('readSources retrieves acknowledged originals by stable root or event without reviving absent sources', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  const first = await repository.ingest(chat('acknowledged', '醒来已经接收的原文', 'a'));
  const unknown = await repository.ingest(chat('staged', '尚未认出的人'));
  await repository.clearPending([first.eventId, unknown.eventId]);
  const before = await repository.getRuntime();
  const rows = await repository.readSources({ eventIds: [first.eventId], sourceRefs: [{ sourceSessionId: 's1', sourceEventId: 'staged' }] });
  assert.equal(rows.length, 2); assert.equal(rows.find((row) => row.eventId === unknown.eventId).personId, null);
  rows[0].text = 'caller mutation';
  assert.equal((await repository.readSources({ sourceRefs: [{ sourceSessionId: 's1', sourceEventId: 'acknowledged' }] }))[0].text, '醒来已经接收的原文');
  assert.deepEqual(await repository.getRuntime(), before); assert.deepEqual(await repository.getPending(), []);
  assert.deepEqual(await repository.readSources(), []);
  assert.deepEqual(await repository.readSources({ eventIds: ['unknown'] }), []);
  await repository.evictSources([first.record.id]);
  assert.deepEqual(await repository.readSources({ eventIds: [first.eventId] }), []);
  await repository.assign({ sourceSessionId: 's1', sourceEventId: 'staged', personId: 'a' });
  await repository.forget({ ids: [unknown.record.id], targetPersonId: 'a', reason: '明确撤回' });
  assert.deepEqual(await repository.readSources({ sourceRefs: [{ sourceSessionId: 's1', sourceEventId: 'staged' }] }), []);
  await assert.rejects(repository.readSources({ eventIds: 'not-an-array' }), { code: 'SCHEMA_INVALID' });
  await assert.rejects(repository.readSources({ sourceRefs: [{}] }), { code: 'SCHEMA_INVALID' });
});
test('an uncommitted real-shaped candidate and validation error survive without consuming input, then explicit correction can commit', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' });
  await repository.ingest(chat('candidate-source', '值得留下的经历', 'a')); await repository.captureHot(hot('candidate-source', '本次过程', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  const candidate = [{ documentKey: 'person:a:index', expectedVersion: 0, operation: 'upsert', recordId: 'event', value: { kind: 'event', text: '经历' } }];
  const before = { runtime: await repository.getRuntime(), pending: await repository.getPending(), persona: await repository.getPersona() };
  let failure; try { await repository.applyConsolidation(run, candidate); } catch (error) { failure = error; }
  assert.equal(failure.code, 'SCHEMA_INVALID');
  const saved = await repository.recordConsolidationAttempt(run.runId, { candidatePatch: candidate, validationError: failure });
  assert.equal(saved.status, 'prepared'); assert.equal(saved.commitMarker, null); assert.deepEqual(saved.validatedPatch, []);
  assert.deepEqual(saved.candidatePatch, candidate); assert.equal(saved.validationError.message, 'memory.kind has an unknown value');
  assert.deepEqual(await repository.getRuntime(), before.runtime); assert.deepEqual(await repository.getPending(), before.pending); assert.deepEqual(await repository.getPersona(), before.persona);
  const retryPrompt = consolidationMessages(saved, { personId: 'a' });
  const retryData = JSON.parse(retryPrompt.at(-1).content);
  assert.deepEqual(retryData.candidatePatch, candidate); assert.deepEqual(retryData.validationError, saved.validationError);
  candidate[0].value.text = 'caller mutation'; saved.candidatePatch[0].value.text = 'returned mutation';
  const persisted = await repository.getConsolidationRun(run.runId); assert.equal(persisted.candidatePatch[0].value.text, '经历');
  const corrected = structuredClone(persisted.candidatePatch); corrected[0].value.kind = 'fact';
  const result = await repository.applyConsolidation(persisted, corrected);
  assert.equal(result.run.status, 'committed'); assert.equal(result.run.candidatePatch, undefined); assert.equal(result.run.validationError, undefined);
  const committedBefore = await repository.getConsolidationRun(run.runId);
  await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { message: 'late error' } }), { code: 'RUN_NOT_PREPARED' });
  assert.deepEqual(await repository.getConsolidationRun(run.runId), committedBefore);
});
test('explicit revocation clears retained failed candidates and refuses further attempt records', async (t) => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  await repository.ingest(chat('main', '本轮A经历', 'a')); const revoked = await repository.ingest(chat('other', '后来撤回的B经历', 'b'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  const candidate = [{ documentKey: 'global:index', expectedVersion: 0, operation: 'upsert', recordId: 'bad', value: { kind: 'event', text: 'B经历', srcRefs: [{ sourceSessionId: 's1', sourceEventId: 'other' }] } }];
  await repository.recordConsolidationAttempt(run.runId, { candidatePatch: candidate, validationError: { code: 'SCHEMA_INVALID', message: 'bad kind' } });
  await repository.forget({ ids: [revoked.record.id], targetPersonId: 'b', reason: '明确撤回' });
  const failed = await repository.getConsolidationRun(run.runId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.input, undefined); assert.equal(failed.candidatePatch, undefined); assert.equal(failed.validationError, undefined);
  await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: candidate, validationError: { message: 'retry' } }), { code: 'RUN_INVALIDATED' });
  const next = await repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(repository.recordConsolidationAttempt(next.runId, { candidatePatch: candidate, validationError: { message: 'retry' } }), { code: 'SOURCE_REVOKED' });
  assert.equal((await repository.getConsolidationRun(next.runId)).candidatePatch, undefined);
});
test('candidate diagnostics obey the configured workspace capacity without replacing the prepared run', async (t) => {
  const { repository } = await fixture(t, { retention: { journalMaxBytes: 4096 } });
  const run = await repository.prepareConsolidation();
  await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: [{ text: 'x'.repeat(4096) }], validationError: { message: 'oversized' } }), { code: 'CAPACITY_EXCEEDED' });
  assert.deepEqual(await repository.getConsolidationRun(run.runId), run);
});
