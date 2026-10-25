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
