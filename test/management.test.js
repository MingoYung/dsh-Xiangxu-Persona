import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { PersonaRuntime } from '../core/runtime.js';
import { createManagementService } from '../adapters/dsh/management.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-management-')), repository = new MemoryRepository({ root, clock: () => 5000 }); await repository.open();
  await repository.upsertPerson({ personId: 'a', displayName: '甲' });
  const calls = [], coordinator = { repository, memoryRoot: root, agents: new Map(), errors: [], executeCommand: async (command, args) => {
    calls.push({ command, args }); if (command === 'config') return repository.updateConfig(args);
    if (command === 'forget') return repository.forget(args); if (command === 'assign') return repository.assign(args);
    if (command === 'rollback') return repository.rollbackPersona(args.version); return { status: 'completed' };
  } };
  let current = coordinator;
  const service = createManagementService({ getCoordinator: () => current, listInstances: () => ({ items: [{ id: 'one', name: '测试', memoryRoot: root, loaded: Boolean(current), active: Boolean(current) }], activeInstanceId: current ? 'one' : null }) });
  t.after(async () => { await repository.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, coordinator, service, calls, unload: () => { current = null; } };
}
const chat = (id, text) => ({ personId: null, sourceSessionId: 's', sourceEventId: id, sourceKind: 'assistant', contentClass: 'participant_dialogue', channelId: 'c', role: 'assistant', text, sourceAt: 1000, observedAt: 1000 });

test('graph management returns bounded real source and expansion relations without loading original bodies or executing commands', async t => {
  const { service, repository, calls } = await fixture(t), original = (await repository.ingest(chat('graph-source', 'PRIVATE_ORIGINAL_ONLY_ON_DEMAND'))).record;
  const run = await repository.prepareConsolidation({ personId: null });
  await repository.applyConsolidation(run, [
    { documentKey: 'global:index', expectedVersion: run.inputVersions['global:index'], operation: 'upsert', recordId: 'graph-memory', value: { kind: 'fact', text: '共同经历的摘要', srcRefs: [{ sourceSessionId: 's', sourceEventId: 'graph-source' }] } },
    { documentKey: 'global:codes', expectedVersion: run.inputVersions['global:codes'], operation: 'upsert', recordId: 'graph-code', value: { label: '已有编码', meaning: '一次经历', cues: [], expandIds: ['graph-memory'], occurrences: 1, srcRefs: [] } },
  ]);
  const view = await service.dispatch('memory.graph', { scope: 'global', limit: 80, edgeLimit: 160 });
  assert.equal(view.format, 'persona-memory-graph/1'); assert.equal(view.referenceOnly, true); assert.equal(view.automaticRecall, false);
  assert.equal(view.coverage.entireStoreRead, false); assert.equal(view.coverage.total, null); assert.equal(view.coverage.rawScope, 'none');
  assert.ok(view.nodes.some(node => node.recordId === 'graph-memory')); assert.ok(view.nodes.some(node => node.kind === 'source')); assert.ok(view.nodes.some(node => node.kind === 'session'));
  assert.ok(view.edges.some(edge => edge.kind === 'expands')); assert.ok(view.edges.some(edge => edge.kind === 'source')); assert.ok(view.edges.some(edge => edge.kind === 'source_session'));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 131072); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_ORIGINAL_ONLY_ON_DEMAND/);
  const record = view.nodes.find(node => node.recordId === 'graph-memory'), detail = await service.dispatch('memory.detail', { id: record.recordId, recordKey: record.recordKey });
  assert.equal(JSON.parse(detail.text).text, '共同经历的摘要'); assert.deepEqual(calls, []);
  const originalGraph = await service.dispatch('memory.graph', { scope: 'unknown', sourceRef: { sourceSessionId: 's', sourceEventId: 'graph-source' } });
  assert.equal(originalGraph.coverage.rawScope, 'selected_shard'); assert.ok(originalGraph.nodes.some(node => node.recordId === original.id));
});

test('graph management rejects invalid scope and budget and never implicitly loads an unavailable persona', async t => {
  const { service, unload, calls } = await fixture(t);
  await assert.rejects(service.dispatch('memory.graph', { scope: 'all' }), { code: 'SCHEMA_INVALID' });
  await assert.rejects(service.dispatch('memory.graph', { scope: 'global', limit: 10000 }), { code: 'SCHEMA_INVALID' });
  await assert.rejects(service.dispatch('memory.graph', { scope: 'person', personId: '../other' }), { code: 'SCHEMA_INVALID' });
  unload(); await assert.rejects(service.dispatch('memory.graph', { scope: 'global' })); assert.deepEqual(calls, []);
});

test('management carries exact memory identity through browse, search and paged detail without cross-person reads', async t => {
  const { repository, service } = await fixture(t);
  for (const personId of ['a', 'b']) {
    if (personId !== 'a') await repository.upsertPerson({ personId });
    const run = await repository.prepareConsolidation({ personId }), key = `person:${personId}:index`;
    await repository.applyConsolidation(run, [{ documentKey: key, expectedVersion: run.inputVersions[key], operation: 'upsert', recordId: 'shared-id', value: { kind: 'fact', text: `${personId} independent detail`, srcRefs: [] } }]);
  }
  const page = await service.dispatch('memory.list', { scope: 'person', personId: 'b' }), selected = page.items[0];
  assert.equal(selected.personId, 'b'); assert.equal(typeof selected.recordKey, 'string');
  const search = await service.dispatch('memory.search', { query: 'independent', scope: 'all', associationDepth: 0 });
  assert.equal(search.items.length, 2); assert.equal(new Set(search.items.map(row => row.recordKey)).size, 2);
  await assert.rejects(service.dispatch('memory.detail', { id: selected.id }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  let cursor, assembled = '';
  do {
    const result = await service.dispatch('memory.detail', { id: selected.id, recordKey: selected.recordKey, personId: 'b', scope: selected.scope, recordType: selected.recordType, pageChars: 60, cursor });
    assembled += result.text; cursor = result.nextCursor;
  } while (cursor);
  const detail = JSON.parse(assembled); assert.equal(detail.personId, 'b'); assert.equal(detail.text, 'b independent detail');
  await assert.rejects(service.dispatch('memory.detail', { id: selected.id, recordKey: selected.recordKey, personId: 'a' }), { code: 'MEMORY_UNAVAILABLE' });
  await assert.rejects(service.dispatch('memory.detail', { id: selected.id, recordKey: {} }), { code: 'BAD_MANAGEMENT_REQUEST' });
  await assert.rejects(service.dispatch('memory.forget', { ids: [selected.id], targetPersonId: 'b', scope: 'person' }), { code: 'MEMORY_RECORD_AMBIGUOUS' });
  assert.equal((await service.dispatch('memory.list')).total, 2);
});

test('status separates process provenance gaps from dialogue copying failures using only safe aggregate counts', async t => {
  const { service, repository, calls } = await fixture(t), runtime = await repository.getRuntime();
  const secret = 'PRIVATE_GAP_ACCOUNT_0000000000_PATH_TOKEN';
  const gaps = [
    { id: 'process-a', sourceSessionId: secret, sourceEventId: 'same-event', reason: 'hot_dependency_scan_incomplete', createdAt: 1000 },
    { id: 'process-b', sourceSessionId: secret, sourceEventId: 'same-event', reason: 'hot_dependency_scan_incomplete', createdAt: 1001 },
    { id: 'dialogue', sourceSessionId: secret, sourceEventId: 'dialogue-event', reason: 'memory_copy_paused_at_capacity', createdAt: 1002 },
    { id: 'other', sourceSessionId: secret, sourceEventId: 'other-event', reason: secret, createdAt: 1003 },
    { id: 'resolved', sourceSessionId: secret, sourceEventId: 'resolved-event', reason: 'hot_dependency_scan_incomplete', createdAt: 1004, resolvedAt: 0 },
  ], before = structuredClone(gaps);
  repository.getRuntime = async () => ({ ...runtime, memoryGaps: gaps });
  const value = await service.dispatch('status');
  assert.deepEqual(value.runtime.memoryGapCounts, { total: 5, unresolved: 4, unresolvedSources: 3,
    processDependencies: { records: 2, sources: 1 }, dialogueCopies: { records: 1, sources: 1 }, other: { records: 1, sources: 1 },
    byReason: { hot_dependency_scan_incomplete: 2, memory_copy_paused_at_capacity: 1, OTHER: 1 } });
  assert.doesNotMatch(JSON.stringify(value.runtime), /PRIVATE_GAP|same-event|dialogue-event|other-event/);
  assert.deepEqual(gaps, before); assert.equal(calls.length, 0);
});

test('management preserves complete Unicode through bounded detail pages and invalidates stale memory cursors', async t => {
  const { repository, service } = await fixture(t), text = '真实原话😀'.repeat(5000), record = (await repository.ingest(chat('long', text))).record;
  const list = await service.dispatch('memory.list', { scope: 'unknown' }); assert.equal(list.total, 1); assert.notEqual(list.items[0].textPreview, text);
  let cursor, assembled = '';
  do { const page = await service.dispatch('memory.detail', { id: record.id, cursor }); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 131072); assembled += page.text; cursor = page.nextCursor; } while (cursor);
  const detail = JSON.parse(assembled); assert.equal(detail.text, text); assert.equal(detail.role, 'assistant'); assert.equal(detail.personId, null);
  await repository.ingest(chat('new', '后来的一句'));
  const first = await service.dispatch('memory.list', { pageSize: 1 }); assert.ok(first.nextCursor);
  await repository.ingest(chat('later', '再后来'));
  await assert.rejects(service.dispatch('memory.list', { pageSize: 1, cursor: first.nextCursor }), { code: 'MANAGEMENT_CURSOR_STALE' });
});

test('technical settings reject unknown and invalid values before controls, and unloaded status never loads an instance', async t => {
  const { service, repository, calls, unload } = await fixture(t), before = structuredClone(repository.config);
  await assert.rejects(service.dispatch('config.update', { config: { apiKey: 'should-not-save' } }), { code: 'BAD_MANAGEMENT_CONFIG' });
  await assert.rejects(service.dispatch('config.update', { config: { processingLimits: { consolidationOutputTokens: 0 } } }));
  await assert.rejects(service.dispatch('config.update', { config: { timezone: 'nonexistent-zone' } }));
  await assert.rejects(service.dispatch('config.update', { config: { tempTargetChars: Infinity } }), { code: 'BAD_MANAGEMENT_REQUEST' });
  assert.equal(calls.length, 0); assert.deepEqual(repository.config, before);
  await service.dispatch('config.update', { config: { consolidationMode: 'on_write' } }); assert.equal(repository.config.consolidationMode, 'on_write');
  assert.equal((await repository.getRuntime()).sleep.state, 'awake');
  unload(); assert.equal((await service.dispatch('status')).available, false);
  await assert.rejects(service.dispatch('persona.get'), { code: 'PERSONA_NOT_LOADED' });
});

test('explicit background operations persist a receipt before work, deduplicate retries, and never replay interrupted receipts', async t => {
  const { service, coordinator, repository } = await fixture(t); let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  coordinator.executeCommand = async () => { calls++; await gate; return { committed: true, runId: 'run_actual', modelCalls: 1 }; };
  const receipt = await service.dispatch('operations.start', { action: 'control.consolidate', args: { personId: null }, requestId: 'stable_request' });
  assert.equal(receipt.id, 'stable_request');
  const duplicate = await service.dispatch('operations.start', { action: 'control.consolidate', args: { personId: null }, requestId: 'stable_request' }); assert.equal(duplicate.id, receipt.id);
  assert.equal(calls, 1); assert.equal(await service.hasActiveOperations(), true);
  release(); for (let count = 0; count < 100 && await service.hasActiveOperations(); count++) await new Promise(resolve => setTimeout(resolve, 5));
  const complete = await service.dispatch('operations.get', { id: receipt.id }); assert.equal(complete.status, 'completed'); assert.equal(complete.result.runId, 'run_actual'); assert.equal(calls, 1);
  const doc = await repository.store.readJson('ops/management.json'); doc.records.push({ id: 'interrupted', action: 'control.consolidate', args: {}, status: 'running', createdAt: 1, updatedAt: 1 }); await repository.store.transaction({ json: { 'ops/management.json': doc } });
  const restarted = createManagementService({ getCoordinator: () => coordinator });
  assert.equal((await restarted.dispatch('operations.get', { id: 'interrupted' })).status, 'unknown'); assert.equal(calls, 1);
  const replay = await restarted.dispatch('operations.start', { action: 'control.consolidate', args: {}, requestId: 'interrupted' }); assert.equal(replay.status, 'unknown'); assert.equal(calls, 1);
});

test('source assignment retains assistant actor and explicit forgetting never means empty selection clears all', async t => {
  const { service, repository } = await fixture(t), record = (await repository.ingest(chat('source', '这句是助手说的'))).record;
  await service.dispatch('memory.assign', { sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, personId: 'a', reason: '用户明确选择关系归属' });
  const current = await repository.getMemoryRecord(record.id); assert.equal(current.personId, 'a'); assert.equal(current.role, 'assistant'); assert.equal(current.speakerId, null);
  await assert.rejects(service.dispatch('memory.forget', { ids: [] }), { code: 'MEMORY_SELECTION_REQUIRED' }); assert.equal((await repository.browseMemory()).total, 1);
  await service.dispatch('memory.forget', { ids: [record.id], targetPersonId: 'a', reason: '明确删除' }); assert.equal(await repository.getMemoryRecord(record.id), null);
});

test('only named lifecycle and maintenance ports are delegated and arbitrary control/file access is refused', async t => {
  const { coordinator } = await fixture(t), received = [];
  const service = createManagementService({ getCoordinator: () => coordinator,
    lifecycle: { load: async args => { received.push(args); return { loaded: true }; } }, maintenance: { backup: async args => ({ destination: args.destination, status: 'completed' }) } });
  assert.equal((await service.dispatch('instances.load', { instanceId: 'one' })).loaded, true); assert.deepEqual(received, [{ instanceId: 'one' }]);
  assert.equal((await service.dispatch('maintenance.backup', { destination: 'C:/named-backup' })).destination, 'C:/named-backup');
  await assert.rejects(service.dispatch('files.read', { path: 'C:/credentials' }), { code: 'UNKNOWN_MANAGEMENT_ACTION' });
  await assert.rejects(service.dispatch('operations.start', { action: 'control.consolidate', args: { arbitraryPath: 'C:/credentials' } }), { code: 'BAD_MANAGEMENT_REQUEST' });
});

test('a rejected or unpersisted configuration never changes live runtime settings or storage limits', async t => {
  const { repository } = await fixture(t), runtime = new PersonaRuntime({ repository, config: repository.config, autoSchedule: false });
  const before = structuredClone(runtime.config), stored = await repository.store.readJson('config.json'), limits = structuredClone(repository.store.capacityLimits);
  await assert.rejects(runtime.updateConfig({ processingLimits: { consolidationOutputTokens: 0 } })); assert.deepEqual(runtime.config, before); assert.deepEqual(repository.config, before);
  const transact = repository.store.transaction;
  repository.store.transaction = async () => { throw Object.assign(new Error('Injected persistence refusal before transaction admission'), { code: 'TEST_DISK_FAILURE' }); };
  try { await assert.rejects(runtime.updateConfig({ capacityLimits: { storeBytes: limits.storeBytes + 1024 } }), { code: 'TEST_DISK_FAILURE' }); }
  finally { repository.store.transaction = transact; }
  assert.deepEqual(runtime.config, before); assert.deepEqual(repository.config, before); assert.deepEqual(repository.store.capacityLimits, limits);
  assert.deepEqual(await repository.store.readJson('config.json'), stored);
});
