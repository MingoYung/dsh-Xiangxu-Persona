import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { validateMemoryRoot, createBackup, validateBackup, restoreBackup } from '../core/maintenance.js';

test('offline validation rejects missing deep document authority and invalid timestamps without changing source bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-deep-doc-'));
  const repo = new MemoryRepository({ root }); await repo.open(); await repo.close();
  t.after(async () => { await repo.close(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'global', 'deep.json'), correct = { schemaVersion: 'persona-memory/3', version: 0, updatedAt: 0, items: [] };
  for (const invalid of [{ ...correct, schemaVersion: undefined }, { ...correct, updatedAt: undefined }, { ...correct, updatedAt: -1 }, { ...correct, updatedAt: 1.5 }]) {
    const bytes = Buffer.from(JSON.stringify(invalid)); await fs.writeFile(file, bytes);
    await assert.rejects(validateMemoryRoot(root), { code: 'INVALID_MEMORY' });
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  await fs.writeFile(file, JSON.stringify(correct)); assert.ok((await validateMemoryRoot(root)).files.some(item => item.path === 'global/deep.json'));
});

test('deep experience and its two interpretations survive a stopped backup and restore byte-for-byte', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-deep-backup-')), root = path.join(workspace, 'memory'), backup = path.join(workspace, 'backup');
  const repo = new MemoryRepository({ root, clock: () => 1 }); await repo.open();
  t.after(async () => { await repo.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await repo.ingest({ sourceSessionId: 's', sourceEventId: 'e', sourceKind: 'message', contentClass: 'participant_dialogue', channelId: 'dsh:s', role: 'assistant', text: '我那时很难过，现在理解发生了变化' });
  const run = await repo.prepareConsolidation();
  await repo.applyConsolidation(run, [{ documentKey: 'global:deep', recordId: '后来理解', expectedVersion: run.inputVersions['global:deep'], operation: 'upsert',
    value: { title: '后来理解', reference: '相处的转折', experience: '当时的经历', feltThen: '当时很难过', meaningNow: '现在已经释怀' } }]);
  const original = await fs.readFile(path.join(root, 'global', 'deep.json')); await repo.close();
  await createBackup({ root, destination: backup }); await validateBackup(backup);
  await restoreBackup({ root, source: backup });
  assert.deepEqual(await fs.readFile(path.join(root, 'global', 'deep.json')), original);
  await repo.open(); const item = await repo.getMemoryRecord('后来理解'); assert.equal(item.feltThen, '当时很难过'); assert.equal(item.meaningNow, '现在已经释怀');
});
