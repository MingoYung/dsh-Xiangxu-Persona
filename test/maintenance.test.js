import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { JsonStore } from '../core/store.js';
import { createBackup, restoreBackup, validateBackup, validateMemoryRoot, recoverRestore, exportMemory, importMemory } from '../core/maintenance.js';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-maintenance-'));
  const root = path.join(workspace, 'memory'), backup = path.join(workspace, 'backup');
  const repo = new MemoryRepository({ root, clock: () => 1000 }); await repo.open();
  await repo.upsertPerson({ personId: 'a' });
  await repo.ingest({ personId: 'a', sourceSessionId: 's', sourceEventId: 'm', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'c', role: 'user', text: '完整记忆', sourceAt: 1 });
  t.after(async () => { await repo.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { workspace, root, backup, repo };
}
test('offline backup verifies exact content and restore recovers a stopped same-v3 database', async (t) => {
  const { root, backup, repo } = await fixture(t);
  await assert.rejects(createBackup({ root, destination: backup }), { code: 'WRITER_LOCKED' });
  await repo.close();
  const saved = await exportMemory({ root, destination: backup, clock: () => 1234 });
  assert.equal(saved.schemaVersion, 'persona-memory/3'); assert.equal(saved.createdAt, 1234);
  const verified = await validateBackup(backup); assert.equal(verified.totalBytes, saved.totalBytes);
  await repo.open(); await repo.updateConfig({ consolidationMode: 'on_write' }); await repo.close();
  await importMemory({ root, source: backup });
  await repo.open(); assert.equal(repo.config.consolidationMode, 'sleep');
  assert.equal((await repo.getContext({ personId: 'a' })).records[0].text, '完整记忆'); await repo.close();
  assert.ok((await validateMemoryRoot(root)).files.length);
  assert.equal((await fs.stat(root + '.rollback')).isDirectory(), true);
});
test('tampered files and unsafe destinations are rejected without changing the original root', async (t) => {
  const { root, backup, repo } = await fixture(t); await repo.close();
  await assert.rejects(createBackup({ root, destination: path.join(root, 'backup') }), { code: 'OVERLAPPING_PATHS' });
  await createBackup({ root, destination: backup });
  const original = await fs.readFile(path.join(root, 'self', 'persona.json'));
  await fs.appendFile(path.join(backup, 'data', 'self', 'persona.json'), '\ncorrupt');
  await assert.rejects(restoreBackup({ root, source: backup }), { code: 'BACKUP_CHECKSUM' });
  assert.deepEqual(await fs.readFile(path.join(root, 'self', 'persona.json')), original);
});
test('restore interruption after moving root is recoverable and normal writers cannot create an empty replacement', async (t) => {
  const { root, backup, repo } = await fixture(t); await repo.close(); await createBackup({ root, destination: backup });
  await assert.rejects(restoreBackup({ root, source: backup, fault: (phase) => { if (phase === 'after_root_moved') throw new Error('simulated stop between directory renames'); } }), /between directory/);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
  const writer = new JsonStore(root); await assert.rejects(writer.open(), { code: 'RESTORE_PENDING' });
  const recovered = await recoverRestore({ root }); assert.equal(recovered.recovered, true);
  await repo.open(); assert.equal((await repo.getContext({ personId: 'a' })).records.length, 1); await repo.close();
  assert.equal((await recoverRestore({ root })).status, 'no_pending_restore');
});
test('failed restore never removes an unmanaged rollback directory', async (t) => {
  const { root, backup, repo } = await fixture(t); await repo.close(); await createBackup({ root, destination: backup });
  await fs.mkdir(root + '.rollback'); await fs.writeFile(path.join(root + '.rollback', 'private.txt'), 'keep');
  await assert.rejects(restoreBackup({ root, source: backup }), { code: 'UNMANAGED_TARGET' });
  assert.equal(await fs.readFile(path.join(root + '.rollback', 'private.txt'), 'utf8'), 'keep');
  assert.ok((await fs.stat(root)).isDirectory());
});
test('backup byte limit and future schema checks preserve source; historical pending deliveries restore as unknown', async (t) => {
  const { root, backup, repo } = await fixture(t);
  await repo.saveOutbox([{ deliveryId: 'old', status: 'pending', target: { personId: 'a', channelId: 'c', sessionId: 's' } }]); await repo.close();
  await assert.rejects(createBackup({ root, destination: backup, maxBytes: 10 }), { code: 'BACKUP_CAPACITY' });
  await createBackup({ root, destination: backup }); await restoreBackup({ root, source: backup });
  await repo.open(); assert.equal((await repo.getOutbox())[0].status, 'unknown'); await repo.close();
  const file = path.join(root, 'config.json'); const current = JSON.parse(await fs.readFile(file, 'utf8'));
  current.schemaVersion = 'persona-memory/999'; await fs.writeFile(file, JSON.stringify(current));
  const bytes = await fs.readFile(file);
  await assert.rejects(createBackup({ root, destination: backup }), { code: 'SCHEMA_INVALID' });
  assert.deepEqual(await fs.readFile(file), bytes);
});
test('backup latest rotation keeps one fixed previous backup and rejects unrelated directories', async (t) => {
  const { workspace, root, backup, repo } = await fixture(t); await repo.close();
  await createBackup({ root, destination: backup, clock: () => 1 }); await createBackup({ root, destination: backup, clock: () => 2 });
  assert.equal((await validateBackup(backup + '.previous')).createdAt, 1);
  assert.equal((await validateBackup(backup)).createdAt, 2);
  const unrelated = path.join(workspace, 'unrelated'); await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'notes'), 'keep');
  await assert.rejects(createBackup({ root, destination: unrelated }), { code: 'UNMANAGED_TARGET' });
  assert.equal(await fs.readFile(path.join(unrelated, 'notes'), 'utf8'), 'keep');
});
test('restoring an older snapshot carries newer explicit revocations and blocks unseen-source replay', async (t) => {
  const { root, backup, repo } = await fixture(t);
  const run = await repo.prepareConsolidation({ personId: 'a' });
  await repo.recordConsolidationAttempt(run.runId, { candidatePatch: [{ value: { text: '旧备份中的未提交候选', srcRefs: [{ sourceSessionId: 's', sourceEventId: '1' }] } }], validationError: { code: 'SCHEMA_INVALID', message: 'uncommitted' } });
  await repo.close(); await createBackup({ root, destination: backup });
  await repo.open(); const original = (await repo.getContext({ personId: 'a' })).records[0];
  await repo.forget({ ids: [original.id], reason: '备份之后明确忘掉' }, { personId: 'a' });
  const later = await repo.ingest({ personId: 'a', sourceSessionId: 's', sourceEventId: 'after-backup', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'c', role: 'user', text: '后来也要求忘掉' });
  await repo.forget({ ids: [later.record.id], reason: '这句也忘掉' }, { personId: 'a' }); await repo.close();
  await restoreBackup({ root, source: backup }); await repo.open();
  assert.deepEqual((await repo.getContext({ personId: 'a' })).records, []);
  assert.deepEqual(await repo.getPending(), []);
  const restoredRun = await repo.getConsolidationRun(run.runId);
  assert.equal(restoredRun.status, 'failed'); assert.equal(restoredRun.candidatePatch, undefined); assert.equal(restoredRun.validationError, undefined);
  const replay = await repo.ingest({ personId: 'a', sourceSessionId: 's', sourceEventId: 'after-backup', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'c', role: 'user', text: '不应重新复活' });
  assert.equal(replay.revoked, true);
  await repo.close(); assert.equal((await validateMemoryRoot(root)).schemaVersion, 'persona-memory/3');
});
test('default offline operations honor the deployment backup byte limit below the 64 MiB read cap', async (t) => {
  const { root, backup, repo } = await fixture(t);
  await repo.updateConfig({ retention: { backupMaxBytes: 100 } }); await repo.close();
  await assert.rejects(createBackup({ root, destination: backup }), { code: 'BACKUP_CAPACITY' });
  await assert.rejects(createBackup({ root, destination: backup, maxBytes: 10000000 }), { code: 'BACKUP_CAPACITY' });
  await repo.open(); await repo.updateConfig({ retention: { backupMaxBytes: 8388608 } }); await repo.close(); await createBackup({ root, destination: backup });
  await repo.open(); await repo.updateConfig({ retention: { backupMaxBytes: 100 } }); await repo.close();
  await assert.rejects(restoreBackup({ root, source: backup }), { code: 'BACKUP_CAPACITY' });
});
test('an evolved root beyond the old 8 MiB default backs up under the default retention limit', async (t) => {
  const { root, backup, repo } = await fixture(t);
  // REL-F2-002: real deployments crossed 8 MiB (frozen sample 10.66 MiB, formal
  // persona 9.1 MiB) and default-config backups failed with BACKUP_CAPACITY.
  // Grow past 8 MiB across many per-person files (each under the 1 MiB document
  // limit, like real evolved roots) while keeping the DEFAULT retention config.
  const long = '备份容量回归：完整人格资料必须能整体备份。'.repeat(4000); // ~84 KB per record
  for (let index = 0; index < 50; index += 1) {
    const personId = 'person-' + index;
    await repo.upsertPerson({ personId });
    await repo.ingest({ personId, sourceSessionId: 's' + index, sourceEventId: 'e' + index, sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'c', role: 'user', text: long, sourceAt: index + 1 });
  }
  await repo.close();
  const saved = await createBackup({ root, destination: backup });
  assert.ok(saved.totalBytes > 8 * 1024 * 1024, 'fixture must exceed the old 8 MiB default, got ' + saved.totalBytes);
  const verified = await validateBackup(backup);
  assert.equal(verified.totalBytes, saved.totalBytes);
});
test('foreign root documents require explicit path-scoped admission without core owning their schema', async (t) => {
  const { root, repo } = await fixture(t);
  const file = path.join(root, 'adapter-state.json'), value = { schemaVersion: 'isolated-adapter/1', entries: [] };
  await repo.store.transaction({ runId: 'foreign-root-fixture', json: { 'adapter-state.json': value } });
  await repo.close();
  await assert.rejects(validateMemoryRoot(root), { code: 'SCHEMA_UNSUPPORTED' });
  const extensionValidator = ({ path: name, value: item, kind }) => kind === 'content'
    && name === 'adapter-state.json' && item?.schemaVersion === 'isolated-adapter/1' && Array.isArray(item.entries);
  assert.equal((await validateMemoryRoot(root, { extensionValidator })).schemaVersion, 'persona-memory/3');
  await fs.writeFile(file, JSON.stringify({ ...value, schemaVersion: 'isolated-adapter/2' }));
  await assert.rejects(validateMemoryRoot(root, { extensionValidator }), { code: 'SCHEMA_UNSUPPORTED' });
  await fs.writeFile(file, JSON.stringify(value));
  await fs.writeFile(path.join(root, 'unrecognized.json'), JSON.stringify(value));
  await assert.rejects(validateMemoryRoot(root, { extensionValidator }), { code: 'SCHEMA_UNSUPPORTED' });
});
