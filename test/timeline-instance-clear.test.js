import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { scanManagedText } from '../adapters/dsh/instance-lifecycle.js';

test('instance text preview includes actual tiered memories and refuses unknown archive-adjacent files', async t => {
  const temp = await fs.realpath(os.tmpdir()), base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'persona-timeline-clear-')));
  const root = path.join(base, 'memory');
  const repo = new MemoryRepository({ root, clock: () => 100000, config: { recentPreferredDays: 0, longTermTargetChars: 1 } });
  t.after(async () => {
    await repo.close().catch(() => {});
    assert.ok(path.resolve(base).startsWith(path.resolve(temp) + path.sep));
    await fs.rm(base, { recursive: true, force: true });
  });
  await repo.open();
  await repo.ingest({ sourceSessionId: 'source-session', sourceEventId: 'source-event', personId: null,
    sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', text: '不可因转存丢失的原文😀', channelId: 'actual-channel', sourceAt: 10, observedAt: 20 });
  const status = await repo.getTimelineStatus(); assert.equal(status.archive.count, 1);
  await repo.close();
  const items = [{ instanceId: 'target', memoryRoot: root }];
  const preview = await scanManagedText(root, items, 'target');
  assert.ok(preview.files.some(row => row.path === 'timeline/catalog.json'));
  assert.ok(preview.files.some(row => /^timeline\/archive\/\d{8}\.jsonl$/.test(row.path)));
  await fs.writeFile(path.join(root, 'timeline/archive/not-managed.jsonl'), '{}\n');
  await assert.rejects(scanManagedText(root, items, 'target'), { code: 'INSTANCE_CLEAR_UNKNOWN_FILE' });
  assert.ok((await fs.stat(path.join(root, 'timeline/catalog.json'))).isFile());
});
