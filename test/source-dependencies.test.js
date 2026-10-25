import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { extractSourceDependencies, hotSourceDependencies } from '../core/source-dependencies.js';
import { createBackup, restoreBackup } from '../core/maintenance.js';
import { buildSnapshot, createTokenCounter } from '../core/prompts.js';

const ref = id => ({ sourceSessionId: 'B', sourceEventId: id });
const chat = (id, text, personId = 'b', role = 'user', session = 'B') => ({ personId, sourceSessionId: session, sourceEventId: id,
  sourceKind: role === 'user' ? 'user' : 'model', contentClass: 'participant_dialogue', channelId: session, role, text });
const toolText = item => JSON.stringify({ turn: 7, message: { content: [{ type: 'text', text: JSON.stringify({ items: [item] }) }] } });
const hot = (id, text, options = {}) => ({ personId: 'b', sourceRef: ref(id), sourceKind: 'tool/result', kind: 'tool_result', origin: 'system',
  content: { mode: 'cached', text, chars: [...text].length }, ...options });
async function fixture(t, config) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-dependencies-')), root = path.join(workspace, 'memory');
  const repository = new MemoryRepository({ root, config, clock: () => 5000 }); await repository.open();
  await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  t.after(async () => { await repository.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { root, workspace, repository };
}

test('bounded structural extraction decodes nested JSON references and record IDs without treating words or hot root as dependencies', () => {
  const nested = JSON.stringify({ message: { content: [{ text: JSON.stringify({ items: [{ id: 'fact', text: 'Some unrelated words', srcRefs: [ref('one')] }] }) }] } });
  const result = extractSourceDependencies(JSON.stringify(nested));
  assert.deepEqual(result.refs, [ref('one')]); assert.deepEqual(result.recordIds, ['fact']); assert.equal(result.complete, true);
  assert.deepEqual(extractSourceDependencies('Please forget tea, or retain tea for somebody else').refs, []);
  assert.deepEqual(hotSourceDependencies({ sourceRef: ref('self'), content: { mode: 'cached', text: 'plain text' } }).refs, []);
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.equal(extractSourceDependencies(deep).complete, false);
  assert.equal(extractSourceDependencies({ preview: { format: 'json_text_fragment', text: '{"items":[', fragment: { from: 0, to: 10, total: 100 } } }).complete, false);
});

test('forget removes three nested tool caches and their turn process while preserving unrelated C1, A personality and a new correction', async t => {
  const { repository } = await fixture(t);
  const a = await repository.ingest(chat('a', '桂花乌龙也是A自己的经历', 'a', 'user', 'A'));
  const aRun = await repository.prepareConsolidation({ personId: 'a' });
  await repository.applyConsolidation(aRun, [{ documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '桂花乌龙也是A自己的经历', srcRefs: [{ sourceSessionId: 'A', sourceEventId: 'a' }] } }]);
  const user = await repository.ingest(chat('tea-user', '我喜欢这杯茶'));
  const ai = await repository.ingest(chat('tea-assistant', '你喜欢这杯茶', 'b', 'assistant'));
  const old = await repository.prepareConsolidation({ personId: 'b' }); await repository.applyConsolidation(old, []);
  const night = await repository.ingest(chat('night', '第一次五公里和跑道蓝灯'));
  const visible = await repository.ingest(chat('same-assistant-root', '这句无关的外显回复必须保留', 'b', 'assistant'));
  const group = 'B/turn7';
  const ids = [];
  for (const [id, item] of [['103', { id: 'tea-derived', srcRefs: [ref('tea-user')], text: '旧偏好' }],
    ['110', { id: ai.record.id, srcRefs: [ref('tea-assistant')], text: '助手旧复述' }],
    ['117', { id: user.record.id, srcRefs: [ref('tea-user')], text: '用户旧原话' }]]) {
    ids.push((await repository.captureHot(hot(id, toolText(item), { contextGroupId: group }))).record.id);
  }
  const process = await repository.captureHot(hot('same-assistant-root', '同一轮尚未表达的理解', { kind: 'reasoning', contextGroupId: group }));
  const frozen = await repository.prepareConsolidation({ personId: 'b' });
  await repository.recordConsolidationAttempt(frozen.runId, { candidatePatch: { entries: [], debug: toolText({ srcRefs: [ref('tea-user')], text: '旧候选' }) }, validationError: { message: 'old candidate' } });
  await repository.forget({ ids: [user.record.id, ai.record.id], targetPersonId: 'b', reason: '明确撤销' });
  const invalid = await repository.getConsolidationRun(frozen.runId);
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.input, undefined); assert.equal(invalid.candidatePatch, undefined);
  assert.deepEqual(await repository.readSources({ eventIds: [night.eventId, visible.eventId, a.eventId] }).then(rows => rows.map(r => r.id).sort()), [night.record.id, visible.record.id, a.record.id].sort());
  assert.equal((await repository.getPersona()).anchor.text, '桂花乌龙也是A自己的经历');
  const correction = await repository.ingest(chat('correction', '请忘掉这杯茶，不把它继续当我的偏好'));
  const next = await repository.prepareConsolidation({ personId: 'b' });
  assert.ok(next.input.chat.some(record => record.id === correction.record.id));
  assert.ok(!next.input.hot.some(record => [...ids, process.record.id].includes(record.id)));
  const replay = await repository.captureHot(hot('new-tool-seq', toolText({ srcRefs: [ref('tea-user')], text: '旧偏好' })));
  assert.equal(replay.revoked, true);
  const late = await repository.captureHot(hot('late-same-turn', '迟到的过程', { kind: 'reasoning', contextGroupId: group }));
  assert.equal(late.revoked, true);
  const fresh = await repository.ingest(chat('fresh-choice', '我喜欢这杯茶'));
  assert.equal(fresh.duplicate, false);
  const freshProcess = await repository.captureHot(hot('fresh-process', '我喜欢这杯茶', { kind: 'reasoning', contextGroupId: 'B/turn8', dependencyRefs: [ref('fresh-choice')] }));
  assert.ok(freshProcess.record); assert.ok(freshProcess.record.dependencyRefs.some(reference => reference.sourceEventId === 'fresh-choice'));
  const meta = await repository.store.readJson('meta/state.json');
  assert.ok(meta.dependencyCleanups.some(row => row.reason === 'explicit_revocation'));
  assert.ok(!meta.revokedSources.includes(JSON.stringify(['B', 'same-assistant-root'])));
});

test('overflow stores extracted dependencies before host trace conversion and record-ID-only dependencies revoke', async t => {
  const { repository } = await fixture(t, { tempTargetChars: 0 });
  const original = await repository.ingest(chat('root', '待撤销内容'));
  const text = toolText({ id: original.record.id, text: '无显式srcRefs的结构副本' });
  const copied = await repository.captureHot(hot('cached', text, { traceLocator: 'host:old', hostAvailable: true }));
  assert.equal(copied.record.content.mode, 'host_trace'); assert.ok(copied.record.dependencyRecordIds.includes(original.record.id));
  await repository.forget({ ids: [original.record.id], targetPersonId: 'b', reason: '明确撤销' });
  const run = await repository.prepareConsolidation({ personId: 'b', maxInputChars: 16000 }); assert.deepEqual(run.input.hot, []);
  assert.equal((await repository.captureHot(hot('another-seq', text, { hostAvailable: true }))).revoked, true);
  const incomplete = await repository.captureHot(hot('incomplete', '未解析完成', { dependencyScanComplete: false }));
  assert.equal(incomplete.gap.reason, 'hot_dependency_scan_incomplete');
});

test('read guard and reopen sanitize legacy cached/host-trace process copies, including another source session carrying a revoked reference', async t => {
  const { repository } = await fixture(t); const original = await repository.ingest(chat('old', '原内容'));
  await repository.forget({ ids: [original.record.id], targetPersonId: 'b', reason: '撤销' });
  const legacy = (id, session, kind, content) => ({ ...hot(id, '', { kind, sourceRef: { sourceSessionId: session, sourceEventId: id } }), id, schemaVersion: 'persona-memory/3', eventId: 'ev_99999999999999999999', observedAt: 5000, sourceAt: 1000, content });
  const cached = text => ({ mode: 'cached', text, chars: [...text].length });
  const rows = [legacy('legacy-json', 'C', 'tool_result', cached(toolText({ srcRefs: [ref('old')], text: '旧结果' }))),
    legacy('legacy-C-reasoning', 'C', 'reasoning', cached('缺少引用但属于受影响会话的旧过程')),
    legacy('legacy-B-trace', 'B', 'reasoning', { mode: 'host_trace', locator: 'host:old', available: true }),
    legacy('legacy-A-safe', 'A', 'reasoning', cached('不相关A过程'))];
  await repository.store.transaction({ jsonl: { 'people/b/hot.jsonl': rows } });
  const next = await repository.prepareConsolidation({ personId: 'b' });
  assert.deepEqual(next.input.hot.map(record => record.id), ['legacy-A-safe']);
  await repository.close(); await repository.open();
  assert.deepEqual((await repository.store.readLines('people/b/hot.jsonl')).map(record => record.id), ['legacy-A-safe']);
  const meta = await repository.store.readJson('meta/state.json'); assert.ok(meta.dependencyCleanups.some(row => row.reason === 'open_revocation_cleanup' && row.removedHotCount === 3));
});

test('plain scalar personality and impression lineage is carried into immutable request snapshot dependencies', async t => {
  const { repository } = await fixture(t); await repository.ingest(chat('lineage', '原经历'));
  const run = await repository.prepareConsolidation({ personId: 'b' });
  await repository.applyConsolidation(run, [{ documentKey: 'persona', expectedVersion: 0, operation: 'upsert', recordId: 'anchor', value: { text: '没有内嵌引用的锚' } },
    { documentKey: 'person:b:impression', expectedVersion: 0, operation: 'upsert', recordId: 'summary', value: '没有内嵌引用的印象' }]);
  const material = await repository.getContext({ personId: 'b' }); assert.ok(material.sourceDependencies.refs.some(r => r.sourceEventId === 'lineage'));
  const snapshot = await buildSnapshot({ material, context: { personId: 'b' }, config: repository.config, now: 5000, counter: createTokenCounter({}) });
  assert.ok(snapshot.sourceDependencies.refs.some(r => r.sourceEventId === 'lineage')); assert.ok(Object.isFrozen(snapshot.sourceDependencies));
});

test('restoring an older backup with newer revocations sanitizes legacy process caches before opening the restored store', async t => {
  const { repository, root, workspace } = await fixture(t); const original = await repository.ingest(chat('old', '旧偏好'));
  const copied = await repository.captureHot(hot('tool', toolText({ srcRefs: [ref('old')], text: '旧偏好' })));
  const legacy = { ...copied.record }; delete legacy.dependencyRefs; delete legacy.dependencyRecordIds; delete legacy.dependencyScanComplete;
  await repository.store.transaction({ jsonl: { 'people/b/hot.jsonl': [legacy, { ...legacy, id: 'legacy-trace', kind: 'reasoning', sourceRef: ref('trace'), content: { mode: 'host_trace', locator: 'host:trace', available: true } }] } });
  const backup = path.join(workspace, 'backup'); await repository.close(); await createBackup({ root, destination: backup }); await repository.open();
  await repository.forget({ ids: [original.record.id], targetPersonId: 'b', reason: '备份后撤销' }); await repository.close();
  await restoreBackup({ root, source: backup });
  assert.equal((await fs.readFile(path.join(root, 'people/b/hot.jsonl'), 'utf8')).trim(), '');
  const meta = JSON.parse(await fs.readFile(path.join(root, 'meta/state.json'), 'utf8'));
  assert.ok(meta.dependencyCleanups.some(row => row.reason === 'restore_revocation_cleanup'));
  await repository.open(); assert.deepEqual((await repository.prepareConsolidation({ personId: 'b' })).input.hot, []);
});
